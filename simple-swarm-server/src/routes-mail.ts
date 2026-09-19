/*
 * 邮箱接口（M3.1：只读骨架 —— 列邮箱、查单个邮箱）。
 * M3.2 起会在这里挂上收件箱 / 已发送 / 归档 / 回执。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "./eventstore.ts";
import { addressOf, formatAddress, localOf, parseAddress, SHARED_LOCALS } from "./mail.ts";
import { isRefusal, sendMail } from "./send.ts";
import { clock, messageId } from "./time.ts";
import { bumpThread } from "./threads.ts";
import type { MailData, MailFolder, Mailbox, MessageKind } from "./types.ts";

const MAIL_KINDS: MessageKind[] = [
  "agent",
  "system",
  "goal",
  "claim",
  "question",
  "answer",
  "verify",
  "collision",
  "signoff",
];

const sendMailSchema = z.object({
  swarmId: z.string().min(1).max(80),
  /** 发件人：裸名字（human / peliscout）或完整地址 */
  from: z.string().min(1).max(80).default("human"),
  /** 收件人：地址或别名（all@ / agents@ / humans@，可省略域名）。
      可以省略 —— 前提是写了 replyTo，此时默认**只回原发件人**（闸 1：默认不 reply-all）。 */
  to: z.array(z.string().min(1).max(120)).max(64).default([]),
  cc: z.array(z.string().min(1).max(120)).max(64).default([]),
  subject: z.string().max(200).default(""),
  body: z.string().min(1).max(8000),
  kind: z.enum(MAIL_KINDS as [MessageKind, ...MessageKind[]]).default("agent"),
  /** 落到哪个房间；不填则按收件人推导 */
  threadId: z.string().min(1).max(80).optional(),
  replyTo: z.string().min(1).max(80).default(""),
});

/** 附加"同域内省略域名"的短显示名，纯展示用 */
function withShortName(mailbox: Mailbox): Mailbox & { shortName: string } {
  return { ...mailbox, shortName: formatAddress(mailbox.address, mailbox.swarmId) };
}

export function registerMailRoutes(app: FastifyInstance, store: EventStore): void {
  /* ---------- 发信（人类的插话/写信；智能体走同一套 sendMail，见 src/send.ts） ---------- */
  app.post("/api/mails", async (request, reply) => {
    const parsed = sendMailSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法", issues: parsed.error.issues });

    const result = sendMail(store, parsed.data);
    if (isRefusal(result)) return reply.code(result.status).send(result.body);
    return reply.code(201).send(result);
  });

  /* ---------- 标记已读 ---------- */
  app.post("/api/mails/:id/read", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const parsed = z.object({ reader: z.string().min(1).max(120) }).safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });

    const mail = store.getMail(params.data.id);
    if (!mail) return reply.code(404).send({ error: "邮件不存在", id: params.data.id });

    let reader = parsed.data.reader;
    if (reader.includes("@")) {
      const addr = parseAddress(reader, mail.swarmId);
      if (!addr.ok) return reply.code(400).send({ error: "读者地址非法", detail: addr.reason });
      reader = addr.address;
    } else {
      reader = addressOf(reader, mail.swarmId);
    }
    const box = store.getMailbox(reader);
    if (!box) return reply.code(404).send({ error: "邮箱不存在", reader });

    store.append({ type: "mail.read", swarmId: mail.swarmId, mailId: mail.id, reader, time: clock() });
    return reply.send({ ok: true, mailId: mail.id, reader, mailbox: store.getMailbox(reader) });
  });

  /* ---------- 归档 / 删除 / 移回收件箱 ---------- */
  app.post("/api/mails/:id/move", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const parsed = z
      .object({
        owner: z.string().min(1).max(120),
        folder: z.enum(["inbox", "sent", "archive", "trash"]),
      })
      .safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "参数非法" });

    const mail = store.getMail(params.data.id);
    if (!mail) return reply.code(404).send({ error: "邮件不存在", id: params.data.id });

    let owner = parsed.data.owner;
    if (owner.includes("@")) {
      const addr = parseAddress(owner, mail.swarmId);
      if (!addr.ok) return reply.code(400).send({ error: "所有者地址非法", detail: addr.reason });
      owner = addr.address;
    } else {
      owner = addressOf(owner, mail.swarmId);
    }
    if (!store.getMailbox(owner)) return reply.code(404).send({ error: "邮箱不存在", owner });

    store.append({
      type: "mail.moved",
      swarmId: mail.swarmId,
      mailId: mail.id,
      owner,
      folder: parsed.data.folder as MailFolder,
    });
    return reply.send({ ok: true, mailId: mail.id, owner, folder: parsed.data.folder, mailbox: store.getMailbox(owner) });
  });

  app.get("/api/mailboxes", async (request, reply) => {
    const parsed = z
      .object({ swarmId: z.string().optional() })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法" });
    const { swarmId } = parsed.data;
    if (swarmId && !store.getSwarm(swarmId)) return reply.code(404).send({ error: "集群不存在", swarmId });
    return reply.send(store.listMailboxes(swarmId).map(withShortName));
  });

  /* 收件箱 / 已发送 / 归档 / 已删除 */
  app.get("/api/mailboxes/:address/mails", async (request, reply) => {
    const params = z.object({ address: z.string() }).safeParse(request.params);
    const query = z
      .object({
        folder: z.enum(["inbox", "sent", "archive", "trash"]).default("inbox"),
        limit: z.coerce.number().int().min(1).max(2000).default(200),
      })
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数非法" });

    const address = decodeURIComponent(params.data.address).toLowerCase();
    if (!store.getMailbox(address)) return reply.code(404).send({ error: "邮箱不存在", address });

    const { folder, limit } = query.data;
    return reply.send({
      address,
      folder,
      count: store.listMailboxMails(address, folder as MailFolder, limit).length,
      mails: store.listMailboxMails(address, folder as MailFolder, limit),
    });
  });

  /* 地址里含 @，既支持 URL 编码也支持原样（Fastify 会解码） */
  app.get("/api/mailboxes/:address", async (request, reply) => {
    const parsed = z.object({ address: z.string() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法" });
    const address = decodeURIComponent(parsed.data.address).toLowerCase();
    const mailbox = store.getMailbox(address);
    if (!mailbox) return reply.code(404).send({ error: "邮箱不存在", address });
    return reply.send(withShortName(mailbox));
  });
}
