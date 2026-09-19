/*
 * 发信的唯一实现（M3.5 闸门 + M4 工具层共用）。
 *
 * 为什么必须抽出来：智能体的 send_mail/reply/broadcast 和人类的 POST /api/mails
 * 是同一条路径。闸门（限流/配额/别名展开/房间归属）在这里写一遍，
 * 两边就不可能跑偏 —— 否则"agent 绕过了人类那条路的限流"这种洞迟早出现。
 */
import type { EventStore } from "./eventstore.ts";
import { addressOf, expandRecipients, localOf, parseAddress } from "./mail.ts";
import { guardSend } from "./storm-guard.ts";
import { STORM } from "./storm.ts";
import { bumpThread, dmThreadId, dmThreadTitle, makeThread } from "./threads.ts";
import { clock, messageId } from "./time.ts";
import type { MailData, MessageKind } from "./types.ts";

export interface SendInput {
  swarmId: string;
  /** 裸名字（human / peliscout）或完整地址 */
  from: string;
  /** 收件人（地址或别名）。留空 + 给了 replyTo → 只回原发件人（闸 1） */
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  kind?: MessageKind;
  /** 强制落到某个房间；不填则按收件人推导 */
  threadId?: string;
  replyTo?: string;
}

export interface SendResult {
  mail: MailData;
  delivered: string[];
  bounced: { address: string; reason: string }[];
  quotaBlocked: { address: string; unread: number }[];
}

export interface SendRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** 私信房间按需创建（幂等）：两个人名排序拼 id，同一个组合永远同一个房间 */
export function ensureDmThread(store: EventStore, swarmId: string, left: string, right: string, createdBy: string): string {
  const id = dmThreadId(left, right);
  if (store.getThread(swarmId, id)) return `${swarmId}/${id}`;

  const thread = makeThread({
    swarmId,
    id,
    title: dmThreadTitle(left, right),
    visibility: "private",
    members: [left, right],
    createdBy,
  });
  store.append({ type: "thread.created", thread });
  const swarm = store.getSwarm(swarmId);
  if (swarm) store.append({ type: "swarm.updated", swarm: { ...swarm, threads: swarm.threads + 1 } });
  return `${swarmId}/${id}`;
}

export function sendMail(store: EventStore, input: SendInput): SendResult | SendRefusal {
  const { swarmId, cc = [], subject = "", body, kind = "agent", replyTo = "" } = input;
  const swarm = store.getSwarm(swarmId);
  if (!swarm) return { status: 404, body: { error: "集群不存在", swarmId } };

  // 发件人：完整地址或裸名字
  let from: string;
  try {
    /* parseAddress 是「返回错误对象」不是抛异常，必须查 ok：
       否则非法地址会拿到 undefined，报错信息也会张冠李戴 */
    if (input.from.includes("@")) {
      const parsed = parseAddress(input.from, swarmId);
      if (!parsed.ok) return { status: 400, body: { error: "发件人地址非法", detail: parsed.reason } };
      from = parsed.address;
    } else {
      from = addressOf(input.from, swarmId);
    }
  } catch (error) {
    return { status: 400, body: { error: "发件人地址非法", detail: String(error) } };
  }
  if (!store.hasMailbox(from)) return { status: 400, body: { error: "发件人没有邮箱", from } };

  // 闸 2（每 agent 每分钟 ≤12 封）+ 闸 5（全集群每分钟 ≤300 封 → 暂停集群）
  const refusal = guardSend(store, swarmId, from);
  if (refusal) return refusal;

  // 闸 1：默认不 reply-all。写了 replyTo 又没写收件人 → 只回原发件人。
  const original = replyTo ? store.getMail(replyTo) : undefined;
  if (replyTo && !original) return { status: 404, body: { error: "被回复的邮件不存在", replyTo } };
  const recipients = [...input.to];
  if (recipients.length === 0) {
    if (!original) {
      return {
        status: 400,
        body: {
          error: "必须指定收件人",
          hint: "写了 replyTo 可以省略 to —— 会默认只回原发件人，不会回所有人",
        },
      };
    }
    recipients.push(original.from);
  }

  // 收件人展开（别名此刻先展一次，用于判定房间 + 返回退信）
  const roster = { swarmId, agents: swarm.agents };
  const expanded = expandRecipients([...recipients, ...cc], roster);

  // 房间归属
  let threadId: string;
  if (input.threadId) {
    const explicit = store.getThread(swarmId, input.threadId);
    if (!explicit) return { status: 404, body: { error: "线程不存在", threadId: input.threadId } };
    threadId = `${swarmId}/${explicit.id}`;
  } else if (original) {
    // 回复就留在原房间里（房间 = 完整档案，只有被回的人会收到通知）
    threadId = original.threadId;
  } else {
    const self = localOf(from);
    const others = [...new Set(expanded.delivered.map((address) => localOf(address)).filter((local) => local !== self))];
    if (others.length === 1) {
      threadId = ensureDmThread(store, swarmId, self, others[0], self);
    } else {
      threadId = `${swarmId}/primary`;
      if (!store.getThread(swarmId, "primary")) {
        const fallback = makeThread({
          swarmId,
          id: "broadcast",
          title: "BROADCAST",
          visibility: "public",
          members: swarm.agents,
          createdBy: self,
        });
        store.append({ type: "thread.created", thread: fallback });
        threadId = `${swarmId}/broadcast`;
      }
    }
  }

  // 闸 3：收件箱配额。投影里会做同样的跳过（确定性），这里只为审计 + 如实回复。
  const quotaBlocked = expanded.delivered
    .map((address) => ({ address, unread: store.getMailbox(address)?.unread ?? 0 }))
    .filter((item) => item.unread >= STORM.unreadQuota);
  const blocked = new Set(quotaBlocked.map((item) => item.address));
  const delivered = expanded.delivered.filter((address) => !blocked.has(address));

  const mail: MailData = {
    id: messageId(),
    swarmId,
    from,
    // 存**发件人写的原样**（可含别名），投递时按当时的名单再展开一次
    to: [...recipients],
    cc: [...cc],
    subject,
    body,
    chars: body.length,
    kind,
    threadId,
    replyTo,
    time: clock(),
  };
  store.append({ type: "mail.sent", mail });

  for (const bounce of expanded.bounced) {
    store.append({ type: "mail.bounced", swarmId, mailId: mail.id, recipient: bounce.address, reason: bounce.reason });
  }
  for (const item of quotaBlocked) {
    store.append({
      type: "mail.quota_exceeded",
      swarmId,
      mailId: mail.id,
      recipient: item.address,
      unread: item.unread,
      limit: STORM.unreadQuota,
    });
  }

  // 房间预览
  const localThreadId = threadId.slice(swarmId.length + 1);
  const thread = store.getThread(swarmId, localThreadId);
  if (thread) store.append({ type: "thread.updated", thread: bumpThread(thread, localOf(from), body) });

  return { mail, delivered, bounced: expanded.bounced, quotaBlocked };
}

/** 判断是不是"被拒绝"（区别于成功返回） */
export function isRefusal(value: SendResult | SendRefusal): value is SendRefusal {
  return "status" in value;
}

/** 人多活少时多人同干一片：由系统把同一条线上的人拉到一起，逼他们先对齐分工再动手。
 *  2026-09-18 需求：多个模型可以同时干一份工（人多的时候），需要通知同时干的模型一起讨论合并。 */
export function mailSharedClaimLine(store: EventStore, swarmId: string, slice: string, holders: string[]): void {
  if (holders.length < 2) return;
  const BR = String.fromCharCode(10);
  sendMail(store, {
    swarmId,
    from: "system",
    to: holders,
    subject: "同一片活儿现在有 " + String(holders.length) + " 个人一起干：" + slice,
    body:
      "板上已经没有别的空活了（人手比活多），所以把 " + holders.join("、") + " 排到了同一片：" + BR + "「" + slice + "」" + BR + BR +
      "你们现在在同一条工作线上，先别各画各的：" + BR +
      "1. 先用 send_mail / reply 说清：谁负责哪一部分、用哪套坐标（以 CONTRACT 为准）、各自产出放哪个文件；" + BR +
      "2. 分工定完再开工，别两个人改同一个文件、把对方的改动覆盖掉；" + BR +
      "3. 交付时把产出合并成一份再 complete_slice，证据里写清哪部分是谁做的。",
    kind: "system",
  });
}
