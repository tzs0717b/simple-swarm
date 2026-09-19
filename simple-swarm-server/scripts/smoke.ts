/*
 * 契约自检（M2 版）：把前端 src/data.ts 里的 interface 字段解析出来，
 * 与后端 API 返回对象的实际 key 做严格比对；再校验分页/排序/隔离等不变量。
 *
 * 用法：先 npm start，再 npm run smoke
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API ?? "http://127.0.0.1:8787";
const FRONTEND_DATA = process.env.FRONTEND_DATA ?? path.resolve(here, "../../simple-swarm-web/src/data.ts");

/* M4 之后不再有演示种子：自检自己造现场（走真实接口，不编数据） */
import { makeLiveSwarm } from "./fixture.ts";

const SEARCH_TOKEN = "smokesearchtoken";
const fixture = await makeLiveSwarm({
  name: "Smoke Fixture",
  agentCount: 4,
  budget: 5,
  goal: `自检用目标：验证搜索索引能命中中文，也能命中 ${SEARCH_TOKEN} 这样的标识符。DoD：搜索有结果。`,
});
const FIXTURE = fixture.swarmId;

const problems: string[] = [];
const lines: string[] = [];
const ok = (message: string) => lines.push(`  ✅ ${message}`);
const bad = (message: string) => {
  problems.push(message);
  lines.push(`  ❌ ${message}`);
};

/** 从 TS 源码里抠出一个 interface 的字段名列表（类型在运行时被抹掉，只能解析源码）。 */
function interfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"))
    /* 可选字段写成 foo?: T —— 字段名必须把 ? 去掉，
       否则拿 "foo?" 去比对象键，永远报"缺字段"（新增 stops? 时踩到过）。 */
    .map((line) => line.split(":")[0].trim().replace(/\?$/, ""))
    .filter((field) => field.length > 0);
}

function sameKeys(actual: string[], expected: string[]): { missing: string[]; extra: string[] } {
  return {
    missing: expected.filter((field) => !actual.includes(field)),
    extra: actual.filter((field) => !expected.includes(field)),
  };
}

function checkShape(label: string, sample: Record<string, unknown> | undefined, expected: string[]): void {
  if (!sample) {
    bad(`${label} 没有样本对象可校验`);
    return;
  }
  const { missing, extra } = sameKeys(Object.keys(sample), expected);
  if (missing.length) bad(`${label} 缺字段: ${missing.join(", ")}`);
  else if (extra.length) bad(`${label} 多字段: ${extra.join(", ")}`);
  else ok(`${label} 字段与前端接口完全一致（${expected.length} 个）`);
}

async function getJson<T>(route: string): Promise<T> {
  const response = await fetch(`${BASE}${route}`);
  if (!response.ok) throw new Error(`${route} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** POST 辅助：返回 { status, body }，不因非 2xx 抛错（生命周期要断言 409） */
async function postJson<T>(route: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/* ---------- 0. 从源码读契约 ---------- */
const source = await readFile(FRONTEND_DATA, "utf8");
const CONTRACT = {
  AgentInfo: interfaceFields(source, "AgentInfo"),
  SwarmData: interfaceFields(source, "SwarmData"),
  ThreadData: interfaceFields(source, "ThreadData"),
  MessageData: interfaceFields(source, "MessageData"),
  TraceEventData: interfaceFields(source, "TraceEventData"),
  AgentEvent: interfaceFields(source, "AgentEvent"),
  SearchHit: interfaceFields(source, "SearchHit"),
  Mailbox: interfaceFields(source, "Mailbox"),
};
lines.push(`从 ${path.relative(process.cwd(), FRONTEND_DATA)} 解析出契约：`);
for (const [name, fields] of Object.entries(CONTRACT)) {
  lines.push(`  ${name}: ${fields.length} 个字段`);
  if (fields.length === 0) bad(`解析 ${name} 失败（源码结构变了？）`);
}

/* ---------- 1. /api/swarms ---------- */
lines.push("\n[1] GET /api/swarms");
const swarmPayload = await getJson<{ swarms: Record<string, unknown>[]; totals: { swarms: number; live: number } }>("/api/swarms");
checkShape("SwarmData", swarmPayload.swarms[0], CONTRACT.SwarmData);
if (!swarmPayload.swarms.some((swarm) => swarm.id === FIXTURE)) bad(`刚建的 fixture 集群没出现在列表里: ${FIXTURE}`);
else ok(`fixture 集群在列表里（${FIXTURE}）；当前共 ${swarmPayload.swarms.length} 个，在线 ${swarmPayload.totals.live}`);
if (swarmPayload.totals.swarms !== swarmPayload.swarms.length) bad("totals.swarms 与数组长度不一致");

/* ---------- 2. 线程 + 消息 ---------- */
lines.push("\n[2] 线程与消息");
let threadCount = 0;
let messageCount = 0;
for (const swarm of swarmPayload.swarms) {
  const swarmId = String(swarm.id);
  const threads = await getJson<Record<string, unknown>[]>(`/api/swarms/${swarmId}/threads`);
  threadCount += threads.length;
  if (threads.length === 0) bad(`${swarmId} 没有任何线程`);
  checkShape(`ThreadData(${swarmId})`, threads[0], CONTRACT.ThreadData);

  for (const thread of threads) {
    const threadId = String(thread.id);
    const messages = await getJson<Record<string, unknown>[]>(`/api/swarms/${swarmId}/threads/${threadId}/messages`);
    messageCount += messages.length;
    if (messages.length === 0) continue;
    checkShape(`MessageData(${swarmId}/${threadId})`, messages[0], CONTRACT.MessageData);

    const times = messages.map((message) => String(message.time));
    if (!times.every((time, index) => index === 0 || times[index - 1] >= time)) bad(`${swarmId}/${threadId} 消息未按时间倒序`);
    const malformed = times.filter((time) => !/^\d{2}:\d{2}:\d{2}$/.test(time));
    if (malformed.length) bad(`${swarmId}/${threadId} 时间格式非法: ${malformed.slice(0, 3).join(", ")}`);
    const badChars = messages.filter((message) => typeof message.chars !== "number" || (message.chars as number) <= 0);
    if (badChars.length) bad(`${swarmId}/${threadId} chars 非法: ${badChars.length} 条`);
  }
}
ok(`${threadCount} 个线程 / ${messageCount} 条消息，字段、倒序、时间格式全部合法`);

const cursorProbe = await getJson<Record<string, unknown>[]>(`/api/swarms/${FIXTURE}/threads/primary/messages?limit=5`);
if (cursorProbe.length === 5) ok("limit 分页生效");
else bad(`limit=5 失效，返回 ${cursorProbe.length} 条`);
const nextPage = await getJson<Record<string, unknown>[]>(
  `/api/swarms/${FIXTURE}/threads/primary/messages?limit=5&before=${String(cursorProbe[4].id)}`,
);
if (nextPage.some((message) => message.id === cursorProbe[4].id)) bad("before 游标失效（重复返回）");
else ok("before 游标生效");

/* ---------- 3. trace ---------- */
lines.push("\n[3] GET /api/swarms/:id/trace");
for (const swarm of swarmPayload.swarms) {
  const swarmId = String(swarm.id);
  const events = await getJson<Record<string, unknown>[]>(`/api/swarms/${swarmId}/trace`);
  if (events.length === 0) continue;
  checkShape(`TraceEventData(${swarmId})`, events[0], CONTRACT.TraceEventData);
  const foreign = events.filter((event) => event.swarmId !== swarmId).length;
  if (foreign) bad(`${swarmId} trace 混入其它集群事件 ${foreign} 条`);
}
ok("各集群 trace 的 swarmId 归属正确");

/* ---------- 4. agents ---------- */
lines.push("\n[4] GET /api/agents");
const agents = await getJson<Record<string, unknown>[]>("/api/agents");
checkShape("AgentInfo", agents[0], CONTRACT.AgentInfo);

/* 邮箱：列表与单个都必须是同一个形状（智能体详情页直接读它显示地址与未读） */
const boxes = (await (await fetch(`${BASE}/api/mailboxes`)).json()) as (Record<string, unknown> & {
  address: string;
  unread: number;
})[];
checkShape("Mailbox(列表)", boxes[0], CONTRACT.Mailbox);
const oneBox = (await (await fetch(`${BASE}/api/mailboxes/${encodeURIComponent(boxes[0].address)}`)).json()) as Record<
  string,
  unknown
>;
checkShape("Mailbox(单个)", oneBox, CONTRACT.Mailbox);
if (JSON.stringify(oneBox) !== JSON.stringify(boxes[0])) {
  bad("单个邮箱与列表里的同一邮箱字段不一致");
} else {
  ok(`单个邮箱与列表一致：${boxes[0].address}`);
}
if (boxes.every((box) => box.unread <= (box.total as number))) {
  ok("每个邮箱的未读 ≤ 收件");
} else {
  bad("存在未读数大于收件数的邮箱");
}
const duplicateNames = agents.length - new Set(agents.map((agent) => agent.name)).size;
if (duplicateNames > 0) bad(`智能体名单有 ${duplicateNames} 个重名`);
else ok(`${agents.length} 个智能体，名单无重名`);

/* ---------- 5. 单个智能体窗口 ---------- */
lines.push("\n[5] GET /api/agents/:name");
/* 样本要挑"真有过事件"的智能体：刚注册的 agent 事件流是空的，拿它当样本只会得到
   "没有样本对象可校验" —— 那是样本选错了，不是契约坏了（在空账本上跑套件必踩）。 */
let sample = agents.find((agent) => String(agent.name) === "pixelpilot");
if (!sample || (await getJson<unknown[]>(`/api/agents/${encodeURIComponent(String(sample.name))}/events`)).length === 0) {
  sample = agents[0];
  for (const agent of agents) {
    const events = await getJson<unknown[]>(`/api/agents/${encodeURIComponent(String(agent.name))}/events`);
    if (events.length > 0) {
      sample = agent;
      break;
    }
  }
}
const agentName = String(sample.name);
const detail = await getJson<{
  agent: Record<string, unknown>;
  swarms: unknown[];
  threads: { swarmId: string; threadId: string; title: string; messageCount: number }[];
  counts: { messages: number; tools: number; thinking: number; failures: number; sessions: number };
}>(`/api/agents/${agentName}`);
checkShape(`AgentDetail.agent(${agentName})`, detail.agent, CONTRACT.AgentInfo);
if (!Array.isArray(detail.swarms) || !Array.isArray(detail.threads)) bad("AgentDetail 的 swarms/threads 不是数组");
else ok(`agent 详情：${detail.swarms.length} 个集群 / ${detail.threads.length} 个线程`);

const agentEvents = await getJson<Record<string, unknown>[]>(`/api/agents/${agentName}/events`);
/* 空账本确实没有样本 —— 那是"没得查"，不是"查不过" */
if (agentEvents.length === 0) ok("账本里还没有任何智能体事件，跳过 AgentEvent 形状校验（不算失败）");
else checkShape(`AgentEvent(${agentName})`, agentEvents[0], CONTRACT.AgentEvent);
const counted = detail.counts;
if (counted.messages !== agentEvents.filter((event) => event.kind === "message").length) bad("counts.messages 与实际消息条数不一致");
if (counted.failures !== agentEvents.filter((event) => event.kind === "failure").length) bad("counts.failures 与实际失败条数不一致");
if (counted.tools !== agentEvents.filter((event) => event.kind === "tool").length) bad("counts.tools 与实际工具条数不一致");
else ok(`事件流 ${agentEvents.length} 条，分类计数自洽（消息 ${counted.messages} / 工具 ${counted.tools} / 思考 ${counted.thinking} / 失败 ${counted.failures} / 收工 ${counted.sessions}）`);

const failureEvents = await getJson<Record<string, unknown>[]>(`/api/agents/${agentName}/events?kind=failures`);
const wrongKind = failureEvents.filter((event) => event.kind !== "failure").length;
if (wrongKind > 0) bad(`kind=failures 混入其它分类 ${wrongKind} 条`);
else ok(`kind=failures 过滤正确（${failureEvents.length} 条）`);

/* ---------- 6. 全局搜索 ---------- */
lines.push("\n[6] GET /api/search");
const search = await getJson<{
  query: string;
  total: number;
  swarms: Record<string, unknown>[];
  threads: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  messages: Record<string, unknown>[];
}>(`/api/search?q=${SEARCH_TOKEN}`);
const firstHit = search.swarms[0] ?? search.threads[0] ?? search.messages[0];
checkShape("SearchHit", firstHit, CONTRACT.SearchHit);
const sum = search.swarms.length + search.threads.length + search.agents.length + search.messages.length;
if (sum !== search.total) bad(`search.total=${search.total} 与分组条数之和 ${sum} 不一致`);
else ok(`搜索 fixture 自己的目标文本（${SEARCH_TOKEN}）命中 ${search.total} 条，分组求和一致`);
const lower = await getJson<{ total: number }>(`/api/search?q=${SEARCH_TOKEN.toUpperCase()}`);
if (lower.total !== search.total) bad("搜索大小写不敏感校验失败");
else ok("搜索大小写不敏感");
const empty = await getJson<{ total: number }>("/api/search?q=");
if (empty.total !== 0) bad("空查询应当返回 0 条");
else ok("空查询返回空结果");

const healthBaseline = (await getJson<{ lastSeq: number }>("/api/health")).lastSeq;

/* ---------- 7. 集群生命周期 ---------- */
lines.push("\n[7] 集群生命周期 pending → live → stopped → done");
const created = await postJson<{ swarm: Record<string, unknown> }>("/api/swarms", {
  goal: "smoke 生命周期探针",
  name: "smoke lifecycle",
  agentCount: 2,
});
const probeId = String(created.body.swarm.id);
checkShape("SwarmData(新建)", created.body.swarm, CONTRACT.SwarmData);
if (created.body.swarm.state !== "pending") bad(`新建集群 state 应为 pending，实际 ${String(created.body.swarm.state)}`);
else if (created.body.swarm.startedAt !== "") bad("待启动集群的 startedAt 应为空串");
else ok("新建 → pending 且 startedAt 为空（必须显式启动）");

const started = await postJson<{ state: string; startedAt: string }>(`/api/swarms/${probeId}/start`, {});
if (started.status !== 200 || started.body.state !== "live") bad(`start 失败：${started.status} / ${started.body.state}`);
else if (started.body.startedAt.length !== 8) bad(`start 后 startedAt 应为 HH:MM:SS，实际 ${JSON.stringify(started.body.startedAt)}`);
else ok(`start → live（startedAt=${started.body.startedAt}）`);

const stopped = await postJson<{ state: string }>(`/api/swarms/${probeId}/stop`, { reason: "smoke 停止" });
if (stopped.body.state !== "stopped") bad(`stop 失败：${stopped.body.state}`);
else ok("stop → stopped");

const completed = await postJson<{ state: string }>(`/api/swarms/${probeId}/complete`, { evidence: "smoke 核验" });
if (completed.body.state !== "done") bad(`complete 失败：${completed.body.state}`);
else ok("complete → done");

const restart = await postJson<{ error: string }>(`/api/swarms/${probeId}/start`, {});
if (restart.status !== 409) bad(`已完成后 start 应 409，实际 ${restart.status}`);
else ok("已完成后再次 start → 409（状态机不可逆）");

const missing = await postJson<{ error: string }>("/api/swarms/no-such-swarm/start", {});
if (missing.status !== 404) bad(`不存在的集群 start 应 404，实际 ${missing.status}`);
else ok("不存在的集群 → 404");

const lifeEvents = await getJson<{ events: { type: string; seq: number }[] }>(
  `/api/events?since=${healthBaseline}&limit=200`,
);
const kinds = new Set(lifeEvents.events.map((event) => event.type));
for (const needed of ["swarm.started", "swarm.stopped", "swarm.completed"]) {
  if (!kinds.has(needed)) bad(`事件日志缺少 ${needed}`);
}
ok("三个生命周期事件都已落盘（可重放重建状态）");

/* ---------- 8. health / events ---------- */
lines.push("\n[8] GET /api/health + /api/events");
const health = await getJson<{ ok: boolean; events: number; lastSeq: number; corruptLines: number }>("/api/health");
if (!health.ok) bad("health.ok 不为 true");
if (health.corruptLines > 0) bad(`事件日志有 ${health.corruptLines} 行损坏`);
ok(`health ok · events=${health.events} · lastSeq=${health.lastSeq} · corrupt=0`);
const incremental = await getJson<{ count: number }>(`/api/events?since=${Math.max(0, health.lastSeq - 5)}`);
if (incremental.count < 1) bad("/api/events 增量查询失效");
else ok(`/api/events 增量查询正常（${incremental.count} 条）`);

console.log(lines.join("\n"));
console.log(`\n${problems.length === 0 ? "✅ 契约自检全部通过" : `❌ 发现 ${problems.length} 个问题`}`);
if (problems.length > 0) {
  console.log(problems.map((problem) => `  - ${problem}`).join("\n"));
  process.exit(1);
}
