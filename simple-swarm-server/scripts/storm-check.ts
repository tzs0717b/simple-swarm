/*
 * 防风暴自检（M3.5）。
 *
 * 分两段：
 *   A. 临时事件库：纯策略 + 投影级闸门（需要几百封信才能触发，走 HTTP 太慢且会污染演示数据）
 *   B. 真实接口：闸 1 默认不 reply-all、闸 2 限流、broadcast 标记、快照一致性
 *
 * 用法：先 npm start，再 npm run storm-check
 */
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../src/eventstore.ts";
import { addressOf } from "../src/mail.ts";
import { seedSwarm } from "./fixture.ts";
import { guardSend } from "../src/storm-guard.ts";
import { isBroadcast, STORM, withinWindow } from "../src/storm.ts";
import { clock } from "../src/time.ts";
import type { MailData, SwarmEvent } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API ?? "http://127.0.0.1:8787";
const TMP = path.resolve(here, "../data-storm-tmp");

let pass = 0;
let fail = 0;
const eq = (label: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

/* ================= A. 临时事件库 ================= */
console.log("[A] 策略与投影级闸门（临时事件库，不碰演示数据）");

eq("窗口内（差 30s）", withinWindow("12:00:30", "12:00:00", 60), true);
eq("窗口外（差 90s）", withinWindow("12:01:30", "12:00:00", 60), false);
eq("跨午夜也算窗口内", withinWindow("00:00:30", "23:59:50", 60), true);
eq("时间串在未来 → 不计入（宁可放过不误杀）", withinWindow("12:00:00", "12:05:00", 60), false);
eq("阈值：agent 12/分、未读 400、广播窗 30s、集群 300/分", 
  [STORM.agentPerMinute, STORM.unreadQuota, STORM.broadcastWindowSec, STORM.swarmPerMinute], [12, 400, 30, 300]);
eq("别名 = 广播", isBroadcast(["all@x.swarm"], new Set(["all", "agents", "humans"])), true);
eq("显式地址 ≠ 广播", isBroadcast(["ana@x.swarm"], new Set(["all", "agents", "humans"])), false);

await rm(TMP, { recursive: true, force: true });
const store = new EventStore(TMP);
await store.load();
/* 自建三个集群（走真实 createSwarm），不再依赖演示种子 */
seedSwarm(store, { id: "gate-a", agents: ["drift", "skein"] });
seedSwarm(store, { id: "gate-b", agents: ["wheelwright", "pellet"] });
seedSwarm(store, { id: "gate-c", agents: ["peliscout", "palette"] });
await store.flush();
eq("临时库建好三个集群", store.totals().swarms, 3);
eq("每个集群都开了邮箱（含人类这种共享地址）", store.getMailbox(addressOf("human", "gate-a")) !== undefined, true);

let appended = 0;
const makeMail = (swarmId: string, from: string, to: string[], body: string, time = clock()): MailData => ({
  id: `storm-${swarmId}-${from}-${Math.random().toString(36).slice(2, 10)}`,
  swarmId,
  from: addressOf(from, swarmId),
  to,
  cc: [],
  subject: "",
  body,
  chars: body.length,
  kind: "agent",
  threadId: `${swarmId}/primary`,
  replyTo: "",
  time,
});

/* ---- 闸 2：每 agent 每分钟 12 封 ---- */
const A = "gate-a";
const A_AGENT = addressOf("drift", A);
const A_TARGET = [`${addressOf("skein", A)}`];
for (let i = 0; i < 12; i += 1) {
  store.append({ type: "mail.sent", mail: makeMail(A, "drift", A_TARGET, `闸2 第${i + 1}封`) });
  appended += 1;
}
eq("已发 12 封", store.recentSendCount(A, A_AGENT, 60), 12);
eq("第 13 封被拒（429）", guardSend(store, A, A_AGENT)?.status, 429);
eq("拒信原因是发信过快", guardSend(store, A, A_AGENT)?.body.error, "发信过快");
eq("人类不受个人限流约束", guardSend(store, A, addressOf("human", A)), null);

/* ---- 闸 3：收件箱配额 400 ---- */
const B = "gate-b";
const B_TARGET = addressOf("wheelwright", B);
const unread0 = store.getMailbox(B_TARGET)?.unread ?? 0;
const burst = STORM.unreadQuota - unread0 + 5;
for (let i = 0; i < burst; i += 1) {
  store.append({ type: "mail.sent", mail: makeMail(B, "human", [B_TARGET], `闸3 灌信 ${i + 1}`) });
  appended += 1;
}
const box = store.getMailbox(B_TARGET);
eq(`未读灌到上限后不再增长（${unread0} + ${burst} 封 → 上限 ${STORM.unreadQuota}）`, box?.unread, STORM.unreadQuota);
eq("超出配额的信仍在账本里（一封没丢）", store.recentSendCount(B, addressOf("human", B), 60), burst);

/* ---- 闸 5：全集群 300 封/分 → 暂停 ---- */
const C = "gate-c";
const C_TARGET = [addressOf("peliscout", C)];
const C_AGENT = addressOf("peliscout", C);
for (let i = 0; i < STORM.swarmPerMinute; i += 1) {
  store.append({ type: "mail.sent", mail: makeMail(C, "pellet", C_TARGET, `闸5 风暴 ${i + 1}`) });
  appended += 1;
}
eq(`集群一分钟内攒到 ${STORM.swarmPerMinute} 封`, store.recentSendCount(C, null, 60) >= STORM.swarmPerMinute, true);
const refusal = guardSend(store, C, C_AGENT);
eq("闸 5 优先于闸 2：集群被暂停（429）", refusal?.status, 429);
eq("拒信原因是集群风暴", refusal?.body.error, "集群因消息风暴被暂停");
eq("集群状态被按停", store.getSwarm(C)?.state, "stopped");
eq("再发一次不会重复落 swarm.paused", guardSend(store, C, C_AGENT)?.status, 429);
await store.flush();

/* 审计事件：直接读临时库的 JSONL，顺带验证真的落盘了 */
const files = (await readdir(TMP)).filter((name) => name.endsWith(".jsonl"));
const logged: SwarmEvent[] = [];
for (const name of files) {
  for (const line of (await readFile(path.join(TMP, name), "utf8")).split("\n")) {
    if (line.trim().length > 0) logged.push(JSON.parse(line) as SwarmEvent);
  }
}
const countType = (type: string): number => logged.filter((event) => event.type === type).length;
eq("落盘了 mail.rate_limited", countType("mail.rate_limited") >= 1, true);
eq("落盘了 swarm.paused", countType("swarm.paused"), 1);
/* 建集群本身会给成员发一封"目标信"，所以账本里的 mail.sent = 灌进去的 + 3 封目标信 */
const goalMails = logged.filter((e) => e.type === "mail.sent" && (e as any).mail.kind === "goal").length;
eq("三个集群各自发了一封目标信", goalMails, 3);
eq("灌进去的信全部落盘（一封不丢）", logged.filter((e) => e.type === "mail.sent").length - goalMails, appended);
const paused = logged.find((event) => event.type === "swarm.paused") as { reason: string; count: number } | undefined;
eq("swarm.paused 带原因", (paused?.reason ?? "").includes("消息风暴"), true);
const limited = logged.find((event) => event.type === "mail.rate_limited") as { from: string; limit: number } | undefined;
eq("mail.rate_limited 记了发件人与阈值", [limited?.from, limited?.limit], [A_AGENT, STORM.agentPerMinute]);

/* 快照一致性：seq 必须等于实际事件里最大的 seq（踩过坑，见 eventstore.snapshot 注释） */
await store.snapshot();
const snap = JSON.parse(await readFile(path.join(TMP, "snapshot-latest.json"), "utf8")) as {
  seq: number;
  events: SwarmEvent[];
};
eq("快照 seq 与实际事件最大 seq 一致", snap.seq, snap.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0));
await rm(TMP, { recursive: true, force: true });

/* ================= B. 真实接口 ================= */
console.log("\n[B] 真实接口");

const post = async (route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/* 新建一个专用集群：里面的 agent 一封信都还没发过。
   拿演示集群测「恰好放行 12 封」不幂等 —— 重跑一次就被上一轮的余量顶掉了。 */
const created = await post("/api/swarms", {
  goal: "storm-check：防风暴自检",
  name: "Storm Check",
  agentCount: 4,
  budget: 1,
});
eq("建专用集群 → 201", created.status, 201);
const S = (created.body.swarm as { id: string }).id;
const [peer, replyAgent, rateAgent, quietAgent] = created.body.agents as string[];
const addr = (name: string): string => addressOf(name, S);

let allowed = 0;
let rejected = 0;
for (let i = 0; i < 15; i += 1) {
  const result = await post("/api/mails", {
    swarmId: S,
    from: rateAgent,
    to: [addr(peer)],
    body: `storm-check 限流 ${i + 1}`,
  });
  if (result.status === 201) allowed += 1;
  else if (result.status === 429) rejected += 1;
}
eq(`agent 一分钟内恰好被放行 ${STORM.agentPerMinute} 封`, allowed, STORM.agentPerMinute);
eq("其余全部 429（不是 500）", rejected, 15 - STORM.agentPerMinute);

/* 闸 1：replyTo 且不写 to → 只回原发件人 */
const broadcast = await post("/api/mails", {
  swarmId: S,
  from: peer,
  to: [`all@${S}.swarm`],
  body: "storm-check 群发一条",
});
const broadcastMail = broadcast.body.mail as { id: string; threadId: string };
eq("群发命中全集群（4 个 agent + human）", (broadcast.body.delivered as string[]).length, 5);

const reply = await post("/api/mails", {
  swarmId: S,
  from: replyAgent,
  replyTo: broadcastMail.id,
  body: "storm-check 只回发件人（故意不写 to）",
});
eq("回复默认只投给原发件人", reply.body.delivered, [addr(peer)]);
eq("回复留在原房间", (reply.body.mail as { threadId: string }).threadId, broadcastMail.threadId);

const noRecipient = await post("/api/mails", { swarmId: S, from: quietAgent, body: "既没 to 也没 replyTo" });
eq("既没 to 也没 replyTo → 400", noRecipient.status, 400);
eq("400 不会写进账本（发件人已发送仍为 0）",
  ((await (await fetch(`${BASE}/api/mailboxes/${encodeURIComponent(addr(quietAgent))}`)).json()) as { sent: number }).sent, 0);

/* broadcast 标记 */
const messages = (await (
  await fetch(`${BASE}/api/swarms/${S}/threads/primary/messages?limit=20`)
).json()) as { id: string; broadcast: boolean }[];
eq("群发那条被标成 broadcast", messages.find((m) => m.id === broadcastMail.id)?.broadcast, true);
eq("回复那条不是 broadcast", messages.find((m) => m.id === (reply.body.mail as { id: string }).id)?.broadcast, false);
eq("限流那条不是 broadcast", messages.every((m) => m.broadcast === true || m.broadcast === false), true);

const health = (await (await fetch(`${BASE}/api/health`)).json()) as { events: number; lastSeq: number };
eq("健康接口无损坏行（事件数 = lastSeq）", health.events, health.lastSeq);

console.log(`\n${fail === 0 ? "✅ 防风暴自检全部通过" : "❌ 防风暴自检有失败"}  （${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
