import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addressOf, expandRecipients, localOf, type SwarmRoster } from "./mail.ts";
import { isBroadcast, STORM, withinWindow } from "./storm.ts";
import type { AgentStop, ChallengeInfo } from "./types.ts";
import type {
  AgentInfo,
  MailData,
  MailEntry,
  MailFolder,
  MailView,
  Mailbox,
  MessageData,
  SliceInfo,
  SwarmData,
  SwarmEvent,
  SwarmEventPayload,
  SwarmTotals,
  ThreadData,
  TraceEventData,
} from "./types.ts";

/** 邮箱内部状态：公开形状 + per-mail 索引（索引不出接口） */
interface MailboxState extends Mailbox {
  entries: Map<string, MailEntry>;
}

/** 退信记录（派生，不进 MailData） */
/** 工作区文件留档（git）：谁写过、写了几次、最新一版是哪个提交。 */
export interface FileRecord {
  path: string;
  lastAgent: string;
  lastCommit: string;
  lastTime: string;
  writers: Map<string, number>;
  commits: { commit: string; agent: string; tool: string; bytes: number; time: string }[];
}

/** 对外（HTTP）的文件留档视图。 */
export interface FileInfo {
  path: string;
  lastAgent: string;
  lastCommit: string;
  lastTime: string;
  writers: { agent: string; count: number }[];
  commits: { commit: string; agent: string; tool: string; bytes: number; time: string }[];
}

export interface MailBounce {
  mailId: string;
  recipient: string;
  reason: string;
  time: string;
}

/** 线程主键：前端 MessageData.threadId 用的就是 `${swarmId}/${threadId}`。 */
export function threadKey(swarmId: string, threadId: string): string {
  return `${swarmId}/${threadId}`;
}

function todayFile(home: string, date = new Date()): string {
  return path.join(home, `events-${date.toISOString().slice(0, 10)}.jsonl`);
}

/**
 * append-only 事件库 + 内存投影。
 *
 * - 写入：append() 先应用到内存投影，再串行落盘（Promise 队列，避免交错写）。
 * - 读取：load() = 快照 + 增量事件重放；损坏行跳过并计数，不阻断启动。
 * - 查询：所有 list / get 方法都是投影上的只读操作。
 */
/** 钱保留 6 位小数：累加 1e5 次也不会浮点漂移成 0.30000000000000004 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export class EventStore {
  private events: SwarmEvent[] = [];
  private seq = 0;
  private readonly swarms = new Map<string, SwarmData>();
  private readonly threads = new Map<string, ThreadData>();
  private readonly messages = new Map<string, MessageData[]>();
  private readonly traces = new Map<string, TraceEventData[]>();
  private readonly agents = new Map<string, AgentInfo>();
  /** swarmId -> (slice -> agent) */
  private readonly claims = new Map<string, Map<string, string>>();
  /** 看板（M6）：swarmId -> sliceName -> 状态（available/claimed/completed）。
   *  从 swarm.created 预填 available，claim/bounce/completed 事件推进状态机。 */
  /* 曾经被用过的集群 id（含已删除的）。事件账本是 append-only 的：
     id 一旦重用，账本里两代集群的事件就再也分不开了（追踪/统计会串台），
     所以 id 只能往后取，不能回收。removeSwarm 故意不动这个集合。 */
  private readonly everCreated = new Set<string>();

  private readonly slices = new Map<
    string,
    Map<string, { status: "available" | "claimed" | "completed"; claimedBy: string; evidence: string }>
  >();

  /* 质疑：id → ChallengeInfo。一等账本对象，见 types.ts 的 ChallengeInfo 注释。 */
  private readonly challenges = new Map<string, Map<string, ChallengeInfo>>();
  /** 撞过的切片：谁跟谁抢过（first-wins 的账）。智能体靠它"别重复撞同一片"。 */
  private readonly collisions = new Map<string, { slice: string; holders: string[]; verdict: string }[]>();
  /** 邮箱投影：address → MailboxState（含 per-mail 索引） */
  /* 工作区文件留档（git）：path → 谁写过、写了几次、最新提交（M12） */
  private readonly files = new Map<string, Map<string, FileRecord>>();
  private readonly mailboxes = new Map<string, MailboxState>();
  /** 邮件本体：一份存储（mailId → MailData） */
  private readonly mails = new Map<string, MailData>();
  /** 退信记录 */
  private readonly bounceLog: MailBounce[] = [];
  private readonly listeners = new Set<(event: SwarmEvent) => void>();
  private readonly home: string;
  private readonly snapshotFile: string;
  private queue: Promise<void> = Promise.resolve();
  private corruptLines = 0;

  constructor(home: string) {
    this.home = home;
    this.snapshotFile = path.join(home, "snapshot-latest.json");
  }

  get homeDir(): string {
    return this.home;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get corrupt(): number {
    return this.corruptLines;
  }

  /** 快照 + 事件日志 → 内存投影。返回重放信息，便于启动日志。 */
  async load(): Promise<{ snapshotSeq: number; replayed: number; files: number }> {
    await mkdir(this.home, { recursive: true });

    let snapshotSeq = 0;
    try {
      const raw = await readFile(this.snapshotFile, "utf8");
      const snapshot = JSON.parse(raw) as { seq?: number; events?: SwarmEvent[] };
      snapshotSeq = snapshot.seq ?? 0;
      for (const event of snapshot.events ?? []) {
        this.apply(event);
        this.events.push(event);
      }
      this.seq = Math.max(this.seq, snapshotSeq);
    } catch {
      /* 冷启动：没有快照 */
    }

    const files = (await readdir(this.home))
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();

    let replayed = 0;
    for (const name of files) {
      const raw = await readFile(path.join(this.home, name), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let event: SwarmEvent;
        try {
          event = JSON.parse(line) as SwarmEvent;
        } catch {
          this.corruptLines += 1;
          continue;
        }
        if (typeof event.seq !== "number" || event.seq <= snapshotSeq) continue;
        this.apply(event);
        this.events.push(event);
        replayed += 1;
      }
    }
    this.events.sort((a, b) => a.seq - b.seq);
    return { snapshotSeq, replayed, files: files.length };
  }

  /** 追加一个事件：内存生效 + 落盘（串行）。 */
  append(payload: SwarmEventPayload): SwarmEvent {
    const event = { ...payload, seq: ++this.seq, at: new Date().toISOString() } as SwarmEvent;
    this.apply(event);
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[eventstore] 订阅者异常:", error);
      }
    }
    const line = `${JSON.stringify(event)}\n`;
    const file = todayFile(this.home);
    this.queue = this.queue
      .then(() => appendFile(file, line, "utf8"))
      .catch((error: unknown) => {
        console.error("[eventstore] 落盘失败:", error);
      });
    return event;
  }

  /** 纯函数式投影：任何事件都必须能从这里重放出同样的状态。 */
  private apply(event: SwarmEvent): void {
    this.seq = Math.max(this.seq, event.seq ?? 0);
    switch (event.type) {
      case "swarm.created": {
        this.swarms.set(event.swarm.id, event.swarm);
        /* 看板：切片液名从集群的切片列表预填为 available（幂等：已有则不覆盖） */
        const sliceMap = new Map<
          string,
          { status: "available" | "claimed" | "completed"; claimedBy: string; evidence: string }
        >();
        for (const name of event.swarm.slices) sliceMap.set(name, { status: "available", claimedBy: "", evidence: "" });
        if (!this.slices.has(event.swarm.id)) this.slices.set(event.swarm.id, sliceMap);
        this.everCreated.add(event.swarm.id);
        break;
      }
      case "swarm.updated": {
        /* 载荷是"整对象替换"，但老账本里的 swarm.updated 是在 stops 字段存在**之前**写下的：
           它根本不知道有 stops，直接替换会把投影里已经攒到的 stops 抹掉
           （PELICAN NEW 重放后就只剩最后 3 个人的收工方式）。所以跟旧对象合并一次 ——
           载荷里有的以载荷为准，载荷里没有的保留旧值。 */
        const prev = this.swarms.get(event.swarm.id);
        this.swarms.set(event.swarm.id, prev ? { ...prev, ...event.swarm } : event.swarm);
        break;
      }
      case "thread.created": {
        /* 新线程要把本集群**已经发生**的工作步数补进去，否则同一个集群的线程会一个有点、一个没点 */
        const thread = event.thread;
        const counts = this.workCounts(thread.swarmId);
        this.threads.set(threadKey(thread.swarmId, thread.id), {
          ...thread,
          members: thread.members.map((member) => ({ ...member, count: counts.get(member.name) ?? 0 })),
        });
        break;
      }
      case "thread.updated":
        this.threads.set(threadKey(event.thread.swarmId, event.thread.id), event.thread);
        break;
      case "agent.registered":
        this.agents.set(event.agent.name, event.agent);
        break;
      case "swarm.started": {
        const swarm = this.swarms.get(event.swarmId);
        if (swarm) this.swarms.set(event.swarmId, { ...swarm, state: "live", startedAt: swarm.startedAt || event.time });
        break;
      }
      case "swarm.stopped": {
        const swarm = this.swarms.get(event.swarmId);
        if (swarm) this.swarms.set(event.swarmId, { ...swarm, state: "stopped" });
        break;
      }
      case "swarm.completed": {
        const swarm = this.swarms.get(event.swarmId);
        if (swarm) this.swarms.set(event.swarmId, { ...swarm, state: "done" });
        break;
      }
      case "swarm.deleted": {
        /* 删除也走账本：重放时同样会删，所以删掉的集群不会在重启后复活。
           清理逻辑只有一处实现 —— removeSwarm()。 */
        this.removeSwarm(event.swarmId);
        break;
      }
      case "swarm.paused": {
        // 消息风暴把集群按停：状态机复用 stopped（人来修完循环再 start），
        // 但事件本身是 swarm.paused，原始追踪里能看到原因。
        const swarm = this.swarms.get(event.swarmId);
        if (swarm) this.swarms.set(event.swarmId, { ...swarm, state: "stopped" });
        break;
      }
      case "mailbox.created": {
        const meta = event.mailbox;
        if (!this.mailboxes.has(meta.address)) {
          this.mailboxes.set(meta.address, {
            ...meta,
            unread: 0,
            total: 0,
            sent: 0,
            archived: 0,
            trashed: 0,
            entries: new Map<string, MailEntry>(),
          });
        }
        break;
      }
      case "mail.sent": {
        this.projectMail(event.mail);
        /* 集群消息计数器：SwarmData.messages ≡ 本集群 mail.sent 总数（含目标信）。
           之前是死字段（永远停留在 createSwarm 时的 1），集群卡片上"消息 N"会骗人。 */
        const swarm = this.swarms.get(event.mail.swarmId);
        if (swarm) this.swarms.set(event.mail.swarmId, { ...swarm, messages: swarm.messages + 1 });
        break;
      }
      case "mail.read": {
        const box = this.mailboxes.get(event.reader);
        const entry = box?.entries.get(event.mailId);
        if (box && entry && !entry.read) {
          entry.read = true;
          entry.readAt = event.time;
          if (entry.folder === "inbox") box.unread = Math.max(0, box.unread - 1);
        }
        break;
      }
      case "mail.moved": {
        const box = this.mailboxes.get(event.owner);
        const entry = box?.entries.get(event.mailId);
        if (box && entry && entry.folder !== event.folder) {
          this.countFolder(box, entry.folder, -1);
          entry.folder = event.folder;
          this.countFolder(box, event.folder, 1);
        }
        break;
      }
      case "mail.starred": {
        const entry = this.mailboxes.get(event.owner)?.entries.get(event.mailId);
        if (entry) entry.starred = event.starred;
        break;
      }
      case "mail.bounced": {
        this.bounceLog.push({
          mailId: event.mailId,
          recipient: event.recipient,
          reason: event.reason,
          time: this.clockNow(),
        });
        break;
      }
      case "agent.done": {
        const agent = this.agents.get(event.agent);
        if (agent) this.agents.set(event.agent, { ...agent, live: false });
        /* 收工方式存进集群状态：谁是自己判定干完、谁是被硬闸按停。
           老账本的事件没有 stop 字段 → 按 "done" 处理（那时确实没这个区分）。 */
        const doneSwarm = this.swarms.get(event.swarmId);
        if (doneSwarm) {
          this.swarms.set(event.swarmId, {
            ...doneSwarm,
            stops: { ...(doneSwarm.stops ?? {}), [event.agent]: event.stop ?? "done" },
          });
        }
        break;
      }
      case "message.posted": {
        /* 历史格式（129 条）：帖子里发一句 → 投影成一封发给**该线程成员**的邮件。
           老前端读的 messages 索引由 projectMail 一并维护，因此前端零改动。 */
        this.projectMail(legacyMail(event.message, this.recipientsOfThread(event.message.threadId)));
        break;
      }
      case "trace.appended": {
        const key = event.event.swarmId;
        const list = this.traces.get(key);
        if (list) list.push(event.event);
        else this.traces.set(key, [event.event]);
        /* 干活了：刷成员工作步数（线程列表的糖葫芦串点数就是它） */
        if (event.event.type !== "retry" && event.event.type !== "system") {
          this.bumpWork(key, event.event.agent);
        }
        break;
      }
      case "slice.added": {
        /* 切片生成器：系统往板上放一片**未认领**的活。
           幂等 —— 已经有过这片（任何状态）就原样保留，重放安全。 */
        let existing = this.slices.get(event.swarmId);
        if (!existing) {
          existing = new Map();
          this.slices.set(event.swarmId, existing);
        }
        if (!existing.has(event.slice)) {
          existing.set(event.slice, { status: "available", claimedBy: "", evidence: "" });
        }
        break;
      }
      case "challenge.raised":
      case "challenge.answered":
      case "challenge.resolved":
      case "challenge.expired": {
        /* 质疑状态机：后到的同 id 事件覆盖前面的（幂等，重放安全）。 */
        let cm = this.challenges.get(event.challenge.swarmId);
        if (!cm) {
          cm = new Map();
          this.challenges.set(event.challenge.swarmId, cm);
        }
        cm.set(event.challenge.id, event.challenge);
        break;
      }
      case "file.written": {
        let byPath = this.files.get(event.swarmId);
        if (!byPath) {
          byPath = new Map<string, FileRecord>();
          this.files.set(event.swarmId, byPath);
        }
        let record = byPath.get(event.path);
        if (!record) {
          record = {
            path: event.path,
            lastAgent: "",
            lastCommit: "",
            lastTime: "",
            writers: new Map<string, number>(),
            commits: [],
          };
          byPath.set(event.path, record);
        }
        record.lastAgent = event.agent;
        record.lastCommit = event.commit;
        record.lastTime = event.time;
        record.writers.set(event.agent, (record.writers.get(event.agent) ?? 0) + 1);
        record.commits.push({
          commit: event.commit,
          agent: event.agent,
          tool: event.tool,
          bytes: event.bytes,
          time: event.time,
        });
        /* 只留最近 400 条，长跑集群不然会一直涨 */
        if (record.commits.length > 400) record.commits.splice(0, record.commits.length - 400);
        break;
      }
      case "claim.taken": {
        const held = this.claims.get(event.swarmId);
        if (held) held.set(event.slice, event.agent);
        else this.claims.set(event.swarmId, new Map([[event.slice, event.agent]]));
        /* 看板：该片 → claimed */
        const sliceMap = this.slices.get(event.swarmId);
        if (sliceMap) sliceMap.set(event.slice, { status: "claimed", claimedBy: event.agent, evidence: "" });
        break;
      }
      case "claim.released": {
        this.claims.get(event.swarmId)?.delete(event.slice);
        /* 看板：该片 → available */
        const sliceMap = this.slices.get(event.swarmId);
        /* 释放 = 退回未认领，证据也跟着作废 */
        if (sliceMap) sliceMap.set(event.slice, { status: "available", claimedBy: "", evidence: "" });
        break;
      }
      case "slice.completed": {
        /* 看板：该片 → completed（交付了就不退回 available） */
        const sliceMap = this.slices.get(event.swarmId);
        if (sliceMap) {
          const cur = sliceMap.get(event.slice);
          const evidence = typeof event.evidence === "string" ? event.evidence : "";
          sliceMap.set(event.slice, { status: "completed", claimedBy: cur?.claimedBy ?? event.agent, evidence });
        }
        break;
      }
      case "usage.recorded": {
        /* 记账：这一步的 token/耗时落到智能体和集群两个计数器上。
           纯累加 → 重放安全；cost 是落盘时算好的，所以换换算率不会改写历史。 */
        const agent = this.agents.get(event.agent);
        if (agent) {
          this.agents.set(event.agent, {
            ...agent,
            cost: round6(agent.cost + event.cost),
            tokens: agent.tokens + event.tokens,
            readTokens: agent.readTokens + event.readTokens,
            writeTokens: agent.writeTokens + event.writeTokens,
            cacheRead: agent.cacheRead + event.cacheRead,
            cacheWrite: agent.cacheWrite + event.cacheWrite,
            calls: agent.calls + 1,
            events: agent.events + 1,
            failures: agent.failures + (event.failed ? 1 : 0),
          });
        }
        const swarm = this.swarms.get(event.swarmId);
        if (swarm) {
          this.swarms.set(event.swarmId, {
            ...swarm,
            cost: round6(swarm.cost + event.cost),
            tokens: swarm.tokens + event.tokens,
            calls: swarm.calls + 1,
          });
        }
        break;
      }
      case "collision.detected": {
        const list = this.collisions.get(event.swarmId);
        const record = { slice: event.slice, holders: event.holders, verdict: event.verdict };
        if (list) list.push(record);
        else this.collisions.set(event.swarmId, [record]);
        break;
      }
    }
  }

  /** 删除一个集群：从内存投影里摘掉它的所有痕迹。 */
  removeSwarm(id: string): boolean {
    const swarm = this.swarms.get(id);
    if (!swarm) return false;
    this.swarms.delete(id);

    /* 线程和消息的键都是 `${swarmId}/${threadId}` —— 按前缀清干净 */
    const prefix = id + "/";
    for (const key of [...this.threads.keys()]) {
      if (key.startsWith(prefix)) this.threads.delete(key);
    }
    for (const key of [...this.messages.keys()]) {
      if (key.startsWith(prefix)) this.messages.delete(key);
    }

    /* 这几个本来就是按 swarmId 直接索引的 */
    this.traces.delete(id);
    this.claims.delete(id);
    this.slices.delete(id);
    this.collisions.delete(id);

    /* 邮件和邮箱按 swarmId 过滤；退信日志顺手把对应邮件的条目清掉 */
    const doomedMails = new Set<string>();
    for (const [mailId, mail] of [...this.mails.entries()]) {
      if (mail.swarmId === id) {
        doomedMails.add(mailId);
        this.mails.delete(mailId);
      }
    }
    for (const [address, box] of [...this.mailboxes.entries()]) {
      if (box.swarmId === id) this.mailboxes.delete(address);
    }
    for (let index = this.bounceLog.length - 1; index >= 0; index -= 1) {
      if (doomedMails.has(this.bounceLog[index].mailId)) this.bounceLog.splice(index, 1);
    }

    /* 智能体是全局按名字登记的，可能同时属于别的集群；
       只有当它不再属于任何集群时才摘掉，免得 /api/agents 里留下孤儿 */
    for (const name of swarm.agents) {
      const stillUsed = [...this.swarms.values()].some((other) => other.agents.includes(name));
      if (!stillUsed) this.agents.delete(name);
    }

    return true;
  }

  /* ---------- 只读查询 ---------- */

  listSwarms(): SwarmData[] {
    return [...this.swarms.values()];
  }

  getSwarm(id: string): SwarmData | undefined {
    return this.swarms.get(id);
  }

  /**
   * 读取时按本集群现算成员工作步数 —— 这样同一个集群的**所有房间**点数一致
   * （线程是后来才建的也不会少算），语义就是"该成员在本集群干了多少活"。
   * 投影里存的那份只服务于 WS 增量推送（见 bumpWork）。
   */
  private withWork(thread: ThreadData, counts: Map<string, number>): ThreadData {
    return {
      ...thread,
      members: thread.members.map((member) => ({ ...member, count: counts.get(member.name) ?? 0 })),
    };
  }

  listThreads(swarmId: string): ThreadData[] {
    const counts = this.workCounts(swarmId);
    return [...this.threads.values()]
      .filter((thread) => thread.swarmId === swarmId)
      .map((thread) => this.withWork(thread, counts));
  }

  getThread(swarmId: string, threadId: string): ThreadData | undefined {
    const thread = this.threads.get(threadKey(swarmId, threadId));
    return thread ? this.withWork(thread, this.workCounts(swarmId)) : undefined;
  }

  /** 倒序返回（最新在前），与前端 UI 一致。 */
  listMessages(swarmId: string, threadId: string): MessageData[] {
    const list = this.messages.get(threadKey(swarmId, threadId)) ?? [];
    return [...list].reverse();
  }

  /** 倒序返回（最新在前）。 */
  listTraces(swarmId: string, limit = 0): TraceEventData[] {
    const list = this.traces.get(swarmId) ?? [];
    const reversed = [...list].reverse();
    return limit > 0 ? reversed.slice(0, limit) : reversed;
  }

  /**
   * 该 agent 在本集群的**真实工作步数**。
   * 网关重试（retry）与系统跳过（system）不算干活 —— 否则被限流打崩的 agent
   * 反而成了"最活跃"的那个（PELICAN LOOP 那次就是 94 次 retry）。
   */
  private workCounts(swarmId: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const trace of this.traces.get(swarmId) ?? []) {
      if (trace.type === "retry" || trace.type === "system") continue;
      counts.set(trace.agent, (counts.get(trace.agent) ?? 0) + 1);
    }
    return counts;
  }

  /** 干了一步活：本集群每个线程里这个成员 +1 */
  private bumpWork(swarmId: string, agent: string): void {
    for (const [key, thread] of [...this.threads]) {
      if (thread.swarmId !== swarmId) continue;
      if (!thread.members.some((member) => member.name === agent)) continue;
      this.threads.set(key, {
        ...thread,
        members: thread.members.map((member) =>
          member.name === agent ? { ...member, count: member.count + 1 } : member,
        ),
      });
    }
  }

  /* ---------- 邮件投影 ---------- */

  /** 统一投递：一份存储 + 线程索引 + N 个邮箱索引 */
  private projectMail(mail: MailData): void {
    this.mails.set(mail.id, mail);

    // 线程索引（前端 MessageData 视图）
    const list = this.messages.get(mail.threadId);
    if (list) list.push(toMessageData(mail));
    else this.messages.set(mail.threadId, [toMessageData(mail)]);

    // 发件人：自己那封进「已发送」
    const sender = this.mailboxes.get(mail.from);
    if (sender && !sender.entries.has(mail.id)) {
      sender.entries.set(mail.id, { folder: "sent", read: true, readAt: "", starred: false });
      sender.sent += 1;
    }

    // 收件人：按**当时**的名单展开别名（发给在场的人）
    const roster = this.rosterOf(mail.swarmId);
    if (!roster) return;
    const { delivered } = expandRecipients([...mail.to, ...mail.cc], roster);
    for (const address of delivered) {
      const box = this.mailboxes.get(address);
      // 已有条目 = 发件人自己那封（sent）或重复投递 → 跳过，避免未读自增
      if (!box || box.entries.has(mail.id)) continue;
      // 闸 3：收件箱配额。判定依赖"此刻的未读数"，而它本身就是投影的产物 → 重放结果一致。
      if (box.unread >= STORM.unreadQuota) continue;
      box.entries.set(mail.id, { folder: "inbox", read: false, readAt: "", starred: false });
      box.total += 1;
      box.unread += 1;
    }
  }

  /**
   * 防风暴计数器（闸 2 / 闸 5）：某集群最近 windowSec 秒内发了多少封。
   * from=null 表示整个集群；计数从投影里现算，没有隐藏状态，重放后完全一致。
   * 用邮件自带的 time（"HH:MM:SS"）而不是事件时间戳：历史重放出来的老邮件
   * 其事件 at 是"播种那一刻"，会把限流器一次点着。
   */
  recentSendCount(swarmId: string, from: string | null, windowSec: number): number {
    const now = this.clockNow();
    let count = 0;
    for (const mail of this.mails.values()) {
      if (mail.swarmId !== swarmId) continue;
      if (from !== null && mail.from !== from) continue;
      if (withinWindow(now, mail.time, windowSec)) count += 1;
    }
    return count;
  }

  /**
   * 这封信有没有投到某个邮箱（用于"只看发给我的"）。
   * 直接查投递索引：entries 里有它 = 投过（发件人是 sent 条目，收到的是 inbox 条目）。
   */
  deliveredTo(address: string, mailId: string): boolean {
    return this.mailboxes.get(address)?.entries.has(mailId) ?? false;
  }

  /** 列出某房间里"投给这个地址"的消息（新的在前），语义 = 收件箱视角的房间档案 */
  listMessagesFor(swarmId: string, threadId: string, address: string): MessageData[] {
    return this.listMessages(swarmId, threadId).filter((message) => this.deliveredTo(address, message.id));
  }

  private countFolder(box: MailboxState, folder: MailFolder, delta: number): void {
    if (folder === "inbox") box.total = Math.max(0, box.total + delta);
    else if (folder === "sent") box.sent = Math.max(0, box.sent + delta);
    else if (folder === "archive") box.archived = Math.max(0, box.archived + delta);
    else box.trashed = Math.max(0, box.trashed + delta);
  }

  /**
   * 一个线程的收件人 = 它的成员（房间语义）。
   * 线程不存在或没有成员时退化为整集群广播，避免邮件石沉大海。
   */
  private recipientsOfThread(threadKeyValue: string): string[] {
    const thread = this.threads.get(threadKeyValue);
    if (!thread || thread.members.length === 0) {
      return [`all@${threadKeyValue.split("/")[0]}.swarm`];
    }
    return thread.members.map((member) => addressOf(member.name, thread.swarmId));
  }

  private rosterOf(swarmId: string): SwarmRoster | undefined {
    const swarm = this.swarms.get(swarmId);
    return swarm ? { swarmId, agents: swarm.agents } : undefined;
  }

  private clockNow(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /** 抹掉内部索引，得到可序列化的公开形状 */
  private publicMailbox(state: MailboxState): Mailbox {
    return {
      address: state.address,
      local: state.local,
      swarmId: state.swarmId,
      owner: state.owner,
      kind: state.kind,
      shared: state.shared,
      createdAt: state.createdAt,
      unread: state.unread,
      total: state.total,
      sent: state.sent,
      archived: state.archived,
      trashed: state.trashed,
    };
  }

  /* ---------- 邮件读取 ---------- */

  getMail(mailId: string): MailData | undefined {
    return this.mails.get(mailId);
  }

  /** 某个邮箱里某个文件夹的邮件（按时间倒序，最新在前） */
  listMailboxMails(address: string, folder: MailFolder, limit = 0): MailView[] {
    const box = this.mailboxes.get(address.trim().toLowerCase());
    if (!box) return [];
    const out: MailView[] = [];
    for (const [mailId, entry] of box.entries) {
      if (entry.folder !== folder) continue;
      const mail = this.mails.get(mailId);
      if (!mail) continue;
      out.push({ ...mail, folder: entry.folder, read: entry.read, readAt: entry.readAt, starred: entry.starred });
    }
    out.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    return limit > 0 ? out.slice(0, limit) : out;
  }

  /** 已读回执：谁读过这封邮件 */
  readersOf(mailId: string): { reader: string; readAt: string }[] {
    const out: { reader: string; readAt: string }[] = [];
    for (const box of this.mailboxes.values()) {
      const entry = box.entries.get(mailId);
      if (!entry) continue;
      out.push({ reader: box.address, readAt: entry.read ? entry.readAt : "" });
    }

    return out;
  }

  bouncesOf(mailId: string): MailBounce[] {
    return this.bounceLog.filter((item) => item.mailId === mailId);
  }

  /** 邮箱列表（可按集群过滤） */
  listMailboxes(swarmId?: string): Mailbox[] {
    const out: Mailbox[] = [];
    for (const mailbox of this.mailboxes.values()) {
      if (swarmId && mailbox.swarmId !== swarmId) continue;
      out.push(this.publicMailbox(mailbox));
    }
    return out.sort((a, b) => a.address.localeCompare(b.address));
  }

  getMailbox(address: string): Mailbox | undefined {
    const state = this.mailboxes.get(address.trim().toLowerCase());
    return state ? this.publicMailbox(state) : undefined;
  }

  hasMailbox(address: string): boolean {
    return this.mailboxes.has(address.trim().toLowerCase());
  }

  /** 某智能体的全部 trace（跨集群） */
  tracesOfAgent(name: string): TraceEventData[] {
    const out: TraceEventData[] = [];
    for (const list of this.traces.values()) {
      for (const event of list) {
        if (event.agent === name) out.push(event);
      }
    }

    return out;
  }

  /** 某智能体发出的全部消息（跨线程） */
  messagesOfAgent(name: string): MessageData[] {
    const out: MessageData[] = [];
    for (const list of this.messages.values()) {
      for (const message of list) {
        if (message.agent === name) out.push(message);
      }
    }

    return out;
  }

  /** 某智能体的收工记录（agent.done 事件） */
  sessionsOfAgent(
    name: string,
  ): { seq: number; time: string; reason: string; confirm: string; stop: AgentStop; at: string }[] {
    const out: { seq: number; time: string; reason: string; confirm: string; stop: AgentStop; at: string }[] = [];
    for (const event of this.events) {
      if (event.type !== "agent.done" || event.agent !== name) continue;
      const at = typeof event.at === "string" ? event.at : "";
      const clock = at.length >= 19 ? at.slice(11, 19) : "";
      const confirm = typeof event.confirm === "string" ? event.confirm : "";
      out.push({ seq: event.seq, time: clock, reason: event.reason, confirm, stop: event.stop ?? "done", at });
    }

    return out;
  }

  /** 这个集群已经花掉多少（= SwarmData.cost，但显式给一个查询，读起来更清楚） */
  spendOf(swarmId: string): number {
    return this.swarms.get(swarmId)?.cost ?? 0;
  }

  /** 这个集群撞过的切片（按发生顺序） */
  listCollisions(swarmId: string): { slice: string; holders: string[]; verdict: string }[] {
    return [...(this.collisions.get(swarmId) ?? [])];
  }

  /** 我已经撞过、还没拿下的切片名（大脑用来换下一片，避免死循环撞同一片） */
  myLostSlices(swarmId: string, agent: string): string[] {
    return (this.collisions.get(swarmId) ?? []).filter((item) => item.holders.includes(agent)).map((item) => item.slice);
  }

  listClaims(swarmId: string): { slice: string; agent: string }[] {
    const held = this.claims.get(swarmId);
    if (!held) return [];
    return [...held.entries()].map(([slice, agent]) => ({ slice, agent }));
  }

  /** 这个 id 是否**曾经**用过（含已删除的集群）—— 建集群时用来保证 id 永不重用 */
  hasEverHadSwarm(id: string): boolean {
    return this.everCreated.has(id) || this.swarms.has(id);
  }

  /** 工作区版本留档：某集群每个文件谁写过（write 工具和 bash heredoc 都算）。 */
  listFiles(swarmId: string): FileInfo[] {
    const byPath = this.files.get(swarmId);
    if (!byPath) return [];
    return [...byPath.values()]
      .map((record) => ({
        path: record.path,
        lastAgent: record.lastAgent,
        lastCommit: record.lastCommit,
        lastTime: record.lastTime,
        writers: [...record.writers.entries()]
          .map(([agent, count]) => ({ agent, count }))
          .sort((a, b) => b.count - a.count),
        commits: record.commits.slice(-50),
      }))
      .sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));
  }

  /** 看板：某集群所有切片的当前状态 */
  listSlices(swarmId: string): SliceInfo[] {
    const map = this.slices.get(swarmId);
    if (!map) return [];
    return [...map.entries()].map(([slice, info]) => ({
      slice,
      status: info.status,
      claimedBy: info.claimedBy,
      evidence: info.evidence,
    }));
  }

  /** 质疑：某集群全部质疑（按提出时间有序）。 */
  listChallenges(swarmId: string): ChallengeInfo[] {
    const map = this.challenges.get(swarmId);
    if (!map) return [];
    return [...map.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }

  /** 质疑：某 agent 收到的、还没回应的质疑（催他回应用）。 */
  openChallengesFor(swarmId: string, agent: string): ChallengeInfo[] {
    return this.listChallenges(swarmId).filter(
      (c) => c.status === "open" && (c.target === agent || c.target === "all"),
    );
  }

  /** 看板：某集群某切片的当前状态 */
  sliceByName(swarmId: string, slice: string): SliceInfo | undefined {
    const info = this.slices.get(swarmId)?.get(slice);
    return info ? { slice, status: info.status, claimedBy: info.claimedBy, evidence: info.evidence } : undefined;
  }

  /** 看板：某切片交付时留下的证据（没交付过就是空串）。收工汇报会引用它 */
  sliceEvidence(swarmId: string, slice: string): string {
    return this.slices.get(swarmId)?.get(slice)?.evidence ?? "";
  }

  /** 某个 agent 在这个集群里做过几件某种动作（工具名的行为流条数）。
   *  收工闸问的是"封板之后你有没有亲自查证过"，mock 大脑靠它知道该不该先去验一遍。 */
  countTraces(swarmId: string, agent: string, types: string[]): number {
    const list = this.traces.get(swarmId) ?? [];
    return list.filter((item) => item.agent === agent && types.includes(item.type)).length;
  }

  /** 某个 agent 在某个时间**之后**做过的动作（P2 停滞检测用：
   *  切片被认领之后，持有人到底有没有在干活 —— 看动作，不看"过了几轮"）。
   *  时间戳是 ISO 串，字典序即时间序。 */
  tracesSince(swarmId: string, agent: string, since: string, types: string[]): TraceEventData[] {
    const list = this.traces.get(swarmId) ?? [];
    return list.filter(
      (item) => item.agent === agent && types.includes(item.type) && item.time >= since,
    );
  }

  claimHolder(swarmId: string, slice: string): string | undefined {
    return this.claims.get(swarmId)?.get(slice);
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /** 订阅事件（WS 推送用）。返回取消订阅函数。 */
  onAppend(listener: (event: SwarmEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listAgents(): AgentInfo[] {
    return [...this.agents.values()];
  }

  listEvents(since = 0): SwarmEvent[] {
    return since > 0 ? this.events.filter((event) => event.seq > since) : [...this.events];
  }

  totals(): SwarmTotals {
    const swarms = this.listSwarms();
    return { swarms: swarms.length, live: swarms.filter((swarm) => swarm.state === "live").length };
  }

  /** 真正的空库：没有任何事件、也没有任何集群。仅此时才允许播种，避免重复 seed。 */
  isPristine(): boolean {
    return this.seq === 0 && this.swarms.size === 0 && this.slices.size === 0;
  }

  /**
   * 写快照（含全部事件，重启时按 seq 去重）。
   *
   * seq 必须取「实际持有的事件里的最大 seq」，不能取 this.seq：
   * append() 是「先 ++seq 再 apply()」，万一某个投影抛异常，this.seq 就跑到 events 前面了。
   * 那时候按 this.seq 写快照，重载时会跳过所有 seq ≤ snapshotSeq 的日志行 ——
   * 而快照里并没有这些事件，于是**静默丢数据**。（2026-09-14 实测踩到：快照 80 条却声称 seq=82，
   * 日志 677 行只重放出 637 条。）
   */
  async snapshot(): Promise<void> {
    const seq = this.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    await writeFile(this.snapshotFile, JSON.stringify({ seq, events: this.events }), "utf8");
  }

  /** 等待落盘队列排空（优雅退出用）。 */
  async flush(): Promise<void> {
    await this.queue;
  }
}

/* ---------- 纯转换 ---------- */

/** MailData → 前端 MessageData（agent 用 local 部分，保持老契约） */
function toMessageData(mail: MailData): MessageData {
  return {
    id: mail.id,
    threadId: mail.threadId,
    time: mail.time,
    agent: localOf(mail.from),
    chars: mail.chars,
    kind: mail.kind,
    body: mail.body,
    broadcast: isBroadcast([...mail.to, ...mail.cc], ALIAS_LOCALS),
  };
}

/** 别名集合：发信时写进收件人的那些"通配名字" */
const ALIAS_LOCALS: ReadonlySet<string> = new Set(["all", "agents", "humans"]);

/** 历史 message.posted → 邮件（收件人由调用方按线程成员解析） */
function legacyMail(message: MessageData, recipients: string[]): MailData {
  const swarmId = message.threadId.split("/")[0];
  return {
    id: message.id,
    swarmId,
    from: addressOf(message.agent, swarmId),
    to: recipients,
    cc: [],
    subject: "",
    body: message.body,
    chars: message.chars,
    kind: message.kind,
    threadId: message.threadId,
    replyTo: "",
    time: message.time,
  };
}
