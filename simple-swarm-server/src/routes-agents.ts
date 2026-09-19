/*
 * 智能体视图接口：单个智能体详情、单智能体事件流、全局搜索。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "./eventstore.ts";
import type { AgentDetail, AgentEvent, AgentInfo, SearchHit, SearchResult, TraceEventData } from "./types.ts";

/** 把 trace 类型归到界面上的分页签 */
function traceKind(event: TraceEventData): AgentEvent["kind"] {
  if (event.status === "error") return "failure";
  if (event.type === "thinking") return "thinking";
  return "tool";
}

function toAgentEvent(event: TraceEventData): AgentEvent {
  return {
    id: event.id,
    time: event.time,
    kind: traceKind(event),
    action: event.type,
    detail: event.detail,
    ms: event.ms,
  };
}

/** HH:MM:SS → 便于排序 */
function clockOrZero(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

export function registerAgentRoutes(app: FastifyInstance, store: EventStore): void {
  /* ---------- 单个智能体详情 ---------- */
  app.get("/api/agents/:name", async (request, reply) => {
    const parsed = z.object({ name: z.string() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "参数非法" });
    const { name } = parsed.data;

    const agent = store.listAgents().find((item) => item.name === name);
    if (!agent) return reply.code(404).send({ error: "智能体不存在", name });

    const swarms = store
      .listSwarms()
      .filter((swarm) => swarm.agents.includes(name))
      .map((swarm) => ({ id: swarm.id, name: swarm.name }));

    const threads = swarms.flatMap((swarm) =>
      store
        .listThreads(swarm.id)
        .filter((thread) => thread.members.some((member) => member.name === name))
        .map((thread) => ({
          swarmId: swarm.id,
          threadId: thread.id,
          title: thread.title,
          messageCount: thread.messageCount,
        })),
    );

    const traces = store.tracesOfAgent(name);
    const messages = store.messagesOfAgent(name);
    const sessions = store.sessionsOfAgent(name);

    const detail: AgentDetail = {
      agent,
      swarms,
      threads,
      counts: {
        messages: messages.length,
        tools: traces.filter((event) => traceKind(event) === "tool").length,
        thinking: traces.filter((event) => event.type === "thinking").length,
        failures: traces.filter((event) => event.status === "error").length,
        sessions: sessions.length,
      },
    };
    return reply.send(detail);
  });

  /* ---------- 单个智能体的事件流（分页签用） ---------- */
  app.get("/api/agents/:name/events", async (request, reply) => {
    const params = z.object({ name: z.string() }).safeParse(request.params);
    const query = z
      .object({
        kind: z.enum(["all", "messages", "tools", "thinking", "failures", "sessions"]).default("all"),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      })
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "参数非法" });
    const { name } = params.data;
    if (!store.hasAgent(name)) return reply.code(404).send({ error: "智能体不存在", name });

    const { kind, limit } = query.data;
    const events: AgentEvent[] = [];

    if (kind === "all" || kind === "messages") {
      for (const message of store.messagesOfAgent(name)) {
        events.push({
          id: message.id,
          time: message.time,
          kind: "message",
          action: `message:${message.kind}`,
          detail: JSON.stringify({ thread: message.threadId, chars: message.chars, body: message.body.slice(0, 400) }),
          ms: 0,
        });
      }
    }
    if (kind === "all" || kind === "tools" || kind === "thinking" || kind === "failures") {
      for (const trace of store.tracesOfAgent(name)) {
        const mapped = traceKind(trace);
        if (kind === "tools" && mapped !== "tool") continue;
        if (kind === "thinking" && mapped !== "thinking") continue;
        if (kind === "failures" && mapped !== "failure") continue;
        events.push(toAgentEvent(trace));
      }
    }
    if (kind === "all" || kind === "sessions") {
      for (const session of store.sessionsOfAgent(name)) {
        events.push({
          id: `session-${session.seq}`,
          time: session.time,
          kind: "session",
          action: "done",
          detail: JSON.stringify({ reason: session.reason, confirm: session.confirm, at: session.at }),
          ms: 0,
        });
      }
    }

    events.sort((a, b) => clockOrZero(b.time) - clockOrZero(a.time) || b.id.localeCompare(a.id));
    return reply.send(events.slice(0, limit));
  });

  /* ---------- 全局搜索：集群 / 线程 / 智能体 / 消息 ---------- */
  app.get("/api/search", async (request, reply) => {
    const query = z
      .object({ q: z.string().default(""), limit: z.coerce.number().int().min(1).max(100).default(20) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "参数非法" });
    const needle = query.data.q.trim().toLowerCase();
    const limit = query.data.limit;

    if (needle.length === 0) {
      const empty: SearchResult = { query: "", total: 0, swarms: [], threads: [], agents: [], messages: [] };
      return reply.send(empty);
    }

    const swarms: SearchHit[] = store
      .listSwarms()
      .filter((swarm) => matches(swarm.id, needle) || matches(swarm.name, needle) || matches(swarm.model, needle))
      .slice(0, limit)
      .map((swarm) => ({
        kind: "swarm",
        id: swarm.id,
        title: swarm.name,
        subtitle: `${swarm.state} · ${swarm.model} · ${swarm.agents.length} 智能体`,
        swarmId: swarm.id,
        threadId: "",
        agent: "",
        time: swarm.startedAt,
      }));

    const threads: SearchHit[] = [];
    for (const swarm of store.listSwarms()) {
      for (const thread of store.listThreads(swarm.id)) {
        if (matches(thread.title, needle) || matches(thread.id, needle) || matches(thread.preview, needle)) {
          threads.push({
            kind: "thread",
            id: thread.id,
            title: thread.title,
            subtitle: `${swarm.name} · ${thread.messageCount} 消息 · ${thread.members.length} 成员`,
            swarmId: swarm.id,
            threadId: thread.id,
            agent: thread.previewAgent,
            time: thread.createdAt,
          });
        }
      }
    }

    const agents: SearchHit[] = store
      .listAgents()
      .filter((agent: AgentInfo) => matches(agent.name, needle) || matches(agent.role, needle))
      .slice(0, limit)
      .map((agent) => ({
        kind: "agent",
        id: agent.name,
        title: agent.name,
        subtitle: `${agent.role || "未认领"} · ${agent.calls} calls · $${agent.cost.toFixed(4)}`,
        swarmId: "",
        threadId: "",
        agent: agent.name,
        time: agent.activeTo,
      }));

    const messages: SearchHit[] = [];
    for (const swarm of store.listSwarms()) {
      for (const thread of store.listThreads(swarm.id)) {
        for (const message of store.listMessages(swarm.id, thread.id)) {
          if (matches(message.body, needle) || matches(message.agent, needle)) {
            messages.push({
              kind: "message",
              id: message.id,
              title: message.body.replace(/\\s+/g, " ").slice(0, 90),
              subtitle: `${message.agent} · ${thread.title}`,
              swarmId: swarm.id,
              threadId: thread.id,
              agent: message.agent,
              time: message.time,
            });
          }
        }
      }
    }
    messages.sort((a, b) => b.time.localeCompare(a.time));

    const result: SearchResult = {
      query: query.data.q,
      total: swarms.length + threads.length + agents.length + messages.length,
      swarms: swarms.slice(0, limit),
      threads: threads.slice(0, limit),
      agents: agents.slice(0, limit),
      messages: messages.slice(0, limit),
    };
    return reply.send(result);
  });
}
