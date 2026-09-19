/*
 * 类型契约（与后端 simple-swarm-server/src/types.ts 一一对应）。
 * M2 起数据来自后端 API，本文件只保留类型与纯计算辅助函数。
 */
import { marks } from "./lib/theme";

/** 集群生命周期：pending → live → stopped / done */
export type SwarmState = "pending" | "live" | "stopped" | "done";

export interface DodResult {
  criterion: string;
  passed: boolean;
  evidence: string;
}
export type ThreadState = "running" | "dormant";
export type ViewMode = "all" | "preview" | "raw";

export interface AgentInfo {
  name: string;
  events: number;
  cost: number;
  calls: number;
  live: boolean;
  tokens: number;
  failures: number;
  readTokens: number;
  writeTokens: number;
  cacheRead: number;
  cacheWrite: number;
  contextUsed: number;
  contextLimit: number;
  /** 当前认领的切片；空字符串 = 尚未认领 */
  role: string;
  activeFrom: string;
  activeTo: string;
  /** 参与的线程数 / 发出的消息数 */
  threadCount: number;
  messageCount: number;
}

export type AgentStop = "done" | "mail-cap" | "budget" | "brain-giveup";

export interface IncompleteStop {
  agent: string;
  stop: AgentStop;
  reason: string;
}

export interface SwarmData {
  id: string;
  /** 人类写下的目标原文（含 DoD 段落）—— 详情页展示都读它 */
  goal: string;
  name: string;
  state: SwarmState;
  startedAt: string;
  model: string;
  agents: string[];
  /** 每个成员的收工方式（后端 agent.done 投影）。老账本没这个字段 → undefined，按"自主收工"显示。 */
  stops?: Record<string, AgentStop>;
  threads: number;
  messages: number;
  calls: number;
  tokens: number;
  cost: number;
  budget: number;
  /** 工作切片清单（智能体认领的对象） */
  slices: string[];
  createdAt: string;
}

/** 看板上的一个切片（M6）：available → claimed → completed */
export interface SliceInfo {
  /** 切片名（同集群内唯一，也是认领的键） */
  slice: string;
  status: "available" | "claimed" | "completed";
  /** 谁认领的（裸名字）；available 时为 "" */
  claimedBy: string;
  /** 交付时留下的证据；未交付时是 "" */
  evidence: string;
}

export interface ThreadData {
  id: string;
  swarmId: string;
  title: string;
  primary: boolean;
  visibility: "public" | "private";
  state: ThreadState;
  /** count = 该成员在本集群的真实工作步数（工具调用/思考；网关重试不算） */
  members: { name: string; count: number }[];
  createdBy: string;
  createdAt: string;
  messageCount: number;
  activity: number;
  preview: string;
  previewAgent: string;
  seed: number;
}

export type MessageKind =
  | "agent"
  | "system"
  | "goal"
  | "collision"
  | "claim"
  | "verify"
  | "question"
  | "answer"
  | "signoff";

export interface MessageData {
  id: string;
  threadId: string;
  time: string;
  agent: string;
  chars: number;
  kind: MessageKind;
  body: string;
  /** 这条是群发（收件人写了 all@ / agents@ / humans@）—— 用来把连续广播折叠成一条 */
  broadcast: boolean;
}

/*
 * 行为流类型 = **真实工具名**（M8 起）。后端 simple-swarm-server/src/types.ts 是唯一真相，这里必须一一对应。
 * thinking 是模型的思考过程、retry 是单步失败后的自动重试、system 是系统干预（预算熔断/被闸按停）——
 * 这三个不是工具，但确实会发生。老账本里还留着 post/inbox/render 那套旧类型，
 * 所以界面上取值一律要兜底（见 lib/trace.ts 的 typeColor/typeLabel）。
 */
export type TraceType =
  | "bash"
  | "read"
  | "write"
  | "edit"
  | "read_inbox"
  | "list_mailboxes"
  | "mark_read"
  | "archive"
  | "send_mail"
  | "reply"
  | "broadcast"
  | "publish_slice"
  | "claim_slice"
  | "release_slice"
  | "complete_slice"
  | "done"
  | "thinking"
  | "retry"
  | "system";

export interface TraceEventData {
  id: string;
  swarmId: string;
  time: string;
  agent: string;
  type: TraceType;
  detail: string;
  ms: number;
  status: "ok" | "error";
}

/** 单个智能体的统一事件流条目（agent 窗口的分页签用） */
export interface AgentEvent {
  id: string;
  time: string;
  kind: "message" | "tool" | "thinking" | "failure" | "session";
  action: string;
  detail: string;
  ms: number;
}

export interface AgentDetail {
  agent: AgentInfo;
  swarms: { id: string; name: string }[];
  threads: { swarmId: string; threadId: string; title: string; messageCount: number }[];
  counts: { messages: number; tools: number; thinking: number; failures: number; sessions: number };
}

export interface SearchHit {
  kind: "swarm" | "thread" | "agent" | "message";
  id: string;
  title: string;
  subtitle: string;
  swarmId: string;
  threadId: string;
  agent: string;
  time: string;
}

export interface SearchResult {
  query: string;
  total: number;
  swarms: SearchHit[];
  threads: SearchHit[];
  agents: SearchHit[];
  messages: SearchHit[];
}

export interface SwarmTotals {
  swarms: number;
  live: number;
}

/* ---------- 事件（后端 → 前端 WS 推送） ---------- */

/** 邮箱元信息（后端 MailboxMeta 的前端镜像） */
export interface MailboxMeta {
  address: string;
  local: string;
  swarmId: string;
  owner: string;
  kind: "agent" | "human" | "system" | "board";
  shared: boolean;
  createdAt: string;
}

/** 完整邮箱（含计数器）—— GET /api/mailboxes 与 /api/mailboxes/:address 的返回 */
export interface Mailbox {
  address: string;
  local: string;
  swarmId: string;
  owner: string;
  kind: "agent" | "human" | "system" | "board";
  shared: boolean;
  createdAt: string;
  unread: number;
  total: number;
  sent: number;
  archived: number;
  trashed: number;
  /** 同域内省略域名的短名，纯展示用 */
  shortName: string;
}

/** 一封邮件（后端 MailData 的前端镜像） */
export interface MailData {
  id: string;
  swarmId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  chars: number;
  kind: MessageData["kind"];
  threadId: string;
  replyTo: string;
  time: string;
}

export type MailFolder = "inbox" | "sent" | "archive" | "trash";

export type SwarmEventPayload =
  | { type: "swarm.created"; swarm: SwarmData }
  | { type: "swarm.updated"; swarm: SwarmData }
  | { type: "swarm.started"; swarmId: string; time: string }
  | { type: "swarm.stopped"; swarmId: string; reason: string; time: string }
  | {
      type: "swarm.completed";
      swarmId: string;
      dod: DodResult[];
      /** 被硬闸按停、不是自主收工的成员（老事件没有这个字段 → 可选） */
      incomplete?: IncompleteStop[];
      /** M8：履约情况。系统不判对错，但"6 片只有 2 片被认领、4 片躺着没人动"必须能被看见。 */
      deliverables?: { claimed: number; completed: number; total: number };
      time: string;
    }
  | { type: "swarm.deleted"; swarmId: string; time: string }
  | { type: "thread.created"; thread: ThreadData }
  | { type: "thread.updated"; thread: ThreadData }
  | { type: "agent.registered"; agent: AgentInfo }
  | {
      type: "agent.done";
      swarmId: string;
      agent: string;
      reason: string;
      confirm: string;
      /** 收工方式（老事件没有 → 可选） */
      stop?: AgentStop;
    }
  | { type: "message.posted"; message: MessageData }
  | { type: "trace.appended"; event: TraceEventData }
  | { type: "claim.taken"; swarmId: string; agent: string; slice: string }
  | { type: "claim.released"; swarmId: string; agent: string; slice: string }
  | { type: "slice.completed"; swarmId: string; slice: string; agent: string; evidence: string; time: string }
  | { type: "collision.detected"; swarmId: string; slice: string; holders: string[]; verdict: string }
  | { type: "mailbox.created"; mailbox: MailboxMeta }
  | { type: "mail.sent"; mail: MailData }
  | { type: "mail.read"; swarmId: string; mailId: string; reader: string; time: string }
  | { type: "mail.moved"; swarmId: string; mailId: string; owner: string; folder: MailFolder }
  | { type: "mail.starred"; swarmId: string; mailId: string; owner: string; starred: boolean }
  | { type: "mail.bounced"; swarmId: string; mailId: string; recipient: string; reason: string }
  /* 防风暴（M3.5）违约事件 */
  | { type: "mail.rate_limited"; swarmId: string; from: string; count: number; limit: number; time: string }
  | {
      type: "mail.quota_exceeded";
      swarmId: string;
      mailId: string;
      recipient: string;
      unread: number;
      limit: number;
    }
  | { type: "swarm.paused"; swarmId: string; reason: string; count: number; limit: number; time: string }
  /* 记账（M5）：token 是真数据，cost = token × 换算率（不做真实计费） */
  | {
      type: "usage.recorded";
      swarmId: string;
      agent: string;
      model: string;
      readTokens: number;
      writeTokens: number;
      cacheRead: number;
      cacheWrite: number;
      tokens: number;
      cost: number;
      ms: number;
      failed: boolean;
      time: string;
    };

export type SwarmEvent = SwarmEventPayload & { seq: number; at: string };

/* ---------- 纯计算 ---------- */

/** 甘特点线：按线程成员数生成固定间隔的活跃刻度。 */
export function timelineMarksFor(thread: ThreadData, index: number): number[] {
  const memberCount = thread.members.length;
  return marks(thread.seed + index * 13, 5 + memberCount);
}
