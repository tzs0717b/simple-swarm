/*
 * 契约类型 —— 与前端 simple-swarm-web/src/data.ts 一一对应。
 * 改动这里必须同步改前端，反之前端可零改动切换。
 */

/**
 * 集群生命周期：
 *   pending → live → stopped     （人工停止）
 *                  → done        （DoD 通过，自动完成）
 * pending 是新建后的默认态，必须显式 start 才会跑。
 */
export type SwarmState = "pending" | "live" | "stopped" | "done";

/** 邮箱类型：智能体 / 人类操作者 / 系统 / 共享看板 */
export type MailboxKind = "agent" | "human" | "system" | "board";

/** 邮箱元信息（不可变部分，写进 mailbox.created 事件） */
export interface MailboxMeta {
  /** 完整地址：peliscout@perfect-pelican.swarm */
  address: string;
  /** 地址的 local 部分：peliscout */
  local: string;
  swarmId: string;
  /** 归属者：agent 名 / "human" / "system" / "board" */
  owner: string;
  kind: MailboxKind;
  /** 共享邮箱（human/system/board 为 true，所有成员可读） */
  shared: boolean;
  createdAt: string;
}

/** 邮件所在文件夹 */
export type MailFolder = "inbox" | "sent" | "archive" | "trash";

/**
 * 一封邮件（只存一份）。
 * to/cc 存**发件人写的原样**（可含 all@ / agents@ 等别名），投递时按当时名单展开 —— 可审计可回放。
 */
export interface MailData {
  id: string;
  swarmId: string;
  /** 发件人完整地址 */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  chars: number;
  kind: MessageKind;
  /** 会话容器，形如 `${swarmId}/${threadId}`（前端 MessageData 用的就是这个） */
  threadId: string;
  /** 回复的那封邮件 id；空串 = 新会话 */
  replyTo: string;
  time: string;
}

/** 某个邮箱对某封邮件的私有状态（已读/文件夹/星标） */
export interface MailEntry {
  folder: MailFolder;
  read: boolean;
  readAt: string;
  starred: boolean;
}

/** 邮箱运行态（接口返回的形状；内部索引 entries 不出现在这里，Map 没法序列化） */
export interface Mailbox extends MailboxMeta {
  unread: number;
  total: number;
  sent: number;
  archived: number;
  trashed: number;
}

/** 收件箱/已发送列表里的一条：邮件本体 + 该邮箱自己的状态 */
export interface MailView extends MailData {
  folder: MailFolder;
  read: boolean;
  readAt: string;
  starred: boolean;
}

/** DoD 单条判定的结果（M7 才真正填充，先定好形状避免以后改契约） */
export interface DodResult {
  criterion: string;
  passed: boolean;
  evidence: string;
}

/** 智能体收工的方式。
 *  "done" = 模型自己判定干完了 —— 唯一算"自主收工"的；
 *  其余都是被系统按停的：发信上限 / 预算熔断 / 连续网关失败被放弃。
 *  PELICAN NEW 那次 velma 被发信上限按停，却在账本里和"真干完了"长得一模一样。 */
export type AgentStop = "done" | "mail-cap" | "budget" | "brain-giveup";

/** 一次运行里"不是自主收工"的成员：谁、因为什么、原话是啥 */
export interface IncompleteStop {
  agent: string;
  stop: AgentStop;
  reason: string;
}
export type ThreadState = "running" | "dormant";
export type ViewMode = "all" | "preview" | "raw";

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

/*
 * 看板切片状态（M6）：从"认领就是记个名"升成有生命周期的实体。
 * status: available（待认领）→ claimed（进行中）→ completed（已完成）。
 * 字段全部必填（契约自检按字段名逐一对齐），claimedBy 在 available 时为 ""。
 */
export interface SliceInfo {
  /** 切片名（如「需求拆解」），同集群内唯一，也是认领的键 */
  slice: string;
  status: "available" | "claimed" | "completed";
  /** 谁认领的（裸名字）；available 时为 "" */
  claimedBy: string;
  /** 交付时留下的证据：凭什么说这片做完了（M6）。未交付时是 "" */
  evidence: string;
}

/*
 * 质疑（challenge）：agent 之间的公开质询，也包括对**派工员**的质询。
 *
 * 为什么做成一等账本对象而不是普通邮件：邮件可以被无视，质疑必须有「回应义务」和「裁决」才有牙齿。
 *   challenge.raised → challenge.answered（被质疑者回应）→ challenge.resolved（第三方裁决）
 * 超过 SWARM_CHALLENGE_GRACE 轮无人回应 → challenge.expired，按「沉默即认账」记作 upheld。
 * 裁决人必须既不是 by 也不是 target（自审无效，机械判定）。
 *
 * 与 doneGate 的关系：doneGate 是系统打回「没干完就想收工」，质疑是它的推广 ——
 * 让同伴也能打回，包括打回派工员切错的片。
 */
export interface ChallengeInfo {
  id: string;
  swarmId: string;
  /** 质疑者（裸名字） */
  by: string;
  /** 被质疑者：agent 裸名，或 "slicer"（派工员切的板），或 "all" */
  target: string;
  /** slicer=片切得不对 ｜ artifact=产物不合规 ｜ evidence=交付说明与事实不符 ｜ duplicate=重复劳动 */
  kind: "slicer" | "artifact" | "evidence" | "duplicate";
  /** 被质疑的片名（可空） */
  slice: string;
  /** 一句话主张：你认为哪里不对 */
  claim: string;
  /** 证据：命令、数字、文件加行号 —— 空口质疑无效 */
  evidence: string;
  /** 你要求对方做的**可执行最小动作** */
  ask: string;
  status: "open" | "answered" | "upheld" | "dismissed" | "expired";
  response: string;
  responseEvidence: string;
  /** 裁决人（既不是质疑者也不是被质疑者） */
  ruledBy: string;
  verdict: string;
  /** 展示用时间（HH:MM:SS，和账本其余事件同口径） */
  time: string;
  /** 真实 epoch 毫秒 —— 只给宽限期计时用。clock() 返回 HH:MM:SS 根本算不出年龄，
      2026-09-19 自检抓到这个坑：光靠 time 字段宽限期永远不会触发。 */
  raisedAt: number;
}

/*
 * 行为流的类型 = **真实工具名**（M8 改）。
 *
 * 之前是 thinking/edit/post/inbox 这套抽象概念 —— 智能体明明只是发了封邮件或认领了切片，
 * 却记成"发帖""编辑"，和它实际做的事对不上，界面上的名字也就只能说谎。
 * 现在一条记录的类型就是它真正调用的那个工具，剩下三个不是工具的也留着：
 * thinking 是模型自己的思考，retry 是失败后的自动重试，system 是系统干预（熔断/被闸按停）。
 */
export type TraceType =
  /* 真·干活工具：在自己的工作目录里动手 */
  | "bash"
  /* P16：只读自检 —— 拿题面自带用例量当前工作区 */
  | "check_acceptance"
  | "read"
  | "write"
  | "edit"
  /* 协作工具：邮件 + 看板 */
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
  | "challenge"
  | "respond_challenge"
  | "rule_challenge"
  /* 不是工具，但确实是发生过的事 */
  | "thinking"
  | "retry"
  | "system";

export interface AgentInfo {
  name: string;
  events: number;
  cost: number;
  calls: number;
  live: boolean;
  /** 累计 token（含读/写/缓存明细） */
  tokens: number;
  /** 失败次数（trace 中 status=error 的条数） */
  failures: number;
  readTokens: number;
  writeTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** 上下文窗口占用与上限 */
  contextUsed: number;
  contextLimit: number;
  /** 当前认领的切片名；空字符串 = 尚未认领（活不预先分配） */
  role: string;
  /** 活跃区间（当天时钟） */
  activeFrom: string;
  activeTo: string;
  /** 参与的线程数 / 发出的消息数（卡片上的 "N threads / N messages"） */
  threadCount: number;
  messageCount: number;
}

export interface SwarmData {
  id: string;
  /** 人类写下的目标原文（含 DoD 段落）。
   *  DoD 判定直接读这里，而不是从目标信里捞 —— 事件账本里目标信是 mail.sent，
   *  读它要顺着消息找，而 swarm.created 就在眼前。 */
  goal: string;
  name: string;
  state: SwarmState;
  startedAt: string;
  model: string;
  agents: string[];
  /** 每个成员的收工方式（由 agent.done 投影）。
   *  老账本里没有这个字段 → 读到 undefined 时一律按 "done"（那时确实没这个区分）。 */
  stops: Record<string, AgentStop>;
  threads: number;
  messages: number;
  calls: number;
  tokens: number;
  cost: number;
  budget: number;
  /*
   * 工作切片清单（M4 引入，M6 会扩成带状态的实体 + 看板）。
   * 它就是"这活怎么切"的答案 —— 智能体认领的对象。
   */
  slices: string[];
  createdAt: string;
}

export interface ThreadMember {
  name: string;
  /** 该成员在本集群的真实工作步数（工具调用/思考；网关重试与系统跳过不算） */
  count: number;
}

export interface ThreadData {
  id: string;
  swarmId: string;
  title: string;
  primary: boolean;
  /** public = 公开房间（成员均可读）；private = 私信（房间只有 2 人） */
  visibility: "public" | "private";
  state: ThreadState;
  members: ThreadMember[];
  createdBy: string;
  createdAt: string;
  messageCount: number;
  activity: number;
  preview: string;
  previewAgent: string;
  seed: number;
}

export interface MessageData {
  id: string;
  threadId: string;
  time: string;
  agent: string;
  chars: number;
  kind: MessageKind;
  body: string;
  /** 这条是群发（收件人里写了 all@ / agents@ / humans@）—— 前端据此把连续广播折叠成一条 */
  broadcast: boolean;
}

export interface TraceEventData {
  id: string;
  swarmId: string;
  time: string;
  agent: string;
  type: TraceType;
  detail: string;
  ms: number;
  /** ok = 成功；error = 失败（对应界面上的 FAILURES 分类） */
  status: "ok" | "error";
}

/** 单个智能体的统一事件流条目（消息/工具/思考/失败/收工），供 agent 窗口的分页签使用。 */
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

/* ---------- 事件（append-only 日志的载荷） ---------- */

export type SwarmEventPayload =
  | { type: "swarm.created"; swarm: SwarmData }
  /* 注意：载荷里用 time 而不是 at，因为事件信封已经占用了 at（ISO 时间戳） */
  | { type: "swarm.started"; swarmId: string; time: string }
  | { type: "swarm.stopped"; swarmId: string; reason: string; time: string }
  | {
      type: "swarm.completed";
      swarmId: string;
      dod: DodResult[];
      /** 被硬闸按停、不是自主收工的成员（空 = 全员都是自己判定干完的）。
       *  老账本没有这个字段 → 可选。 */
      incomplete?: IncompleteStop[];
      /** M8：履约情况。系统不判对错，但"6 片只有 2 片被认领"必须能被看见 ——
       *  否则会出现"agent 说交付了、4 片躺着没人动、集群照样 swarm.completed"。
       *  老账本没有这个字段 → 可选。 */
      deliverables?: { claimed: number; completed: number; total: number };
      time: string;
    }
  /* 删除集群：让"删掉"也进账本，重启重放后不会复活 */
  | { type: "swarm.deleted"; swarmId: string; time: string }
  | { type: "mailbox.created"; mailbox: MailboxMeta }
  | { type: "mail.sent"; mail: MailData }
  | { type: "mail.read"; swarmId: string; mailId: string; reader: string; time: string }
  | { type: "mail.moved"; swarmId: string; mailId: string; owner: string; folder: MailFolder }
  | { type: "mail.starred"; swarmId: string; mailId: string; owner: string; starred: boolean }
  | { type: "mail.bounced"; swarmId: string; mailId: string; recipient: string; reason: string }
  /* ---------- 防风暴（M3.5）：违约事件，写路径拒绝时落盘，可审计 ---------- */
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
  | { type: "swarm.updated"; swarm: SwarmData }

  /*
   * 记账（M5）：每走一步就落一条用量。
   * token 是真数据（M8 从 API 响应的 usage 里抄），cost 由 token × 换算率算出来 ——
   * 不做真实计费，只用来"跑超了刹车"。钱是算出来的，token 是记下来的。
   */
  | {
      type: "usage.recorded";
      swarmId: string;
      agent: string;
      model: string;
      readTokens: number;
      writeTokens: number;
      cacheRead: number;
      cacheWrite: number;
      /** 四者之和，冗余存一份方便直接求和 */
      tokens: number;
      /** = usdForTokens(tokens)，落盘时就固定住，换换算率不会改写历史 */
      cost: number;
      /** 这一步花的时间（毫秒） */
      ms: number;
      /** 是否失败（失败也花了 token，所以要记） */
      failed: boolean;
      time: string;
    }
  | { type: "thread.created"; thread: ThreadData }
  | { type: "thread.updated"; thread: ThreadData }
  | { type: "agent.registered"; agent: AgentInfo }
  | {
      type: "agent.done";
      swarmId: string;
      agent: string;
      reason: string;
      confirm: string;
      /** 收工方式。老账本没有这个字段 → 可选，读时按 "done"。 */
      stop?: AgentStop;
    }
  | { type: "message.posted"; message: MessageData }
  | { type: "trace.appended"; event: TraceEventData }
  /* 工作区文件留档（git）：每一步之后由**系统**提交。归因靠工作区 diff，
     所以 agent 用 bash heredoc 写的文件也算数（B10）。 */
  | { type: "file.written"; swarmId: string; path: string; agent: string; tool: string; bytes: number; commit: string; time: string }
  | { type: "claim.taken"; swarmId: string; agent: string; slice: string }
  | { type: "claim.released"; swarmId: string; agent: string; slice: string }
  | { type: "collision.detected"; swarmId: string; slice: string; holders: string[]; verdict: string }
  /* 看板（M6）：切片交付 → completed。认领/释放复用 claim.taken/released。 */
  | { type: "slice.completed"; swarmId: string; slice: string; agent: string; evidence: string; time: string }
  /* 切片生成器（系统）：往板上放一片细粒度的活，摆着等 agent 来认领。
     与 publish_slice 的区别是它**不认领** —— 系统只切活，不替 agent 选活。 */
    /* 质疑（见 ChallengeInfo）：raised → answered → resolved / expired，投影里推进状态机。 */
    | { type: "challenge.raised"; challenge: ChallengeInfo }
    | { type: "challenge.answered"; challenge: ChallengeInfo }
    | { type: "challenge.resolved"; challenge: ChallengeInfo }
    | { type: "challenge.expired"; challenge: ChallengeInfo }
  | { type: "slice.added"; swarmId: string; slice: string; by: string; time: string };

/** 事件归属的集群（用于 WS 定向推送）；全局事件返回 undefined → 广播给所有订阅者。 */
export function eventSwarmId(event: SwarmEvent): string | undefined {
  switch (event.type) {
    case "swarm.created":
    case "swarm.updated":
      return event.swarm.id;
    case "swarm.started":
    case "swarm.stopped":
    case "swarm.completed":
    case "swarm.deleted":
      return event.swarmId;
    case "mailbox.created":
      return event.mailbox.swarmId;
    case "mail.sent":
      return event.mail.swarmId;
    case "mail.read":
    case "mail.moved":
    case "mail.starred":
    case "mail.bounced":
    case "mail.rate_limited":
    case "mail.quota_exceeded":
    case "swarm.paused":
    case "usage.recorded":
    case "agent.done":
    case "file.written":
      return event.swarmId;
    case "claim.taken":
    case "claim.released":
    case "collision.detected":
    case "slice.completed":
    case "slice.added":
      return event.swarmId;
    case "thread.created":
    case "thread.updated":
      return event.thread.swarmId;
    case "message.posted":
      return event.message.threadId.split("/")[0];
    case "trace.appended":
      return event.event.swarmId;
    default:
      return undefined;
  }
}

export type SwarmEvent = SwarmEventPayload & { seq: number; at: string };
