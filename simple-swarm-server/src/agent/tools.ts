/*
 * SwarmKit：智能体唯一的对外接口（M4）。
 *
 * 设计原则：智能体**不能直接改状态**，只能调这些工具；每个工具做两件事 ——
 *   1) 往事件账本里追加事实（mail.sent / mail.read / claim.taken …）
 *   2) 返回一段"观察结果"给大脑看
 *
 * 观察结果是**文本**：这是 M8 接真模型时的关键 —— 到那时这段文本就是 tool result，
 * 整条管线（工具定义 → 事件落盘 → 预算记账 → 行为流）一行都不用改，只换掉"谁来决策"。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { releaseSlice, takeSlice } from "../claims.ts";
import { BASH_TIMEOUT_MS, SWARM_BLOCK_INSTALL } from "../config.ts";
import type { EventStore } from "../eventstore.ts";
import { addressOf, localOf } from "../mail.ts";
import { isRefusal, mailSharedClaimLine, sendMail } from "../send.ts";
import { clock } from "../time.ts";
import type { AgentStop, TraceType } from "../types.ts";
import { displayPath, resolveInWorkspace, workspaceOf } from "./workspace.ts";
import { raiseChallenge, answerChallenge, ruleChallenge, challengeQuotaLeft } from "../challenges.ts";

export interface ToolContext {
  store: EventStore;
  swarmId: string;
  /** 裸名字（peliscout）—— 地址由工具自己拼 */
  agent: string;
}

export interface ToolResult {
  /** 给大脑看的文本（M8 里就是 tool result） */
  observation: string;
  /** 行为流类型。不填就用**工具名本身**（M8：类型 = 真实工具名，不再手写抽象概念） */
  traceType?: TraceType;
  detail: string;
  /** true = 这个智能体收工了 */
  done?: boolean;
  /** true = 工具压根没能执行（参数非法 / 路径越界 / 冲突）—— 只有这个算失败、才触发自动重试 */
  refused?: boolean;
  /** true = 执行了但结果不理想（比如命令退出码非零）。记进追踪给人看，**不重试**：
   *  模型本来就该看到这个报错、然后自己改。把它当失败会让失败数和重试次数彻底失真。 */
  error?: boolean;
  /** 收工时说的话（只有 done 这一步有） */
  reason?: string;
  /** 收工时给的验收说明：为什么判定可以了（M7） */
  confirm?: string;
  /** 收工方式（只有 done 这一步有）：done = 自己判定干完；其余 = 被硬闸/故障按停 */
  stop?: AgentStop;
}

function address(ctx: ToolContext): string {
  return addressOf(ctx.agent, ctx.swarmId);
}

/* ---------- 收件箱 ---------- */

/** 读收件箱：只列未读，**最老的在前**（按到达顺序处理，不然永远在处理最新的那封） */
export function toolReadInbox(ctx: ToolContext, limit = 5): ToolResult {
  const unread = ctx.store
    .listMailboxMails(address(ctx), "inbox", 0)
    .filter((mail) => !mail.read)
    .reverse();
  if (unread.length === 0) {
    return { observation: "收件箱没有未读。", detail: "检查收件箱：0 封未读" };
  }
  const shown = unread.slice(0, limit);
  const lines = shown.map(
    (mail) => `- id=${mail.id} from=${mail.from} at=${mail.time}\n  ${mail.body.slice(0, 160).replace(/\n/g, " ")}`,
  );
  return {
    observation: `未读 ${unread.length} 封（列出最老的 ${shown.length} 封）：\n${lines.join("\n")}`,
    detail: `读收件箱：${unread.length} 封未读`,
  };
}

/** 列出本集群所有邮箱（谁在场、各自多少未读） */
export function toolListMailboxes(ctx: ToolContext): ToolResult {
  const boxes = ctx.store.listMailboxes(ctx.swarmId);
  const lines = boxes
    .filter((box) => box.kind === "agent" || box.local !== "system")
    .map((box) => `- ${box.address} 未读 ${box.unread} / 收件 ${box.total}`);
  return {
    observation: `本集群 ${boxes.length} 个邮箱：\n${lines.join("\n")}`,
    detail: `列出邮箱：${boxes.length} 个`,
  };
}

/** 标记已读（自己的收件箱里） */
export function toolMarkRead(ctx: ToolContext, mailId: string): ToolResult {
  const mail = ctx.store.getMail(mailId);
  if (!mail) {
    return { observation: `邮件 ${mailId} 不存在。`, detail: `标记已读失败：邮件不存在`, refused: true };
  }
  if (!ctx.store.deliveredTo(address(ctx), mailId)) {
    return {
      observation: `邮件 ${mailId} 不在你的收件箱里，不能标记已读。`,
      detail: `标记已读被拒：不是你的邮件`,
      refused: true,
    };
  }
  ctx.store.append({ type: "mail.read", swarmId: ctx.swarmId, mailId, reader: address(ctx), time: clock() });
  return { observation: `已把 ${mailId} 标记为已读。`, detail: `标记已读 ${mailId}` };
}

/** 归档（从收件箱移走，不再占用未读配额） */
export function toolArchive(ctx: ToolContext, mailId: string): ToolResult {
  const box = ctx.store.getMailbox(address(ctx));
  if (!ctx.store.getMail(mailId) || !box) {
    return { observation: `归档失败：邮件或邮箱不存在。`, detail: "归档失败", refused: true };
  }
  ctx.store.append({ type: "mail.moved", swarmId: ctx.swarmId, mailId, owner: address(ctx), folder: "archive" });
  return { observation: `已归档 ${mailId}。`, detail: `归档 ${mailId}` };
}

/* ---------- 发信 ---------- */

function reportSend(label: string, result: ReturnType<typeof sendMail>, detail: string): ToolResult {
  if (isRefusal(result)) {
    return {
      observation: `${label}被拒绝（${result.status}）：${String(result.body.error ?? "")}`,
      detail: `${label}被拒：${String(result.body.error ?? "")}`,
      refused: true,
    };
  }
  const bounced = result.bounced.length > 0 ? `，退信 ${result.bounced.length} 封（${result.bounced[0]?.reason ?? ""}）` : "";
  const quota = result.quotaBlocked.length > 0 ? `，${result.quotaBlocked.length} 人收件箱已满未投递` : "";
  return {
    observation: `${label}成功，投递 ${result.delivered.length} 人${bounced}${quota}。邮件 id=${result.mail.id}`,
    detail,
  };
}

/** 发给指定的人（可写别名 all@<集群>.swarm） */
export function toolSendMail(
  ctx: ToolContext,
  input: { to: string[]; subject?: string; body: string; kind?: "agent" | "question" | "answer" | "verify" | "claim" },
): ToolResult {
  const result = sendMail(ctx.store, {
    swarmId: ctx.swarmId,
    from: ctx.agent,
    to: input.to,
    subject: input.subject ?? "",
    body: input.body,
    kind: input.kind ?? "agent",
  });
  return reportSend(`发信给 ${input.to.join(", ")}`, result, `发信给 ${input.to.join(", ")}`);
}

/** 回信：**默认只回原发件人**（闸 1），绝不 reply-all */
export function toolReply(ctx: ToolContext, input: { mailId: string; body: string }): ToolResult {
  const original = ctx.store.getMail(input.mailId);
  if (!original) {
    return { observation: `回信失败：邮件 ${input.mailId} 不存在。`, detail: "回信失败：邮件不存在", refused: true };
  }
  const result = sendMail(ctx.store, {
    swarmId: ctx.swarmId,
    from: ctx.agent,
    to: [], // 闸 1：不写收件人 → 只回原发件人
    replyTo: input.mailId,
    body: input.body,
    kind: "answer",
  });
  // 回信即已读：一条自然动作，别让大脑还要多花一轮去"清已读"
  if (!isRefusal(result) && ctx.store.deliveredTo(address(ctx), input.mailId)) {
    ctx.store.append({ type: "mail.read", swarmId: ctx.swarmId, mailId: input.mailId, reader: address(ctx), time: clock() });
  }
  return reportSend(`回信给 ${localOf(original.from)}`, result, `回信给 ${localOf(original.from)}`);
}

/** 广播：发给本集群所有人（含人类）。这是最容易炸的那条路，四道闸都盯着它 */
export function toolBroadcast(ctx: ToolContext, input: { body: string }): ToolResult {
  const result = sendMail(ctx.store, {
    swarmId: ctx.swarmId,
    from: ctx.agent,
    to: [`all@${ctx.swarmId}.swarm`],
    body: input.body,
    kind: "agent",
  });
  return reportSend("广播", result, "广播给全集群");
}

/* ---------- 任务 ---------- */

/**
 * 发布一条自己的工作到认领板 —— **发布即认领**，一次调用完成。
 *
 * 为什么要有它：认领板默认是空的。工作不是别人替你切好的，你要做什么就自己发布上去；
 * 别人打开看板就能看到"这片活在谁手上"。名字撞车时不标 refused（那通常只是
 * "这活已经有人做了"），让模型自己换个名字继续，别把它算成一次失败。
 */
/** 归一化切片名：只留汉字/字母/数字（去空白标点），用于识别"差一两个字"的同一件事。 */
function normSliceName(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const isHan = c >= 0x4e00 && c <= 0x9fff;
    const isAlnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (isHan || isAlnum) out += ch;
  }
  return out.toLowerCase();
}

/** 两片是不是"同一件事"：前 16 字相同 + 字符集重合度 >= 0.9。
 *  实测事故：exp-13/14 板上同时出现「把鹈鹕…」和「把鹈鹵…」两片，两个 agent 干同一件事。 */
/** 编辑距离（Levenshtein），只用于切片名去重 */
function editDistance(a: string, b: string): number {
  const prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev.push(j);
  for (let i = 1; i <= a.length; i += 1) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      const sub = last + (a[i - 1] === b[j - 1] ? 0 : 1);
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, sub);
      last = tmp;
    }
  }
  return prev[b.length];
}

/** 两片是不是"同一件事"：归一化后差 1~2 个字就算。
 *  实测事故：exp-13/14 板上同时有「把鹈鹕…」和「把鹈鹵…」，两个 agent 干同一件事。
 *  短名（< 8 字）只认完全相同 —— 否则「甲」「乙」会被判成重复。 */
export function looksSameSlice(a: string, b: string): boolean {
  const x = normSliceName(a);
  const y = normSliceName(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;
  if (x.length < 8 || y.length < 8) return false;
  if (Math.abs(x.length - y.length) > 3) return false;
  const d = editDistance(x, y);
  return d <= 2 && d / Math.max(x.length, y.length) <= 0.12;
}
export function toolPublishSlice(ctx: ToolContext, slice: string): ToolResult {
  const name = slice.trim().replace(/\s+/g, " ").slice(0, 60);
  if (name.length === 0) {
    return {
      observation: "切片名不能是空的。取个具体点的名字，比如「写 hello.py 并跑通」。",
      detail: "发布失败：名字为空",
    };
  }
  const exists = ctx.store.sliceByName(ctx.swarmId, name);
  if (exists) {
    const who = exists.claimedBy.length > 0 ? exists.claimedBy : "还没人接";
    return {
      observation:
        `认领板上已经有「${name}」了（${exists.status}，${who}）。要么自己发布一条新的工作，要么用 claim_slice 去认领没主的片。`,
      detail: `发布失败：板上已有「${name}」`,
    };
  }
    /* 近似重复闸（实测：exp-13/14 里「把鹈鹕…」与「把鹈鹵…」两份活同时存在，两个人干同一件事）。
       只看完全同名挡不住差一两个字的复制品。 */
    const twins = ctx.store
      .listSlices(ctx.swarmId)
      .filter((info) => info.status !== "completed" && looksSameSlice(info.slice, name));
    if (twins.length > 0) {
      const t = twins[0];
      const owner = t.claimedBy.length > 0 ? t.claimedBy : "还没人接";
      return {
        observation:
          "别重复造活：板上已经有一片几乎同名的「" + t.slice + "」（" + t.status + "，" + owner + "）。" +
          "它跟你这条只差一两个字 —— 直接 claim_slice 认领它，或者 send_mail 说清你要补什么，不要另开一片，" +
          "否则两个人会干同一件事、白烧一份预算。",
        detail: "发布失败：与现有切片近似重复（" + t.slice.slice(0, 24) + "）",
      };
    }
  /* 板上还有没人接的活，就先别自己造新活（系统预置的细粒度切片就是这时候用的）。
     分工过粗的根源就是"人人都想圈一块大的" —— PELICAN 3 里 6 个人造出 7 片，
     真正的产物只有一片，剩下的全是验证脚本。先接活、接完了才允许造血。 */
  const board = ctx.store.listSlices(ctx.swarmId);
  const free = board.filter((info) => info.status === "available");
  const mine = board.filter((info) => info.status === "claimed" && info.claimedBy === ctx.agent);
  if (free.length > 0 && mine.length === 0) {
    return {
      observation:
        "先别造新活：板上还有 " + free.length + " 片没人接 —— " +
        free.map((info) => "「" + info.slice + "」").join("、") +
        "。用 claim_slice 接一片（一次接一片，做完再发布你自己的新工作）。",
      detail: "发布被挡：板上有没人接的活，先接活再造血",
    };
  }
  const outcome = takeSlice(ctx.store, ctx.swarmId, ctx.agent, name);
  if (!outcome.ok) {
    return { observation: `发布「${name}」失败：${String(outcome.body.error)}。换个名字。`, detail: `发布失败：${name}` };
  }
  return {
    observation: `已发布并认领「${name}」—— 别人现在能在认领板上看到这片活在你手上。`,
    detail: `发布并认领切片：${name}`,
  };
}

export function toolClaimSlice(ctx: ToolContext, slice: string): ToolResult {
  const outcome = takeSlice(ctx.store, ctx.swarmId, ctx.agent, slice);
  if (!outcome.ok) {
    /* 认领冲突是正常的竞争结果（账本已经落了 collision.detected）。这里不标 refused ——
       否则它既算进失败数，又会触发失败自动重试，把调用次数撑得比步数还多。 */
    return {
      observation:
        "认领「" + slice + "」失败：" + String(outcome.body.error) + "（持有者 " + JSON.stringify(outcome.body.holders) + "）。",
      detail: "认领冲突：" + slice + "（换一片）",
    };
  }
  /* 人多活少时的共用：同一片现在有几个人一起干 —— 由系统把他们拉进同一条线，
     逼他们先对齐口径再动手（"通知同时干的模型一起讨论合并"）。 */
  if (outcome.shared && outcome.shared.length > 1) {
    const others = outcome.shared.filter((name) => name !== ctx.agent);
    mailSharedClaimLine(ctx.store, ctx.swarmId, slice, outcome.shared);
    return {
      observation:
        "已认领「" + slice + "」—— 但注意：这片现在有 " + outcome.shared.join("、") + " 一起干（板上没有别的空活了）。" +
        "系统已经发了群信，请先和 " + others.join("、") + " 对齐分工与坐标，交付前把产出合并成一份。",
      detail: "认领切片（共用 " + String(outcome.shared.length) + " 人）：" + slice,
    };
  }
  return { observation: "已认领「" + slice + "」。", detail: "认领切片：" + slice };
}

export function toolReleaseSlice(ctx: ToolContext, slice: string): ToolResult {
  ctx.store.append({ type: "claim.released", swarmId: ctx.swarmId, agent: ctx.agent, slice });
  return { observation: `已释放「${slice}」。`, detail: `释放切片：${slice}` };
}

/** 交付切片：看板流转到 completed，**并留下证据**（M6）
 *
 * 证据是这次 M6 的核心：以前只记「我交付了哪片」，于是验收根本无从谈起。
 * 现在必须写清「凭什么说它做完了」，它会落进 slice.completed 事件、看板卡片，
 * 并被收工汇报引用（收工理由不再是模板话）。
 */
/** 系统级验收闸：工作区根目录里 agent 自己写的验收脚本，交付前必须真的跑通。
 *  2026-09-18 exp-21 教训：闭卷下 swarm 自己写了一份 168 行的 CONTRACT.md 和 371 行的 check_layout.py，
 *  但脚本第 372 行就是语法错误，全队 10 个人没一个发现，交付照样记成 completed —— 契约写在纸上没人执行。
 *  所以改成：脚本跑不起来、或报 FAIL（非 0 退出），交付直接打回；输出挂进证据，让人看得见。 */
const CHECK_SCRIPT_RE = /^(check|verify|test)[a-z0-9_-]*\.py$|^[a-z0-9_-]*_check\.py$/i;

function runWorkspaceChecks(swarmId: string): { ok: boolean; note: string } {
  const dir = workspaceOf(swarmId);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => CHECK_SCRIPT_RE.test(n)).sort();
  } catch {
    return { ok: true, note: "" };
  }
  if (names.length === 0) return { ok: true, note: "" };
  const ran: string[] = [];
  for (const name of names.slice(0, 3)) {
    let r;
    try {
      r = spawnSync("python3", [name], { cwd: dir, encoding: "utf8", timeout: 90000, env: { ...process.env } });
    } catch {
      return { ok: false, note: "系统的验收闸没过：" + name + " 跑不动（超时或无法启动）。先把它修到能直接跑通再来交付。" };
    }
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    const tail = (out.length > 420 ? out.slice(out.length - 420) : out).replace(/\s+/g, " ");
    ran.push(name + " 退出码 " + String(r.status) + (tail ? "｜" + tail.slice(0, 160) : ""));
    if (r.status !== 0) {
      return {
        ok: false,
        note:
          "系统的验收闸没过：工作区里的验收脚本 " + name + " 没通过（退出码 " + String(r.status) + "）。" +
          "交付被打回 —— 先把脚本修到能无参数直接跑通（自己找到要检查的产物），或者去把 FAIL 的那一项修好。" +
          "实际输出：" + tail.slice(0, 300),
      };
    }
  }
  return { ok: true, note: "系统已跑过验收脚本：" + ran.join("；").slice(0, 280) };
}

export function toolCompleteSlice(ctx: ToolContext, slice: string, evidence = ""): ToolResult {
  const info = ctx.store.sliceByName(ctx.swarmId, slice);
  if (!info) {
    return { observation: "切片不存在：" + slice, detail: "交付失败：" + slice, refused: true };
  }
  if (info.status === "available") {
    return {
      observation: "没人认领的切片不能直接交付：" + slice + "。",
      detail: "交付失败：" + slice + "（未认领）",
      refused: true,
    };
  }
  /* 验收闸：跑 agent 自己写的验收脚本，不过就不许交付（"工程上的测试不过就继续造"）。 */
  const gate = runWorkspaceChecks(ctx.swarmId);
  if (!gate.ok) {
    return { observation: gate.note, detail: "交付被打回：" + slice + "（系统跑验收脚本没过）", refused: true };
  }
  ctx.store.append({ type: "slice.completed", swarmId: ctx.swarmId, slice, agent: ctx.agent, evidence: gate.note ? evidence + "｜" + gate.note : evidence, time: clock() });
  if (gate.note) {
    ctx.store.append({ type: "trace.appended", swarmId: ctx.swarmId, event: { swarmId: ctx.swarmId, agent: "system", type: "system", detail: "验收闸通过：" + gate.note.slice(0, 200), time: clock() } });
  }
  /* 共用片：交付后立刻通知同一条线上的其他人核对合并，别让共干者白干 */
  const line = [...new Set(ctx.store.listClaims(ctx.swarmId).filter((c) => c.slice === slice).map((c) => c.agent))].filter(
    (name) => name !== ctx.agent,
  );
  if (line.length > 0) {
    sendMail(ctx.store, {
      swarmId: ctx.swarmId,
      from: "system",
      to: line,
      subject: ctx.agent + " 已交付「" + slice + "」，请核对合并",
      body:
        ctx.agent + " 刚刚交付了你们共干的切片「" + slice + "」。\n" +
        "请立刻 read 它交付的文件和证据，核对和你手上的部分能不能合上（坐标、命名、动画时序）；合不上就发信说清要改哪一处。",
      kind: "system",
    });
    ctx.store.append({ type: "trace.appended", swarmId: ctx.swarmId, event: { swarmId: ctx.swarmId, agent: "system", type: "system", detail: "共用片交付：" + slice + " → 已通知同线 " + line.join("、") + " 核对合并", time: clock() } });
  }
  const proof = evidence.length > 0 ? "｜证据：" + evidence : "｜（没写证据）";
  return {
    observation: "已交付「" + slice + "」（看板 → completed）。" + (line.length > 0 ? "已通知同线 " + line.join("、") + " 核对合并。" : ""),
    detail: "交付切片：" + slice + proof,
  };
}

export function toolHandoff(
  ctx: ToolContext,
  input: { to: string; why: string; acceptance: string; progress: string; slice?: string },
): ToolResult {
  /* 结构化交接（抄 openai Agents SDK 的 handoff：转交必须带结构化字段）。
     裸发信的问题是：对方得来回问一轮，才知道要干什么、什么算完成。 */
  const to = String(input.to ?? "").trim();
  const why = String(input.why ?? "").trim();
  const acceptance = String(input.acceptance ?? "").trim();
  const progress = String(input.progress ?? "").trim();
  const miss: string[] = [];
  if (!to) miss.push("to（交给谁）");
  if (!why) miss.push("why（为什么交给你）");
  if (!acceptance) miss.push("acceptance（什么算完成）");
  if (!progress) miss.push("progress（我做到哪一步）");
  if (miss.length > 0) {
    return {
      observation: "交接失败：少写了 " + miss.join("、") + "。结构化交接四件套缺一不可 —— 少一个对方就得来回问一轮。",
      detail: "交接失败：字段不全",
      refused: true,
    };
  }
  const BR = String.fromCharCode(10);
  const slice = String(input.slice ?? "").trim();
  let released = false;
  if (slice.length > 0) {
    const held = ctx.store.sliceByName(ctx.swarmId, slice);
    if (held && held.status === "claimed" && held.claimedBy.includes(ctx.agent)) {
      released = releaseSlice(ctx.store, ctx.swarmId, slice, ctx.agent).ok;
    }
  }
  const mail = sendMail(ctx.store, {
    swarmId: ctx.swarmId,
    from: ctx.agent,
    to: [to],
    subject: "交接：" + (slice.length > 0 ? slice : "一件活") + " → " + to,
    body:
      "【结构化交接】" + ctx.agent + " → " + to + BR + BR +
      "· 为什么交给你：" + why + BR +
      "· 什么算完成（验收标准）：" + acceptance + BR +
      "· 我做到哪一步了：" + progress + BR +
      (slice.length > 0 ? "· 切片：" + slice + (released ? "（我已释放认领，你 claim_slice 接它）" : "（我还没释放，先对接）") + BR : "") +
      BR +
      "接活前先确认：能做就回信 + claim_slice；不能做就回信说清，别让活悬着。",
    kind: "claim",
  });
  if (isRefusal(mail)) {
    return { observation: "交接信没发出去", detail: "交接失败：发信被拒", refused: true };
  }
  ctx.store.append({
    type: "trace.appended",
    swarmId: ctx.swarmId,
    event: { swarmId: ctx.swarmId, agent: ctx.agent, type: "message", detail: "结构化交接 → " + to + "：" + (slice.length > 0 ? slice : why.slice(0, 24)), time: clock() },
  });
  return {
    observation: "已结构化交接给 " + to + "（to/why/acceptance/progress 四件套齐全）。" + (released ? "切片「" + slice + "」已释放，等对方认领。" : ""),
    detail: "结构化交接：" + to,
  };
}

export function toolDone(ctx: ToolContext, reason: string, confirm = "", stop: AgentStop = "done"): ToolResult {
  /* stop 也落进账本：外部（前端 / 收工报告 / 重放）必须能区分"自己说干完了"和"被按停" ——
     只把真相写在中文 reason 里，下游就只能靠猜。 */
  ctx.store.append({ type: "agent.done", swarmId: ctx.swarmId, agent: ctx.agent, reason, confirm, stop });
  const why = confirm.length > 0 ? "（验收：" + confirm + "）" : "";
  return {
    observation: "已收工：" + reason + why,
    detail: "收工：" + reason + why,
    done: true,
    reason,
    confirm,
    stop,
  };
}

/* ---------- 真·干活工具（M8）：在自己的工作目录里动手 ---------- */

/** 工具输出会原样塞回模型上下文：不截断会撑爆窗口、也会把界面卡死 */
function clip(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n…（已截断，原文 " + text.length + " 字符）";
}

function refuse(why: string, detail: string): ToolResult {
  return { observation: why, detail, refused: true };
}

/** 解析路径到工作目录内；越界/非法就返回一条拒绝，而不是抛出去炸掉整个循环 */
function safePath(ctx: ToolContext, filePath: string): string | ToolResult {
  try {
    return resolveInWorkspace(ctx.swarmId, filePath);
  } catch (error) {
    return refuse(String(error instanceof Error ? error.message : error), "路径被拒：" + filePath);
  }
}

/** 安装命令识别：pip/npm/pkg/apt/... install|add|get（允许前面有 sudo 和分号管道） */
const INSTALL_PATTERN = /(^|[;&|]\s*)(sudo\s+)?(pip3?|npm|pnpm|yarn|pkg|apt|apt-get|apk|gem|cargo|go|uv)\s+(install|add|get)\b/;

/** 跑一条 shell 命令。工作目录锁在集群工作目录里，超时和输出都有上限。 */
export function toolBash(ctx: ToolContext, command: string): ToolResult {
  /* 安装拦截（2026-09-17）：实测有 agent 为了一片"playwright 截图验收"的切片去 pip install playwright，
     白烧几十分钟 —— 而环境里早就装好了能干同样事的 chromium-browser。要新工具就走邮件找人装。 */
  if (SWARM_BLOCK_INSTALL && INSTALL_PATTERN.test(command)) {
    return refuse(
      "这条命令被系统挡了：智能体不许自己安装软件。环境里已经装好了：chromium-browser（无头截图，能真渲染 SMIL 动画：" +
        "chromium-browser --headless --screenshot=out.png --window-size=800,500 --virtual-time-budget=2000 file.svg）、" +
        "rsvg-convert、ImageMagick（convert / magick）、ffmpeg、python3（PIL / cairosvg / lxml / svglib）。" +
        "需要别的东西就在邮件里说、让人来装；现在换上面的工具把活干完。",
      "被拦：疑似安装命令",
    );
  }
  const cwd = workspaceOf(ctx.swarmId);
  const started = Date.now();
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    timeout: BASH_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SWARM_ID: ctx.swarmId, SWARM_AGENT: ctx.agent },
  });
  const ms = Date.now() - started;
  const code = result.status ?? (result.error ? 124 : 0);
  const failed = code !== 0;
  const parts = ["$ " + command, "退出码 " + code + (failed ? "（失败）" : "")];
  const stdout = clip(result.stdout ?? "");
  const stderr = clip(result.stderr ?? "");
  if (stdout.length > 0) parts.push("stdout:\n" + stdout);
  if (stderr.length > 0) parts.push("stderr:\n" + stderr);
  if (result.error && (result.error as { code?: string }).code === "ETIMEDOUT") {
    parts.push("（超过 " + BASH_TIMEOUT_MS + "ms 被强杀）");
  }
  return {
    observation: parts.join("\n"),
    detail: "$ " + clip(command, 100) + "  → 退出码 " + code + "（" + ms + "ms）",
    /* 非零退出是**正常的观察结果**：模型看到报错该自己改，而不是被当成"工具失败"去重试 */
    error: failed,
  };
}

/** 读工作目录里的文件（带行号，方便模型引用原文） */
export function toolReadFile(ctx: ToolContext, filePath: string, offset = 1, limit = 200): ToolResult {
  const target = safePath(ctx, filePath);
  if (typeof target !== "string") return target;
  if (!existsSync(target)) return refuse("文件不存在：" + filePath + "（先 ls 看看目录里有什么）", "读取失败：不存在 " + filePath);
  /* 读目录 / 读不动，都必须是**可观察的失败**，不能抛出去 ——
     PELICAN 8 真跑里 agent 对目录调了一次 read，异常一路穿过 turn/run 打到 /run 路由，
     一次 EISDIR 把 6 个 agent 的一整轮全带崩了（20 分钟白跑）。 */
  try {
    if (statSync(target).isDirectory()) {
      const entries = readdirSync(target).slice(0, 40);
      return refuse(
        "「" + filePath + "」是个**目录**，不是文件。它里面是：" +
          (entries.length > 0 ? entries.join("、") : "（空目录）") +
          "\n要读哪个就写具体的文件名。",
        "读取失败：这是目录 " + filePath,
      );
    }
  } catch (error) {
    return refuse(
      "读不了「" + filePath + "」：" + (error instanceof Error ? error.message : String(error)),
      "读取失败：" + filePath,
    );
  }
  let text = "";
  try {
    text = readFileSync(target, "utf8");
  } catch (error) {
    return refuse(
      "读文件出错「" + filePath + "」：" + (error instanceof Error ? error.message : String(error)),
      "读取失败：" + filePath,
    );
  }
  const lines = text.split("\n");
  const from = Math.max(1, offset);
  const shown = lines.slice(from - 1, from - 1 + Math.max(1, limit));
  if (shown.length === 0) return refuse("从第 " + from + " 行开始没内容了（共 " + lines.length + " 行）。", "读取越界：" + filePath);
  const rel = displayPath(ctx.swarmId, target);
  const body = shown.map((line, index) => from + index + "\t" + line).join("\n");
  return {
    observation: rel + "（共 " + lines.length + " 行，显示 " + from + "-" + (from + shown.length - 1) + "）：\n" + clip(body),
    detail: "读取 " + rel + "（" + lines.length + " 行）",
  };
}

/** 写文件（覆盖已有内容；父目录自动创建） */
/* ---------- 已交付文件保护（用户口径 2026-09-18）----------
   改构思是对的，但要**版本化**：旧版本必须留着（它就是历史交付），新方向另起文件名（_v2）。
   做法：任何一片已交付（completed）的 evidence 里出现过的文件名，都进保护名单，不许覆盖。 */
function deliveredPaths(ctx: ToolContext): Set<string> {
  const out = new Set<string>();
  for (const info of ctx.store.listSlices(ctx.swarmId)) {
    if (info.status !== "completed") continue;
    const ev = ctx.store.sliceEvidence(ctx.swarmId, info.slice) || "";
    for (const m of ev.matchAll(/[A-Za-z0-9_./-]+\.(?:svg|html|py|json|md|css|js|ts|txt|png)/g)) {
      out.add(m[0].replace(/^\.\//, ""));
    }
  }
  return out;
}

/** 命中保护名单就返回拒绝，否则 undefined */
function guardDelivered(ctx: ToolContext, rel: string): ToolResult | undefined {
  const delivered = deliveredPaths(ctx);
  const base = rel.split("/").pop() || rel;
  if (!delivered.has(rel) && !delivered.has(base)) return undefined;
  const dot = base.lastIndexOf(".");
  const v2 = dot > 0 ? base.slice(0, dot) + "_v2" + base.slice(dot) : base + "_v2";
  return {
    observation:
      "写入被挡：「" + rel + "」已经作为交付物存在了，**不许覆盖**。" + String.fromCharCode(10) +
      "改构思的正确做法（三步）：" + String.fromCharCode(10) +
      "1. 旧版本原样留着 —— 它就是历史交付，谁都不许删或改；" + String.fromCharCode(10) +
      "2. 新方向写到新文件名，比如「" + v2 + "」；" + String.fromCharCode(10) +
      "3. 交付时在 evidence 里写清三件事：为什么换方案 / 旧版本在哪个文件 / 新版比旧版好在哪。" + String.fromCharCode(10) +
      "（如果你只是要修一个 bug，也同样开 _v2，别动已交付的那份。）",
    detail: "写入被挡：试图覆盖已交付文件 " + rel,
    refused: true,
  };
}

export function toolWriteFile(ctx: ToolContext, filePath: string, content: string): ToolResult {
  const target = safePath(ctx, filePath);
  if (typeof target !== "string") return target;
  const rel = displayPath(ctx.swarmId, target);
  const blocked = guardDelivered(ctx, rel);
  if (blocked) return blocked;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return {
    observation: "已写入 " + rel + "（" + Buffer.byteLength(content, "utf8") + " 字节，" + content.split("\n").length + " 行）。",
    detail: "写入 " + rel + "（" + content.length + " 字符）",
  };
}

/** 改文件：把 old 精确替换成 new。old 必须**唯一出现**，否则不执行 —— 跟人类用的编辑工具一个脾气 */
export function toolEditFile(ctx: ToolContext, filePath: string, oldText: string, newText: string): ToolResult {
  const target = safePath(ctx, filePath);
  if (typeof target !== "string") return target;
  if (oldText.length === 0) return refuse("old 不能是空字符串。", "编辑失败：old 为空");
  if (!existsSync(target)) return refuse("文件不存在：" + filePath, "编辑失败：不存在 " + filePath);
  const editBlocked = guardDelivered(ctx, displayPath(ctx.swarmId, target));
  if (editBlocked) return editBlocked;
  const before = readFileSync(target, "utf8");
  const hits = before.split(oldText).length - 1;
  const rel = displayPath(ctx.swarmId, target);
  if (hits === 0) return refuse("没找到要替换的原文。先 read 一下确认（注意缩进和换行）。", "编辑失败：未匹配 " + rel);
  if (hits > 1) return refuse("要替换的原文出现了 " + hits + " 次，不唯一。多带几行上下文。", "编辑失败：匹配 " + hits + " 处 " + rel);
  writeFileSync(target, before.split(oldText).join(newText), "utf8");
  return { observation: "已修改 " + rel + "（替换 1 处）。", detail: "编辑 " + rel + "：替换 1 处" };
}

/* ---------- 工具清单：这份 schema 直接喂给真模型做 function calling ---------- */

export interface ToolParam {
  type: string;
  description: string;
  items?: { type: string };
}

export interface ToolSpec {
  name: string;
  /** 给人看的一句话（也当模型的工具描述用） */
  help: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParam>;
    required: string[];
  };
}

const NO_ARGS: ToolSpec["parameters"] = { type: "object", properties: {}, required: [] };

export const SWARMKIT: ToolSpec[] = [
  {
    name: "bash",
    help: "在自己的工作目录里跑一条 shell 命令（ls / cat / python3 都行）。工作目录是集群私有的，一律写相对路径。",
    parameters: { type: "object", properties: { command: { type: "string", description: "要执行的命令，例如 python3 hello.py" } }, required: ["command"] },
  },
  {
    name: "read",
    help: "读工作目录里的一个文本文件（带行号）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径" },
        offset: { type: "integer", description: "从第几行开始读，默认 1" },
        limit: { type: "integer", description: "最多读多少行，默认 200" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    help: "把内容写入工作目录里的文件（覆盖已有内容，父目录自动创建）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    help: "把文件里的一段原文精确替换掉。原文必须在文件里唯一出现，否则不执行。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径" },
        old: { type: "string", description: "要被替换的原文（含缩进，必须唯一）" },
        new: { type: "string", description: "替换成什么" },
      },
      required: ["path", "old", "new"],
    },
  },
  { name: "read_inbox", help: "看自己收件箱里的未读邮件（最老的在前）。", parameters: NO_ARGS },
  { name: "list_mailboxes", help: "列出本集群所有邮箱和各自未读数（谁在场、该找谁）。", parameters: NO_ARGS },
  {
    name: "mark_read",
    help: "把一封邮件标记为已读。",
    parameters: { type: "object", properties: { mail_id: { type: "string", description: "邮件 id" } }, required: ["mail_id"] },
  },
  {
    name: "archive",
    help: "归档一封邮件（从收件箱移走）。",
    parameters: { type: "object", properties: { mail_id: { type: "string", description: "邮件 id" } }, required: ["mail_id"] },
  },
  {
    name: "send_mail",
    help: "给指定的人发信。可以写 all@<集群>.swarm 发给全集群。要把活交给别人时，请用 handoff 工具（必须写清 why / acceptance / progress，比裸发信强）。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "收件人地址或别名" },
        body: { type: "string", description: "正文" },
        subject: { type: "string", description: "主题，可省略" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "reply",
    help: "回一封信，只回原发件人（不会群回）。",
    parameters: {
      type: "object",
      properties: { mail_id: { type: "string", description: "要回的邮件 id" }, body: { type: "string", description: "正文" } },
      required: ["mail_id", "body"],
    },
  },
  {
    name: "broadcast",
    help: "广播给全集群所有人。用之前想清楚：这条最容易吵到别人。",
    parameters: { type: "object", properties: { body: { type: "string", description: "正文" } }, required: ["body"] },
  },
  {
    name: "publish_slice",
    help: "发布一条你要做的工作（发布即认领）。认领板上没有你要做的事，就自己发布一条 —— 工作不是别人替你切好的。名字写具体，比如「写 hello.py 并跑通」。",
    parameters: { type: "object", properties: { slice: { type: "string", description: "切片名，写具体一点" } }, required: ["slice"] },
  },
  {
    name: "claim_slice",
    help: "认领一片**已经发布**在认领板上的工作（可以是别人发布、目前没主的）。板上还没有的，用 publish_slice 自己发布。",
    parameters: { type: "object", properties: { slice: { type: "string", description: "切片名" } }, required: ["slice"] },
  },
  {
    name: "release_slice",
    help: "释放自己认领的切片。",
    parameters: { type: "object", properties: { slice: { type: "string", description: "切片名" } }, required: ["slice"] },
  },
  {
    name: "complete_slice",
    help: "交付自己认领的切片。evidence 必填，写清三件事：做了什么 / 怎么验的（跑命令、截图、目测都算）/ 哪里没做完。**半成品照样可以交付** —— 说清边界比憋着强；**工作目录里如果有验收脚本（check_layout.py / verify.py 之类），把它的整张结果表原样贴进 evidence —— 表里有 FAIL 就不算完成。** 系统会在你交付时**自动跑**工作区根目录的 check*/verify*/test*.py（必须能**无参数**直接跑，退出码 0）；跑不起来或报 FAIL，这次交付会被**直接打回**。 墙钟 50% 和 80% 系统会点名催交付。",
    parameters: {
      type: "object",
      properties: {
        slice: { type: "string", description: "切片名" },
        evidence: { type: "string", description: "交付证据，要具体、可核对" },
      },
      required: ["slice", "evidence"],
    },
  },
  {
    name: "handoff",
    help: "把一件活**结构化交接**给别人（比裸发信强得多）：必须写清 to（交给谁）/ why（为什么交给你）/ acceptance（什么算完成）/ progress（我做到哪一步）。给了 slice 且在你名下，会自动释放认领，让对方 claim_slice 接手。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "交给谁（名字或别名）" },
        why: { type: "string", description: "为什么交给你" },
        acceptance: { type: "string", description: "什么算完成（可核对的验收标准）" },
        progress: { type: "string", description: "我做到哪一步了" },
        slice: { type: "string", description: "可选：一并交出去的切片名" },
      },
      required: ["to", "why", "acceptance", "progress"],
    },
  },
  {
    name: "done",
    help: "收工。confirm 里必须写清为什么判定这件事可以了；如果你不是独立验证者，要说清是谁验证过你的产出。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "收工理由" },
        confirm: { type: "string", description: "验收说明：为什么判定 OK" },
      },
      required: ["reason", "confirm"],
    },
  },
  {
    name: "challenge",
    help:
      "质疑：对**派工员切的板**或对同伴的产物/交付说明提出带证据的公开质询。被质疑者必须在宽限期内回应（不回应=认账，自动成立）；裁决成立后系统会**真的改板**：重开那片，或按你的 ask 新增一片。每人 3 次配额，被驳回才扣一格。空口质疑不受理 —— 必须带命令、实测数字、文件加行号。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "质疑谁：agent 名字，或 slicer（派工员写的板），或 all" },
        kind: { type: "string", description: "slicer | artifact | evidence | duplicate" },
        claim: { type: "string", description: "一句话主张：你认为哪里不对" },
        evidence: { type: "string", description: "证据：命令、实测数字、文件加行号 —— 空口质疑无效" },
        ask: { type: "string", description: "你要对方做的可执行最小动作" },
        slice: { type: "string", description: "可选：相关的片名" },
      },
      required: ["target", "kind", "claim", "evidence", "ask"],
    },
  },
  {
    name: "respond_challenge",
    help: "回应针对你的质疑（被质疑者的义务）。不回应会在宽限期后自动按「认账」成立并改板。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "质疑编号（#后面那 6 位）" },
        response: { type: "string", description: "你的回应：认账就说怎么改，不认就说为什么" },
        evidence: { type: "string", description: "可选：支撑你回应的实测证据" },
      },
      required: ["id", "response"],
    },
  },
  {
    name: "rule_challenge",
    help: "第三方裁决一条质疑（verdict=upheld 成立 / dismissed 驳回）。质疑者和被质疑者自己判无效；成立会真的改板（重开那片或按 ask 新增一片），驳回则质疑者扣一格配额。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "质疑编号" },
        verdict: { type: "string", description: "upheld | dismissed" },
        reason: { type: "string", description: "裁决理由" },
        evidence: { type: "string", description: "可选：你实测出来的依据" },
      },
      required: ["id", "verdict", "reason"],
    },
  },
];


/* ── 质疑（challenge）：设计说明见 src/challenges.ts ── */

export function toolChallenge(
  ctx: ToolContext,
  input: { target: string; kind: string; claim: string; evidence: string; ask: string; slice?: string },
): ToolResult {
  const r = raiseChallenge(ctx.store, {
    swarmId: ctx.swarmId,
    by: ctx.agent,
    target: String(input.target ?? ""),
    kind: String(input.kind ?? ""),
    slice: String(input.slice ?? ""),
    claim: String(input.claim ?? ""),
    evidence: String(input.evidence ?? ""),
    ask: String(input.ask ?? ""),
  });
  return {
    observation: r.message + "（你的质疑配额：还剩 " + String(challengeQuotaLeft(ctx.store, ctx.swarmId, ctx.agent)) + " 次）",
    detail: r.ok ? "提出质疑" : "质疑被拒",
    refused: !r.ok,
  };
}

export function toolRespondChallenge(
  ctx: ToolContext,
  input: { id: string; response: string; evidence?: string },
): ToolResult {
  const r = answerChallenge(ctx.store, {
    swarmId: ctx.swarmId,
    id: String(input.id ?? "").replace(/^#/, "").trim(),
    agent: ctx.agent,
    response: String(input.response ?? ""),
    evidence: String(input.evidence ?? ""),
  });
  return { observation: r.message, detail: r.ok ? "回应质疑" : "回应被拒", refused: !r.ok };
}

export function toolRuleChallenge(
  ctx: ToolContext,
  input: { id: string; verdict: string; reason: string; evidence?: string },
): ToolResult {
  const r = ruleChallenge(ctx.store, {
    swarmId: ctx.swarmId,
    id: String(input.id ?? "").replace(/^#/, "").trim(),
    agent: ctx.agent,
    verdict: String(input.verdict ?? ""),
    reason: String(input.reason ?? ""),
    evidence: String(input.evidence ?? ""),
  });
  return { observation: r.message, detail: r.ok ? "裁决质疑" : "裁决被拒", refused: !r.ok };
}
