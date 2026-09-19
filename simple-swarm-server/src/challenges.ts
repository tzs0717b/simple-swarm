/*
 * 质疑（challenge）：agent 之间的公开质询，也包括对**派工员**的质询。
 *
 * 动机（2026-09-19 复盘 pelican-45b）：
 *   agent 手里实际只有「120 字的目标（goalOf 截断）+ 自己的片名」，
 *   所以派工员写下的片名就是这个去中心化集群唯一的协调媒介，也是唯一的单点。
 *   片切粗了（保底切法那种「主要运动动画 1：主体最核心的那个动作」），
 *   全队就会各交一摊碎片 —— 而这轮没有任何补偿机制。
 *
 * 于是加一条**可纠错通道**：任何 agent 都能质疑派工员的板、也能质疑同伴的交付。
 * 三件事让它有牙齿（而不是变成闲聊）：
 *   1. 必须带证据（命令/数字/文件加行号），空口质疑直接拒收；
 *   2. 被质疑者**必须回应**，超过 SWARM_CHALLENGE_GRACE_MS 无人回应 → 沉默即认账，按成立处理；
 *   3. 第三方裁决（既不是质疑者也不是被质疑者），成立会**真的改板**：重开那片、或按质疑者的
 *      ask 在板上新增一片（这就是「质疑派工员」的落地方式）。
 *
 * 反作弊：每人 SWARM_CHALLENGE_QUOTA 次配额，被驳回扣一格（成立不扣）；
 * 同一目标 + 同一主张去重，防止复读刷屏。
 */
import { sendMail } from "./send.ts";
import { clock } from "./time.ts";
import type { EventStore } from "./eventstore.ts";
import type { ChallengeInfo } from "./types.ts";

const QUOTA = Math.max(1, Number(process.env.SWARM_CHALLENGE_QUOTA ?? 3));
const GRACE_MS = Math.max(1_000, Number(process.env.SWARM_CHALLENGE_GRACE_MS ?? 360000));

const KIND_LABEL: Record<string, string> = {
  slicer: "派工不当（片切得不对）",
  artifact: "产物不合规",
  evidence: "交付说明与事实不符",
  duplicate: "重复劳动",
};

function nowIso(): string {
  /* 和账本其余事件同一口径（time.ts 的 clock 在 mock 模式下是虚拟时钟） */
  return clock();
}

function freeChars(): string {
  return String.fromCharCode(10);
}

/** 某人还剩几次质疑配额（成立不扣、被驳回扣一格）。 */
export function challengeQuotaLeft(store: EventStore, swarmId: string, agent: string): number {
  const used = store
    .listChallenges(swarmId)
    .filter((c) => c.by === agent && c.status === "dismissed").length;
  return Math.max(0, QUOTA - used);
}

/** 板上/上下文用的质疑清单文案。 */
export function challengeBoard(store: EventStore, swarmId: string, agent: string): string {
  const mine = store.openChallengesFor(swarmId, agent);
  const all = store.listChallenges(swarmId);
  const BR = freeChars();
  const lines: string[] = [];
  if (mine.length > 0) {
    lines.push("【有人质疑你，必须在 " + Math.round(GRACE_MS / 60000) + " 分钟内用 respond_challenge 回应（不回应视为你认账）】");
    for (const c of mine.slice(0, 4)) {
      lines.push("  · #" + c.id.slice(0, 6) + " " + c.by + " 质疑你：" + c.claim);
      lines.push("    他要求：" + c.ask + "（证据：" + c.evidence.slice(0, 80) + "）");
    }
  }
  const recent = all.filter((c) => c.status === "upheld").slice(-3);
  if (recent.length > 0) {
    lines.push("【最近成立的质疑（板子因此改过）】");
    for (const c of recent) lines.push("  · " + c.by + " 质疑 " + c.target + "：" + c.claim.slice(0, 70) + " → 成立");
  }
  return lines.join(BR);
}

export interface RaiseInput {
  swarmId: string;
  by: string;
  target: string;
  kind: string;
  slice?: string;
  claim: string;
  evidence: string;
  ask: string;
}

export function raiseChallenge(store: EventStore, input: RaiseInput): { ok: boolean; message: string } {
  const target = input.target.trim();
  const claim = input.claim.trim();
  const evidence = input.evidence.trim();
  const ask = input.ask.trim();
  const kind = (input.kind.trim() || "artifact") as ChallengeInfo["kind"];
  const slice = (input.slice ?? "").trim();

  if (!KIND_LABEL[kind]) {
    return { ok: false, message: "质疑失败：kind 只能是 slicer / artifact / evidence / duplicate。" };
  }
  if (target.length === 0) return { ok: false, message: "质疑失败：没写质疑谁（target）。" };
  if (claim.length === 0) return { ok: false, message: "质疑失败：没写主张（claim：你认为哪里不对）。" };
  if (ask.length === 0) return { ok: false, message: "质疑失败：没写你要对方做什么（ask）。质疑要有可执行的落点。" };
  if (evidence.length < 8) {
    return {
      ok: false,
      message: "质疑失败：证据太薄（evidence）。贴一条能核对的证据 —— 命令、实测数字、文件加行号。空口质疑不受理。",
    };
  }

  const swarm = store.getSwarm(input.swarmId);
  if (!swarm) return { ok: false, message: "质疑失败：集群不存在。" };

  /* 被质疑者存在性：agent 裸名 / slicer（派工员切的板）/ all（全队） */
  if (target !== "slicer" && target !== "all") {
    const names = (swarm.agents ?? []).map((a) => (typeof a === "string" ? a : a.name));
    if (!names.includes(target)) {
      return { ok: false, message: "质疑失败：查无此人「" + target + "」。可用 respond 前先 read_inbox 看看到底是谁；质疑派工员写 target=slicer。" };
    }
  }
  const left = challengeQuotaLeft(store, input.swarmId, input.by);
  if (left <= 0) {
    return {
      ok: false,
      message: "质疑失败：你的质疑配额用完了（被驳回 " + String(QUOTA) + " 次）。先把活干完，别再刷质疑。",
    };
  }
  const dup = store
    .listChallenges(input.swarmId)
    .find((c) => c.by === input.by && c.target === target && c.slice === slice && c.claim.slice(0, 24) === claim.slice(0, 24));
  if (dup) {
    return { ok: false, message: "质疑失败：你已经提过一模一样的质疑（#" + dup.id.slice(0, 6) + "，状态 " + dup.status + "）。别复读。" };
  }

  const challenge: ChallengeInfo = {
    id: "ch_" + Math.random().toString(36).slice(2, 10),
    swarmId: input.swarmId,
    by: input.by,
    target,
    kind,
    slice,
    claim,
    evidence,
    ask,
    status: "open",
    response: "",
    responseEvidence: "",
    ruledBy: "",
    verdict: "",
    time: nowIso(),
    raisedAt: Date.now(),
  };
  store.append({ type: "challenge.raised", swarmId: input.swarmId, challenge });
  store.append({
    type: "trace.appended",
    swarmId: input.swarmId,
    event: {
      swarmId: input.swarmId,
      agent: input.by,
      type: "challenge",
      detail: "质疑 " + target + "（" + KIND_LABEL[kind] + "）：" + claim.slice(0, 60),
      ms: 0,
      status: "open",
    },
  });

  const BR = freeChars();
  const toAddr = target === "slicer" ? ["all"] : target === "all" ? ["all"] : [target];
  sendMail(store, {
    swarmId: input.swarmId,
    from: "system",
    to: toAddr,
    cc: ["all"],
    subject: "【质疑 #" + challenge.id.slice(0, 6) + "】" + input.by + " 质疑 " + target + "：" + claim.slice(0, 40),
    body:
      "【质疑 #" + challenge.id.slice(0, 6) + "】" + BR +
      "· 质疑者：" + input.by + BR +
      "· 被质疑：" + target + "（" + KIND_LABEL[kind] + "）" + (slice ? "，相关片：「" + slice + "」" : "") + BR +
      "· 主张：" + claim + BR +
      "· 证据：" + evidence + BR +
      "· 要求：" + ask + BR + BR +
      (target === "slicer"
        ? "派工员的板子有异议 —— 全队都可以来裁决（rule_challenge）：说得对就改板，说的不对就驳回。" + BR
        : target + " 必须在 " + String(Math.round(GRACE_MS / 60000)) + " 分钟内用 respond_challenge 回应（不回应 = 认账，质疑自动成立并改板）。" + BR) +
      "任何人都可以裁决（rule_challenge，#" + challenge.id.slice(0, 6) + "），但**质疑者和被质疑者自己的裁决不算** —— 必须找第三方。" + BR +
      "裁决成立后系统会真的改板：重开那片，或按质疑者的要求新增一片。",
    kind: "verify",
  });
  return {
    ok: true,
    message:
      "质疑 #" + challenge.id.slice(0, 6) + " 已立案并广播全队（对象：" + target + "）。" +
      (target === "slicer"
        ? "派工员的板子被质疑后，任何人都能裁决；成立则按你的 ask 新增一片。"
        : "对方必须在 " + String(Math.round(GRACE_MS / 60000)) + " 分钟内回应，不回应视为认账。") +
      "你还有 " + String(left) + " 次配额（被驳回才扣）。",
  };
}

export function answerChallenge(
  store: EventStore,
  input: { swarmId: string; id: string; agent: string; response: string; evidence?: string },
): { ok: boolean; message: string } {
  const c = store.listChallenges(input.swarmId).find((x) => x.id === input.id || x.id.slice(0, 6) === input.id);
  if (!c) return { ok: false, message: "回应失败：找不到质疑 " + input.id + "。" };
  if (c.status !== "open") return { ok: false, message: "这条质疑已经不是待回应状态（" + c.status + "），不用再回。" };
  if (input.agent !== c.target) {
    return { ok: false, message: "回应失败：这条质疑是 " + c.by + " 质疑 " + c.target + " 的，你不是被质疑者。有不同意见请自己提一条（challenge），或去裁决（rule_challenge）。" };
  }
  const response = input.response.trim();
  if (response.length === 0) return { ok: false, message: "回应失败：没写回应内容。" };
  const next: ChallengeInfo = {
    ...c,
    status: "answered",
    response,
    responseEvidence: (input.evidence ?? "").trim(),
    time: nowIso(),
  };
  store.append({ type: "challenge.answered", swarmId: input.swarmId, challenge: next });
  sendMail(store, {
    swarmId: input.swarmId,
    from: "system",
    to: [c.by],
    cc: ["all"],
    subject: "【质疑 #" + c.id.slice(0, 6) + "】" + c.target + " 已回应",
    body: "【" + c.target + " 的回应】" + freeChars() + response + freeChars() + freeChars() +
      (next.responseEvidence ? "· 他给的证据：" + next.responseEvidence + freeChars() : "") +
      freeChars() + "现在需要第三方裁决（rule_challenge #" + c.id.slice(0, 6) + "，verdict=upheld/dismissed）—— " + c.by + " 和 " + c.target + " 自己都不能判。",
    kind: "verify",
  });
  return { ok: true, message: "已回应质疑 #" + c.id.slice(0, 6) + "，等第三方裁决。" };
}

/** 把成立的质疑真正落到板上：重开那片 / 或按质疑者的 ask 新增一片。 */
function applyVerdict(store: EventStore, c: ChallengeInfo, reason: string): string {
  const BR = freeChars();
  if (c.target === "slicer" || (c.slice.length === 0 && c.target !== "slicer")) {
    const name = "【质疑改板】" + c.ask.slice(0, 60);
    const exists = store.listSlices(c.swarmId).some((s) => s.slice === name);
    if (!exists) {
      store.append({ type: "slice.added", swarmId: c.swarmId, slice: name, by: "challenge/" + c.by, time: nowIso() });
      return "已按质疑要求往板上新增一片：「" + name + "」" + BR;
    }
    return "板上已有这片，未重复新增。" + BR;
  }
  const info = store.sliceByName(c.swarmId, c.slice);
  if (!info) return "相关片「" + c.slice + "」不在板上，无需改动。" + BR;
  let out = "";
  if (info.status === "claimed") {
    store.append({ type: "claim.released", swarmId: c.swarmId, agent: info.claimedBy, slice: c.slice });
    out += "已释放「" + c.slice + "」（原认领人 " + info.claimedBy + "）并放回板上重做。" + BR;
  } else if (info.status === "completed") {
    store.append({ type: "claim.released", swarmId: c.swarmId, agent: info.claimedBy, slice: c.slice });
    out += "已把「" + c.slice + "」退回重做（原交付人 " + info.claimedBy + "，原证据已作废：" + info.evidence.slice(0, 60) + "）。" + BR;
  } else {
    out += "「" + c.slice + "」本来就在板上待认领。" + BR;
  }
  const add = "【返工】" + c.slice + " —— 质疑成立：" + c.ask.slice(0, 60);
  if (!store.listSlices(c.swarmId).some((s) => s.slice === add)) {
    store.append({ type: "slice.added", swarmId: c.swarmId, slice: add, by: "challenge/" + c.by, time: nowIso() });
    out += "并新增一片返工要求：「" + add + "」" + BR;
  }
  return out;
}

export function ruleChallenge(
  store: EventStore,
  input: { swarmId: string; id: string; agent: string; verdict: string; reason: string; evidence?: string },
): { ok: boolean; message: string } {
  const c = store.listChallenges(input.swarmId).find((x) => x.id === input.id || x.id.slice(0, 6) === input.id);
  if (!c) return { ok: false, message: "裁决失败：找不到质疑 " + input.id + "。" };
  if (c.status === "upheld" || c.status === "dismissed" || c.status === "expired") {
    return { ok: false, message: "这条质疑已经裁过了（" + c.status + "）。" };
  }
  const verdict = input.verdict.trim() === "upheld" ? "upheld" : input.verdict.trim() === "dismissed" ? "dismissed" : "";
  if (!verdict) return { ok: false, message: "裁决失败：verdict 只能是 upheld（质疑成立）或 dismissed（驳回）。" };
  if (input.agent === c.by || input.agent === c.target) {
    return {
      ok: false,
      message: "裁决无效：你自己既不是质疑者就是被质疑者时不能判（自审不算）。找一个第三方来 rule_challenge，或者让他看到这条消息。",
    };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: false, message: "裁决失败：没写理由（reason）—— 裁决必须给出依据与实测数字。" };

  const next: ChallengeInfo = {
    ...c,
    status: verdict,
    ruledBy: input.agent,
    verdict: reason + (input.evidence ? " ｜ 实测：" + input.evidence.trim() : ""),
    time: nowIso(),
  };
  store.append({ type: "challenge.resolved", swarmId: input.swarmId, challenge: next });
  const effect = verdict === "upheld" ? applyVerdict(store, next, reason) : "";
  store.append({
    type: "trace.appended",
    swarmId: input.swarmId,
    event: {
      swarmId: input.swarmId,
      agent: input.agent,
      type: "challenge",
      detail: "裁决 #" + c.id.slice(0, 6) + " → " + (verdict === "upheld" ? "成立" : "驳回") + "：" + reason.slice(0, 50),
      ms: 0,
      status: verdict,
    },
  });
  const BR = freeChars();
  sendMail(store, {
    swarmId: input.swarmId,
    from: "system",
    to: [c.by, c.target],
    cc: ["all"],
    subject: "【质疑 #" + c.id.slice(0, 6) + "】裁决：" + (verdict === "upheld" ? "成立" : "驳回"),
    body:
      "【裁决】" + input.agent + " 裁定 #" + c.id.slice(0, 6) + "（" + c.by + " 质疑 " + c.target + "）：" +
      (verdict === "upheld" ? "成立" : "驳回") + BR + BR +
      "· 理由：" + reason + BR +
      (input.evidence ? "· 依据：" + input.evidence.trim() + BR : "") +
      (effect ? BR + "【系统已改板】" + BR + effect : "") +
      (verdict === "dismissed" ? BR + c.by + " 因此消耗一次质疑配额。" + BR : ""),
    kind: "verify",
  });
  return {
    ok: true,
    message:
      "裁决已记录：#" + c.id.slice(0, 6) + " → " + (verdict === "upheld" ? "成立" : "驳回") + "。" +
      (effect ? "系统已改板：" + effect.replace(freeChars(), " ") : ""),
  };
}

/** 每轮扫一遍：超过宽限期没人回应的质疑 → 沉默即认账，按成立处理并生效。 */
export function sweepChallenges(store: EventStore, swarmId: string): number {
  /* 宽限期用真实 epoch 毫秒（raisedAt）计时。
     clock() 返回的是 HH:MM:SS，Date.parse 得到 NaN —— 2026-09-19 自检抓到：
     光靠 time 字段算年龄，宽限期永远不会触发。 */
  const now = Date.now();
  let n = 0;
  for (const c of store.listChallenges(swarmId)) {
    if (c.status !== "open" && c.status !== "answered") continue;
    const raised = typeof c.raisedAt === "number" ? c.raisedAt : Date.parse(String(c.time));
    if (!Number.isFinite(raised)) continue;
    if (now - raised < GRACE_MS) continue;
    const next: ChallengeInfo = {
      ...c,
      status: "expired",
      verdict: "超过 " + String(Math.round(GRACE_MS / 60000)) + " 分钟无人回应 → 沉默即认账，按成立处理",
      ruledBy: "system",
      time: clock(),
    };
    store.append({ type: "challenge.expired", swarmId, challenge: next });
    applyVerdict(store, next, next.verdict);
    store.append({
      type: "trace.appended",
      swarmId,
      event: {
        swarmId,
        agent: c.target,
        type: "challenge",
        detail: "质疑 #" + c.id.slice(0, 6) + " 超时未回应 → 按成立处理并改板",
        ms: 0,
        status: "expired",
      },
    });
    n += 1;
  }
  return n;
}
