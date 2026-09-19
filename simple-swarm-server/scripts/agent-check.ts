/*
 * 智能体循环自检（M4 + M5）。
 *
 * 这段检查回答一个问题：**"系统真的活了吗？"**
 *   - 智能体之间真的在通信（不是播种时编的）
 *   - 认领会撞车，撞车会记账（first-wins）
 *   - 收工会真的收工，全员收工 → 集群完成
 *   - 每一步都记账，账本（JSONL）折出来的数 == 接口投影出来的数
 *   - 花超预算会自己刹车
 *
 * 用法：先 npm start，再 npm run agent-check
 */
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../src/agent/runner.ts";
import { MockBrain } from "../src/agent/brain.ts";
import { TOKEN_RATE_PER_MTOK, usdForTokens } from "../src/config.ts";
import { EventStore } from "../src/eventstore.ts";
import { addressOf } from "../src/mail.ts";
import { seedSwarm } from "./fixture.ts";
import { clock } from "../src/time.ts";
import type { AgentInfo, SwarmData, SwarmEvent } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API ?? "http://127.0.0.1:8787";
/* 账本目录必须跟后端一致：后端认 SWARM_HOME，自检也得认。
 * 否则「拿临时后端跑自检」时这里会去读真实 data/ 的老账 → 数字翻倍（踩过）。 */
const DATA = path.resolve(process.env.SWARM_HOME ?? path.join(here, "../data"));
const TMP = path.resolve(here, "../data-agent-tmp");

/*
 * 护栏：本文件会打 live 接口（POST /run 是真的跑一整轮）。
 * 后端要是跑在真模型模式，这一跑就是**真的调模型、真的花钱**，而且十几轮根本跑不完。
 * 以前 MOCK_LLM=0 时这个接口直接 501，现在接口真能跑了 —— 所以必须先确认后端的模式。
 */
{
  const health = await fetch(`${BASE}/api/health`)
    .then((response) => response.json() as Promise<{ ok?: boolean; mockLlm?: boolean }>)
    .catch(() => null);
  if (health !== null && health.ok === true && health.mockLlm === false) {
    console.error("❌ 后端正跑在真模型模式（MOCK_LLM=0），自检会真的调模型、真的花钱。");
    console.error("   请先用 mock 模式重启后端（MOCK_LLM=1 或去掉 MOCK_LLM=0）再跑自检。");
    process.exit(1);
  }
}

let pass = 0;
let fail = 0;
const eq = (label: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

const req = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const newSwarm = async (name: string, budget: number, agentCount: number): Promise<SwarmData> => {
  const created = await req("POST", "/api/swarms", {
    goal: `自检用集群：${name}。DoD：跑完、有通信、有认领、能收工。`,
    name,
    budget,
    agentCount,
  });
  if (created.status !== 201) throw new Error(`建集群失败：${created.status} ${JSON.stringify(created.body)}`);
  return created.body.swarm as SwarmData;
};

/** 把账本 JSONL 全读出来（用它来验"投影 == 账本折叠"，这是最重要的一条不变式） */
const readLedgerRaw = async (): Promise<{ events: SwarmEvent[]; lines: number }> => {
  const files = (await readdir(DATA)).filter((file) => file.startsWith("events-") && file.endsWith(".jsonl")).sort();
  const events: SwarmEvent[] = [];
  let lines = 0;
  for (const file of files) {
    const text = await readFile(path.join(DATA, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        events.push(JSON.parse(line) as SwarmEvent);
      } catch {
        /* 半截行：跳过 */
      }
    }
  }
  return { events, lines };
};

/**
 * 读账本前先等它落盘。
 *
 * 事件是**异步**写文件的（内存投影立刻更新，JSONL 排队写）。一开始没等，
 * 结果读到半截账本，自检报了一堆假失败（"通信是假的""收工 0 次"）。
 * 判据用 health.events（服务端内存里的事件总数）—— 文件行数追平它才算写完。
 */
const readLedger = async (): Promise<SwarmEvent[]> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const health = (await req("GET", "/api/health")).body as { events: number };
    const { events, lines } = await readLedgerRaw();
    if (lines >= health.events) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("账本落盘超时：文件行数追不上 health.events");
};

/* ================= 1. 一套智能体真的跑起来 ================= */
console.log("\n[1] 三个智能体真的跑一轮");

const swarm = await newSwarm("Agent Check", 5, 3);
eq("新集群初始为 pending", swarm.state, "pending");
check("新集群的认领板是空的（工作由 agent 自己发布）", Array.isArray(swarm.slices) && swarm.slices.length === 0, JSON.stringify(swarm.slices));
eq("新集群花费从 0 开始", swarm.cost, 0);

eq("未启动时不能跑", (await req("POST", `/api/swarms/${swarm.id}/run`, {})).status, 409);
eq("启动集群", (await req("POST", `/api/swarms/${swarm.id}/start`, {})).status, 200);

const run1 = (await req("POST", `/api/swarms/${swarm.id}/run`, { maxTurns: 16, maxMails: 5 })).body;
eq("一轮跑完 → 全员收工", run1.stoppedBy, "all-done");
check("真的走了不止一步", run1.steps > 3, `steps=${run1.steps}`);
check("真的发了信", run1.mails >= 3, `mails=${run1.mails}`);
check("三个智能体都动过", Object.keys(run1.turns).length === 3, JSON.stringify(run1.turns));
check("每个智能体都收工了", run1.report.filter((step: any) => step.done).length === 3);
check("每一步都有工具名", run1.report.every((step: any) => typeof step.tool === "string" && step.tool.length > 0));

const after1 = (await req("GET", `/api/swarms/${swarm.id}`)).body as SwarmData;
eq("全员收工 → 集群完成", after1.state, "done");
check("花费 > 0", after1.cost > 0, `cost=${after1.cost}`);
check("token > 0", after1.tokens > 0);
eq("调用次数 = 步数", after1.calls, run1.steps);

/* ================= 2. 通信是真的（不是播种编的） ================= */
console.log("\n[2] 通信是真的");

const ledger = await readLedger();
const mine = ledger.filter((event) => {
  const id = (event as any).swarmId ?? (event as any).mail?.swarmId ?? (event as any).event?.swarmId;
  return id === swarm.id;
});
const mails = mine.filter((event) => event.type === "mail.sent").map((event: any) => event.mail);
check("账本里有这个集群的信", mails.length >= 3, `${mails.length} 封`);

const senders = new Set(mails.map((mail: any) => mail.from.replace(`@${swarm.id}.swarm`, "")));
check("至少两个不同的智能体发过信", senders.size >= 2, JSON.stringify([...senders]));

const replies = mails.filter((mail: any) => mail.replyTo);
check("存在真正的回信（replyTo 非空）", replies.length >= 1, `${replies.length} 封`);
/* 闸 1：回信必须只发给原发件人一个人 */
check(
  "每封回信都只发给一个人（没有 reply-all）",
  replies.every((mail: any) => mail.to.length === 1),
  JSON.stringify(replies.map((mail: any) => mail.to)),
);
/* 别名信：all@ 会展开给所有人，且带 broadcast 标记 */
const broadcasts = mails.filter((mail: any) => mail.to.some((to: string) => to.startsWith("all@")));
check("存在广播", broadcasts.length >= 1, `${broadcasts.length} 封`);

/* ================= 3. 认领与撞车 ================= */
console.log("\n[3] 认领与撞车");

const claims = mine.filter((event) => event.type === "claim.taken").map((event: any) => event.slice);
const collisions = mine.filter((event) => event.type === "collision.detected").map((event: any) => event);
check("有切片被认领", claims.length >= 3, JSON.stringify(claims));
check("三个人认领到的是不同的片", new Set(claims).size === claims.length, JSON.stringify(claims));
check("撞车被记了账（first-wins）", collisions.length >= 1, `${collisions.length} 次`);
check(
  "每次撞车都记了持有者",
  collisions.every((event: any) => Array.isArray(event.holders) && event.holders.length >= 2),
  JSON.stringify(collisions.map((event: any) => event.holders)),
);
check(
  "撞车的那片最终归先来的那个人",
  collisions.every((event: any) => {
    const taken = mine.find((item: any) => item.type === "claim.taken" && item.slice === event.slice);
    return taken !== undefined && event.holders.includes(taken.agent);
  }),
);
eq("每人收工恰好一次", mine.filter((event) => event.type === "agent.done").length, 3);
eq("集群完成恰好一次", mine.filter((event) => event.type === "swarm.completed").length, 1);

/* ================= 4. 记账：接口的数 == 账本折出来的数 ================= */
console.log("\n[4] 记账对得上（M5）");

const usages = mine.filter((event) => event.type === "usage.recorded").map((event: any) => event);
eq("每一步都记了账", usages.length, run1.steps);
check(
  "每条记账的 cost = token × 换算率",
  usages.every((usage: any) => usage.cost === usdForTokens(usage.tokens)),
  `换算率 ${TOKEN_RATE_PER_MTOK} 美元/百万 token`,
);
check(
  "每条记账的 tokens = 四项之和",
  usages.every((usage: any) => usage.tokens === usage.readTokens + usage.writeTokens + usage.cacheRead + usage.cacheWrite),
);

const sumTokens = usages.reduce((total: number, usage: any) => total + usage.tokens, 0);
const sumCost = Math.round(usages.reduce((total: number, usage: any) => total + usage.cost, 0) * 1e6) / 1e6;
check("集群 token 总数 == 账本求和", after1.tokens === sumTokens, `接口 ${after1.tokens} vs 账本 ${sumTokens}`);
check("集群花费 == 账本求和", Math.abs(after1.cost - sumCost) < 1e-6, `接口 ${after1.cost} vs 账本 ${sumCost}`);

const agents = (await req("GET", "/api/agents")).body as AgentInfo[];
for (const name of Object.keys(run1.turns)) {
  const agent = agents.find((item) => item.name === name);
  const own = usages.filter((usage: any) => usage.agent === name);
  check(
    `${name} 的花费与账本一致`,
    agent !== undefined && Math.abs(agent.cost - Math.round(own.reduce((t: number, u: any) => t + u.cost, 0) * 1e6) / 1e6) < 1e-6,
  );
  eq(`${name} 的调用次数 = 自己的步数`, agent?.calls, own.length);
  eq(`${name} 已收工（live=false）`, agent?.live, false);
}

/* ================= 5. 熔断：花超了自己停 ================= */
console.log("\n[5] 预算熔断");

const poor = await newSwarm("Poor Swarm", 0.02, 3);
await req("POST", `/api/swarms/${poor.id}/start`, {});
const run2 = (await req("POST", `/api/swarms/${poor.id}/run`, { maxTurns: 20, maxMails: 9 })).body;
eq("跑爆预算 → stoppedBy=budget", run2.stoppedBy, "budget");
check("没跑满轮数就停了", run2.steps < 20, `steps=${run2.steps}`);
check("花费确实越过了上限（先检查后花钱，允许小幅超出）", run2.spend >= poor.budget, `花 ${run2.spend} / 上限 ${poor.budget}`);
check("超出的幅度 < 一步的钱（没有失控）", run2.spend - poor.budget < run2.report[0].cost * 3);

const after2 = (await req("GET", `/api/swarms/${poor.id}`)).body as SwarmData;
eq("集群被置为 stopped", after2.state, "stopped");
const ledger2 = await readLedger();
const stopped = ledger2.filter((event: any) => event.type === "swarm.stopped" && event.swarmId === poor.id);
eq("落了恰好一条停止事件", stopped.length, 1);
check("停止原因写清了预算", String((stopped[0] as any)?.reason ?? "").includes("预算"), String((stopped[0] as any)?.reason ?? ""));

/* 停下之后再跑一次：接口直接拒绝，一分钱都不再花 */
const rerun = await req("POST", `/api/swarms/${poor.id}/run`, { maxTurns: 20 });
eq("已停的集群不能再跑（接口拒绝）", rerun.status, 409);
const after3 = (await req("GET", `/api/swarms/${poor.id}`)).body as SwarmData;
eq("没有多花一分钱", after3.cost, after2.cost);

/* ================= 6. 智能体绕不过防风暴闸（临时库） ================= */
console.log("\n[6] 智能体的发信和人类走同一套闸门（临时事件库）");

await rm(TMP, { recursive: true, force: true });
const temp = new EventStore(TMP);
await temp.load();
/* 自建一个集群（走真实 createSwarm），不再依赖演示种子 */
const victim = seedSwarm(temp, { id: "storm-victim", agents: ["tally", "span", "loom"] });
const VICTIM = victim.swarm.id;
eq("临时库里建好了集群", temp.getSwarm(VICTIM) !== undefined, true);
temp.append({ type: "swarm.started", swarmId: VICTIM, time: clock() });

/* 先把这个集群灌到"一分钟内 300 封"——风暴闸 5 的阈值 */
const stuffer = temp.getSwarm(VICTIM)!.agents.find((name) => name !== "system")!;
for (let index = 0; index < 300; index += 1) {
  temp.append({
    type: "mail.sent",
    mail: {
      id: `stuff-${index}`,
      swarmId: VICTIM,
      from: addressOf(stuffer, VICTIM),
      to: [`${stuffer}@${VICTIM}.swarm`],
      cc: [],
      subject: "",
      body: "灌数据：把集群推到风暴阈值",
      chars: 12,
      kind: "agent",
      threadId: `${VICTIM}/primary`,
      replyTo: "",
      time: clock(),
    },
  });
}
eq("灌到阈值：集群每分钟发信数 ≥ 300", temp.recentSendCount(VICTIM, null, 60) >= 300, true);

const stormRunner = new AgentRunner({
  store: temp,
  swarmId: VICTIM,
  slices: temp.getSwarm(VICTIM)!.slices,
  brain: new MockBrain(),
  maxTurns: 4,
  maxSparkMails: 5,
  tokensPerTurn: 1000,
});
const stormRun = await stormRunner.run();
eq("智能体一发信就撞上风暴闸 → 整个循环停下", stormRun.stoppedBy, "swarm-stopped");
eq("集群被按停", temp.getSwarm(VICTIM)?.state, "stopped");
check("按停之后没有再多走很多步", stormRun.steps <= 3, `steps=${stormRun.steps}`);
const paused = temp.listEvents().filter((event) => event.type === "swarm.paused");
eq("风暴事件落了一条（且只一条）", paused.length, 1);
/* run() 现在是异步的：删目录前必须等事件库的落盘队列排空，
   否则 appendFile 会在 rm 之后又把文件写回来 → ENOTEMPTY */
await temp.flush();
await rm(TMP, { recursive: true, force: true });

/* ================= 7. 防风暴闸门没有被绕过 ================= */
console.log("\n[7] 智能体也得守防风暴的规矩");

const agentMails = new Map<string, number>();
for (const mail of mails) {
  const from = mail.from;
  agentMails.set(from, (agentMails.get(from) ?? 0) + 1);
}
check(
  "没有智能体超过每轮上限（maxMails=5，加上 system 的目标信）",
  [...agentMails.values()].every((count) => count <= 6),
  JSON.stringify([...agentMails.entries()]),
);
const limited = mine.filter((event) => event.type === "mail.rate_limited");
eq("正常小规模运行不该触发每分钟限流", limited.length, 0);

console.log(
  `\n${fail === 0 ? "✅ 智能体循环自检全部通过" : "❌ 智能体循环自检有失败"}  （${pass} 通过 / ${fail} 失败）`,
);
process.exit(fail === 0 ? 0 : 1);
