/*
 * 后端 API 客户端（M2）：REST 读写 + WebSocket 实时流。
 * 默认连本机 8787；部署时用 VITE_API 覆盖。
 */
import type {
  AgentDetail,
  AgentEvent,
  AgentInfo,
  Mailbox,
  MessageData,
  SearchResult,
  SliceInfo,
  SwarmData,
  SwarmEvent,
  SwarmTotals,
  ThreadData,
  TraceEventData,
} from "../data";

function resolveBase(): string {
  const override = import.meta.env.VITE_API as string | undefined;
  if (override) return override;
  if (typeof window !== "undefined") {
    // 跟随页面地址：localhost 打开就连 localhost，手机用 LAN IP 打开就连同一个 IP
    return `${window.location.protocol}//${window.location.hostname}:8787`;
  }
  return "http://127.0.0.1:8787";
}

export const API_BASE: string = resolveBase();

export type StreamStatus = "connecting" | "open" | "closed";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} → ${response.status} ${detail.slice(0, 180)}`);
  }
  return (await response.json()) as T;
}

export interface CreateSwarmInput {
  goal: string;
  name?: string;
  model?: string;
  budget?: number;
  agentCount?: number;
  slices?: string[];
}

/** POST /api/swarms/:id/run 的返回：这一轮谁做了什么、花了多少 */
export interface RunStep {
  agent: string;
  tool: string;
  detail: string;
  observation: string;
  ms: number;
  tokens: number;
  cost: number;
  done: boolean;
  refused: boolean;
  /** 收工时说的话（只有 done 这一步有） */
  reason: string;
  /** 收工时给的验收说明（M7：为什么判定可以了） */
  confirm: string;
}

/** M7：真正收工的人 + 他给的验收说明 */
export interface RunFinisher {
  agent: string;
  reason: string;
  confirm: string;
  /** 收工方式：done = 自主收工；其余 = 被硬闸/故障按停 */
  stop: string;
}

export interface RunReport {
  swarmId: string;
  steps: number;
  mails: number;
  turns: Record<string, number>;
  stoppedBy: "all-done" | "max-turns" | "budget" | "swarm-stopped" | "no-agents" | "brain-error" | "time-limit";
  spend: number;
  budget: number;
  /** M7：谁真的收工了 + 各自给的验收说明 */
  finishers: RunFinisher[];
  /** 这次每个 agent 允许发多少封（后端按人头算：2 × 人数，下限 5、上限 50） */
  mailCap: number;
  /** 不是自主收工的成员（发信上限 / 预算 / 网关放弃）。空 = 全员自己判定干完 */
  incomplete: { agent: string; stop: string; reason: string }[];
  /** M8：履约情况 —— 让系统至少报一下"有人没动/没做完" */
  deliverables?: { claimed: number; completed: number; total: number };
  report: RunStep[];
}

export interface ClaimResult {
  slice: string;
  agent: string;
}

export const api = {
  health: () => request<{ ok: boolean; lastSeq: number; events: number }>("/api/health"),
  swarms: () => request<{ swarms: SwarmData[]; totals: SwarmTotals }>("/api/swarms"),
  swarm: (id: string) => request<SwarmData>(`/api/swarms/${id}`),
  agents: () => request<AgentInfo[]>("/api/agents"),
  threads: (swarmId: string) => request<ThreadData[]>(`/api/swarms/${swarmId}/threads`),
  thread: (swarmId: string, threadId: string) => request<ThreadData>(`/api/swarms/${swarmId}/threads/${threadId}`),
  messages: (swarmId: string, threadId: string, limit = 1000, to?: string) =>
    request<MessageData[]>(
      `/api/swarms/${swarmId}/threads/${threadId}/messages?limit=${limit}` +
        (to ? `&to=${encodeURIComponent(to)}` : ""),
    ),

  /** 单个邮箱（含未读/收件/已发送计数）—— 智能体详情页显示自己的地址与未读 */
  mailbox: (address: string) => request<Mailbox>(`/api/mailboxes/${encodeURIComponent(address)}`),
  mailboxes: (swarmId?: string) =>
    request<Mailbox[]>(`/api/mailboxes${swarmId ? `?swarmId=${encodeURIComponent(swarmId)}` : ""}`),
  trace: (swarmId: string, limit = 2000) => request<TraceEventData[]>(`/api/swarms/${swarmId}/trace?limit=${limit}`),
  claims: (swarmId: string) => request<ClaimResult[]>(`/api/swarms/${swarmId}/claims`),
  /** 看板（M6）：每个切片的 available/claimed/completed 与交付证据 */
  slices: (swarmId: string) => request<SliceInfo[]>(`/api/swarms/${swarmId}/slices`),
  completeSlice: (swarmId: string, slice: string, agent = "human", evidence = "") =>
    request<{ slice: string; status: string; agent: string; evidence: string }>(
      `/api/swarms/${swarmId}/slices/${encodeURIComponent(slice)}/complete`,
      { method: "POST", body: JSON.stringify({ agent, evidence }) },
    ),

  agentDetail: (name: string) => request<AgentDetail>(`/api/agents/${encodeURIComponent(name)}`),
  agentEvents: (name: string, kind = "all") =>
    request<AgentEvent[]>(`/api/agents/${encodeURIComponent(name)}/events?kind=${kind}`),
  search: (query: string, limit = 20) =>
    request<SearchResult>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`),

  startSwarm: (id: string) => request<unknown>(`/api/swarms/${id}/start`, { method: "POST", body: "{}" }),
  stopSwarm: (id: string, reason = "人工停止") =>
    request<unknown>(`/api/swarms/${id}/stop`, { method: "POST", body: JSON.stringify({ reason }) }),
  completeSwarm: (id: string, evidence = "") =>
    request<unknown>(`/api/swarms/${id}/complete`, { method: "POST", body: JSON.stringify({ evidence }) }),

  /** 删除集群：后端落一条 swarm.deleted 事件，删掉的东西重启后也不会回来 */
  deleteSwarm: (id: string) => request<{ deleted: string }>(`/api/swarms/${id}`, { method: "DELETE" }),

  /** 让智能体真的跑起来（M4）。同步返回本轮报告。 */
  run: (swarmId: string, options?: { maxTurns?: number; maxMails?: number; tokensPerTurn?: number }) =>
    request<RunReport>(`/api/swarms/${swarmId}/run`, {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    }),

  createSwarm: (input: CreateSwarmInput) =>
    request<{ swarm: SwarmData; thread: ThreadData; agents: string[] }>("/api/swarms", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createThread: (
    swarmId: string,
    input: { title?: string; members?: string[]; visibility?: "public" | "private"; createdBy?: string },
  ) =>
    request<ThreadData>(`/api/swarms/${swarmId}/threads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  postMessage: (swarmId: string, threadId: string, body: string, agent = "human", kind = "agent") =>
    request<MessageData>(`/api/swarms/${swarmId}/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, agent, kind }),
    }),

  claimSlice: (swarmId: string, agent: string, slice: string) =>
    request<ClaimResult>(`/api/swarms/${swarmId}/claims`, {
      method: "POST",
      body: JSON.stringify({ agent, slice }),
    }),

  releaseSlice: (swarmId: string, slice: string, agent?: string) =>
    request<{ released: string; agent: string }>(
      `/api/swarms/${swarmId}/claims?slice=${encodeURIComponent(slice)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`,
      { method: "DELETE" },
    ),
};

export interface StreamHandlers {
  onEvent: (event: SwarmEvent) => void;
  onStatus: (status: StreamStatus) => void;
  getLastSeq: () => number;
}

/**
 * 打开实时事件流（断线自动重连 + 用 since 补拉漏掉的事件）。
 * 返回关闭函数。
 */
export function openEventStream(handlers: StreamHandlers): () => void {
  let socket: WebSocket | null = null;
  let timer: number | undefined;
  let retry = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    handlers.onStatus("connecting");
    socket = new WebSocket(`${API_BASE.replace(/^http/, "ws")}/ws`);

    socket.onopen = () => {
      retry = 0;
      handlers.onStatus("open");
      socket?.send(JSON.stringify({ sub: "*" }));
      const since = handlers.getLastSeq();
      if (since > 0) socket?.send(JSON.stringify({ since }));
    };

    socket.onmessage = (raw) => {
      try {
        const message = JSON.parse(String(raw.data)) as { type: string; event?: SwarmEvent };
        if (message.type === "event" && message.event) handlers.onEvent(message.event);
      } catch {
        /* 坏帧忽略 */
      }
    };

    socket.onerror = () => socket?.close();

    socket.onclose = () => {
      if (closed) return;
      handlers.onStatus("closed");
      retry += 1;
      timer = window.setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(retry, 5)));
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    socket?.close();
  };
}
