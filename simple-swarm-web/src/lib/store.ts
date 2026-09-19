/*
 * 全局数据仓（M2）：启动时从 REST 水合，之后由 WebSocket 实时增量更新。
 * 组件用 hooks 订阅；数据变化自动重渲染，无需手动刷新。
 */
import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentDetail,
  AgentEvent,
  AgentInfo,
  MessageData,
  SliceInfo,
  SwarmData,
  SwarmEvent,
  SwarmState,
  SwarmTotals,
  ThreadData,
  TraceEventData,
} from "../data";
import { api, openEventStream, type CreateSwarmInput, type RunReport, type StreamStatus } from "./api";

const NO_THREADS: ThreadData[] = [];
const NO_MESSAGES: MessageData[] = [];
const NO_TRACES: TraceEventData[] = [];
const NO_SLICES: SliceInfo[] = [];
const NO_AGENTS: AgentInfo[] = [];
const NO_TOTALS: SwarmTotals = { swarms: 0, live: 0 };

export interface StoreState {
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  connection: StreamStatus;
  lastSeq: number;
  swarms: SwarmData[];
  totals: SwarmTotals;
  agents: AgentInfo[];
  threads: Record<string, ThreadData[]>;
  messages: Record<string, MessageData[]>;
  traces: Record<string, TraceEventData[]>;
  /** 看板（M6）：swarmId → 切片状态，跟着 WS 实时更新 */
  slices: Record<string, SliceInfo[]>;
  agentDetails: Record<string, AgentDetail>;
  agentEvents: Record<string, AgentEvent[]>;
}

let state: StoreState = {
  phase: "idle",
  error: null,
  connection: "connecting",
  lastSeq: 0,
  swarms: [],
  totals: NO_TOTALS,
  agents: NO_AGENTS,
  threads: {},
  messages: {},
  traces: {},
  slices: {},
  agentDetails: {},
  agentEvents: {},
};

const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): StoreState => state;

function totalsOf(swarms: SwarmData[]): SwarmTotals {
  return { swarms: swarms.length, live: swarms.filter((swarm) => swarm.state === "live").length };
}

/** 看板里替换某一片，保持原有顺序 */
function setSlice(board: SliceInfo[], slice: string, next: Omit<SliceInfo, "slice">): SliceInfo[] {
  return board.map((item) => (item.slice === slice ? { slice, ...next } : item));
}

/** 本地把某个集群连它的线程/消息/轨迹/看板缓存一起摘掉（与后端 removeSwarm 对齐） */
function withoutSwarm(id: string): Partial<StoreState> {
  const swarms = state.swarms.filter((swarm) => swarm.id !== id);
  const threads = { ...state.threads };
  delete threads[id];
  const traces = { ...state.traces };
  delete traces[id];
  const slices = { ...state.slices };
  delete slices[id];
  const messages: Record<string, MessageData[]> = {};
  for (const [key, list] of Object.entries(state.messages)) {
    if (!key.startsWith(`${id}/`)) messages[key] = list;
  }
  // 智能体是全局按名字登记的：只有不再属于任何集群的才从名单里去掉
  const agents = state.agents.filter((agent) => swarms.some((swarm) => swarm.agents.includes(agent.name)));
  return { swarms, totals: totalsOf(swarms), threads, traces, slices, messages, agents };
}

/* ---------- 事件应用（镜像后端投影） ---------- */

function applyEvent(event: SwarmEvent): void {
  const patch: Partial<StoreState> = { lastSeq: Math.max(state.lastSeq, event.seq) };

  switch (event.type) {
    case "swarm.created":
    case "swarm.updated": {
      const exists = state.swarms.some((swarm) => swarm.id === event.swarm.id);
      const swarms = exists
        ? state.swarms.map((swarm) => (swarm.id === event.swarm.id ? event.swarm : swarm))
        : [...state.swarms, event.swarm];
      patch.swarms = swarms;
      patch.totals = totalsOf(swarms);
      if (event.type === "swarm.created") {
        patch.slices = {
          ...state.slices,
          [event.swarm.id]: event.swarm.slices.map((slice) => ({
            slice,
            status: "available",
            claimedBy: "",
            evidence: "",
          })),
        };
      }
      break;
    }
    case "swarm.paused":
    case "swarm.started":
    case "swarm.stopped":
    case "swarm.completed": {
      const nextState: SwarmState =
        event.type === "swarm.started"
          ? "live"
          : event.type === "swarm.stopped" || event.type === "swarm.paused"
            ? "stopped"
            : "done";
      const swarms = state.swarms.map((swarm) =>
        swarm.id === event.swarmId
          ? {
              ...swarm,
              state: nextState,
              // 只有 swarm.started 会走到这里（其它三种 nextState 都不是 live）
              startedAt: nextState === "live" && !swarm.startedAt ? event.time : swarm.startedAt,
            }
          : swarm,
      );
      patch.swarms = swarms;
      patch.totals = totalsOf(swarms);
      break;
    }
    /* 删除也是事件：后端清投影，这里做同样的本地清理（别的标签页删了也能同步） */
    case "swarm.deleted": {
      Object.assign(patch, withoutSwarm(event.swarmId));
      break;
    }
    /* 看板（M6）：与后端投影逐条对齐，认领/交付在界面上当场动 */
    case "claim.taken": {
      /* 本地还没有看板也要接住：事件里带着切片名/认领人/证据，够拼一张卡片；
         后端才是真相，REST 拉回来会覆盖成完整看板。原先这里直接 break，
         导致"看板没跟上"时实时事件也被丢掉。 */
      const board = state.slices[event.swarmId] ?? [];
      patch.slices = {
        ...state.slices,
        [event.swarmId]: setSlice(board, event.slice, { status: "claimed", claimedBy: event.agent, evidence: "" }),
      };
      break;
    }
    case "claim.released": {
      /* 本地还没有看板也要接住：事件里带着切片名/认领人/证据，够拼一张卡片；
         后端才是真相，REST 拉回来会覆盖成完整看板。原先这里直接 break，
         导致"看板没跟上"时实时事件也被丢掉。 */
      const board = state.slices[event.swarmId] ?? [];
      patch.slices = {
        ...state.slices,
        [event.swarmId]: setSlice(board, event.slice, { status: "available", claimedBy: "", evidence: "" }),
      };
      break;
    }
    case "slice.completed": {
      /* 本地还没有看板也要接住：事件里带着切片名/认领人/证据，够拼一张卡片；
         后端才是真相，REST 拉回来会覆盖成完整看板。原先这里直接 break，
         导致"看板没跟上"时实时事件也被丢掉。 */
      const board = state.slices[event.swarmId] ?? [];
      const cur = board.find((item) => item.slice === event.slice);
      patch.slices = {
        ...state.slices,
        [event.swarmId]: setSlice(board, event.slice, {
          status: "completed",
          claimedBy: cur?.claimedBy ?? event.agent,
          evidence: event.evidence ?? "",
        }),
      };
      break;
    }
    case "thread.created":
    case "thread.updated": {
      const list = state.threads[event.thread.swarmId] ?? NO_THREADS;
      const exists = list.some((thread) => thread.id === event.thread.id);
      patch.threads = {
        ...state.threads,
        [event.thread.swarmId]: exists
          ? list.map((thread) => (thread.id === event.thread.id ? event.thread : thread))
          : [...list, event.thread],
      };
      break;
    }
    case "usage.recorded": {
      // 实时把这一步的 token/钱加到智能体和集群的计数器上（界面上的数字要当场动）
      patch.agents = state.agents.map((agent) =>
        agent.name === event.agent
          ? {
              ...agent,
              cost: agent.cost + event.cost,
              tokens: agent.tokens + event.tokens,
              readTokens: agent.readTokens + event.readTokens,
              writeTokens: agent.writeTokens + event.writeTokens,
              calls: agent.calls + 1,
              events: agent.events + 1,
              failures: agent.failures + (event.failed ? 1 : 0),
            }
          : agent,
      );
      patch.swarms = state.swarms.map((swarm) =>
        swarm.id === event.swarmId
          ? { ...swarm, cost: swarm.cost + event.cost, tokens: swarm.tokens + event.tokens, calls: swarm.calls + 1 }
          : swarm,
      );
      break;
    }

    case "agent.registered": {
      const exists = state.agents.some((agent) => agent.name === event.agent.name);
      patch.agents = exists
        ? state.agents.map((agent) => (agent.name === event.agent.name ? event.agent : agent))
        : [...state.agents, event.agent];
      break;
    }
    case "agent.done": {
      patch.agents = state.agents.map((agent) => (agent.name === event.agent ? { ...agent, live: false } : agent));
      /* 收工方式同步进集群状态：被硬闸按停的人，界面上必须看得出来（老事件没有 stop → 按 done） */
      patch.swarms = state.swarms.map((swarm) =>
        swarm.id === event.swarmId
          ? { ...swarm, stops: { ...(swarm.stops ?? {}), [event.agent]: event.stop ?? "done" } }
          : swarm,
      );
      break;
    }
    case "message.posted": {
      const key = event.message.threadId;
      const list = state.messages[key];
      if (!list) break; // 未加载过的线程不缓存，进页面时再拉
      if (list.some((message) => message.id === event.message.id)) break;
      patch.messages = { ...state.messages, [key]: [event.message, ...list] };
      break;
    }
    /* M3.3 起，发消息产生的是 mail.sent。这里做与后端 projectMail 相同的投影：
       MailData → MessageData（agent 取地址的 local 部分），线程视图因此零改动。 */
    case "mail.sent": {
      const mail = event.mail;
      const key = mail.threadId;
      const list = state.messages[key];
      if (!list) break;
      if (list.some((message) => message.id === mail.id)) break;
      const projected: MessageData = {
        id: mail.id,
        threadId: mail.threadId,
        time: mail.time,
        agent: mail.from.slice(0, mail.from.indexOf("@")),
        chars: mail.chars,
        kind: mail.kind,
        body: mail.body,
        broadcast: isBroadcastMail(mail.to, mail.cc),
      };
      const next = { ...state.messages, [key]: [projected, ...list] };
      // "只看发给我的"那份没法在客户端判断别名展开，直接作废，界面会自己重拉
      for (const existing of Object.keys(next)) {
        if (existing.startsWith(`${key}?to=`)) delete next[existing];
      }
      patch.messages = next;
      break;
    }
    case "trace.appended": {
      const key = event.event.swarmId;
      const trace = event.event;
      /* 工作步数：与后端投影同一套规则（重试/系统跳过不算干活）。
         刷点不能依赖 traces 是否加载过，所以独立于下面的缓存判断。 */
      if (trace.type !== "retry" && trace.type !== "system") {
        const threads = state.threads[key];
        if (threads) {
          patch.threads = {
            ...state.threads,
            [key]: threads.map((thread) => ({
              ...thread,
              members: thread.members.map((member) =>
                member.name === trace.agent ? { ...member, count: member.count + 1 } : member,
              ),
            })),
          };
        }
      }
      const list = state.traces[key];
      if (!list) break;
      if (list.some((item) => item.id === trace.id)) break;
      patch.traces = { ...state.traces, [key]: [trace, ...list] };
      break;
    }
    default:
      break;
  }

  setState(patch);
}

/* ---------- 实时流 ---------- */

let closeStream: (() => void) | null = null;

function startStream(): void {
  closeStream?.();
  closeStream = openEventStream({
    onEvent: applyEvent,
    onStatus: (connection) => setState({ connection }),
    getLastSeq: () => state.lastSeq,
  });
}

/* ---------- 动作 ---------- */

let booted = false;

export async function boot(force = false): Promise<void> {
  if (booted && !force) return;
  booted = true;
  setState({ phase: "loading", error: null });
  try {
    const [swarmPayload, agents] = await Promise.all([api.swarms(), api.agents()]);
    const lists = await Promise.all(
      swarmPayload.swarms.map(async (swarm) => [swarm.id, await api.threads(swarm.id)] as const),
    );
    const threads: Record<string, ThreadData[]> = {};
    for (const [id, list] of lists) threads[id] = list;
    setState({
      phase: "ready",
      error: null,
      swarms: swarmPayload.swarms,
      totals: swarmPayload.totals,
      agents,
      threads,
    });
    startStream();
  } catch (error) {
    setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

const inflight = new Set<string>();

export function ensureAgentDetail(name: string): void {
  const key = `agent:${name}`;
  if (state.agentDetails[name] || inflight.has(key)) return;
  inflight.add(key);
  void Promise.all([api.agentDetail(name), api.agentEvents(name, "all")])
    .then(([detail, events]) =>
      setState({
        agentDetails: { ...state.agentDetails, [name]: detail },
        agentEvents: { ...state.agentEvents, [name]: events },
      }),
    )
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
}

/** 收件人里写了别名就是群发 —— 与后端 storm.isBroadcast 同一套规则 */
const ALIAS_LOCALS = new Set(["all", "agents", "humans"]);
function isBroadcastMail(to: string[], cc: string[]): boolean {
  return [...to, ...cc].some((raw) => ALIAS_LOCALS.has(raw.split("@")[0].toLowerCase()));
}

/** 消息列表的 store key：全量用 swarm/thread；带收件人过滤的视图另存一份，互不覆盖 */
function messageKey(swarmId: string, threadId: string, to?: string): string {
  const base = `${swarmId}/${threadId}`;
  return to ? `${base}?to=${to}` : base;
}

export function ensureMessages(swarmId: string, threadId: string, to?: string): void {
  const key = messageKey(swarmId, threadId, to);
  if (state.messages[key] || inflight.has(key)) return;
  inflight.add(key);
  void api
    .messages(swarmId, threadId, 1000, to)
    .then((list) => setState({ messages: { ...state.messages, [key]: list } }))
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
}

export function ensureTrace(swarmId: string): void {
  if (state.traces[swarmId] || inflight.has(`trace:${swarmId}`)) return;
  inflight.add(`trace:${swarmId}`);
  void api
    .trace(swarmId)
    .then((list) => setState({ traces: { ...state.traces, [swarmId]: list } }))
    .catch(() => undefined)
    .finally(() => inflight.delete(`trace:${swarmId}`));
}

async function refreshMessages(swarmId: string, threadId: string): Promise<void> {
  const key = `${swarmId}/${threadId}`;
  const list = await api.messages(swarmId, threadId);
  setState({ messages: { ...state.messages, [key]: list } });
}

/**
 * 建线程（公开房间 / 私信）。后端对同一个私信组合是幂等的，
 * 这里把返回的线程并进 store，保证导航过去时页面已经有它。
 */
export async function createThread(
  swarmId: string,
  input: { title?: string; members?: string[]; visibility?: "public" | "private"; createdBy?: string },
): Promise<ThreadData> {
  const thread = await api.createThread(swarmId, input);
  const list = state.threads[swarmId] ?? [];
  if (!list.some((item) => item.id === thread.id)) {
    setState({ threads: { ...state.threads, [swarmId]: [...list, thread] } });
  }
  return thread;
}

export async function postMessage(swarmId: string, threadId: string, body: string): Promise<void> {
  await api.postMessage(swarmId, threadId, body);
  // 正常情况下 WS 会推回这条消息；WS 断开时兜底重新拉取
  if (state.connection !== "open") await refreshMessages(swarmId, threadId);
}

export async function createSwarm(input: CreateSwarmInput): Promise<SwarmData> {
  const created = await api.createSwarm(input);
  const threads = await api.threads(created.swarm.id);
  setState({ threads: { ...state.threads, [created.swarm.id]: threads } });
  return created.swarm;
}

/**
 * 让智能体跑起来（M4）。pending 的集群先 start。
 * 返回本轮报告给界面显示 —— 用户要能当场看到"谁做了什么、花了多少"。
 */
export async function runSwarm(
  swarmId: string,
  options?: { maxTurns?: number; maxMails?: number; tokensPerTurn?: number },
): Promise<RunReport> {
  const swarm = state.swarms.find((item) => item.id === swarmId);
  if (swarm?.state === "pending") await api.startSwarm(swarmId);
  const report = await api.run(swarmId, options);
  // 计数（cost/tokens/calls）由 WS 的 usage.recorded 推上来；集群状态可能变了，兜底拉一次
  const fresh = await api.swarm(swarmId);
  setState({ swarms: state.swarms.map((item) => (item.id === swarmId ? fresh : item)) });
  return report;
}

export async function claimSlice(swarmId: string, agent: string, slice: string): Promise<void> {
  await api.claimSlice(swarmId, agent, slice);
}

/** 删除集群：先本地摘掉让按钮立刻有反应；WS 没连通时再整仓重拉兜底 */
export async function deleteSwarm(id: string): Promise<void> {
  await api.deleteSwarm(id);
  setState(withoutSwarm(id));
  if (state.connection !== "open") await boot(true);
}

/* ---------- hooks ---------- */

function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useStatus(): { phase: StoreState["phase"]; error: string | null; connection: StreamStatus; lastSeq: number } {
  const current = useStore();
  return { phase: current.phase, error: current.error, connection: current.connection, lastSeq: current.lastSeq };
}

export function useSwarms(): SwarmData[] {
  return useStore().swarms;
}

export function useTotals(): SwarmTotals {
  return useStore().totals;
}

export function useSwarm(id: string | undefined): SwarmData | undefined {
  const current = useStore();
  if (!id) return undefined;
  return current.swarms.find((swarm) => swarm.id === id);
}

export function useAgents(): AgentInfo[] {
  return useStore().agents;
}

export function useThreads(swarmId: string | undefined): ThreadData[] {
  const current = useStore();
  if (!swarmId) return NO_THREADS;
  return current.threads[swarmId] ?? NO_THREADS;
}

export function useAllThreads(): ThreadData[] {
  const current = useStore();
  const live = new Set(current.swarms.filter((swarm) => swarm.state === "live").map((swarm) => swarm.id));
  const out: ThreadData[] = [];
  for (const [swarmId, list] of Object.entries(current.threads)) {
    if (live.has(swarmId)) out.push(...list);
  }
  return out;
}

export function useThread(swarmId: string | undefined, threadId: string | undefined): ThreadData | undefined {
  const current = useStore();
  if (!swarmId || !threadId) return undefined;
  return (current.threads[swarmId] ?? NO_THREADS).find((thread) => thread.id === threadId);
}

export function useMessages(
  swarmId: string | undefined,
  threadId: string | undefined,
  to?: string,
): MessageData[] {
  const current = useStore();
  const key = swarmId && threadId ? messageKey(swarmId, threadId, to) : "";
  // loaded 作为依赖：新邮件到达时"只看发给我的"那份缓存会被作废，这里要能重新拉回来
  const loaded = key ? current.messages[key] !== undefined : false;
  useEffect(() => {
    if (swarmId && threadId && !loaded) ensureMessages(swarmId, threadId, to);
  }, [swarmId, threadId, to, loaded]);
  if (!key) return NO_MESSAGES;
  return current.messages[key] ?? NO_MESSAGES;
}

export function useTrace(swarmId: string | undefined): TraceEventData[] {
  const current = useStore();
  useEffect(() => {
    if (swarmId) ensureTrace(swarmId);
  }, [swarmId]);
  if (!swarmId) return NO_TRACES;
  return current.traces[swarmId] ?? NO_TRACES;
}

/** 消息是否还没第一次加载完（undefined = 未加载过，[] = 加载过但为空）。 */
export function useMessagesLoading(
  swarmId: string | undefined,
  threadId: string | undefined,
  to?: string,
): boolean {
  const current = useStore();
  if (!swarmId || !threadId) return false;
  return current.messages[messageKey(swarmId, threadId, to)] === undefined;
}

export function useTraceLoading(swarmId: string | undefined): boolean {
  const current = useStore();
  if (!swarmId) return false;
  return current.traces[swarmId] === undefined;
}

export function useAgentDetail(name: string | undefined): AgentDetail | undefined {
  const current = useStore();
  useEffect(() => {
    if (name) ensureAgentDetail(name);
  }, [name]);
  if (!name) return undefined;
  return current.agentDetails[name];
}

export function useAgentEvents(name: string | undefined): AgentEvent[] {
  const current = useStore();
  const EMPTY: AgentEvent[] = [];
  useEffect(() => {
    if (name) ensureAgentDetail(name);
  }, [name]);
  if (!name) return EMPTY;
  return current.agentEvents[name] ?? EMPTY;
}

export function useAgent(name: string): AgentInfo | undefined {
  const current = useStore();
  return current.agents.find((agent) => agent.name === name);
}

/* ---------- 看板（M6） ---------- */

/* 哪些集群的看板已经真的从后端拉过一次了。
   绝对不能拿 "state.slices[swarmId] 是不是空的" 当判断 —— 空数组是 truthy，
   而 swarm.created 事件会给每个新集群先塞一个空看板（默认切片本来就是空的），
   于是：一进看板页，fetch 被守卫挡掉；万一真去 fetch 又失败了（比如后端刚被杀），
   空数组会让它"看起来已经加载过"，从此再也不重试 —— 看板永久空白。
   这就是"点进去啥都没有"的根因。 */
const loadedSlices = new Set<string>();

/* 第二层根因（2026-09-17 用户反馈）：拉取失败或拉到空数组时被静默吞掉，页面分不清
   "真空看板"和"根本没拉到"，一旦判空就再也不重试 —— 表现就是永久空白。
   所以：失败/空 -> 2.5 秒后自动重拉，最多 40 次（100 秒）；真拿到片就停。 */
const sliceRetry = new Map<string, ReturnType<typeof setTimeout>>();
const sliceRetries = new Map<string, number>();

function scheduleSliceRetry(swarmId: string): void {
  const attempts = (sliceRetries.get(swarmId) ?? 0) + 1;
  sliceRetries.set(swarmId, attempts);
  if (attempts > 40) return; /* 100 秒还没片：不骚扰后端了，交给「刷新」按钮 */
  if (sliceRetry.has(swarmId)) return;
  sliceRetry.set(
    swarmId,
    setTimeout(() => {
      sliceRetry.delete(swarmId);
      loadedSlices.delete(swarmId);
      ensureSlices(swarmId);
    }, 2500),
  );
}

export function ensureSlices(swarmId: string, force = false): void {
  if (!force && loadedSlices.has(swarmId)) return;
  if (inflight.has(`slices:${swarmId}`)) return;
  inflight.add(`slices:${swarmId}`);
  const seqAtStart = state.lastSeq;
  void api
    .slices(swarmId)
    .then((list) => {
      if (list.length === 0) {
        /* 空看板不等于等于空：集群可能刚 start、派工员还在切片 -> 过一会儿再拉 */
        scheduleSliceRetry(swarmId);
      } else {
        sliceRetries.delete(swarmId); /* 真拿到片了，重试计数清零 */
        loadedSlices.add(swarmId);
      }
      const board = state.slices[swarmId];
      /* 竞态修复：拉取期间 WS 又落了事件（seq 前进），REST 那份就是旧的。
         这时只补 REST 里有、看板里没有的片；冲突时以看板（更新）为准。
         force=true（用户点刷新）时强制覆盖。 */
      if (!force && board && state.lastSeq > seqAtStart) {
        const names = new Set(board.map((item) => item.slice));
        const merged = [...board, ...list.filter((item) => !names.has(item.slice))];
        setState({ slices: { ...state.slices, [swarmId]: merged } });
      } else {
        setState({ slices: { ...state.slices, [swarmId]: list } });
      }
    })
    .catch(() => {
      /* 后端刚重启/断连也会走到这里 —— 不能装作空看板，要自动重试 */
      scheduleSliceRetry(swarmId);
    })
    .finally(() => inflight.delete(`slices:${swarmId}`));
}

export function useSlices(swarmId: string | undefined): SliceInfo[] {
  const current = useStore();
  useEffect(() => {
    /* 无条件调：拉没拉过由 ensureSlices 内部的 loadedSlices 记账 */
    if (swarmId) ensureSlices(swarmId);
  }, [swarmId, current.slices]);
  if (!swarmId) return NO_SLICES;
  return current.slices[swarmId] ?? NO_SLICES;
}

/** 人工把某片标记为已交付（看板上的按钮）；证据由调用方写明 */
export async function completeSlice(
  swarmId: string,
  slice: string,
  evidence = "",
  agent = "human",
): Promise<void> {
  await api.completeSlice(swarmId, slice, agent, evidence);
  if (state.connection !== "open") ensureSlicesRefresh(swarmId);
}

/** 强制重拉看板（WS 没连通时的兜底） */
function ensureSlicesRefresh(swarmId: string): void {
  ensureSlices(swarmId, true);
}
