/* WS 实时推送自检：订阅 → 触发写操作 → 确认事件被推到客户端 */
import { WebSocket } from "ws";

const BASE = process.env.API ?? "http://127.0.0.1:8787";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";

const received: string[] = [];
const socket = new WebSocket(WS_URL);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 轮询直到条件成立（自检不该赌机器快不快），最多等 timeout 毫秒 */
const waitFor = async (condition: () => boolean, timeout = 4000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await wait(50);
};

socket.on("open", () => {
  socket.send(JSON.stringify({ sub: "swarm:ws-check" }));
});

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw)) as { type: string; event?: { type: string }; lastSeq?: number; count?: number };
  if (message.type === "hello") {
    console.log(`[ws] hello  lastSeq=${message.lastSeq}`);
    return;
  }
  if (message.type === "subscribed") {
    console.log(`[ws] 已订阅 ${JSON.parse(String(raw)).sub}`);
    return;
  }
  if (message.type === "event" && message.event) {
    received.push(message.event.type);
    console.log(`[ws] ← 收到事件 ${message.event.type}`);
  }
});

await new Promise((resolve) => socket.on("open", resolve));
await wait(300);

console.log("\n--- 触发写操作 ---");
const created = await fetch(`${BASE}/api/swarms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ goal: "WS 自检任务", name: "WS Check", agentCount: 2, budget: 1 }),
}).then((response) => response.json() as Promise<{ swarm: { id: string } }>);
console.log("创建集群:", created.swarm.id);

await wait(200);
await fetch(`${BASE}/api/swarms/${created.swarm.id}/threads/primary/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "这条消息应该实时推给我", agent: "human" }),
});
console.log("已发消息");

await wait(500);
socket.close();

const expected = ["swarm.created", "agent.registered", "thread.created", "mail.sent"];
const missing = expected.filter((type) => !received.includes(type));
console.log(`\n收到 ${received.length} 个事件: ${[...new Set(received)].join(", ")}`);
console.log(missing.length === 0 ? "✅ WS 实时推送正常" : `❌ 缺少事件: ${missing.join(", ")}`);

/* ---------- 第二阶段：mailbox:<地址> 订阅只收到与自己相关的邮件 ---------- */
console.log("\n--- 信箱订阅 ---");
const swarmId = created.swarm.id;
const swarm = (await fetch(`${BASE}/api/swarms/${swarmId}`).then((r) => r.json())) as { agents: string[] };
const mine = swarm.agents[0];
const other = swarm.agents[1];
const myAddress = `${mine}@${swarmId}.swarm`;

const box: { type: string; event?: { type: string; mail?: { id: string; body: string }; mailId?: string } }[] = [];
const mailboxSocket = new WebSocket(WS_URL);
await new Promise<void>((resolve) => mailboxSocket.on("open", () => resolve()));
mailboxSocket.on("message", (raw) => box.push(JSON.parse(String(raw))));
// replace: 先清掉默认的 "*"，否则什么都会推过来
mailboxSocket.send(JSON.stringify({ sub: `mailbox:${myAddress}`, replace: true }));
await wait(300);

const sendMail = async (to: string[], body: string): Promise<string> => {
  const result = (await fetch(`${BASE}/api/mails`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ swarmId, from: "human", to, body }),
  }).then((r) => r.json())) as { mail: { id: string } };
  return result.mail.id;
};

const myMailId = await sendMail([myAddress], "ws-check：只发给我的信");
await waitFor(() => box.some((m) => m.event?.mail?.body.includes("只发给我")));
await sendMail([`${other}@${swarmId}.swarm`], "ws-check：发给别人的信");
// 这封信**不该**来，所以只能等一个"别人确实收到了"的时长再下结论
await wait(400);
await fetch(`${BASE}/api/mails/${myMailId}/read`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ reader: myAddress }),
});
await waitFor(() => box.some((m) => m.type === "event" && m.event?.type === "mail.read"));
mailboxSocket.close();

const sentEvents = box.filter((m) => m.type === "event" && m.event?.type === "mail.sent");
const readEvents = box.filter((m) => m.type === "event" && m.event?.type === "mail.read");
const checks: [boolean, string][] = [
  [sentEvents.some((m) => m.event?.mail?.body.includes("只发给我")), "收到 💬 发给自己的信"],
  [!sentEvents.some((m) => m.event?.mail?.body.includes("发给别人")), "没收到 发给别人的信"],
  [readEvents.some((m) => m.event?.mailId === myMailId), "收到 👁 自己的已读回执"],
];
for (const [ok, label] of checks) console.log(`  ${ok ? "✅" : "❌"} ${label}`);

const failed = missing.length === 0 && checks.every(([ok]) => ok);
console.log(failed ? "\n✅ WS 订阅（集群 + 邮箱）全部正常" : "\n❌ WS 自检有失败");
process.exit(failed ? 0 : 1);
