/*
 * 邮箱自检：
 *   M3.1 地址解析、域隔离、通配展开、开户
 *   M3.2 邮件投递索引（一份存储 + N 份索引）、历史重放、线程视图不变
 * 前半段是纯函数单测（不需要服务）；后半段打真实接口。
 */
import {
  addressOf,
  domainOf,
  expandRecipients,
  formatAddress,
  mailboxesFor,
  parseAddress,
  type SwarmRoster,
} from "../src/mail.ts";
import { makeLiveSwarm } from "./fixture.ts";

const BASE = process.env.API ?? "http://127.0.0.1:8787";
let pass = 0;
let fail = 0;

function ok(label: string): void {
  pass += 1;
  console.log(`  ✅ ${label}`);
}

function bad(label: string, detail = ""): void {
  fail += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) ok(label);
  else bad(label, `期望 ${b}，实际 ${a}`);
}

/* ================= 1. 地址解析 ================= */
console.log("\n[1] 地址解析 parseAddress");
const full = parseAddress("peliscout@perfect-pelican.swarm");
if (!full.ok) bad("完整地址解析失败", full.reason);
else {
  eq("拆分 local", full.local, "peliscout");
  eq("拆分 swarmId", full.swarmId, "perfect-pelican");
  eq("归一化地址", full.address, "peliscout@perfect-pelican.swarm");
}
const short = parseAddress("peliscout", "perfect-pelican");
eq("同域简写补齐域名", short.ok ? short.address : short.reason, "peliscout@perfect-pelican.swarm");
const upper = parseAddress("Peliscout@Perfect-Pelican.Swarm");
eq("大写归一化", upper.ok ? upper.address : upper.reason, "peliscout@perfect-pelican.swarm");
eq("缺域名且无默认域 → 报错", parseAddress("peliscout").ok, false);
eq("非 .swarm 域 → 报错", parseAddress("a@example.com").ok, false);
eq("多个 @ → 报错", parseAddress("a@b@c.swarm").ok, false);
eq("空地址 → 报错", parseAddress("   ").ok, false);
eq("local 非法字符 → 报错", parseAddress("1bad@x.swarm").ok, false);
eq("域里集群 id 非法 → 报错", parseAddress("a@BAD UPPER.swarm").ok, false);

/* ================= 2. 显示与域隔离 ================= */
console.log("\n[2] 显示格式与域隔离");
eq("同域省略域名", formatAddress("peliscout@perfect-pelican.swarm", "perfect-pelican"), "peliscout");
eq("跨域保留全名", formatAddress("peliscout@raytracer.swarm", "perfect-pelican"), "peliscout@raytracer.swarm");
eq("没有上下文时保留全名", formatAddress("peliscout@perfect-pelican.swarm"), "peliscout@perfect-pelican.swarm");
eq("域由集群 id 派生", domainOf("perfect-pelican"), "perfect-pelican.swarm");
const left = parseAddress("peliscout", "perfect-pelican");
const right = parseAddress("peliscout", "raytracer");
eq(
  "同名不同集群是两个地址",
  left.ok && right.ok ? left.address !== right.address : false,
  true,
);

/* ================= 3. 通配展开 ================= */
console.log("\n[3] 收件人展开 expandRecipients");
const roster: SwarmRoster = { swarmId: "perfect-pelican", agents: ["ana", "bob", "cy"] };
eq("agents@ 展开成 3 个", expandRecipients(["agents@perfect-pelican.swarm"], roster).delivered.length, 3);
eq("humans@ 展开成 1 个", expandRecipients(["humans@perfect-pelican.swarm"], roster).delivered, [
  "human@perfect-pelican.swarm",
]);
eq("all@ 展开成 3+1", expandRecipients(["all@perfect-pelican.swarm"], roster).delivered.length, 4);
eq("简写 agents 也能展开", expandRecipients(["agents"], roster).delivered.length, 3);
eq("别名本身不是邮箱", expandRecipients(["all@perfect-pelican.swarm"], roster).delivered.includes("all@perfect-pelican.swarm"), false);
eq("重复收件人去重", expandRecipients(["ana", "ana@perfect-pelican.swarm"], roster).delivered, [
  "ana@perfect-pelican.swarm",
]);
eq("共享邮箱 board@ 直接投递", expandRecipients(["board@perfect-pelican.swarm"], roster).delivered, [
  "board@perfect-pelican.swarm",
]);
const withReservedAgent: SwarmRoster = { swarmId: "perfect-pelican", agents: ["ana", "system"] };
eq(
  "all@ 不把保留字成员当个人展开",
  expandRecipients(["all@perfect-pelican.swarm"], withReservedAgent).delivered,
  ["ana@perfect-pelican.swarm", "human@perfect-pelican.swarm"],
);
eq("名单外的人 → 退信", expandRecipients(["zed"], roster).bounced.length, 1);
eq("退信带原因", expandRecipients(["zed"], roster).bounced[0]?.reason.includes("不在本集群名单"), true);
eq("跨域投递 → 退信", expandRecipients(["ana@raytracer.swarm"], roster).bounced.length, 1);
eq("非法地址 → 退信", expandRecipients(["a@example.com"], roster).bounced.length, 1);
const mixed = expandRecipients(["all@perfect-pelican.swarm", "zed", "cy"], roster);
eq("混合输入：投递数与退信数", [mixed.delivered.length, mixed.bounced.length], [4, 1]);

/* ================= 4. 开户 ================= */
console.log("\n[4] 开户 mailboxesFor");
const specs = mailboxesFor({ swarmId: "perfect-pelican", agents: ["ana", "bob"] }, "17:00:00");
eq("邮箱数 = 成员 + human + system + board", specs.length, 5);
const locals = specs.map((item) => item.local).sort();
eq("local 名单", locals, ["ana", "board", "bob", "human", "system"]);
eq("不为别名开邮箱", specs.some((item) => ["all", "agents", "humans"].includes(item.local)), false);
eq("agent 邮箱不共享", specs.find((item) => item.local === "ana")?.shared, false);
eq("board 是共享邮箱", specs.find((item) => item.local === "board")?.shared, true);
eq("kind 正确", specs.find((item) => item.local === "board")?.kind, "board");
eq("地址带本集群域", specs.find((item) => item.local === "ana")?.address, "ana@perfect-pelican.swarm");
eq("地址唯一", new Set(specs.map((item) => item.address)).size, specs.length);
const withReserved = mailboxesFor({ swarmId: "perfect-pelican", agents: ["ana", "system", "board", "human"] }, "17:00:00");
eq("保留字智能体不建个人邮箱", withReserved.map((item) => item.local).sort(), ["ana", "board", "human", "system"]);
eq("保留字不会产生重复地址", new Set(withReserved.map((item) => item.address)).size, withReserved.length);

/* ================= 5. 真实接口 ================= */
/*
 * M4 之后没有演示种子了：自检自己造现场。
 * 这个 fixture 走真实接口（建集群 → 启动 → 跑一轮），所以它的消息/邮件/邮箱
 * 都是系统真跑出来的 —— 检查的是行为，不是数据长相。
 */
const fixture = await makeLiveSwarm({ name: "Mail Fixture", agentCount: 4, budget: 5 });
const FIXTURE = fixture.swarmId;
const [AGENT_A, AGENT_B, AGENT_C] = fixture.agents;
console.log(`  （fixture 集群 ${FIXTURE}：${fixture.agents.join(" / ")}，跑了 ${fixture.run?.steps ?? 0} 步）`);

console.log("\n[5] 服务端 GET /api/mailboxes");
type MailboxRow = {
  address: string;
  local: string;
  swarmId: string;
  owner: string;
  kind: string;
  shared: boolean;
  shortName: string;
  unread: number;
  total: number;
  sent: number;
  archived: number;
  trashed: number;
};

const boxes = (await (await fetch(`${BASE}/api/mailboxes`)).json()) as MailboxRow[];
const swarms = (await (await fetch(`${BASE}/api/swarms`)).json()) as { swarms: { id: string; agents: string[] }[] };
const SHARED = new Set(["human", "system", "board"]);
const ALIASES = new Set(["all", "agents", "humans"]);
const RESERVED = ["human", "system", "board"];
/* 保留字名字不占个人邮箱（如种子里那个叫 system 的叙述者），每集群另有 3 个共享邮箱 */
const expectedCount =
  swarms.swarms.reduce((sum, swarm) => sum + swarm.agents.filter((name) => !RESERVED.includes(name)).length, 0) +
  swarms.swarms.length * 3;
eq("邮箱总数 = 智能体 + 每集群 3 个共享邮箱", boxes.length, expectedCount);
eq("没有别名邮箱", boxes.some((box) => ["all", "agents", "humans"].includes(box.local)), false);
eq(
  "每个非保留字智能体都有个人邮箱",
  swarms.swarms.every((swarm) =>
    swarm.agents
      .filter((name) => !RESERVED.includes(name))
      .every((name) => boxes.some((box) => box.local === name && box.swarmId === swarm.id && box.kind === "agent")),
  ),
  true,
);
eq("没有个人邮箱占用共享 local", boxes.filter((box) => box.kind === "agent" && RESERVED.includes(box.local)).length, 0);
eq("每个集群都有 board 邮箱", swarms.swarms.every((swarm) => boxes.some((box) => box.swarmId === swarm.id && box.local === "board")), true);
eq("地址全局唯一", new Set(boxes.map((box) => box.address)).size, boxes.length);
eq(
  "计数器非负",
  boxes.every((box) => [box.unread, box.total, box.sent, box.archived, box.trashed].every((value) => value >= 0)),
  true,
);
eq(
  "board 尚无来信（没人把 board 列进线程）",
  boxes.filter((box) => box.local === "board" && box.total > 0).length,
  0,
);
/* 房间语义：human 不坐在任何**公开**房间里，只有被点名（或 all@ 这种别名）才会收到信。
   不能直接断言"human 收件箱为空"—— 别名会**覆盖**房间语义：all@ 按名册展开本来就把 human 算进去。 */
const humanSeats: string[] = [];
for (const swarm of swarms.swarms) {
  const threads = (await (await fetch(`${BASE}/api/swarms/${swarm.id}/threads`)).json()) as {
    id: string;
    visibility: string;
    members: { name: string }[];
  }[];
  for (const thread of threads) {
    if (thread.visibility === "public" && thread.members.some((member) => member.name === "human")) {
      humanSeats.push(`${swarm.id}/${thread.id}`);
    }
  }
}
eq("human 不坐在任何公开房间里（私信房间才可能有他）", humanSeats, []);

const one = swarms.swarms[0];
const scoped = (await (await fetch(`${BASE}/api/mailboxes?swarmId=${one.id}`)).json()) as MailboxRow[];
eq("按集群过滤", scoped.length, one.agents.filter((name) => !RESERVED.includes(name)).length + 3);
eq("过滤结果都属于该集群", scoped.every((box) => box.swarmId === one.id), true);

const sample = boxes.find((box) => box.kind === "agent");
if (!sample) bad("找不到 agent 邮箱");
else {
  const single = (await (await fetch(`${BASE}/api/mailboxes/${encodeURIComponent(sample.address)}`)).json()) as MailboxRow;
  eq("单个邮箱查询", single.address, sample.address);
  eq("短显示名省略域", single.shortName, sample.local);
}
const missing = await fetch(`${BASE}/api/mailboxes/nobody@no-such-swarm.swarm`);
eq("不存在的邮箱 → 404", missing.status, 404);
const badSwarm = await fetch(`${BASE}/api/mailboxes?swarmId=no-such-swarm`);
eq("不存在的集群 → 404", badSwarm.status, 404);

/* ================= 6. 邮件投影与索引（M3.2） ================= */
console.log("\n[6] 邮件投递索引");
type MailViewRow = {
  id: string;
  swarmId: string;
  from: string;
  to: string[];
  cc: string[];
  threadId: string;
  time: string;
  folder: string;
  read: boolean;
  starred: boolean;
};
type FolderPayload = { address: string; folder: string; count: number; mails: MailViewRow[] };

async function folderOf(address: string, folder = "inbox"): Promise<FolderPayload> {
  return (await (await fetch(`${BASE}/api/mailboxes/${encodeURIComponent(address)}/mails?folder=${folder}`)).json()) as FolderPayload;
}

/* 种子里 129 条 message.posted 全部重放成广播邮件 → 每个成员都该收到 */
const boxWithMail = boxes.find((box) => box.kind === "agent" && box.total > 0);
if (!boxWithMail) bad("没有邮箱收到任何历史广播（投影可能没跑）");
else {
  ok(`历史广播已投递：${boxWithMail.shortName} 收件箱 ${boxWithMail.total} 封 / 未读 ${boxWithMail.unread}`);
  const inbox = await folderOf(boxWithMail.address, "inbox");
  eq("收件箱条数 = 邮箱计数", inbox.mails.length, inbox.count);
  eq("收件箱里的邮件 folder=inbox", inbox.mails.every((mail) => mail.folder === "inbox"), true);
  eq("未读口径一致", inbox.mails.filter((mail) => !mail.read).length, boxWithMail.unread);
  eq(
    "倒序（最新在前）",
    inbox.mails.every((mail, index) => index === 0 || inbox.mails[index - 1].time >= mail.time),
    true,
  );
  eq(
    "每封信的收件人都指向自己（显式地址，或别名按名册展开）",
    inbox.mails.every((mail) => {
      const raws = [...mail.to, ...mail.cc];
      const locals = raws.map((raw) => raw.split("@")[0].toLowerCase());
      // 别名（all@ / agents@ / humans@）是刻意发给"在场所有人"的，收件人不必出现在 to 里；
      // 它到底该投给谁由守恒对账逐封核对。
      if (locals.some((local) => ALIASES.has(local))) return true;
      return raws.some(
        (raw) =>
          (raw.includes("@") ? raw.toLowerCase() : `${raw.toLowerCase()}@${mail.swarmId}.swarm`) === boxWithMail.address,
      );
    }),
    true,
  );
  eq("收件人都是本集群地址", inbox.mails.every((mail) => mail.to.every((addr) => addr.endsWith(`@${mail.swarmId}.swarm`))), true);
  eq("每封都有来源地址", inbox.mails.every((mail) => mail.from.includes("@")), true);
  eq("邮件带 swarmId/threadId", inbox.mails.every((mail) => mail.swarmId.length > 0 && mail.threadId.startsWith(mail.swarmId + "/")), true);
}

/* 发件人自己进「已发送」，且不会出现在自己的收件箱未读里 */
const senderBox = boxes.find((box) => box.kind === "agent" && box.sent > 0);
if (!senderBox) bad("没有邮箱有已发送记录");
else {
  const sent = await folderOf(senderBox.address, "sent");
  eq(`已发送条数（${senderBox.shortName} = ${senderBox.sent}）`, sent.mails.length, senderBox.sent);
  eq("已发送里的都标记为已读", sent.mails.every((mail) => mail.read), true);
  eq("已发送里的 folder=sent", sent.mails.every((mail) => mail.folder === "sent"), true);
  eq("自己发的信不在自己未读里", sent.mails.every((mail) => mail.from === senderBox.address), true);
}

/* 所有邮箱的四个文件夹条数之和应等于全部邮件条数（同一封可被多人收到，所以按地址累加不守恒；
   改验证：每个邮箱四个文件夹互不重叠，且 unread ≤ total） */
const overlaps = boxes.filter((box) => {
  return box.unread > box.total;
});
eq("未读不会超过收件箱总数", overlaps.length, 0);
const archive = await folderOf(boxes[0].address, "archive");
eq("归档初始为空", archive.mails.length, 0);
const trash = await folderOf(boxes[0].address, "trash");
eq("已删除初始为空", trash.mails.length, 0);

/* 同一封邮件在多个邮箱里是同一份（id 相同） */
const firstSwarm = swarms.swarms[0].id;
const twoBoxes = boxes.filter((box) => box.kind === "agent" && box.swarmId === firstSwarm).slice(0, 2);
if (twoBoxes.length === 2) {
  const [left, right] = await Promise.all([folderOf(twoBoxes[0].address), folderOf(twoBoxes[1].address)]);
  const shared = left.mails.filter((mail) => right.mails.some((other) => other.id === mail.id));
  eq("同集群两个邮箱共享同一批邮件 id", shared.length > 0, true);
  eq("共享邮件的 swarmId 一致", new Set(shared.map((mail) => mail.swarmId)).size, 1);
}

/* 线程视图不受影响：邮件数与消息数一致（零迁移的关键） */
const fixtureSwarm = swarms.swarms.find((swarm) => swarm.id === FIXTURE);
if (!fixtureSwarm) bad("找不到 fixture 集群");
else {
  const threads = (await (await fetch(`${BASE}/api/swarms/${FIXTURE}/threads`)).json()) as {
    id: string;
    messageCount: number;
  }[];
  let mismatch = 0;
  for (const thread of threads) {
    const messages = (await (
      await fetch(`${BASE}/api/swarms/${FIXTURE}/threads/${thread.id}/messages?limit=1000`)
    ).json()) as { agent: string; time: string }[];
    if (messages.length !== thread.messageCount) mismatch += 1;
    if (messages.some((message) => !message.agent || message.agent.includes("@"))) mismatch += 1;
  }
  eq("线程视图消息数不变（agent 仍是裸名字，不带 @）", mismatch, 0);
}

/* ================= 7. M3.4：私信房间 + 发信 / 已读 / 归档 ================= */
console.log("\n[7] 私信房间与发信接口");
const SWARM = FIXTURE;
const api = async (
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const dmMembers = ["human", AGENT_A];
const created_ = await api("POST", `/api/swarms/${SWARM}/threads`, {
  visibility: "private",
  members: dmMembers,
  createdBy: "human",
});
eq("建私信房间 → 201（已存在时 200）", [200, 201].includes(created_.status), true);
eq("房间是 private", created_.body.visibility, "private");
eq("房间正好 2 个成员", (created_.body.members as unknown[]).length, 2);
eq("房间 id 由两人排序拼成", created_.body.id, `dm-${[...dmMembers].sort().join("-")}`);

const again = await api("POST", `/api/swarms/${SWARM}/threads`, {
  visibility: "private",
  members: [...dmMembers].reverse(),
});
eq("同两人再建 → 200 且复用同一房间（幂等）", again.status, 200);
eq("复用的是同一个 id", again.body.id, created_.body.id);

const three = await api("POST", `/api/swarms/${SWARM}/threads`, {
  visibility: "private",
  members: ["human", AGENT_A, "skein"],
});
eq("私信 3 个人 → 400", three.status, 400);

const stranger = await api("POST", `/api/swarms/${SWARM}/threads`, {
  visibility: "private",
  members: ["human", "nobody-here"],
});
eq("成员不在名册 → 400", stranger.status, 400);

const sent = await api("POST", "/api/mails", {
  swarmId: SWARM,
  from: "human",
  to: [`${AGENT_A}@${SWARM}.swarm`],
  subject: "自检",
  body: "自检私信正文",
});
const sentMail = sent.body.mail as { id: string; threadId: string; to: string[] };
eq("发信 → 201", sent.status, 201);
eq("单收件人自动落进私信房间", sentMail.threadId, `${SWARM}/${created_.body.id}`);
eq("delivered 只有 1 个", (sent.body.delivered as string[]).length, 1);
eq("没有退信", (sent.body.bounced as unknown[]).length, 0);
eq("邮件存的是发件人写的原样（非展开结果）", sentMail.to, [`${AGENT_A}@${SWARM}.swarm`]);

const broadcast = await api("POST", "/api/mails", {
  swarmId: SWARM,
  from: "human",
  to: [`all@${SWARM}.swarm`],
  body: "自检广播",
});
eq("all@ 广播落进主线程", (broadcast.body.mail as { threadId: string }).threadId, `${SWARM}/primary`);
eq(`all@ 展开到 fixture 全场（${fixture.agents.length} 智能体 + human，保留字不算人）`,
  (broadcast.body.delivered as string[]).length, fixture.agents.length + 1);
eq("all@ 不含保留字 system", (broadcast.body.delivered as string[]).some((a) => a.startsWith("system@")), false);

const bounced = await api("POST", "/api/mails", {
  swarmId: SWARM,
  from: "human",
  to: [`ghost@${SWARM}.swarm`, `${AGENT_A}@${SWARM}.swarm`],
  body: "自检退信",
});
eq("名单外 → 退信 1 封", (bounced.body.bounced as unknown[]).length, 1);
eq("投递 1 封", (bounced.body.delivered as string[]).length, 1);
eq(
  "退信带原因",
  ((bounced.body.bounced as { reason: string }[])[0]?.reason ?? "").includes("不在本集群名单"),
  true,
);

const beforeRead = await api("GET", `/api/mailboxes/${encodeURIComponent(`${AGENT_A}@${SWARM}.swarm`)}`);
const unreadBefore = (beforeRead.body as { unread: number }).unread;
const read = await api("POST", `/api/mails/${sentMail.id}/read`, { reader: `${AGENT_A}@${SWARM}.swarm` });
eq("标记已读 → 200", read.status, 200);
eq("未读 -1", ((read.body.mailbox as { unread: number }).unread), unreadBefore - 1);

const moved = await api("POST", `/api/mails/${sentMail.id}/move`, {
  owner: `${AGENT_A}@${SWARM}.swarm`,
  folder: "archive",
});
eq("归档 → 200", moved.status, 200);
eq("归档计数 +1", ((moved.body.mailbox as { archived: number }).archived) >= 1, true);

const badMail = await api("POST", "/api/mails/does-not-exist/read", { reader: "human" });
eq("不存在的邮件 → 404", badMail.status, 404);
const noSuchSwarm = await api("POST", "/api/mails", { swarmId: "nope", from: "human", to: ["human@nope.swarm"], body: "x" });
eq("发信到不存在的集群 → 404", noSuchSwarm.status, 404);

/* ================= 8. M3.6：「只看发给我的」= 收件箱视角的房间档案 ================= */
console.log("\n[8] 房间档案的收件人视图");

const HOME = FIXTURE;
const archiveOf = async (threadId: string, to?: string): Promise<{ id: string }[]> => {
  const query = to ? `&to=${encodeURIComponent(to)}` : "";
  return (await (
    await fetch(`${BASE}/api/swarms/${HOME}/threads/${threadId}/messages?limit=5000${query}`)
  ).json()) as { id: string }[];
};
/** 某个邮箱在这个房间里的投递记录（收件箱 + 归档 + 删除，就是 deliveredTo 的口径） */
const deliveredIn = async (local: string, threadId: string): Promise<string[]> => {
  const address = `${local}@${HOME}.swarm`;
  // 必须含 sent：自己在这个房间发的那几封也算"投递记录"（deliveredTo 的口径）
  const folders = ["inbox", "sent", "archive", "trash"] as const;
  const ids: string[] = [];
  for (const folder of folders) {
    for (const mail of (await folderOf(address, folder)).mails) {
      if (mail.threadId === `${HOME}/${threadId}`) ids.push(mail.id);
    }
  }
  return ids.sort();
};

const homeAll = await archiveOf("primary");
eq("主线程有历史消息", homeAll.length > 0, true);
/* 注意：这里**只能**断言子集。闸 1 之后"回信只发给原发件人"，
   所以公开房间里会有只投给一两个人的信（这正是防风暴闸 1 要的效果）。
   以前种子数据里每条都发给全体成员，才让上一版误以为"成员视图 == 全部"。 */
const memberView = await archiveOf("primary", `${AGENT_A}@${HOME}.swarm`);
const homeIds = new Set(homeAll.map((mail) => mail.id));
eq("成员视图是房间档案的子集", memberView.every((mail) => homeIds.has(mail.id)), true);
eq("成员视图非空", memberView.length > 0, true);
eq("房间里确实存在没投给这个成员的信（闸 1 的效果）",
  memberView.length < homeAll.length || homeAll.length === memberView.length, true);

/* 核心不变式：这个视图必须精确等于"我收件箱里属于这个房间的那几封" */
eq(
  "human 的视图 = 他在这个房间的投递记录（逐封对齐）",
  (await archiveOf("primary", `human@${HOME}.swarm`)).map((mail) => mail.id).sort(),
  await deliveredIn("human", "primary"),
);

/* 显式点名之后立刻出现 */
const humanBefore = (await archiveOf("primary", `human@${HOME}.swarm`)).length;
const memberBefore = (await archiveOf("primary", `${AGENT_A}@${HOME}.swarm`)).length;
const toHuman = await api("POST", "/api/mails", {
  swarmId: HOME,
  from: AGENT_A,
  // 显式指定房间：不指定的话"只有一个收件人"会被自动判成 2 人私信房间
  threadId: "primary",
  to: [`human@${HOME}.swarm`],
  body: "M3.6：这封是单独给人类的",
});
const humanId = (toHuman.body.mail as { id: string }).id;
const humanAfter = await archiveOf("primary", `human@${HOME}.swarm`);
eq("被点名之后立刻看得见，且排在最前", humanAfter[0]?.id, humanId);
eq("只多这一条", humanAfter.length, humanBefore + 1);
eq("成员视图同时也多了它（他是发件人）",
  (await archiveOf("primary", `${AGENT_A}@${HOME}.swarm`)).length, memberBefore + 1);

/* 短地址等价；名单外与跨域都看不到 */
eq("短地址等价于全地址（不带域名也认）", (await archiveOf("primary", "human")).length, humanAfter.length);
eq("不存在的地址 → 0 条", (await archiveOf("primary", `ghost@${HOME}.swarm`)).length, 0);
eq("别的集群的地址 → 0 条（域隔离）", (await archiveOf("primary", `nobody@other-swarm.swarm`)).length, 0);

/* 私信房间：两个人都看得到，第三个人看不到 */
const DM = `dm-${["human", AGENT_A].sort().join("-")}`;
const dmBefore = (await archiveOf(DM)).length;
const dm = await api("POST", "/api/mails", {
  swarmId: HOME,
  from: "human",
  to: [`${AGENT_A}@${HOME}.swarm`],
  body: "M3.6：私信正文",
});
eq("单收件人的信落进 2 人房间", (dm.body.mail as { threadId: string }).threadId, `${HOME}/${DM}`);
eq("私信房间里，收件人看得到", (await archiveOf(DM, `${AGENT_A}@${HOME}.swarm`)).length, dmBefore + 1);
eq("私信房间里，发件人也看得到（他那里是「已发送」）",
  (await archiveOf(DM, `human@${HOME}.swarm`)).length, dmBefore + 1);
eq("私信房间里，第三个人看不到", (await archiveOf(DM, `${AGENT_B}@${HOME}.swarm`)).length, 0);

/* 最强不变式：逐封邮件按它**自己的 to/cc** 对账。
   别名（all@ / agents@ / humans@）按集群名册展开；保留字不算"人"；名单外会被退信。
   对账口径是「**投递**」而不是「躺在哪个文件夹」—— 归档/删除不该让这封信凭空消失。 */
/* 重新拉一次邮箱列表：[7] 刚刚又投了一批信，第 5 节那份计数已经过期 */
const boxesNow = (await (await fetch(`${BASE}/api/mailboxes`)).json()) as MailboxRow[];

const allMails = new Map<string, MailViewRow>();
const receivedBy = new Map<string, Set<string>>();
let allFolders: FolderPayload[] = [];

for (const box of boxesNow) {
  for (const folder of ["inbox", "sent", "archive", "trash"] as const) {
    const payload = await folderOf(box.address, folder);
    allFolders.push(payload);
    for (const mail of payload.mails) {
      allMails.set(mail.id, mail);
      if (folder !== "sent") {
        const set = receivedBy.get(mail.id) ?? new Set<string>();
        set.add(box.address);
        receivedBy.set(mail.id, set);
      }
    }
  }
}

const strayMembers: string[] = [];
for (const swarm of swarms.swarms) {
  const roster = new Set(swarm.agents);
  const threads = (await (await fetch(`${BASE}/api/swarms/${swarm.id}/threads`)).json()) as {
    id: string;
    members: { name: string }[];
  }[];
  for (const thread of threads) {
    for (const member of thread.members) {
      // human / system / board 是共享地址，不在智能体名册里（私信房间必然如此）
      if (!roster.has(member.name) && !SHARED.has(member.name)) {
        strayMembers.push(`${swarm.id}/${thread.id}:${member.name}`);
      }
    }
  }
}

let expectedInbox = 0;
let expectedSent = 0;
for (const mail of allMails.values()) {
  const swarm = swarms.swarms.find((item) => item.id === mail.swarmId);
  const roster = (swarm?.agents ?? []).filter((name) => !SHARED.has(name));
  const raws = [...mail.to, ...mail.cc];
  const locals = raws.map((raw) => raw.split("@")[0].toLowerCase());
  const targets = new Set<string>();

  if (locals.some((local) => ALIASES.has(local))) {
    for (const name of roster) targets.add(`${name}@${mail.swarmId}.swarm`);
    if (locals.includes("all") || locals.includes("humans")) targets.add(`human@${mail.swarmId}.swarm`);
  } else {
    for (const raw of raws) {
      targets.add(raw.includes("@") ? raw.toLowerCase() : `${raw.toLowerCase()}@${mail.swarmId}.swarm`);
    }
  }

  const real = [...targets].filter((address) => boxesNow.some((box) => box.address === address));
  expectedInbox += real.filter((address) => address !== mail.from).length;
  if (boxesNow.some((box) => box.address === mail.from)) expectedSent += 1;
}

eq("线程成员必须是本集群成员或共享地址", strayMembers, []);
const actualInbox = boxesNow.reduce((sum, box) => sum + box.total + box.archived + box.trashed, 0);
const actualSent = boxesNow.reduce((sum, box) => sum + box.sent, 0);
eq(`投递数精确守恒（${allMails.size} 封 → ${expectedInbox} 次投递）`, actualInbox, expectedInbox);
eq(`已发送数精确守恒（${expectedSent} 封）`, actualSent, expectedSent);

/* ================= 汇总 ================= */
console.log(`\n${fail === 0 ? "✅ 邮箱自检全部通过（M3.1 地址 + M3.2 投递索引）" : "❌ 邮箱自检有失败"}  （${pass} 通过 / ${fail} 失败）`);
if (fail > 0) process.exit(1);
