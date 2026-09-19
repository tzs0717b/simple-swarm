import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MOCK_LLM, VERSION } from "./config.ts";
import type { EventStore } from "./eventstore.ts";
import type { MessageData } from "./types.ts";

const messageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  before: z.string().optional(),
  /** 只看投给这个地址的消息（"只看发给我的"）；可写成 human / 不带域名的短地址 */
  to: z.string().min(1).max(120).optional(),
});

const traceQuery = z.object({
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

const eventsQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
});

/** 分页：消息按最新在前返回，before 传上一页最后一条的 id。 */
function paginate(messages: MessageData[], before: string | undefined, limit: number | undefined): MessageData[] {
  let list = messages;
  if (before) {
    const index = list.findIndex((message) => message.id === before);
    if (index >= 0) list = list.slice(index + 1);
  }
  return limit ? list.slice(0, limit) : list;
}

export function registerRoutes(app: FastifyInstance, store: EventStore): void {
  app.get("/api/health", async () => ({
    ok: true,
    version: VERSION,
    /* 大脑模式：客户端/自检靠它判断"现在跑的是 mock 还是真模型"。
       真模型模式下一轮 run 是真的花钱，自检必须先看这个再动手。 */
    mockLlm: MOCK_LLM,
    uptime: Math.round(process.uptime()),
    events: store.eventCount,
    lastSeq: store.lastSeq,
    corruptLines: store.corrupt,
    home: store.homeDir,
  }));

  /* ---------- 集群 ---------- */

  app.get("/api/swarms", async () => ({
    swarms: store.listSwarms(),
    totals: store.totals(),
  }));

  app.get("/api/swarms/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const swarm = store.getSwarm(id);
    if (!swarm) return reply.code(404).send({ error: "swarm not found", id });
    return swarm;
  });

  /* ---------- 线程 ---------- */

  app.get("/api/swarms/:id/threads", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSwarm(id)) return reply.code(404).send({ error: "swarm not found", id });
    return store.listThreads(id);
  });

  app.get("/api/swarms/:id/threads/:threadId", async (request, reply) => {
    const { id, threadId } = request.params as { id: string; threadId: string };
    const thread = store.getThread(id, threadId);
    if (!thread) return reply.code(404).send({ error: "thread not found", swarmId: id, threadId });
    return thread;
  });

  app.get("/api/swarms/:id/threads/:threadId/messages", async (request, reply) => {
    const { id, threadId } = request.params as { id: string; threadId: string };
    if (!store.getThread(id, threadId)) {
      return reply.code(404).send({ error: "thread not found", swarmId: id, threadId });
    }
    const parsed = messageQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    let all = store.listMessages(id, threadId);
    if (parsed.data.to) {
      // 短地址（human / peliscout）补上域名；跨集群地址直接查不到 → 空列表
      const raw = parsed.data.to;
      const address = raw.includes("@") ? raw.toLowerCase() : `${raw.toLowerCase()}@${id}.swarm`;
      all = store.listMessagesFor(id, threadId, address);
    }
    return paginate(all, parsed.data.before, parsed.data.limit);
  });

  /* ---------- 追踪 ---------- */

  app.get("/api/swarms/:id/claims", async (request, reply) => {
    const parsed = z.object({ id: z.string() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法" });
    if (!store.getSwarm(parsed.data.id)) return reply.code(404).send({ error: "集群不存在", id: parsed.data.id });
    return reply.send(store.listClaims(parsed.data.id));
  });

  /* 工作区版本留档（M12）：每个文件谁写过 —— write 工具和 bash heredoc 都算。 */
  app.get("/api/swarms/:id/files", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    return reply.send(store.listFiles(id));
  });

  app.get("/api/swarms/:id/trace", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSwarm(id)) return reply.code(404).send({ error: "swarm not found", id });
    const parsed = traceQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    return store.listTraces(id, parsed.data.limit ?? 0);
  });

  /* ---------- 智能体 ---------- */

  app.get("/api/agents", async () => store.listAgents());

  /* ---------- 原始事件流（调试 / 后续 WS 补拉用） ---------- */

  app.get("/api/events", async (request, reply) => {
    const parsed = eventsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    const events = store.listEvents(parsed.data.since ?? 0);
    return { count: events.length, lastSeq: store.lastSeq, events: events.slice(-200) };
  });
}
