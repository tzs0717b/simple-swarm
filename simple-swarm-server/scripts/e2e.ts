/*
 * M2 端到端自检：完全按前端 store 的调用顺序走一遍。
 *   1) 建集群（前端"新建集群"表单）
 *   2) 开 WS 订阅（前端 openEventStream）
 *   3) 发消息（前端"插话"框）
 *   4) 断言 WS 把这条消息推回来（实时出现）
 *   5) 断言 GET 消息列表倒序、新消息在第一条（刷新不丢）
 */
import { WebSocket } from "ws";

const BASE = process.env.API ?? "http://127.0.0.1:8787";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 轮询直到条件成立（自检不该赌机器快不快），最多等 timeout 毫秒 */
const waitFor = async (condition: () => boolean, timeout = 4000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await wait(50);
};

const problems: string[] = [];
const check = (condition: boolean, label: string) => {
  console.log(`  ${condition ? "✅" : "❌"} ${label}`);
  if (!condition) problems.push(label);
};

console.log("[1] 建集群（模拟前端表单）");
const created = (await fetch(`${BASE}/api/swarms`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    goal: "端到端自检：画一只骑自行车的鹈鹕，交付 final_output/pelican.svg。DoD：可渲染 + 1 次对抗性验证。",
    name: "E2E Check",
    budget: 3,
    agentCount: 5,
  }),
}).then((response) => response.json())) as { swarm: { id: string; name: string; agents: string[] } };
const swarmId = created.swarm.id;
check(created.swarm.agents.length === 5, `从名字池抽到 5 个名字: ${created.swarm.agents.join(", ")}`);
check(new Set(created.swarm.agents).size === 5, "5 个名字互不重复");

console.log("\n[2] 开 WS 订阅（模拟前端 openEventStream）");
type Push = {
  type: string;
  event?: { type: string; message?: { id: string; body: string }; mail?: { id: string; body: string } };
  lastSeq?: number;
};
const pushed: Push[] = [];
const socket = new WebSocket(WS_URL);
await new Promise<void>((resolve) => socket.on("open", () => resolve()));
socket.send(JSON.stringify({ sub: "*" }));
socket.on("message", (raw) => pushed.push(JSON.parse(String(raw)) as Push));
await waitFor(() => pushed.some((item) => item.type === "hello"));
const hello = pushed.find((item) => item.type === "hello");
check(Boolean(hello), `收到 hello, lastSeq=${hello?.lastSeq}`);

console.log("\n[3] 发消息（模拟前端插话框）");
const body = `E2E 消息 ${Date.now()}`;
const posted = (await fetch(`${BASE}/api/swarms/${swarmId}/threads/primary/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body, agent: "human" }),
}).then((response) => response.json())) as { id: string; body: string; time: string };
check(posted.body === body, `消息已写入: ${posted.id} @ ${posted.time}`);

console.log("\n[4] 断言实时推送");
await waitFor(() =>
  pushed.some((item) => item.type === "event" && item.event?.type === "mail.sent" && item.event.mail?.body === body),
);
const pushedMessage = pushed.find((item) => item.type === "event" && item.event?.type === "mail.sent" && item.event.mail?.body === body);
check(Boolean(pushedMessage), "WS 推送 mail.sent（前端把它投影进线程视图，界面无需刷新）");

console.log("\n[5] 断言刷新不丢（GET 列表倒序，新消息在第一）");
const list = (await fetch(`${BASE}/api/swarms/${swarmId}/threads/primary/messages?limit=10`).then((response) => response.json())) as {
  id: string;
  time: string;
}[];
check(list[0]?.id === posted.id, "重新拉取时新消息位于第一条（最新在前）");
const descending = list.every((item, index) => index === 0 || list[index - 1].time >= item.time);
check(descending, "列表按时间倒序");

console.log("\n[6] 邮件确实投到了线程成员的信箱（M3.3 兼容层）");
type Box = { local: string; kind: string; total: number; unread: number; sent: number };
const boxes = (await fetch(`${BASE}/api/mailboxes?swarmId=${swarmId}`).then((response) => response.json())) as Box[];
const humanBox = boxes.find((box) => box.local === "human");
check(humanBox?.sent === 1, `发件人 human 计入已发送（sent=${humanBox?.sent ?? "无"}）`);
const receivers = boxes.filter((box) => box.kind === "agent" && box.total >= 1);
check(receivers.length === created.swarm.agents.length, `全部 ${created.swarm.agents.length} 个线程成员都收到（实际 ${receivers.length}）`);
check(receivers.every((box) => box.unread >= 1), "收到的都计为未读");
check(boxes.filter((box) => box.kind === "board" && box.total > 0).length === 0, "board 没被误投");

console.log("\n[6] 认领冲突（前端 M4 会用到）");
await fetch(`${BASE}/api/swarms/${swarmId}/claims`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: created.swarm.agents[0], slice: "几何" }),
});
const conflict = await fetch(`${BASE}/api/swarms/${swarmId}/claims`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agent: created.swarm.agents[1], slice: "几何" }),
});
check(conflict.status === 409, `第二个认领者拿到 409（holders: ${JSON.stringify((await conflict.json()).holders)}）`);

socket.close();
console.log(`\n${problems.length === 0 ? "✅ M2 端到端自检全部通过" : `❌ ${problems.length} 项失败`}`);
if (problems.length > 0) {
  console.log(problems.map((problem) => `  - ${problem}`).join("\n"));
  process.exit(1);
}
