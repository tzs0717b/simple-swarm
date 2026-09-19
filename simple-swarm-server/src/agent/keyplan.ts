/**
 * key 车道分配（2026-09-18 用户口径）：
 *   1) keypool 现在按「优质 / 中等 / 一般」分档，优先用优质；
 *   2) 两个 agent 绝不能共用同一把 key；
 *   3) 横向铺开 —— 第 1 个优质 agent 和第 2 个优质 agent 落在不同 provider 上；
 *   4) 大脑连续失败 2 次 -> 直接换 key / provider。
 *
 * 为什么用「provider 车道」而不是钉 x-key-id：
 *   keypool 是三层结构：auto->模型，模型->provider（固定映射），provider 内部选 key。
 *   key 永远在同一家 provider 内部挑 => provider 不同 => key 物理上不可能撞。
 *   显式指定「某家的优质模型」就等于钉住那家 provider，同时保留该家内部换 key 的自愈 ——
 *   比钉 x-key-id（429 时无处可退）更稳。只有 agent 数 > 可用 provider 数时才退化成同家分不同 key。
 */

export type Lane = {
  provider: string;
  providerName: string;
  model: string;
  tier: string;
  score: number;
  /** 首字延迟 ms：v3 说分档是快照、会劣化，所以按最近实测延迟把慢车道沉底 */
  ttftMs: number;
  /** 开跑前 1-token 实测的响应毫秒；0 = 没测/测挂了 */
  probeMs?: number;
  probeOk?: boolean;
  activeKeys: number;
  /** 同一家被分给多个 agent 时，给每个 agent 钉一把不同的 key */
  pinnedKeys: string[];
};

export type Assignment = {
  agent: string;
  /** 车道队列：第 0 个是首选，失败 2 次后往后换（换 provider） */
  queue: Lane[];
  pinFor: (lane: Lane, laneIndex: number) => string | undefined;
};

let cache: { at: number; lanes: Lane[] } | null = null;
const TTL_MS = 5 * 60_000;

/** 临时排除名单：KEYPOOL_LANE_DENY="modelA,modelB"。v3 3 点名的 nvidia/meta/muse-glimmer-30b
 *  重负载下要 12~180s，而 1-token 探活测不出来（ping 只要 1.6s）=> 只能先按名单沉底。 */
const denyList = (process.env.KEYPOOL_LANE_DENY ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x.length > 0);

type TierRow = { provider?: string; model?: string; tier?: string; score?: number; ttftMs?: number; e2eTps?: number };
type PoolKey = { id?: string; provider?: string; effective_status?: string; first_token_latency_ms?: number };

function adminBase(): string {
  let base = process.env.KEYPOOL_ADMIN_URL ?? "http://127.0.0.1:3131";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

async function getJson(url: string, token: string, ms = 12_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: token ? { authorization: "Bearer " + token } : {}, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 拉池子现状 -> 每家有活 key 的优质模型压成一条车道 */
export async function fetchLanes(): Promise<Lane[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.lanes;
  const token = process.env.KEYPOOL_PROXY_TOKEN ?? process.env.LLM_API_KEY ?? "";
  const base = adminBase();
  const [tierRaw, keysRaw, provRaw] = await Promise.all([
    getJson(base + "/api/bench/tiering", token),
    getJson(base + "/v1/keys", token),
    getJson(base + "/api/providers", token),
  ]);
  const tierRows = ((tierRaw as { models?: TierRow[] }).models ?? []) as TierRow[];
  const poolKeys = ((keysRaw as { data?: PoolKey[] }).data ?? []) as PoolKey[];
  const provList = (Array.isArray(provRaw) ? provRaw : ((provRaw as { data?: unknown[] }).data ?? [])) as { id?: string; name?: string }[];
  const nameOf = new Map(provList.map((p) => [String(p.id), String(p.name ?? p.id).slice(0, 18)]));

  const keysByProvider = new Map<string, PoolKey[]>();
  for (const k of poolKeys) {
    if (k.effective_status !== "active") continue;
    const p = String(k.provider ?? "");
    if (!keysByProvider.has(p)) keysByProvider.set(p, []);
    keysByProvider.get(p)!.push(k);
  }

  const best = new Map<string, TierRow>();
  for (const r of tierRows) {
    if (r.tier !== "优质" || !r.provider || !r.model) continue;
    const cur = best.get(r.provider);
    if (!cur || Number(r.score ?? 0) > Number(cur.score ?? 0)) best.set(r.provider, r);
  }

    const lanes: Lane[] = [];
    const used = new Set<string>();
    const pushLane = (provider: string, row: TierRow): void => {
      const keys = (keysByProvider.get(provider) ?? []).slice();
      if (keys.length === 0) return;
      keys.sort((a, b) => Number(a.first_token_latency_ms ?? 9e9) - Number(b.first_token_latency_ms ?? 9e9));
      used.add(provider);
      lanes.push({
        provider,
        providerName: nameOf.get(provider) ?? provider.slice(0, 8),
        model: String(row.model),
        tier: String(row.tier),
        score: Number(row.score ?? 0),
        ttftMs: Number(row.ttftMs ?? 0),
        activeKeys: keys.length,
        pinnedKeys: keys.map((k) => String(k.id ?? "")),
      });
    };

    /* 人工优选先上车，顺序即优先级（KEYPOOL_LANE_PREFER，逗号分隔；provider/模型 可指定家） */
    const preferList = (process.env.KEYPOOL_LANE_PREFER ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const providerSet = new Set(tierRows.map((r) => String(r.provider ?? "")));
    for (const want of preferList) {
      const slash = want.indexOf("/");
      const scope = slash > 0 && providerSet.has(want.slice(0, slash)) ? want.slice(0, slash) : "";
      const needle = (scope ? want.slice(scope.length + 1) : want).toLowerCase();
      const hit = tierRows
        .filter((r) => r.model && r.provider)
        .filter((r) => (scope ? String(r.provider) === scope : true))
        .filter((r) => String(r.model).toLowerCase().includes(needle))
        .filter((r) => (keysByProvider.get(String(r.provider)) ?? []).length > 0)
        /* 人工点名 provider 时允许同一家出多条车道（不同模型/不同 key）；不点名则一家一条 */
        .filter((r) => (scope ? true : !used.has(String(r.provider))))
        .sort((a, b) => (b.tier === "优质" ? 1 : 0) - (a.tier === "优质" ? 1 : 0) || Number(b.score ?? 0) - Number(a.score ?? 0))[0];
      if (hit) pushLane(String(hit.provider), hit);
    }

    /* 剩下的按老办法补：每家一个优质模型；deny 名单里的常错模型直接不建车道 */
    for (const [provider, row] of best) {
      if (used.has(provider)) continue;
      if (denyList.some((d) => String(row.model).includes(d))) continue;
      pushLane(provider, row);
    }
  /* v3 3 教训：分档是快照，nvidia/meta/muse-glimmer-30b 从 2.8s 劣化到 12~180s 却仍排在前 3。
     所以把"最近实测首字延迟 > 8s（或没测过）"的车道沉到最后：车道数 > agent 数时它们不会被
     选为首选，只有前面全挂了才轮到。 */
  const SLOW_MS = Number(process.env.KEYPOOL_SLOW_TTFT_MS ?? 8000);
  lanes.sort((a, b) => {
    const sa = a.ttftMs === 0 || a.ttftMs > SLOW_MS ? 1 : 0;
    const sb = b.ttftMs === 0 || b.ttftMs > SLOW_MS ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return b.score - a.score || a.ttftMs - b.ttftMs || b.activeKeys - a.activeKeys;
  });
  cache = { at: Date.now(), lanes };
  return lanes;
}

/** 把车道分给 agent：首选 provider 互不相同（有余量时），失败后换到"别人没用过"的车道 */
export function assignLanes(agents: string[], lanes: Lane[]): Map<string, Assignment> {
  const out = new Map<string, Assignment>();
  if (lanes.length === 0) return out;
  const n = lanes.length;
  const sorted = [...agents].sort();
  const usedPin = new Map<string, number>();

  const primaryProviders = new Set(sorted.map((_, i2) => lanes[i2 % n].provider));
  const spares = lanes.filter((l) => !primaryProviders.has(l.provider));

  sorted.forEach((agent, i2) => {
    const start = i2 % n;
    const primary = lanes[start];
    const queue: Lane[] = [primary];
    const rotated = spares.length === 0 ? [] : [...spares.slice(i2 % spares.length), ...spares.slice(0, i2 % spares.length)];
    for (const spare of rotated) queue.push(spare);
    for (let step = 1; step < n; step += 1) {
      const lane = lanes[(start + step) % n];
      if (!queue.includes(lane)) queue.push(lane);
    }
    out.set(agent, {
      agent,
      queue,
      pinFor: (lane, laneIndex) => {
        if (n >= sorted.length && laneIndex === 0) return undefined;
        if (lane.activeKeys <= 1) return undefined;
        const seen = usedPin.get(lane.provider) ?? 0;
        usedPin.set(lane.provider, seen + 1);
        return lane.pinnedKeys[seen % lane.activeKeys];
      },
    });
  });
  return out;
}

/** 终端/追踪用的一句话概述 */
export function describeLanes(assign: Map<string, Assignment>, pins: Record<string, string> = {}): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [agent, a] of assign) {
    seen.add(agent);
    /* 钉死模型的 agent 根本不走车道（runner 里 laneAssign 对它无效），
       照搬车道表会让 UI 显示一个他根本没用的模型 —— 直接报实际用的那个。 */
    const pinned = pins[agent];
    if (pinned) {
      parts.push(agent + "=" + pinned + "（钉死）");
      continue;
    }
    const head = a.queue[0];
    parts.push(agent + "-" + head.providerName + "/" + head.model + (head.activeKeys > 1 ? "(" + head.activeKeys + "key)" : ""));
  }
  for (const [agent, model] of Object.entries(pins)) {
    if (!seen.has(agent)) parts.push(agent + "=" + model + "（钉死）");
  }
  return parts.join("  ");
}

/**
 * 开跑前实测每条车道（v3 3 的教训）：分档是快照，nvidia/meta/muse-glimmer-30b 从 2.8s 劣化到
 * 12~180s，光看榜单会把它排第一。所以这里用 1-token ping 实测一遍，慢的/挂的沉底 ——
 * 只有车道数 > agent 数时它们才不会成为首选。
 */
export async function probeLanes(lanes: Lane[], timeoutMs = Number(process.env.KEYPOOL_PROBE_MS ?? 12_000)): Promise<Lane[]> {
  let base = process.env.LLM_BASE_URL ?? "http://127.0.0.1:3131/v1";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const token = process.env.KEYPOOL_PROXY_TOKEN ?? process.env.LLM_API_KEY ?? "";
  await Promise.all(lanes.map(async (lane) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ model: lane.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: ctrl.signal,
      });
      lane.probeMs = Date.now() - t0;
      lane.probeOk = res.ok;
      if (!res.ok) await res.text().catch(() => "");
    } catch (error) {
      lane.probeMs = Date.now() - t0;
      lane.probeOk = false;
    } finally {
      clearTimeout(timer);
    }
  }));
  return lanes.sort((a, b) => {
    const da = denyList.some((d) => a.model.includes(d)) ? 1 : 0;
    const db = denyList.some((d) => b.model.includes(d)) ? 1 : 0;
    if (da !== db) return da - db;
    const sa = a.probeOk ? 0 : 1;
    const sb = b.probeOk ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.probeMs ?? 9e9) - (b.probeMs ?? 9e9) || b.score - a.score;
  });
}
