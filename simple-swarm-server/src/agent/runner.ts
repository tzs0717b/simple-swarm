/*
 * Agent Runner（M4）：让智能体真的跑起来。
 *
 * 循环的形状（和真模型时一模一样，只是 decide() 换了个实现）：
 *
 *   decide(账本现状)  →  调一个 SwarmKit 工具  →  把观察结果写进行为流  →  记账  →  下一轮
 *
 * 三条硬闸（少任何一条都会烧钱/烧时间）：
 *   1. 每个智能体最多 maxTurns 步          —— 防死循环
 *   2. 每个智能体最多 maxSparkMails 封      —— 防"回信乒乓"（那是真的会无限对轰）
 *      不显式指定时按人头算：2 × 人数，下限 5、上限 50（见 mailCapFor）
 *   3. 集群花超 budget 就停                —— M5 熔断
 * 外加：集群被防风暴闸按停（swarm.stopaused）时立刻停。
 *
 * M7：终止条件只有一条 —— **所有智能体都 done**。
 * 系统不判对错，验收靠社会机制：提示词要求「必须由另一个 agent 确认」，
 * 收工时在 confirm 里写清为什么判定 OK。
 */
import { readdirSync, statSync } from "node:fs";
import {
  LLM_FAILOVER_AFTER,
  LLM_FALLBACK_MODELS,
  LLM_MAX_BRAIN_ERRORS_TOTAL,
  LLM_TURN_DEADLINE_MS,
  SWARM_DONE_GATE,
  SWARM_DONE_ASK,
  SWARM_DONE_ASK_GRACE_MS,
  SWARM_WALL_BROADCAST,
  SWARM_STALL_STEPS,
  SWARM_VERIFY_GATE,
  SWARM_FAIL_MODE,
  SWARM_WATCHDOG_MS,
  usdForTokens,
  SWARM_SHIP_FINAL_FRACTION,
  SWARM_SHIP_FRACTION,
  SWARM_INDEPENDENT_RECHECK,
  SWARM_HANDOFF_GATE,
} from "../config.ts";
import { fetchLanes, probeLanes, assignLanes, describeLanes, type Assignment } from "./keyplan.ts";
import type { EventStore } from "../eventstore.ts";
import { addressOf } from "../mail.ts";
import { sendMail } from "../send.ts";
import { clock, messageId } from "../time.ts";
import { FIX_PREFIX, REVERIFY_PREFIX, isVerificationSlice, reverifyName, verdictOf } from "../verify.ts";
import type { AgentStop, IncompleteStop, SliceInfo, TraceEventData, TraceType } from "../types.ts";
import type { Brain, BrainContext, Decision, StepUsage } from "./brain.ts";
import { sweepChallenges } from "../challenges.ts";
import { SWARM_GOAL_CHARS, SWARM_BOARD_DEADLINE_FRACTION, SWARM_NEGOTIATE_BOARD, SWARM_RUN_MAX_MS, SWARM_PROTOTYPE_FRACTION, SWARM_INBOX_GATE, SWARM_PROTOTYPE_MIN_BUDGET, SWARM_PROTOTYPE_BUDGET, SWARM_HANDOFF_THROTTLE_MS, SWARM_HANDOFF_MAIL_CAP, SWARM_AUTOSHIP_FRACTION, SWARM_DELIVER_NUDGE_CAP, SWARM_IDLE_NUDGE_FRACTION } from "../config.ts";
import { boardDeadlineReached, boardTimeoutText, negotiateKickoffText, resumeKickoffText } from "../board.ts";
import { SWARM_TALK_DOWNGRADE_FRACTION } from "../board.ts";
import {
  runWorkspaceChecks,
  toolArchive,
  toolBash,
  toolBroadcast,
  toolClaimSlice,
  toolCompleteSlice,
  toolDone,
  toolHandoff,
  toolEditFile,
  toolListMailboxes,
  toolMarkRead,
  toolPublishSlice,
  toolReadFile,
  toolReadInbox,
  toolReleaseSlice,
  toolReply,
  toolSendMail,
  toolWriteFile,
  type ToolResult,
  runSampleCheck , runAcceptanceCases } from "./tools.ts";
import { workspaceOf } from "./workspace.ts";
import { commitStep, headSha } from "./gitworkspace.ts";
import { goalDeliverable } from "../slicer.ts";
import { NO_TOOL_STREAK_LIMIT, autoShipEvidence, detectHandoffs, handoffMailText, idleNudgeBody, looksLikeGreenCheck, type Handoff , verifiedVerdict , looksLikeHang, hangNotice , parseTaskSample , parseAcceptanceCases, parseTaskEntry , acceptScore , hollowGreenLine } from "./versions.ts";
import { toolChallenge, toolRespondChallenge, toolRuleChallenge } from "./tools.ts";

export interface RunnerOptions {
  store: EventStore;
  swarmId: string;
  /** 本集群的切片清单 */
  slices: string[];
  brain: Brain;
  /** 每个智能体最多走几步（硬闸） */
  maxTurns: number;
  /** 每个智能体最多发几封（防乒乓） */
  /* 每个 agent 最多发几封（防乒乓）。不填就按人头算 —— 见 mailCapFor() */
  maxSparkMails?: number;
  /** 名字 → 初始 token（M4 的 mock 每步固定消耗，M8 换成真 usage） */
  tokensPerTurn: number;
  /** 单步失败后最多自动重试几次（防一次抖动就全群陪跑） */
  maxAgentRetries?: number;
  /** 单个智能体**连续**多少次"大脑报错"才放弃（中间允许它下一轮再试） */
  maxBrainErrors?: number;
  /** 每个智能体指定模型（M8：同一个集群里可以混用不同模型，不填就用集群默认的） */
  agentModels?: Record<string, string>;
  /** 交付闸开关；不填走 SWARM_HANDOFF_GATE（测试里可以单点关掉） */
  handoffGate?: boolean;
  /** 独立复检开关；不填走 SWARM_INDEPENDENT_RECHECK */
  independentRecheck?: boolean;
  /** 备用模型名单（故障转移用）。不填用 LLM_FALLBACK_MODELS */
  fallbackModels?: string[];
  /** 累计失败多少次后开始换模型。不填用 LLM_FAILOVER_AFTER */
  failoverAfter?: number;
  /** 单个智能体**累计**多少次大脑报错就放弃（跨模型的兜底）。不填用 LLM_MAX_BRAIN_ERRORS_TOTAL */
  maxBrainErrorsTotal?: number;
  /** P2 停滞阈值（步）：认领后多少步没动作算停滞。不填用 SWARM_STALL_STEPS */
  stallSteps?: number;
  /** 看门狗静默阈值（毫秒）：一步超过这么久没动静就往账本写一条。不填用 SWARM_WATCHDOG_MS */
  watchdogMs?: number;
  /** 验收报 FAIL 的语义：rework（照收+开修复片，默认）| reject（拒收+退片） */
  failMode?: "rework" | "reject";
}

export interface StepRecord {
  agent: string;
  tool: string;
  detail: string;
  observation: string;
  ms: number;
  tokens: number;
  cost: number;
  done: boolean;
  refused: boolean;
  /** 收工时说的话（只有 done 这一步有意义） */
  reason: string;
  /** 收工时给的验收说明（M7：为什么判定可以了） */
  confirm: string;
  /** 收工方式：done = 模型自己判定干完；其余 = 被硬闸/故障按停 */
  stop: AgentStop;
}

/** M7：一个智能体的收工记录 —— 系统只记录"他说完成了"，不判对错 */
export interface Finisher {
  agent: string;
  reason: string;
  confirm: string;
  /** 收工方式（见 AgentStop）：不是 all "done" 就说明有人是被按停的 */
  stop: AgentStop;
}

/* 发信上限：每个 agent 能发多少封 = 2 × 人数，下限 5、上限 50。
 * 为什么按人头而不是写死：这个闸是"防回信乒乓"的兜底，不是业务规则。
 * 写死 5 封时，6 人集群里负责协调/组装的那个 agent 会在半路被按停 ——
 * PELICAN NEW 的 velma 就是这么被当成"收工"的（它切片其实已经交付了）。 */
export const MAILS_PER_AGENT = 2;
export const MAIL_CAP_MIN = 5;
export const MAIL_CAP_MAX = 50;

export function mailCapFor(agentCount: number): number {
  return Math.min(MAIL_CAP_MAX, Math.max(MAIL_CAP_MIN, agentCount * MAILS_PER_AGENT));
}

/** 雏形片的标记：系统在 15% 预算点自己开的那一片 */
export const PROTOTYPE_MARK = "雏形：";

export interface RunReport {
  swarmId: string;
  steps: number;
  mails: number;
  turns: Record<string, number>;
  stoppedBy: "all-done" | "max-turns" | "budget" | "swarm-stopped" | "no-agents" | "brain-error" | "time-limit";
  /** 运行过程中"大脑报错"的流水（含已自动重试恢复的）。它是插曲日志，
   *  **不一定**代表失败；真失败看 stoppedBy === "brain-error"。 */
  errors: string[];
  spend: number;
  budget: number;
  /** 真正收工的人 + 他们给的验收说明（M7） */
  finishers: Finisher[];
  /** 这次每个 agent 允许发多少封（没显式传 maxMails 时按人头算出来的值） */
  mailCap: number;
  /** 不是自主收工的成员（发信上限 / 预算 / 网关放弃）。空数组 = 全员自己判定干完。 */
  incomplete: IncompleteStop[];
  /** M8：履约情况 —— 让系统至少报一下"有人没动/没做完" */
  deliverables?: { claimed: number; completed: number; total: number };
  report: StepRecord[];
}

/** 给一个 promise 套上硬超时：超时抛错（走"大脑异常"那条路），而不是永远等下去。
 *  超时之后底下那个请求还会跑到它自己超时为止，但 runner 已经能继续往下走了。 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("大脑调用超时（" + Math.round(ms / 1000) + " 秒）：本轮作废，下一轮再试")),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AgentRunner {
  private readonly store: EventStore;
  private readonly swarmId: string;
  private readonly slices: string[];
  private readonly brain: Brain;
  private readonly maxTurns: number;
  /** 显式覆盖值（不填 = undefined = 按人头算）。真正的上限在 run() 里算成 mailCap */
  private readonly maxSparkMails: number | undefined;
  private readonly tokensPerTurn: number;
  private readonly maxAgentRetries: number;
  private readonly agentModels: Record<string, string>;
  private readonly handoffGateOn: boolean;
  private readonly independentRecheckOn: boolean;
  /** 交作业闸只喊一次 */
  private shipNudged = 0;
  /* P8：最后一次「验收跑绿」的版本与时刻 —— 收工时判定最终产物到底验没验过 */
  private lastGreenAt = "";
  private lastGreenSha = "";
  /* P10-a：挂死红灯 —— 被强杀（124/137/143）也当一等公民记账 */
  private hangSeen = 0;
  private hangLastAt = "";
  private hangLastAgent = "";
  private readonly hangMailed = new Map<string, number>();
  /* P10-c：某个版本已经因为「验收后又改动」被警告过 */
  private readonly postGreenWarned = new Set<string>();
  /* P13：题面验收的分数（上一次判到的通过条数）与「已经报过退步」的版本 */
  /* P14：跑不起来（import 都过不去）也算一次退步，而且比任何分数都严重。 */
  private acceptRankSeen = false;
  private acceptRank = 0;
  private acceptBestSha = "";
  private acceptBestRank = -1;
  private readonly regressWarned = new Set<string>();
  private greenCount = 0;
  /* 续跑广播只喊一次（历史遗留：用了但没声明，靠 JS 宽容没炸） */
  private resumeAnnounced = false;
  /* 换手播报（M12-P2）：节流表 + 单轮计数，别把邮箱刷爆 */
  private readonly handoffMailed = new Map<string, number>();
  /* P5：绿跑点名（每个 agent 最多一次） */
  private readonly greenNudged = new Set<string>();
  /* P6：空转巡检（每人一次）+ 连续不调工具计数 */
  private readonly idleNudged = new Set<string>();
  private readonly noToolStreak = new Map<string, number>();
  private handoffMailCount = 0;
  private readonly maxBrainErrors: number;
  private readonly fallbackModels: string[];
  private readonly failoverAfter: number;
  private readonly maxBrainErrorsTotal: number;
  /** P2：认领后多少步没动作算停滞（测试要能调小，不然等 20 步太慢） */
  private readonly stallSteps: number;
  /* ---- 看门狗（可诊断性）----
     真跑里出现过"账本完全静止、没有任何一条留痕"的静默挂死：单轮超时本该兜住，但那次它没触发。
     这里每隔一段时间检查"当前阶段跑了多久"，超阈值就写一条留痕 ——
     至少以后能一眼看出是卡在**等模型**还是**跑命令**。 */
  private readonly watchdogMs: number;
  /** 验收报 FAIL：照收返工 or 直接拒收 */
  private readonly failMode: "rework" | "reject";
  private watchdog?: NodeJS.Timeout;
  private phase = "空闲";
  private phaseSince = 0;
  private watchdogLoggedAt = 0;
  /** 每个智能体连续的大脑报错次数（成功一步就清零） */
  private readonly consecutiveBrainErrors = new Map<string, number>();
  /** keypool 车道：每个 agent 一条专属优质 provider（key 物理上不可能撞） */
  private laneAssign = new Map<string, Assignment>();
  /** 车道停在第几条：只前进不后退，免得成功一次又跳回坏车道 */
  private laneStep = new Map<string, number>();
  /** 真的"连续失败到放弃"的智能体。只有这里非空才算这次运行不可信 ——
   *  抖一下就恢复的不算，那只是记录在案的小插曲。 */
  private brainGiveUps: string[] = [];
  /* 累计（不是"连续"）的大脑报错次数。PELICAN 3 的 louis 撞了 20 次墙都没被放弃 ——
     因为连续计数每次都被中间一次成功清零。累计才是真的"这个人废了"。 */
  private readonly brainErrorTotals = new Map<string, number>();
  /* 封板（板上切片全部交付）之后，每个 agent 亲自查证过几次产物。
     没有它，验证者可以先收工、后面出的错就没人看（PELICAN 3 的第三个病）。 */
  private readonly inspectedStep = new Map<string, number>();
  /** 已经记过"换模型"的 agent，避免每次换都写一条噪声 */
  private readonly failoverLogged = new Set<string>();

  /* ---------- 验收闭环（P1）与停滞轮换（P2）的状态 ---------- */
  /** 本 run 内最后一次产物改动（write/edit）发生在什么时候、谁干的。
   *  复检必须发生在这之后，否则那次 PASS 早就过期了。 */
  private artifactAt = "";
  private artifactBy = "";
  /** 本 run 内最近一次**验收片 PASS 交付**的时间（给人看的） */
  private passAt = "";
  /* 判定"过期"用的是**步序**而不是时间戳：mock 几步就能跑完，
     clock() 的秒级精度会让"改动"和"验收"落在同一秒里，比不出来（实测踩过）。
     步序单调递增，永远比得清。 -1 = 还没发生过。 */
  private artifactStep = -1;
  private passStep = -1;
  /** 系统自动开的复检片 → 不许签收的人（产物最后改动者）。自己不能给自己盖章 */
  private readonly reverifySubjects = new Map<string, string>();
  /** 已经点名过复检的片（同一片只点一次，防刷屏） */
  private readonly recheckPointed = new Set<string>();
  /** 每个人被点名复检的次数（轮流当验收员，别老压在一个人身上） */
  private readonly recheckTally = new Map<string, number>();
  /** 切片被认领时的全局步数（停滞检测的起点） */
  private readonly claimStep = new Map<string, number>();
  /** 已经催办过的切片，别每轮都催一遍 */
  private readonly nudged = new Set<string>();
  /** 全局步数（全队加起来）。停滞按"步"算而不是按墙钟 —— 一次慢工具调用不该算停滞 */
  private steps = 0;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.swarmId = options.swarmId;
    this.slices = options.slices;
    this.brain = options.brain;
    this.maxTurns = options.maxTurns;
    this.maxSparkMails = options.maxSparkMails;
    this.tokensPerTurn = options.tokensPerTurn;
    this.maxAgentRetries = options.maxAgentRetries ?? 2;
    this.agentModels = options.agentModels ?? {};
    this.handoffGateOn = options.handoffGate ?? SWARM_HANDOFF_GATE;
    this.independentRecheckOn = options.independentRecheck ?? SWARM_INDEPENDENT_RECHECK;
    this.maxBrainErrors = options.maxBrainErrors ?? 3;
    this.fallbackModels = options.fallbackModels ?? LLM_FALLBACK_MODELS;
    this.failoverAfter = options.failoverAfter ?? LLM_FAILOVER_AFTER;
    this.maxBrainErrorsTotal = options.maxBrainErrorsTotal ?? LLM_MAX_BRAIN_ERRORS_TOTAL;
    this.stallSteps = options.stallSteps ?? SWARM_STALL_STEPS;
    this.watchdogMs = options.watchdogMs ?? SWARM_WATCHDOG_MS;
    this.failMode = options.failMode ?? SWARM_FAIL_MODE;
  }

  /** 进入某个阶段（等模型 / 跑工具） */
  private enter(phase: string): void {
    this.phase = phase;
    this.phaseSince = Date.now();
  }

  private startWatchdog(): void {
    if (this.watchdog || this.watchdogMs <= 0) return;
    this.phaseSince = Date.now();
    this.watchdog = setInterval(() => {
      const held = Date.now() - this.phaseSince;
      if (held < this.watchdogMs) return;
      if (Date.now() - this.watchdogLoggedAt < this.watchdogMs) return;
      this.watchdogLoggedAt = Date.now();
      try {
        this.appendSystemTrace("system", "看门狗：「" + this.phase + "」已经 " + Math.round(held / 1000) + " 秒没动静");
      } catch {
        /* 看门狗自己不能把 run 带崩 */
      }
    }, Math.max(1000, Math.floor(this.watchdogMs / 4)));
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /** 本次运行里"大脑报错"的记录（每次 run 开始清空） */
  private brainErrors: string[] = [];

  /** 该给这个 agent 换哪个模型（纯计算、无副作用）。轮换是**环形**的：
   *  原来是"到名单最后一个就卡住"，名单末尾那个也坏了就再没人可换。 */
  /** 车道上还有没有下一条可换（有 → 这个人就不该被判死）。纯计算、无副作用。 */
  private laneNextModel(agent: string): string | undefined {
    if (this.agentModels[agent]) return undefined;
    const lane = this.laneAssign.get(agent);
    if (!lane || lane.queue.length === 0) return undefined;
    const next = (this.laneStep.get(agent) ?? 0) + 1;
    return next < lane.queue.length ? lane.queue[next].model : undefined;
  }

  private pickFallback(agent: string): string | undefined {
    if (this.fallbackModels.length === 0) return undefined;
    const errors = this.brainErrorTotals.get(agent) ?? 0;
    if (errors < this.failoverAfter) return undefined;
    return this.fallbackModels[(errors - this.failoverAfter) % this.fallbackModels.length];
  }

  /** 这个智能体用哪个模型：单独指定优先，否则用集群默认；累计失败到阈值就故障转移 */
  private modelFor(agent: string, fallback: string): string {
    const base = this.agentModels[agent] ?? fallback;
    /* 车道优先（keypool 优质 provider 专属车道）：一家一个 agent => key 物理上不可能撞。
       连续失败到阈值就往队列后面换一条（换 provider），且只前进不后退 —— 用户口径：
       "如果大脑失败 2 次，直接换 key 或者 provider"。调用方显式给该 agent 指定了模型才不接管。 */
    const lane = this.agentModels[agent] ? undefined : this.laneAssign.get(agent);
    if (lane && lane.queue.length > 0) {
      const streak = this.consecutiveBrainErrors.get(agent) ?? 0;
      const wanted = streak < this.failoverAfter
        ? 0
        : Math.min(1 + Math.floor((streak - this.failoverAfter) / this.failoverAfter), lane.queue.length - 1);
      const prevStep = this.laneStep.get(agent) ?? 0;
      const step = Math.max(prevStep, wanted);
      if (step !== prevStep) {
        this.laneStep.set(agent, step);
        const from = lane.queue[prevStep];
        const to = lane.queue[step];
        this.store.append({
          type: "trace.appended",
          event: {
            id: messageId(),
            swarmId: this.swarmId,
            time: clock(),
            agent,
            type: "system",
            detail: "换车道：" + from.providerName + "/" + from.model + " 连续失败 " + streak + " 次 -> " + to.providerName + "/" + to.model,
            ms: 1,
            status: "ok",
          },
        });
      }
      return lane.queue[step].model;
    }
    /* 上游 400/503 是**模型级**故障：重试同一个模型只是烧钱（louis 撞了 20 次）。
       累计失败到阈值就换名单里的下一个 —— 模型坏了不能把整片活拖死。 */
    const errors = this.brainErrorTotals.get(agent) ?? 0;
    const pick = this.pickFallback(agent);
    if (pick !== undefined) {
      if (pick && pick !== base) {
        if (!this.failoverLogged.has(agent)) {
          this.failoverLogged.add(agent);
          this.store.append({
            type: "trace.appended",
            event: {
              id: messageId(),
              swarmId: this.swarmId,
              time: clock(),
              agent,
              type: "system",
              detail: "模型故障转移：" + base + " 累计失败 " + errors + " 次，换到 " + pick,
              ms: 1,
              status: "ok",
            },
          });
        }
        return pick;
      }
    }
    return base;
  }

  /** 把这个 agent 名下**还没交付**的切片退回板上，让别人能接。
   *  一个人被放弃/被按停，他手上的活不该跟着一起死（PELICAN 3：主产物锁死在 louis 手里）。 */
  private releaseClaims(agent: string, why: string): string[] {
    const freed: string[] = [];
    for (const info of this.store.listSlices(this.swarmId)) {
      if (info.status !== "claimed" || info.claimedBy !== agent) continue;
      this.store.append({ type: "claim.released", swarmId: this.swarmId, agent, slice: info.slice });
      this.store.append({
        type: "trace.appended",
        event: {
          id: messageId(),
          swarmId: this.swarmId,
          time: clock(),
          agent,
          type: "system",
          detail: "退回切片「" + info.slice + "」：持有者停摆（" + why + "），退回板上等别人接手",
          ms: 1,
          status: "ok",
        },
      });
      freed.push(info.slice);
    }
    return freed;
  }

  /** 跑完整个集群：一轮一轮地让每个还没收工的智能体走一步，直到某个闸拦下来 */
  async run(): Promise<RunReport> {
    this.startWatchdog();
    try {
      return await this.runInner();
    } finally {
      this.stopWatchdog();
    }
  }

  private async runInner(): Promise<RunReport> {
    const report: StepRecord[] = [];
    const turns: Record<string, number> = {};
    const done = new Set<string>();
    let mails = 0;
    let stoppedBy: RunReport["stoppedBy"] = "all-done";
    this.brainErrors = [];
    this.consecutiveBrainErrors.clear();
    this.brainGiveUps = [];

    const swarm = this.store.getSwarm(this.swarmId);
    if (!swarm) throw new Error("集群不存在：" + this.swarmId);
    const roster = swarm.agents.filter((name) => name !== "system");
    /* 开跑前拉一次 keypool 车道表：优质模型优先 + 横向铺开（每个 agent 一条不同 provider 的车道）。
       key 永远在同一家 provider 内部选 => provider 不同 => key 物理上不可能撞。
       读不到池子就退回静态模型名单，绝不阻塞开跑。 */
    try {
      const lanes = await probeLanes(await fetchLanes());
      this.laneAssign = assignLanes(roster, lanes);
      this.laneStep.clear();
      const anyPinned = roster.some((name) => this.agentModels[name]);
      if (this.laneAssign.size > 0 || anyPinned) {
        this.store.append({
          type: "trace.appended",
          event: {
            id: messageId(),
            swarmId: this.swarmId,
            time: clock(),
            agent: "system",
            type: "system",
            detail: (anyPinned && this.laneAssign.size === 0 ? "模型已钉死（不走车道分配）：" : "车道分配（优质优先，一家一个 agent）：") + describeLanes(this.laneAssign, this.agentModels),
            ms: 1,
            status: "ok",
          },
        });
      }
    } catch (error) {
      this.laneAssign.clear();
    }

    if (roster.length === 0) {
      return {
        swarmId: this.swarmId,
        steps: 0,
        mails: 0,
        turns,
        stoppedBy: "no-agents",
        errors: [],
        spend: 0,
        budget: swarm.budget,
        finishers: [],
        incomplete: [],
        mailCap: 0,
        report,
      };
    }

    /* 发信上限按人头算：固定值会把人多集群里正常协调的 agent 半路按停。
       显式传了 maxMails 就以调用方为准（0 也是合法值 = 一封都不许发）。 */
    const mailCap = this.maxSparkMails ?? mailCapFor(roster.length);

    /* 轮次上限默认取消（maxTurns <= 0 = 一直跑）：用户口径"由人来按停"，预算/墙钟兜底。 */
    const roundCap = this.maxTurns > 0 ? this.maxTurns : Number.POSITIVE_INFINITY;
    const runStartMs = Date.now();
    outer: for (let round = 1; round <= roundCap; round += 1) {
      /* P2：每轮开头扫一遍"被认领但没人动"的片 —— 停滞要有系统动作，不能只靠 agent 自觉 */
      this.stallSweep();
      this.wallClockSweep();
      this.idleSweep();
      /* 交作业闸 v2（exp-16 复盘）：① 旧版插在循环外，只在开跑瞬间判一次 → 整个 run 里永不触发；
         ② exp-14/15/16 的 complete_slice 调用数都是 0 —— 不是交不出去，是没人尝试：
            旧 evidence 要求「跑了什么命令、看到什么输出」，而片子产物是 SVG/图，凑不出这种证据。
         所以 v2：循环内判、两次喊话（50% / 80%）、并且**点名工具名**（"去交付"没用，"调用 complete_slice"才有用）。 */
      if (SWARM_RUN_MAX_MS > 0) {
        const elapsedMs = Date.now() - runStartMs;
        const leftMin = Math.max(0, Math.round((SWARM_RUN_MAX_MS - elapsedMs) / 60000));
        if (this.shipNudged === 0 && elapsedMs >= SWARM_RUN_MAX_MS * SWARM_SHIP_FRACTION) {
          this.shipNudged = 1;
          this.mailTeam(
            "还剩约 " + leftMin + " 分钟：开始收尾，按现状交付",
            "系统提醒（第 1 次 / 共 2 次）：这一轮 " + Math.round(SWARM_RUN_MAX_MS / 60000) + " 分钟，现在剩约 " + leftMin + " 分钟。请现在把手上这片收口：" + "\n" +
              "  1) 只要产物能看/能跑，就调用 complete_slice 交付；evidence 写「做完了什么 / 怎么验的（命令、截图或目测都算）/ 哪里没做完」；" + "\n" +
              "  2) 不需要完美证据，也不需要等人许可 —— 半成品 + 说清边界就是合格交付；" + "\n" +
              "  3) 还在等别人坐标的，按当前假设做完就交付，把假设写进 evidence，不要停在等待上；" + "\n" +
                "  4) 这片太大、到点也做不完的话 —— 不丢人，也不许硬扛：先把**已经做完的那部分**直接 complete_slice 交付，" +
                "     再用 slice_added 把剩下的拆成更小的一片（写清还差什么）。拆片不算失败，卡着不动才算。",
            "verify",
          );
          this.appendSystemTrace("system", "交作业闸①：墙钟 " + Math.round(SWARM_SHIP_FRACTION * 100) + "%，提醒全队调用 complete_slice 按现状交付");
          if (this.hangSeen > 0) {
            const notice = hangNotice(this.hangSeen, this.hangLastAt, this.hangLastAgent);
            this.mailTeam(
              "【挂死提醒】本轮出现过跑挂死的产物",
              notice + "交出去之前对齐一下顺序：让**最后一次验收**晚于**最后一次改动** —— 反过来的话，交付的证据是过期的。",
              "verify",
            );
            this.appendSystemTrace("system", "挂死提醒：已广播全队（" + notice + "）");
          }
          /* P13-a：题面验收**无条件**跑。上一轮把它塞在「挂死」分支里，而 calc-r1 挂死 0 次 ——
             结果整整一轮分数一次都没播出来：有人做到 23/24，别人把它砸成 0/24 连砸 7 次、8 分钟没人知道。 */
          {
            const acceptNow = this.sampleReport();
            const scoreNow = acceptScore(acceptNow.note);
            this.appendSystemTrace(
              "system",
              "交作业闸（50%）题面验收：" + (acceptNow.ok ? "达标" : scoreNow === null ? "跑不起来" : String(scoreNow) + " 分"),
            );
            if (!acceptNow.ok) {
              this.mailTeam(
                "【题面验收没过】机器自己跑的结果在下面",
                acceptNow.note + "\n" + "这是系统拿**题面自带的标准答案**跑的（不是谁的验收脚本）—— 交之前想办法让它对上。" + "\n",
                "verify",
              );
              this.appendSystemTrace("system", "题面验收红灯：" + acceptNow.note);
            }
          }
        } else if (this.shipNudged === 1 && elapsedMs >= SWARM_RUN_MAX_MS * SWARM_SHIP_FINAL_FRACTION) {
          this.shipNudged = 2;
          const openNow = this.store.listSlices(this.swarmId).filter((info) => info.status === "claimed");
          for (const info of openNow) {
            /* 用户 2026-09-18 抓到的 bug：claimedBy 是 string（types.ts:118），
               claimedBy[0] = 首字母 —— 于是"点名催交付"寄给了 p@/a@/r@ 这种不存在的地址，
               agent 看见后还照着抄，造成 11 封退信 + 催办根本没送到人手里。 */
            const who = String(info.claimedBy || "").trim();
            if (!who) continue;
            try {
              sendMail(this.store, {
                swarmId: this.swarmId,
                from: "system",
                to: [who + "@" + this.swarmId + ".swarm"],
                subject: "最后催一次（剩约 " + leftMin + " 分钟）：立刻用 complete_slice 交付「" + info.slice.slice(0, 20) + "」，evidence 贴验收脚本的结果表（有 FAIL 先修）",
                body: "系统点名 " + who + "：你认领的「" + info.slice + "」还没交付，现在剩约 " + leftMin + " 分钟。" + "\n" +
                  "请立刻调用 complete_slice(slice=「…」, evidence=「…」)。" + "\n" +
                  "evidence 只要三件事：做了什么 / 怎么验的 / 哪里没做完。" + "\n" +
                  "哪怕只写「能跑通、目测没问题、色调还没调」也算。别再打磨了 —— 没交付的片在复盘里等于零产出。" + "\n" +
                    "如果这一片到点也做不完：先交你已经做完的那部分，再用 slice_added 把剩下的写成新片（写清还差什么）。先交付 > 完美交付。",
                kind: "verify",
              });
            } catch (error) {
              console.error("[runner] 点名催交付失败:", error);
            }
          }
          this.appendSystemTrace("system", "交作业闸②：墙钟 " + Math.round(SWARM_SHIP_FINAL_FRACTION * 100) + "%，点名 " + openNow.length + " 个未交付的认领人");
        } else if (this.shipNudged === 2 && elapsedMs >= SWARM_RUN_MAX_MS * SWARM_AUTOSHIP_FRACTION) {
          /* 收口兜底（B3）：两次喊话之后还没人交付 -> 系统按现状入账，别让整轮的活白干 */
          this.shipNudged = 3;
          this.autoShipBoard();
        }
      }

      /* 墙钟闸：墙钟上限由 SWARM_RUN_MAX_MS 决定（实验用过 15/30/45 分钟）。只停这一轮 run，状态机不动。 */
      if (SWARM_RUN_MAX_MS > 0 && Date.now() - runStartMs >= SWARM_RUN_MAX_MS) {
        this.appendSystemTrace("system", "跑到墙钟上限 " + Math.round(SWARM_RUN_MAX_MS / 1000) + " 秒，主动停下复盘（swarm 仍为 live，可继续 /run 续跑）");
        stoppedBy = "time-limit";
        break outer;
      }
      /* 雏形闸：花到预算 SWARM_PROTOTYPE_FRACTION 还没出雏形 -> 系统自己往板上开一片 */
      await this.negotiationGate(roster);
      for (const agent of roster) {
        if (done.has(agent)) continue;

        // 熔断：花超了立刻停，别等到这一轮跑完
        const current = this.store.getSwarm(this.swarmId);
        if (!current) break outer;
        if (current.state !== "live") {
          stoppedBy = "swarm-stopped";
          break outer;
        }
        if (current.cost >= current.budget) {
          this.store.append({
            type: "swarm.stopped",
            swarmId: this.swarmId,
            reason:
              "预算耗尽：已花 $" + current.cost.toFixed(4) + " / 上限 $" + current.budget.toFixed(2),
            time: clock(),
          });
          stoppedBy = "budget";
          break outer;
        }

        // 硬闸 2：发信上限。大脑可能被写成"回不完的信"，这里兜底。
        const sent = this.store.listMailboxMails(addressOf(agent, this.swarmId), "sent", 0).length;
        if (sent >= mailCap) {
          /* 被按停的人手上的活也要退回去 —— 别让一个上限把切片一起锁死 */
          this.releaseClaims(agent, "达到发信上限 " + mailCap + " 封");
          const capped = toolDone(
            { store: this.store,
      boardFraction: SWARM_RUN_MAX_MS > 0 ? Math.min(1, (Date.now() - this.boardT0) / Math.max(1, SWARM_RUN_MAX_MS * SWARM_BOARD_DEADLINE_FRACTION)) : 0, swarmId: this.swarmId, agent },
            "已达到发信上限 " + mailCap + " 封，主动收工",
            "被发信上限按停，不算交付完成",
            "mail-cap",
          );
          const step = this.record(agent, swarm.model, "done", { ...capped, traceType: "system" }, 1);
          turns[agent] = (turns[agent] ?? 0) + 1;
          report.push(step);
          done.add(agent);
          continue;
        }

        /* 墙钟闸（每人之前再查一次）：只查每轮开头不够 —— 一个 agent 卡在 300 秒模型超时里，

           整轮就不结束，墙钟硬上限会被冲过头（2026-09-17 实测）。 */

        if (SWARM_RUN_MAX_MS > 0 && Date.now() - runStartMs >= SWARM_RUN_MAX_MS) {

          this.appendSystemTrace("system", "跑到墙钟上限 " + Math.round(SWARM_RUN_MAX_MS / 1000) + " 秒，收工（不再等剩下的 agent）");

          stoppedBy = "time-limit";

          break outer;

        }

        /* 质疑闸：超过宽限期没人回应的质疑 → 沉默即认账，按成立处理并改板。
           放在每人之前，和墙钟闸同一层，保证整轮一定会被扫到。 */
        try {
          const expired = sweepChallenges(this.store, this.swarmId);
          if (expired > 0) this.appendSystemTrace("system", "质疑超时 " + String(expired) + " 条 → 按成立处理并改板");
        } catch (error) {
          console.error("[runner] 质疑扫描失败:", error);
        }
        const step = await this.turnWithRetry(agent, swarm.name, this.modelFor(agent, swarm.model), this.goalOf());
        turns[agent] = (turns[agent] ?? 0) + 1;
        report.push(step);
        if (step.done) done.add(agent);
      }
      if (roster.every((agent) => done.has(agent))) {
        stoppedBy = "all-done";
        break;
      }
    }

    /* 有人因为连续失败被放弃 → 这次运行不可信，不能显示成"全员收工、集群完成"。
       注意判据是 brainGiveUps（真的放弃了）而不是 brainErrors（抖过的次数）：
       只抽了一下又自己恢复的，不该被算成失败。 */
    if (this.brainGiveUps.length > 0 && stoppedBy === "all-done") {
      stoppedBy = "brain-error";
    }

    /* 全部收工 → 集群完成（只有还在 live 的才需要收尾）。
       M7：系统**不判对错**，这里只数人头 —— 所有 agent 都 done 就算收工。
       验收靠社会机制：提示词要求「必须由另一个 agent 确认」，收工时的 confirm
       里写清为什么判定 OK。dod 恒为空数组：不再拿关键词去匹配目标文本
       （那是之前那套伪造判定的做法，已删除）。 */
    /* 谁不是"自己判定干完"的：发信上限按停 / 预算熔断 / 连续网关失败被放弃。
       第一个 done 说了算（一个 agent 收工后不会再被叫起来）。
       M7 系统仍然**不判对错**，但"被按停"和"自己说干完了"必须能被区分 ——
       否则被按停的人会静默混进"全员收工、集群完成"（PELICAN NEW 的 velma 就是这么没的）。 */
    const stops = new Map<string, AgentStop>();
    for (const step of report) {
      if (step.tool === "done" && step.done && !stops.has(step.agent)) stops.set(step.agent, step.stop);
    }
    const incomplete: IncompleteStop[] = [];
    for (const agent of roster) {
      const stop = stops.get(agent);
      if (stop === undefined || stop === "done") continue;
      const last = [...report].reverse().find((step) => step.agent === agent && step.tool === "done");
      incomplete.push({ agent, stop, reason: last?.reason ?? "" });
    }

    /* M8：履约率。系统不判对错，但"6 片只有 2 片被认领、4 片躺着没人动"必须能被看见 ——
       否则 agent 说一句"交付了"、集群照样 swarm.completed，谁都没发现缺口。 */
    const allSlices = this.store.listSlices(this.swarmId);
    const deliverables = {
      claimed: allSlices.filter((s) => s.status !== "available").length,
      completed: allSlices.filter((s) => s.status === "completed").length,
      total: allSlices.length,
    };

    /* M7：谁真的收工了 + 他给的验收说明。直接从落盘的行为流里取，重放后一致。 */
    const finishers: Finisher[] = [];
    for (const agent of roster) {
      const last = [...report].reverse().find((step) => step.agent === agent && step.tool === "done" && step.done);
      if (last) finishers.push({ agent, reason: last.reason, confirm: last.confirm, stop: last.stop });
    }

    /* finishers → dod[]：从目标文本切出 DoD 判据，逐条核对社会验收记录。
       每个 agent 的 confirm 一般都转述 sliceEvidence()，而 mockEvidence 把整个 goal 原文嵌进去，
       所以 DoD 关键词会命中；实智能体的 confirm 会写更直接的代码证据。 */
    const allConfirm = finishers.map((f) => f.agent + "：" + f.confirm).join("；");
    const finished = stoppedBy === "all-done" && roster.every((agent) => done.has(agent))
      ? this.store.getSwarm(this.swarmId) : null;
    const goalText = finished?.goal ?? "";
    const dodMatch = goalText.match(/DoD[\uff1a:]*(.+)/);
    const criteria = dodMatch
      ? dodMatch[1].replace(/[。.]$/, "").split(/[,、，+]|\s*\+\s*/).map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
    const dod: { criterion: string; passed: boolean; evidence: string }[] = criteria.map((criterion) => ({
      criterion,
      passed: allConfirm.length > 0 && allConfirm.includes(criterion),
      evidence: allConfirm || "无社会验收记录",
    }));

    if (stoppedBy === "all-done" && roster.every((agent) => done.has(agent))) {
      if (finished && finished.state === "live") {
        this.store.append({
          type: "swarm.completed",
          swarmId: this.swarmId,
          dod,
          incomplete,
          deliverables,
          time: clock(),
        });
      }
    } else if (stoppedBy === "all-done") {
      stoppedBy = "max-turns";
    }

    /* 可观测性（真跑实测教训）：跑满轮数上限结束是**静默**的 —— 账本一个事件都不写、
       state 还是 live，看上去跟"卡死"一模一样（这一度让人误判成挂死，靠"调用数 = 轮数 × 6"
       才对上账）。这里补一条留痕：跑完就打一声招呼，并说清还能不能续跑。 */
    const stopText =
      stoppedBy === "all-done"
        ? "全员收工"
        : stoppedBy === "time-limit"
          ? "跑到墙钟上限（实验口径）"
        : stoppedBy === "max-turns"
          ? "跑满步数上限"
          : stoppedBy === "budget"
            ? "预算耗尽"
            : stoppedBy === "swarm-stopped"
              ? "集群被停止"
              : stoppedBy === "brain-error"
                ? "有 agent 因模型异常被放弃"
                : "没有可用 agent";
    this.freezeWorkspace();
    this.appendSystemTrace(
      "system",
      "本轮跑完：" +
        stopText +
        "，共 " +
        report.length +
        " 步（每人每轮上限 " +
        (this.maxTurns > 0 ? this.maxTurns + " 步" : "不限") +
        "；swarm 仍为 live，可继续 /run 续跑）",
    );

    mails = report.filter((step) => step.tool === "reply" || step.tool === "send_mail" || step.tool === "broadcast").length;
    const final = this.store.getSwarm(this.swarmId);
    return {
      swarmId: this.swarmId,
      steps: report.length,
      mails,
      turns,
      stoppedBy,
      errors: this.brainErrors,
      spend: final?.cost ?? 0,
      budget: final?.budget ?? 0,
      finishers,
      incomplete,
      deliverables,
      mailCap,
      report,
    };
  }

  /**
   * 走一步；如果这一步被拒绝/异常（refused），就自动重试，最多 maxAgentRetries 次。
   * 这是给"LLM 抽风一次"兜底：不因为单步失败就把整个 agent 判死。
   * 重试也留痕：每条自动重试都写进行为流。
   */
  private async turnWithRetry(agent: string, swarmName: string, model: string, goal: string): Promise<StepRecord> {
    let last: StepRecord | undefined;
    for (let attempt = 0; attempt <= this.maxAgentRetries; attempt += 1) {
      const step = await this.turn(agent, swarmName, model, goal);
      last = step;
      if (!step.refused) return step;
      /* 「模型把工具调用写成文本 / 没调用任何工具」不是异常，但它同样说明这个模型不能用。
         必须计进故障转移计数 —— 否则会像 2026-09-17 实测那样：一个坏模型（glm-4-flash）把工具调用
         写成 json 文本，系统认不出来，同一个 agent 白烧 30 步 / 100k token，还永远不换模型。 */
      if (JSON.stringify(step).includes("模型没有调用任何工具")) {
        this.consecutiveBrainErrors.set(agent, (this.consecutiveBrainErrors.get(agent) ?? 0) + 1);
        /* B1（2026-09-19 实测 p2482-diandian3）：no-tool 时原地重试基本必然再失败（同一上下文同一毛病），
           一次 no-tool 最多白烧 6 次调用（llm 催 1 次 × runner 重试 2 次），全轮 52 次调用被吃掉约 1/3。
           不再原地重试：计完大脑异常（保留故障转移语义）直接放弃这一轮，等下一个排程轮次带新现场再来。 */
        return step;
      }
      if (attempt < this.maxAgentRetries) {
        this.store.append({
          type: "trace.appended",
          event: {
            id: messageId(),
            swarmId: this.swarmId,
            time: clock(),
            agent,
            type: "retry",
            detail:
              "第 " + (attempt + 1) + " 次失败，自动重试（" + (attempt + 1) + "/" + this.maxAgentRetries + "）",
            ms: 1,
            status: "ok",
          },
        });
      }
    }
    return last as StepRecord;
  }

  /** 一个智能体走一步：先问大脑，再把决定落到工具上 */
  private async turn(agent: string, swarmName: string, model: string, goal: string): Promise<StepRecord> {
    const ctx = this.context(agent, swarmName, goal, model);
    const started = Date.now();

    // 预算刹车：钱花光就不再让它继续行动，直接按 done 记一笔。
    if (this.overBudget()) {
      const capped = toolDone(ctx, "预算耗尽，强制收工", "预算熔断，不算交付完成", "budget");
      return this.record(agent, model, "done", { ...capped, traceType: "system" }, Date.now() - started);
    }

    // 大脑异常不让整个集群陪葬：记一笔 done（原因写清是异常），这一轮就结束。
    let decision: Decision;
    let usage: StepUsage | undefined;
    try {
      /* 单轮硬超时：见 withDeadline 的注释（丢包冻集群的实测事故） */
      this.enter("等模型（" + agent + "）");
      const outcome = await withDeadline(this.brain.decide(ctx), LLM_TURN_DEADLINE_MS);
      this.enter("空闲");
      decision = outcome.decision;
      usage = outcome.usage;
      /* 这一步成功了，把"连续失败"计数清零 */
      this.consecutiveBrainErrors.delete(agent);
      /* 模型的思考（reasoning_content）单独记一条：它是"思考"不是"工具调用"，
         但确实发生了，混在别处会让人以为它只是发了个邮件 */
      if (outcome.note !== undefined && outcome.note.length > 0) {
        this.store.append({
          type: "trace.appended",
          event: {
            id: messageId(),
            swarmId: this.swarmId,
            time: clock(),
            agent,
            type: "thinking",
            detail: outcome.note,
            ms: 1,
            status: "ok",
          },
        });
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.brainErrors.push(agent + "：" + why);
      const streak = (this.consecutiveBrainErrors.get(agent) ?? 0) + 1;
      this.consecutiveBrainErrors.set(agent, streak);
      const total = (this.brainErrorTotals.get(agent) ?? 0) + 1;
      this.brainErrorTotals.set(agent, total);
      /* 网关抽一下**不该**把这个 agent 当场判死（PELICAN LOOP 就是这么全灭的：
         一次 503 → 六个 agent 全 "done" → 界面还显示"跑完了"）。
         先记一步 system 跳过本轮，下一轮它还会被叫起来；连续 N 次才真的放弃。 */
      /* P0 韧性（PELICAN 8 真跑暴露）：原来是 streak >= maxBrainErrors(3) 就当场判死，
         而"换模型"只在**下一轮开头**发生 —— 两个默认阈值都是 3，于是**有备用模型的人
         也在第 3 次失败被处决，一次都轮不到新模型**。现在：只要还能换成**另一个**模型，
         就先换、把连续计数清零、接着试；"连续失败判死"只对**同一个模型**成立，
         再加累计上限兜底（防一个人无限换模型烧钱）。 */
      const nextModel = this.pickFallback(agent);
      const laneNext = this.laneNextModel(agent); /* 车道还有下一条 = 也能换，别判死 */
      /* 硬故障（404/400/413/no_active_keys）立即换道，别白重试；软故障（超时/5xx/限流）
         按用户口径「失败 2 次再换」—— 之前写成「只要有下一条车道就换」，一次抖动就白烧一次重试。 */
      const hardFail = ["404", "400", "401", "403", "413", "model_not_found", "no_active_keys"].some((k) => why.includes(k));
      const laneReady = laneNext !== undefined && (hardFail || streak >= this.failoverAfter);
      const willSwitch = (nextModel !== undefined && nextModel !== model) || laneReady;
      if (willSwitch) {
        this.consecutiveBrainErrors.set(agent, 0);
        /* 清零会让 modelFor 里「按计数推进车道」永远停在第 1 条 —— 必须同时把车道挪一格 */
        if (laneNext !== undefined) this.laneStep.set(agent, (this.laneStep.get(agent) ?? 0) + 1);
        this.store.append({
          type: "trace.appended",
          event: {
            id: messageId(),
            swarmId: this.swarmId,
            time: clock(),
            agent,
            type: "system",
            detail:
              "模型故障转移：" + model + " 连续失败 " + streak + " 次，换到 " + (laneNext ?? nextModel) +
              " 再试（连续失败计数已清零；累计失败 " + total + " 次 / 上限 " + this.maxBrainErrorsTotal + "）",
            ms: 1,
            status: "ok",
          },
        });
      }
      if ((!willSwitch && streak >= this.maxBrainErrors) || total >= this.maxBrainErrorsTotal) {
        this.brainGiveUps.push(agent);
        /* 放弃一个人还不够：他名下**没交付**的切片必须退回板上，否则那片活跟着他一起死 */
        const freed = this.releaseClaims(agent, "模型失败 连续" + streak + "次/累计" + total + "次");
        return this.record(
          agent,
          model,
          "done",
          {
            ...toolDone(
              ctx,
              "连续 " + streak + " 次、累计 " + total + " 次模型调用失败：" + why +
                (freed.length > 0 ? "（名下 " + freed.length + " 片已退回板上等别人接手）" : ""),
              "网关故障，未经过任何独立验证",
              "brain-giveup",
            ),
            traceType: "system",
          },
          Date.now() - started,
        );
      }
      return this.record(
        agent,
        model,
        "system",
        {
          observation:
            "模型调用失败（第 " + streak + "/" + this.maxBrainErrors + " 次），本轮跳过，下一轮再试：" + why,
          detail: "跳过本轮：大脑异常（" + streak + "/" + this.maxBrainErrors + "）：" + why,
          traceType: "system",
        },
        Date.now() - started,
      );
    }

    /* 工具炸了不能把整轮 run 带走：PELICAN 8 真跑里一次 EISDIR（对目录 read）
       一路穿过 turn → run → /run 路由，把 6 个 agent 的一整轮全打崩了。
       这里兜底：任何工具异常都变成一条**可观察的失败**还给大脑，让它换个做法。 */
    let result: ToolResult;
    this.enter("跑工具（" + agent + "/" + decision.tool + "）");
    try {
      result = this.execute(ctx, decision);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      result = {
        observation:
          "工具执行出错（你的推理未必错，但这次动作没生效）：" + why +
          "\n换个做法再来：读之前先看清楚是文件还是目录（对目录可以写具体文件名）。",
        detail: "工具异常：" + decision.tool + "：" + why.slice(0, 80),
      };
    }
    /* 把观察结果交回大脑：真模型靠它知道上一步干了什么（不然下一轮会重复劳动或胡编） */
    this.brain.observe?.(ctx, decision.tool, result);
    /* 记账用真实模型名：同一个集群混用两个模型时，账本要分得清哪一步是谁花的 */
    return this.record(agent, usage?.model ?? model, decision.tool, result, Date.now() - started, usage);
  }

  /** 把"决定"落到具体工具上（真模型的参数已在 LlmBrain 里校验过形状） */
  /* ---------- 验收闭环（P1）：测试不过就继续造 ---------- */

  /**
   * 交付 —— 验收片额外过一道「结论闸」。
   *
   * 为什么：PELICAN 3 的 timing_check.py 打印了 ❌FAIL，集群照样收工了。
   * 系统当时只知道「有人点了交付」，不知道「验收没过」。这条闸补上这一点：
   *
   *   · 证据里是 FAIL  → **照收留档**（"测不过"本身就是最值钱的交付，不能白干），
   *                     并把它变成一片**修复任务**、发信点名「最近改过产物的人」——
   *                     形成「测不过 → 继续造 → 重跑出新 PASS」；
   *   · 读不出结论     → 交付被拒，要求写清 ✅/❌ 和实测数字（没结论的验收等于没验）；
   *   · PASS           → 放行，并记下时刻（收工闸要用：PASS 必须晚于最后一次产物改动）；
   *   · 系统开的复检片 → 不能被「产物最后改动者」自己签收（自己不能给自己盖章）。
   */
  private completeSlice(ctx: BrainContext, slice: string, evidence: string): ToolResult {
    const blocked = this.handoffGate(ctx);
    if (blocked) return blocked;
    if (!SWARM_VERIFY_GATE) return toolCompleteSlice(ctx, slice, evidence);
    const info = this.store.sliceByName(this.swarmId, slice);
    if (!info || info.status !== "claimed" || !isVerificationSlice(slice)) {
      return toolCompleteSlice(ctx, slice, evidence);
    }

    const verdict = verdictOf(evidence);
    if (verdict === "fail") {
      /* 「测不过」是**有效交付**：PELICAN 8 真跑里系统拒收过一次，逼得测试员的活白做、片子在板上弹来弹去。
         正确的闭环是：照收留档 → 变成一片**修复任务** → 修完必须重跑出新 PASS 才算数。
         也就是"测试不过 → 继续造"，而不是"把测试员的活扔掉"。 */
      /* reject 模式：验不过就不算交付，切片退回板上（等修完再有人重跑一遍） */
      if (this.failMode === "reject") {
        this.store.append({ type: "claim.released", swarmId: this.swarmId, agent: ctx.agent, slice });
        this.appendSystemTrace(ctx.agent, "验收未通过，交付被拒、切片退回板上：「" + slice + "」");
        this.mailVerifyFailure(ctx.agent, slice, evidence, "");
        return {
          observation:
            "交付被拒：这片是验收片，而证据里是**没过**的结论。看板已退回 available（不算交付）。\n" +
            "接下来二选一：① 把失败证据（哪条断言、差多少）发给产物作者去改；② 你自己能修就直接修，改完**重跑一遍**再拿 ✅ 结论来交付。\n" +
            "（系统只认「产物改动之后重新跑出来的 PASS」—— 之前那次过了不算。）",
          detail: "交付被拒：验收未通过「" + slice + "」",
        };
      }
      const done = toolCompleteSlice(ctx, slice, evidence);
      const fix = this.publishFixSlice(ctx.agent, slice, evidence);
      this.appendSystemTrace(
        ctx.agent,
        "验收未通过（❌ 结论已存档）：「" + slice + "」" +
          (fix.length > 0 ? " → 系统开了修复片「" + fix + "」" : "（板上已有未交付的修复任务）"),
      );
      this.mailVerifyFailure(ctx.agent, slice, evidence, fix);
      return {
        ...done,
        observation:
          "验收结论 ❌ 没过 —— 这次交付**照收留档**（如实报出没过本身就是有价值的交付，不会白干）。\n" +
          "系统已经：① 把失败证据发给全队、点名产物最后改动者" +
          (this.artifactBy.length > 0 ? "（" + this.artifactBy + "）" : "") +
          "；② " +
          (fix.length > 0 ? "往板上开了一片修复任务「" + fix + "」，谁都能接（你自己也能接）。" : "板上已经有修复任务了。") +
          "\n接下来（系统要求的闭环）：修复片被改完之前，收工闸不会放任何人走 —— " +
          "改动过产物，之前那次 PASS 就作废，必须有人重跑一遍并给出 ✅（系统会自动开复检片）。",
        detail: "验收未通过（已存档并开修复片）：「" + slice + "」",
      };
    }
    if (verdict === "unknown") {
      return {
        observation:
          "交付被拒：验收片的证据里读不出结论（既没有 ✅/PASS 也没有 ❌/FAIL）。\n" +
          "没有结论的验收等于没验。交付前请写清判定结果和实测数字，例如：\n" +
          "「✅ 脚-踏板距离全周期最大 1.8px（要求 ≤2px），60 帧采样」或者「❌ 第 37 帧 4.2px，超阈值」。",
        detail: "交付被拒：验收证据没有结论「" + slice + "」",
      };
    }
    const reserved = this.reverifySubjects.get(slice);
    if (reserved !== undefined && reserved.length > 0 && reserved === ctx.agent) {
      return {
        observation:
          "交付被拒：这片复检的对象就是你最后改的产物 —— 自己不能给自己盖章。\n" +
          "把复检交给别人：发信说清你已经改完、跑了哪些命令、现在数字是多少，请对方独立复核。",
        detail: "交付被拒：复检片不能由产物最后改动者签收「" + slice + "」",
      };
    }
    this.passAt = clock();
    this.passStep = this.steps;
    return toolCompleteSlice(ctx, slice, evidence);
  }

  /** 系统自己往板上开一片复检（幂等：板上已有没交付的复检片就不再开） */
  /**
   * 独立复检（用户口径 2026-09-18）：**关键片**一交付，系统当场开一片复检、并**点名一个别人**接手。
   * 为什么不能等收工闸：exp-10~12 里"自己说自己验过了"直接过，出现过假验证（工具根本不渲染动画，
   * 逐像素差照样 0）。复核必须在交付当场发生，且必须换人 —— reverifySubjects 会挡住交付者自己盖章。
   * 幂等：同一片只点一次名；ensureReverify 自身保证板上只留一片未交付复检。
   */
  private maybeOpenIndependentRecheck(ctx: BrainContext, slice: string): void {
    if (!this.independentRecheckOn) return;
    if (!slice || isVerificationSlice(slice)) return; /* 复检片/修复片不再套娃 */
    /* 只对**关键片**复检（用户口径：中 + 只对关键片）——每片都复检会把整轮时间全烧在复核上 */
    const isKey = slice === (this.slices[0] ?? "") || /(产物|主|最终|整合|final|main)/i.test(slice);
    if (!isKey) return;
    const info = this.store.sliceByName(this.swarmId, slice);
    if (!info || info.status !== "completed") return; /* 只对"真的交付成功"的片复检 */
    const swarm = this.store.getSwarm(this.swarmId);
    const others = (swarm ? swarm.agents : []).filter((n) => n !== "system" && n !== ctx.agent);
    if (others.length === 0) return;
    const name = this.ensureReverify();
    if (!name || this.recheckPointed.has(name)) return;
    this.recheckPointed.add(name);
    const pick = others.slice().sort((a, b) => {
      const d = (this.recheckTally.get(a) ?? 0) - (this.recheckTally.get(b) ?? 0);
      return d !== 0 ? d : a.localeCompare(b);
    })[0];
    this.recheckTally.set(pick, (this.recheckTally.get(pick) ?? 0) + 1);
    try {
      sendMail(this.store, {
        swarmId: this.swarmId,
        from: "system",
        to: [addressOf(pick, this.swarmId)],
        subject: "点名复检：「" + slice + "」刚交付，请你独立验一遍",
        body:
          "「" + ctx.agent + "」刚交付了「" + slice + "」，但它自己说验过了不算数。请你去复检片「" + name + "」：" + "\n" +
          "  1) 自己动手跑一遍（不许只看它给的数字）：截图 / 量像素 / 查结构都可以；" + "\n" +
          "  2) 交付证据里写结论：PASS 附实测数字，FAIL 附反例证据（哪里、差多少）；" + "\n" +
          "  3) 拿不准就写「说不清」并说明缺什么 —— 说不清会按没过处理，逼着双方把话说清。" + "\n" +
          "你有 3 分钟以内的预算：够跑一条命令、看一眼图。",
        kind: "verify",
      });
    } catch (error) {
      console.error("[runner] 点名复检邮件失败:", error);
    }
    this.appendSystemTrace("system", "独立复检：给 " + pick + " 点名发信，请它复核「" + slice + "」（交付者不能自己盖章）");
  }

  private ensureReverify(): string {
    const board = this.store.listSlices(this.swarmId);
    const existing = board.find((s) => s.slice.startsWith(REVERIFY_PREFIX) && s.status !== "completed");
    if (existing) return existing.slice;
    const who = this.artifactBy;
    const name = reverifyName(who, "重跑验收脚本，给出 ✅/❌ 与实测数字");
    this.reverifySubjects.set(name, who);
    this.store.append({ type: "slice.added", swarmId: this.swarmId, slice: name, by: "system", time: clock() });
    this.appendSystemTrace("system", "产物改动后没有新的验收 PASS → 系统开了一片复检：「" + name + "」");
    return name;
  }

  /** 验收报 ❌ → 自动开一片**修复任务**（幂等：板上已有没交付的修复片就不再开，防刷屏） */
  private publishFixSlice(by: string, slice: string, evidence: string): string {
    const board = this.store.listSlices(this.swarmId);
    if (board.some((s) => s.slice.startsWith(FIX_PREFIX) && s.status !== "completed")) return "";
    const line =
      evidence
        .split(/\r?\n/)
        .map((x) => x.replace(/\s+/g, " ").trim())
        .find((x) => x.length > 0) ?? "";
    const brief = line.length > 40 ? line.slice(0, 40) + "…" : line;
    const name = FIX_PREFIX + (brief.length > 0 ? brief : "验收报出的问题") + "（" + by + " 的验收未过）";
    if (board.some((s) => s.slice === name)) return "";
    this.store.append({ type: "slice.added", swarmId: this.swarmId, slice: name, by: "system", time: clock() });
    this.appendSystemTrace("system", "验收报 ❌ → 系统开了一片修复：「" + name + "」");
    return name;
  }

  /** 验收没过 → 全员邮件，点名「最近改过产物的人」（谁最可能背这口锅） */
  private mailVerifyFailure(by: string, slice: string, evidence: string, fix: string): void {
    const who = this.artifactBy.length > 0 ? this.artifactBy : "（还没记录到改动者）";
    this.mailTeam(
      "验收没过：" + slice,
      by + " 交上来的验收结论是**没过**（这条已存档，不算白干）。\n" +
        (fix.length > 0 ? "系统已自动开了一片修复任务：「" + fix + "」，等谁接手。\n" : "") +
        "验收对象：最近改过产物的是 " + who + "。\n\n" +
        "证据原文：\n" + evidence.slice(0, 800) + "\n\n" +
        "接下来（系统要求的闭环，不是建议）：\n" +
        "1) " + who + " 按上面的数字修产物；\n" +
        "2) 改完之后必须有人**重新跑一遍**验收并给出 ✅ 结论 —— 改过产物，之前那次 PASS 就作废了；\n" +
        "3) 谁都能签收，但系统自动开的复检片不能由产物最后改动者自己签收。",
      "verify",
    );
  }

  private mailTeam(subject: string, body: string, kind: "verify" | "claim" = "verify"): void {
    try {
      sendMail(this.store, {
        swarmId: this.swarmId,
        from: "system",
        to: ["all@" + this.swarmId + ".swarm"],
        subject,
        body,
        kind,
      });
    } catch (error) {
      /* 发信失败不能带崩整轮跑：系统旁白比中断重要得多 */
      console.error("[runner] 系统邮件发送失败:", error);
    }
  }

  private appendSystemTrace(agent: string, detail: string): void {
    this.store.append({
      type: "trace.appended",
      event: {
        id: messageId(),
        swarmId: this.swarmId,
        time: clock(),
        agent,
        type: "system",
        detail,
        ms: 1,
        status: "ok",
      },
    });
  }

  /* ---------- 停滞轮换（P2）：卡住的活要换人 ---------- */

  /** 这片是哪一刻被认领的（从行为流里找，不动账本结构） */
  private claimTimeOf(info: SliceInfo): string {
    const traces = this.store.listTraces(this.swarmId);
    for (let i = traces.length - 1; i >= 0; i -= 1) {
      const item = traces[i];
      if (item.type === "claim_slice" && item.agent === info.claimedBy && item.detail.includes(info.slice)) {
        return item.time;
      }
    }
    return "";
  }

  /**
   * 停滞轮换：某片被认领后**很多步没有任何动作** → 先催办、再强制退还重板。
   *
   * 为什么看「有没有动作」而不是看「过了几轮」：PELICAN 7 里 sarah 把耦合片抱了很久，
   * 但她一直在 read/edit/bash —— 那是正常干活，收回她的片只会帮倒忙。
   * 真正该收回的是 louis 那种：模型死了、一个字没动，片却锁在他名下。
   * 这就是「重新轮换分配工作」的系统版本 —— 不指望 agent 自己发现。
   */
  private stallSweep(): void {
    if (this.stallSteps <= 0) return;
    const PRODUCTIVE = ["bash", "read", "write", "edit", "complete_slice", "publish_slice"];
    for (const info of this.store.listSlices(this.swarmId)) {
      if (info.status !== "claimed" || info.claimedBy.length === 0) continue;
      const since = this.claimTimeOf(info);
      if (since === "") continue;
      /* 认领之后有真动作 → 人家在干活，别打扰 */
      if (this.store.tracesSince(this.swarmId, info.claimedBy, since, PRODUCTIVE).length > 0) continue;
      if (!this.claimStep.has(info.slice)) this.claimStep.set(info.slice, this.steps);
      const age = this.steps - (this.claimStep.get(info.slice) ?? this.steps);
      if (age < this.stallSteps) continue;

      if (age >= this.stallSteps * 2) {
        /* 催过还没动静 → 强制换人：退回板上，谁都能接 */
        this.store.append({ type: "claim.released", swarmId: this.swarmId, agent: info.claimedBy, slice: info.slice });
        this.claimStep.delete(info.slice);
        this.nudged.delete(info.slice);
        this.appendSystemTrace(
          info.claimedBy,
          "停滞收回：「" + info.slice + "」认领后 " + age + " 步没有任何动作，已退回板上等别人接手",
        );
        this.mailTeam(
          "切片换人：「" + info.slice + "」已退回板上",
          info.claimedBy + " 认领「" + info.slice + "」之后 " + age + " 步没有任何动作，系统把这片退回了板上。\n" +
            "谁有能力都可以 claim_slice 接手；" + info.claimedBy + " 如果只是卡住了，也可以重新认领。",
          "claim",
        );
      } else if (!this.nudged.has(info.slice)) {
        this.nudged.add(info.slice);
        this.appendSystemTrace(info.claimedBy, "催办：「" + info.slice + "」认领后 " + age + " 步没有动作");
        this.mailTeam(
          "催办：「" + info.slice + "」",
          info.claimedBy + " 认领「" + info.slice + "」之后 " + age + " 步没有任何动作。\n" +
            "卡住了就说一声（缺什么、被什么挡住），或者用 release_slice 让给别人 —— " +
            "再过 " + this.stallSteps + " 步系统会直接收回这片。",
          "claim",
        );
      }
    }
  }

  /**
   * 收工闸（M10）：板上还有没交付的活，就不许收工。**系统硬闸，不靠提示词**。
   *
   * 为什么必须做成硬闸：jane 在 PELICAN 3 收工时的原文是
   *   「等待 louis 完成 pelican.svg 后由 henry 进行端到端验证」
   * —— 她**知道**主产物还没出来，照样收工了。提示词写得再清楚也拦不住，只有系统能拦。
   *
   * 两条规则：
   *   1. 板没清空（还有 available / claimed 未交付）→ 不收工，并把它能做的活指给它；
   *   2. 板清空了、但这个人封板后一次都没亲自查证 → 不收工，逼它至少亲手复现一次。
   * 故意**不标 refused**：这是正常的流程拦阻，不是一步失败（标了会触发自动重试，白烧钱）。
   */
  /** 这个地址是不是"队友"（排除 system/board/human 三个共享邮箱） */
  /**
   * 交付闸（用户口径 2026-09-18）：交付一片之前，必须有一封**发给队友（或群发）**的交接信。
   * 判据 "已发交接信数 > 已交付片数" == "每交付一片，至少要有一封新的交接信"，
   * 不需要比对时间戳（邮件时间只有秒级）。不满足就挡住交付，并给一份可照抄的模板。
   */
  private handoffGate(ctx: BrainContext): ToolResult | undefined {
    if (!this.handoffGateOn) return undefined;
    const swarm = this.store.getSwarm(this.swarmId);
    const teammates = (swarm ? swarm.agents : []).filter((name) => name !== ctx.agent && name !== "system");
    if (teammates.length === 0) return undefined; /* 没队友就没什么可交接的，别把单人群卡死 */
    const board = this.store.listSlices(this.swarmId);
    const deliveredMine = board.filter((s) => s.status === "completed" && s.claimedBy === ctx.agent).length;
    const me = addressOf(ctx.agent, this.swarmId);
    const handedOff = this.store
      .listMailboxMails(me, "sent", 0)
      .filter((mail) => mail.to.concat(mail.cc ? mail.cc : []).some((addr) => this.isTeammate(addr))).length;
    if (handedOff > deliveredMine) return undefined;
    return {
      observation:
        "先别交付：这一片还没交接给别人，队友不知道有这活、也不知道怎么验收。请先发一封交接信 ——" +
        "收件人写队友地址（或直接群发 all@" + this.swarmId + ".swarm），正文照这个格式三行：" + "\n" +
        "  ① 做了什么：改了哪个文件 / 哪个组 id（别人要能直接找到）" + "\n" +
        "  ② 怎么验：一条能跑的命令，或肉眼能看的检查点（例如某个函数应该返回什么、某个文件里应该有哪一行、某个数值应该落在什么区间）" + "\n" +
        "  ③ 风险 / 没做完：哪里可能有问题、哪里偷懒了" + "\n" +
        "发完再 complete_slice。已经交付过的片不会因为这条被卡第二次。",
      detail: "交付被挡：还没发交接信（已交付 " + deliveredMine + " 片 / 已发交接信 " + handedOff + " 封）",
    };
  }

  private isTeammate(address: string): boolean {
    const local = address.slice(0, Math.max(0, address.indexOf("@")));
    return !["system", "board", "human"].includes(local);
  }

  /** 雏形闸：花到预算 SWARM_PROTOTYPE_FRACTION 还没出雏形 -> 系统自己往板上开一片雏形。 */
  private prototypeGate(): void {
    if (!(SWARM_PROTOTYPE_FRACTION > 0)) return;
    const swarm = this.store.getSwarm(this.swarmId);
    if (!swarm || swarm.budget < SWARM_PROTOTYPE_MIN_BUDGET) return;  /* 地板：预算太小的场景（自检）不开片 */
    /* 雏形线：优先用绝对额（用户口径 $5/半小时），<0 才退回按预算比例 */
    const protoAt = SWARM_PROTOTYPE_BUDGET >= 0 ? SWARM_PROTOTYPE_BUDGET : swarm.budget * SWARM_PROTOTYPE_FRACTION;
    if (swarm.cost < protoAt) return;
    if (this.hasPrototype()) return;
    const board = this.store.listSlices(this.swarmId);
    if (board.some((info) => info.slice.startsWith(PROTOTYPE_MARK))) return;
    const name = PROTOTYPE_MARK + "先交一个能跑的最小版本（v0）：落到工作目录，跑一条命令能看出来它在动";
    this.store.append({ type: "slice.published", swarmId: this.swarmId, slice: name, by: "system", time: clock() });
    this.appendSystemTrace(
      "system",
      "花到 $" + swarm.cost.toFixed(3) + "（雏形线 $" + protoAt.toFixed(2) + " / 预算 $" + swarm.budget.toFixed(2) +
        "）还没出雏形 —— 系统开了一片「" + PROTOTYPE_MARK + "…」，谁先接谁做；在那之前所有人收工都会被挡住",
    );
  }

  /** 雏形 = 工作目录里真有一个像样的产物文件，或者板上已经有带证据的交付 */
  private hasPrototype(): boolean {
    const delivered = this.store
      .listSlices(this.swarmId)
      .some((info) => info.status === "completed" && this.store.sliceEvidence(this.swarmId, info.slice).trim().length >= 40);
    if (delivered) return true;
    try {
      const dir = workspaceOf(this.swarmId);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (/\.(log|jsonl)$/i.test(entry.name)) continue;
        if (statSync(dir + "/" + entry.name).size >= 200) return true;
      }
    } catch {
      /* 目录还不存在 = 当然还没有雏形 */
    }
    return false;
  }

  /* 去中心化收工征询（2026-09-18 用户口径：不设经理，保持去中心化 —— 谁想收工，系统就打回，
     并往邮箱广播一条"我准备收工，你们还有没有没交的活 / 还要不要我做事 / 同不同意"的征询）。
     规则：① 别人还有没交付的活 → 打回 + 广播；② 刚广播过（grace 内）→ 还是打回，等回信；
     ③ 过了 grace → 放行（谁都不反对就是默认同意，避免死锁）。
     被按停（预算/墙钟/网关故障）走的是 toolDone，不经过这里。 */
  private doneAskGate(ctx: BrainContext): ToolResult | undefined {
    if (!SWARM_DONE_ASK) return undefined;
    const board = this.store.listSlices(this.swarmId);
    if (board.length === 0) return undefined;
    const mineOpen = board.filter((s) => s.status !== "completed" && (s.claimedBy ?? []).includes(ctx.agent));
    if (mineOpen.length > 0) {
      return {
        observation:
          "先别收工：你名下还有 " + String(mineOpen.length) + " 片没交付（" +
          mineOpen.slice(0, 4).map((s) => s.slice).join("、") +
          "）。complete_slice 交付，或者 release_slice / handoff 交给别人 —— 名下有活不算收工。",
        detail: "收工被挡：名下还有未交付的片（" + String(mineOpen.length) + "）",
      };
    }
    const othersOpen = board.filter((s) => s.status !== "completed");
    if (othersOpen.length === 0) return undefined;
    const askedAt = this.doneAskAt.get(ctx.agent) ?? 0;
    const grace = SWARM_DONE_ASK_GRACE_MS;
    const age = Date.now() - askedAt;
    if (askedAt > 0 && age < grace) {
      return {
        observation:
          "先别收工：你 " + String(Math.round(age / 1000)) + " 秒前已经向全队广播过收工征询，还在等回信。" +
          "去 read_inbox 看看有没有人回你；" +
          String(Math.max(1, Math.round((grace - age) / 1000))) + " 秒后没人反对，你可以再调一次 done 收工。",
        detail: "收工被挡：收工征询已广播，等回信",
      };
    }
    if (askedAt > 0) return undefined;
    this.doneAskAt.set(ctx.agent, Date.now());
    const BR = String.fromCharCode(10);
    const lines = board
      .filter((s) => s.status !== "completed")
      .slice(0, 10)
      .map((s) => "  · 「" + s.slice + "」" + (s.status === "available" ? "（还没人接）" : "（" + String(s.claimedBy) + " 手上）"));
    const body =
      "【收工征询】" + ctx.agent + " 认为自己这边做完了，想收工。" + BR + BR +
      "板上还没交付的活：" + BR + lines.join(BR) + BR + BR +
      "请在 " + String(Math.round(grace / 1000)) + " 秒内回信说清三件事（reply 这封，或 send_mail 给 " + ctx.agent + "）：" + BR +
      "1. 你手上还有没有没交付的活？" + BR +
      "2. 还有没有需要 " + ctx.agent + " 做的事？" + BR +
      "3. 你同不同意现在收工？" + BR + BR +
      "没人反对 → " + ctx.agent + " 会在 " + String(Math.round(grace / 1000)) + " 秒后收工；有反对 → 请直接说清缺什么、该改哪里。";
    sendMail(this.store, {
      swarmId: this.swarmId,
      from: "system",
      to: ["all"],
      subject: "[收工征询] " + ctx.agent + " 想收工，请表态（" + String(Math.round(grace / 1000)) + " 秒内）",
      body,
      kind: "question",
    });
    this.appendSystemTrace("system", "收工被打回：已向全队广播收工征询（" + ctx.agent + "）");
    return {
      observation: "先别收工：系统按去中心化收工的规矩把你打回了，并向全队广播了征询。" + BR + BR + body,
      detail: "收工被打回：已向全队广播收工征询",
    };
  }

  /* 墙钟进度广播（2026-09-18 实测"干不完"是主要死因：27 分钟还在画部件，没人提醒该收口）。 */
  private wallT0 = 0;
  /* 协商立板（2026-09-19）：不派工。系统只做两件事 ——
     开工广播一次（把完整题目和立板规则发到每个人手里），以及到截止点还空板时兜底。 */
  private boardT0 = 0;
  private boardKickoff = false;
  private boardFallback = false;
  /* P9-a：闸降级放开只广播一次 */
  private talkGateLifted = false;
  /** 至少有人广播过（判定与 tools 的协商闸同一口径）。 */
  private hasAnyBroadcast(roster: string[]): boolean {
    for (const name of roster) {
      const from = name + "@" + this.swarmId + ".swarm";
      for (const other of roster) {
        if (other === name) continue;
        const heard = this.store
          .listMailboxMails(other + "@" + this.swarmId + ".swarm", "inbox", 0)
          .some((mail) => mail.from === from);
        if (heard) return true;
      }
    }
    return false;
  }

  private async negotiationGate(roster: string[]): Promise<void> {
    if (!SWARM_NEGOTIATE_BOARD || this.boardFallback) return;
    if (this.boardT0 === 0) this.boardT0 = Date.now();
    /* 续跑（板上已经有片）：立板阶段已经过去 —— 但**不能静默 return**：
       续跑不广播任何新指令时，agent 只会抱着上一轮的旧邮件原地打转（实测那轮 50 次
       调用 0 广播 0 认领 0 写文件 0 交付，白烧 $1.37）。 */
    const existing = this.store.listSlices(this.swarmId);
    if (existing.length > 0) {
      if (!this.resumeAnnounced) {
        this.resumeAnnounced = true;
        const doneCount = existing.filter((slice) => slice.status === "completed").length;
        const freeCount = existing.filter((slice) => slice.claimedBy.length === 0 && slice.status !== "completed").length;
        this.mailTeam("【续跑】接着上一轮干，别再立板", resumeKickoffText(this.swarmId, existing.length, doneCount, freeCount), "claim");
        this.appendSystemTrace(
          "system",
          "续跑：板上已有 " + String(existing.length) + " 片（" + String(doneCount) + " 已交付），跳过立板并广播续跑指令",
        );
      }
      return;
    }
    const budget = SWARM_RUN_MAX_MS > 0 ? SWARM_RUN_MAX_MS : SWARM_PROTOTYPE_BUDGET * 60000;
    const boardMs = Math.max(60000, Math.round(budget * SWARM_BOARD_DEADLINE_FRACTION));
    if (!this.boardKickoff) {
      this.boardKickoff = true;
      this.mailTeam(
        "【开工】先立板：这轮的活由你们自己商量分配",
        negotiateKickoffText(this.swarmId, roster.length, boardMs, this.goalOf()),
        "claim",
      );
      this.appendSystemTrace(
        "system",
        "协商立板：已广播开工广播（系统不派工），立板窗口约 " + String(Math.round(boardMs / 60000)) + " 分钟",
      );
      return;
    }
    /* P9-a：闸降级的那一刻必须**系统广播**。实测 p2482-p8：agent 07:56:31 撞了一次闸
       被拦后就再也不试了，而闸在 07:57:51 才放开 —— 没人回来试，降级等于没发生。 */
    if (
      Date.now() - this.boardT0 >= boardMs * SWARM_TALK_DOWNGRADE_FRACTION &&
      !this.talkGateLifted &&
      this.hasAnyBroadcast(roster)
    ) {
      this.talkGateLifted = true;
      this.mailTeam(
        "【可以挂片了】协商闸已放开",
        "协商窗口过半 + 已经有人广播过，闸现在放开了：publish_slice 立刻就能过。"
          + "刚才被拦的人别再等 —— 板还是空的，谁来挂第一片？",
        "claim",
      );
      this.appendSystemTrace(
        "system",
        "协商立板：闸降级放开（窗口过半 + 已有人广播），已广播通知全队重新尝试挂片",
      );
    }
    if (this.boardFallback) return;
    if (!boardDeadlineReached(Date.now() - this.boardT0, budget, SWARM_BOARD_DEADLINE_FRACTION)) return;
    this.boardFallback = true;
    const { genericSlices } = await import("../slicer.ts");
    const names = genericSlices(roster.length, this.goalOf());
    for (const name of names) this.store.append({ type: "slice.added", swarmId: this.swarmId, slice: name, by: "system", time: clock() });
    this.mailTeam("【立板超时】系统已用保底切法兜底", boardTimeoutText(names.length), "claim");
    this.appendSystemTrace("system", "协商立板：超时兜底，保底切法架了 " + String(names.length) + " 片");
  }

  private wallMarks = new Set<number>();
  private wallClockSweep(): void {
    /* P9-b：立板也由墙钟推进。实测 negotiationGate 只在特定工具路径被调，
       于是 5 分钟的保底拖到 6 分 40 秒才落地（p2482-p8）。 */
    {
      const sw = this.store.getSwarm(this.swarmId);
      const roster = (sw ? sw.agents : []).filter((name) => name !== "system");
      if (roster.length > 0) void this.negotiationGate(roster);
    }
    if (!SWARM_WALL_BROADCAST) return;
    const budget = SWARM_RUN_MAX_MS;
    if (!budget || budget <= 0) return;
    if (this.wallT0 === 0) this.wallT0 = Date.now();
    const used = Date.now() - this.wallT0;
    for (const mark of [0.6, 0.8]) {
      if (used < budget * mark || this.wallMarks.has(mark)) continue;
      this.wallMarks.add(mark);
      const left = Math.max(1, Math.round((budget - used) / 60000));
      const body =
        "【进度提醒】已经跑了 " + String(Math.round(used / 60000)) + " 分钟，还剩 " + String(left) + " 分钟。" + String.fromCharCode(10) + String.fromCharCode(10) +
          "从现在起请不要再开新的大片，优先做两件事：" + String.fromCharCode(10) +
          "1. 把已经做好的部分整合进你的唯一交付件（工作目录根的那个成品文件）—— 没整合进去的部分等于没做；" + String.fromCharCode(10) +
          "2. 跑一遍验收脚本，把实测结果写进交付证据，然后 complete_slice 交付。" + String.fromCharCode(10) +
          "时间到就结束了，没进交付件的东西全会作废。";
      this.mailTeam("【进度提醒】还剩 " + String(left) + " 分钟，请收口", body, "verify");
      this.appendSystemTrace("system", "进度广播：" + String(Math.round(mark * 100)) + "% 墙钟，还剩 " + String(left) + " 分钟");
    }
  }

  private doneAskAt = new Map<string, number>();

  private doneGate(ctx: BrainContext): ToolResult | undefined {
    if (!SWARM_DONE_GATE) return undefined;
    const board = this.store.listSlices(this.swarmId);
    if (board.length === 0) return undefined;

    const open = board.filter((s) => s.status !== "completed");
    if (open.length === 0) {
      /* 沟通闸（用户口径：鼓励 agent 之间交流）—— **队友的提问**没回就不许收工。
         只卡 question：系统广播/分享类没读不算账，否则谁都会被一封没人看的公告永久锁死。 */
      if (SWARM_INBOX_GATE) {
        const me = addressOf(ctx.agent, this.swarmId);
        const unread = this.store
          .listMailboxMails(me, "inbox", 0)
          .filter((mail) => !mail.read && mail.kind === "question" && this.isTeammate(mail.from));
        if (unread.length > 0) {
          return {
            observation:
              "先别收工：你收件箱里还有 " + unread.length + " 封未读 —— " +
              unread.slice(-3).map((mail) => mail.from.split("@")[0] + "：「" + String(mail.subject || mail.body).replace(/\s+/g, " ").slice(0, 44) + "」").join("；") +
              "。队友在等你的回话，或者有东西交接给你还没看。read_inbox 看完、该回的 reply 掉，再来收工。",
            detail: "收工被挡：队友的提问还没回（" + unread.length + " 封）",
          };
        }
      }
      /* P1：板上有验收片，就必须存在一次「晚于最后一次产物改动」的 PASS 交付。
         没有 → 系统自己往板上开一片复检，把活重新派出去。
         这是「测试不过继续造」的引擎：产物一改，上次的 PASS 就作废，必须重新验。 */
      if (SWARM_VERIFY_GATE && board.some((s) => isVerificationSlice(s.slice))) {
        /* 过期判定：验收 PASS 还没出现过，或者产物最后一次改动发生在它之后 */
        const stale = this.passStep < 0 || this.artifactStep > this.passStep;
        if (stale) {
          const name = this.ensureReverify();
          const why =
            this.passStep < 0
              ? "板上还没有任何一次拿到 ✅ 的验收交付"
              : "最后一次验收 PASS（" + this.passAt + "）之后，产物又被改过（" + this.artifactAt + "，" + this.artifactBy + "）";
          return {
            observation:
              "先别收工：这个集群要的是「验过的产物」，不是「交过的片」。\n" +
              "· " + why + " —— 那次验收已经过期。\n" +
              "· 系统已经在板上开了一片「" + name + "」：去 claim_slice 接它，重跑验收脚本，" +
              "把 ✅/❌ 与实测数字写进证据再交付。\n" +
              "（在这之前集群不会结束 —— 谁收工都会被这条挡住。）",
            detail: "收工被挡：缺少「改动之后」的复检 PASS",
          };
        }
      }
      /* 封板了。但"全员交付"不等于"有人验过" —— 至少让每个要走的人亲手看过一次。 */
      if ((this.inspectedStep.get(ctx.agent) ?? -1) > this.artifactStep) return undefined;
      return {
        observation:
          "先别收工：板上 " + board.length + " 片**都交付了**，但封板之后你一次都没亲自看过产物。" +
          "现在收工等于「凭别人说」就信了。请至少亲手复现一次：跑一遍交付证据里的命令、" +
          "或者打开产物核对关键数字。确认没问题再来收工；发现问题就发信给作者、或重新认领那一片。",
        detail: "收工被挡：封板后未亲自查证",
      };
    }

    const mine = open.filter((s) => s.claimedBy === ctx.agent);
    const free = open.filter((s) => s.status === "available");
    const theirs = open.filter((s) => s.status === "claimed" && s.claimedBy !== ctx.agent);
    const list = (xs: { slice: string; claimedBy: string }[], withWho: boolean): string =>
      xs.map((s) => "「" + s.slice + "」" + (withWho && s.claimedBy ? "（" + s.claimedBy + "）" : "")).join("、");

    const lines: string[] = [];
    if (mine.length > 0) {
      lines.push("· 你名下还有 " + mine.length + " 片没交付：" + list(mine, false) + " —— 先做完，或者用 release_slice 让给别人");
    }
    if (free.length > 0) {
      lines.push("· 板上还有 " + free.length + " 片没人接：" + list(free, false) + " —— 挑一片 claim_slice 做掉");
    }
    if (theirs.length > 0) {
      lines.push("· 还有 " + theirs.length + " 片在别人手上没交付：" + list(theirs, true) + " —— 去帮他们验证或接手（他停摆了你可以直接接）");
    }
    return {
      observation:
        "先别收工：全队还没散，板上有 " + open.length + " 片没交付，现在收工就等于烂尾。\n" +
        lines.join("\n") +
        "\n（这个集群只有当**每一片都交付**之后，大家才收得了工。）",
      detail: "收工被挡：板上还有 " + open.length + " 片没交付",
    };
  }

  private execute(ctx: BrainContext, decision: Decision): ToolResult {
    /* P1：产物改动了就记下来 —— 复检必须晚于这一刻，之前那次 PASS 作废 */
    if (SWARM_VERIFY_GATE && (decision.tool === "write" || decision.tool === "edit")) {
      this.artifactAt = clock();
      this.artifactBy = ctx.agent;
      this.artifactStep = this.steps;
    }
    /* 封板之后还算「亲自查证」的动作：真去看产物、真跑一遍命令。
       发信/认领不算验证，所以只数 bash / read。 */
    if (SWARM_DONE_GATE && (decision.tool === "bash" || decision.tool === "read")) {
      this.inspectedStep.set(ctx.agent, this.steps);
    }
    switch (decision.tool) {
      case "read_inbox":
        return toolReadInbox(ctx);
      case "list_mailboxes":
        return toolListMailboxes(ctx);
      case "mark_read":
        return toolMarkRead(ctx, decision.mailId);
      case "archive":
        return toolArchive(ctx, decision.mailId);
      case "send_mail":
        return toolSendMail(ctx, decision);
      case "reply":
        return toolReply(ctx, { mailId: decision.mailId, body: decision.body });
      case "broadcast":
        return toolBroadcast(ctx, decision);
      case "publish_slice":
        return toolPublishSlice(ctx, decision.slice);
      case "claim_slice": {
        const claimed = toolClaimSlice(ctx, decision.slice);
        /* P2：记下认领时的全局步数，停滞检测从这里开始算 */
        if (!claimed.refused) this.claimStep.set(decision.slice, this.steps);
        return claimed;
      }
      case "challenge":
        return toolChallenge(ctx, decision);
      case "respond_challenge":
        return toolRespondChallenge(ctx, decision);
      case "rule_challenge":
        return toolRuleChallenge(ctx, decision);
      case "handoff":
        return toolHandoff(ctx, decision);
      case "release_slice":
        return toolReleaseSlice(ctx, decision.slice);
      case "complete_slice":
        const outcome = this.completeSlice(ctx, decision.slice, decision.evidence);
        this.maybeOpenIndependentRecheck(ctx, decision.slice);
        return outcome;
      case "done": {
        const blocked = this.doneGate(ctx);
        if (blocked) return blocked;
        /* 去中心化收工征询：别人还有活没说清就先别走。 */
        const asked = this.doneAskGate(ctx);
        if (asked) return asked;
        return toolDone(ctx, decision.reason, decision.confirm);
      }
      /* ---------- 真·干活工具（M8） ---------- */
      case "bash":
        return toolBash(ctx, decision.command);
      case "read":
        return toolReadFile(ctx, decision.path, decision.offset, decision.limit);
      case "write":
        return toolWriteFile(ctx, decision.path, decision.content);
      case "edit":
        return toolEditFile(ctx, decision.path, decision.old, decision.new);
      case "unknown":
        return {
          observation: "没有这个工具：" + decision.name + "。只能用系统提示里列出的工具。",
          detail: "调用了不存在的工具：" + decision.name,
          refused: true,
          traceType: "system",
        };
    }
  }

  /**
   * 工作区版本留档：提交一次 + 落 file.written 事件。
   * 任何失败都只是少一条记录，绝不能打断跑（所以整段吞异常）。
   */
  /**
   * 墙钟到点时的最终快照（P7-b）。
   * 实测：交付发生在 90%，agent 之后还在改主产物 —— 「验过的版本」和「最终版本」不是一个
   * 东西，于是证据看着是真的、产物却是坏的。这里把最终版本号钉进账本并广播全队。
   */
  private freezeWorkspace(): void {
    try {
      const sha = headSha(this.swarmId);
      if (!sha) return;
      const files = this.store.listFiles(this.swarmId);
      const tail = files
        .slice(0, 5)
        .map((file) => file.path + "(" + (file.lastAgent || "?") + " " + (file.lastCommit || "?") + ")")
        .join("、");
      const verdict = verifiedVerdict(sha, this.lastGreenSha, this.lastGreenAt);
      const check = runWorkspaceChecks(this.swarmId);
      const checkLine = check.note
        ? "系统体检：" + (check.ok ? "✅ 通过" : "❌ 没过") + "｜" + check.note.slice(0, 220)
        : "系统体检：工作区里没有 test_/verify_/check_ 开头的可跑验收脚本，机器没法替你判。";
      this.appendSystemTrace("system", "最终快照：" + sha + "（工作区最终版本；文件 " + String(files.length) + " 个：" + tail + "）");
      this.appendSystemTrace("system", "最终体检：" + verdict + "｜" + checkLine + "｜本轮共看到 " + String(this.greenCount) + " 次验收跑绿");
      const hangLine = hangNotice(this.hangSeen, this.hangLastAt, this.hangLastAgent);
      if (hangLine.length > 0) this.appendSystemTrace("system", "最终体检（挂死）：" + hangLine);
      const sampleNote = this.sampleReport().note;
      this.appendSystemTrace("system", "最终体检（题面样例）：" + sampleNote);
      this.mailTeam(
        "【本轮结束】工作区最终版本 " + sha,
        "本轮结束时工作区的最终 git 版本是 " + sha + "。" + "\n" + "\n" +
          "注意：**交付之后被改动过的产物，以这个版本为准**（交付那一刻的证据可能已经过期）。" + "\n" +
          "下一轮接着干：git show " + sha + ":路径 取任意文件；git diff " + sha + " HEAD -- 路径 看后来改了什么。" + "\n" +
          "文件清单：" + tail +
          "\n\n" + "【验没验过】" + verdict + "\n" + checkLine
          + (hangLine.length > 0 ? "【挂死】" + hangLine : "")
          + "\n\n" + sampleNote,
        "verify",
      );
    } catch (error) {
      console.error("[runner] 最终快照失败:", error);
    }
  }

  /** 连续不调工具（P6/B6）：累计到限额就点一次名，任何一次正常调用都清零。 */
  private trackNoTool(agent: string, tool: string): void {
    try {
      if (tool !== "unknown") {
        this.noToolStreak.set(agent, 0);
        return;
      }
      const streak = (this.noToolStreak.get(agent) ?? 0) + 1;
      this.noToolStreak.set(agent, streak);
      if (streak !== NO_TOOL_STREAK_LIMIT) return;
      sendMail(this.store, {
        swarmId: this.swarmId,
        from: "system",
        to: [addressOf(agent, this.swarmId)],
        subject: "【卡住了】你连续 " + String(streak) + " 步没有调用任何工具",
        body:
          agent + "：你已经连续 " + String(streak) + " 步没有调用任何工具（模型给了空回复）。" + "\n" +
          "不要再想、不要输出纯文字：下一个回复**必须**只包含一个工具调用。" + "\n" +
          "最稳的三个选择：read_inbox（看有没有人给你留言）｜claim_slice（接一片活）｜write（把想到的东西写成文件）。" + "\n" +
          "写一半也算产出 —— 系统每步自动提交并署你的名。",
        kind: "verify",
      });
      this.appendSystemTrace("system", "哑火点名：" + agent + " 连续 " + String(streak) + " 步没调用工具");
    } catch (error) {
      console.error("[runner] 哑火点名失败:", error);
    }
  }

  /**
   * 零贡献巡检（P6）：墙钟过 30% 还没认领、或认领了却一个文件都没碰的人，系统点一次名。
   * 去中心化口径不变：系统不派活、不做裁判，只把「你现在具体该敲哪个工具」说清楚。
   */
  private idleSweep(): void {
    try {
      if (SWARM_IDLE_NUDGE_FRACTION <= 0 || SWARM_RUN_MAX_MS <= 0) return;
      const elapsed = Date.now() - this.wallT0;
      if (elapsed < SWARM_RUN_MAX_MS * SWARM_IDLE_NUDGE_FRACTION) return;
      const files = this.store.listFiles(this.swarmId);
      const claims = this.store.listClaims(this.swarmId);
      const free = this.store
        .listSlices(this.swarmId)
        .filter((info) => info.status !== "completed" && String(info.claimedBy || "") === "")
        .map((info) => info.slice);
      const roster = (this.store.getSwarm(this.swarmId)?.agents ?? []).filter((name) => name !== "system");
      for (const agent of roster) {
        if (this.idleNudged.has(agent)) continue;
        const mine = claims.find((claim) => claim.agent === agent);
        const touched = files.filter((file) => file.commits.some((commit) => commit.agent === agent)).length;
        if (mine && touched > 0) continue;
        this.idleNudged.add(agent);
        const body = idleNudgeBody(free, Boolean(mine), touched, agent);
        sendMail(this.store, {
          swarmId: this.swarmId,
          from: "system",
          to: [addressOf(agent, this.swarmId)],
          subject: mine ? "【收口】你有产出/有片但还没交付" : "【点名】你还没有任何贡献",
          body,
          kind: "verify",
        });
        this.appendSystemTrace(
          "system",
          "零贡献巡检：" + agent + "（认领=" + (mine ? "有" : "无") + " 碰过文件=" + String(touched) + "）已点名",
        );
      }
    } catch (error) {
      console.error("[runner] 零贡献巡检失败:", error);
    }
  }

  /**
   * 绿跑点名（P5）：agent 刚把验收脚本跑绿 —— 这一刻就是交付的时机，系统点一次名。
   * 每个 agent 一轮最多点一次（默认上限 4 = 全员各一次），免得变成噪音。
   */
  /**
   * 挂死红灯（P10-a）：命令被 30 秒强杀时当场告诉那个 agent —— 别把它当「跑过了」。同时
   * 记账（交接班提醒与收工体检都会说）。节流：每人每轮最多 3 封。
   */
  private nudgeHang(agent: string, tool: string, result: ToolResult): void {
    if (!looksLikeHang(tool, result.detail)) return;
    this.hangSeen += 1;
    this.hangLastAt = clock();
    this.hangLastAgent = agent;
    this.appendSystemTrace(
      "system",
      "挂死红灯：" + agent + " 的命令被强杀（" + result.detail.slice(0, 70) + "）",
    );
    const sent = this.hangMailed.get(agent) ?? 0;
    if (sent >= 3) return;
    this.hangMailed.set(agent, sent + 1);
    const body = [
      "【挂死了】你刚跑的东西 30 秒没返回，被系统强杀了：",
      "",
      "  $ " + result.detail.slice(0, 120),
      "",
      "这不是「跑过了」，也不是「验收通过」—— 是产物卡死了。三件事挑一件：",
      "  1) 修产物的死循环 / 等输入；",
      "  2) 给验收脚本里每一次运行加超时（python：subprocess.run(..., timeout=10)），免得脚本",
      "     自己跟着挂死、把 30 秒强杀误当成「脚本跑通了」；",
      "  3) 到点也修不好的话：按现状交付，但在 evidence 里**明写**「产物在样例输入下会挂死（30s 强杀）」。说清楚 > 假装绿。",
    ].join("\n");
    sendMail(this.store, {
      swarmId: this.swarmId,
      from: "system",
      to: [addressOf(agent, this.swarmId)],
      subject: "【挂死了】产物 30 秒被强杀 —— 别当跑过了",
      body,
      kind: "verify",
    });
  }

  /**
   * P11-b：系统自己跑一遍题面样例 —— 标准答案写在题面里，agent 删不掉。
   * 实测 p2482-p10：agent 的验收脚本自己消失了，系统只好说「没有可跑脚本」，最后只有人手工判。
   */
  private sampleReport(): { ok: boolean; note: string } {
    try {
      const goal = this.store.getSwarm(this.swarmId)?.goal ?? "";
      /* P12：题面给了成条的验收用例就优先跑它（部分分 + 每轮可比）；否则退回【样例输入/输出】对照。 */
      const cases = parseAcceptanceCases(goal);
      const entry = parseTaskEntry(goal);
      if (cases.length > 0 && entry !== null) {
        return runAcceptanceCases(workspaceOf(this.swarmId), entry, cases);
      }
      const sample = parseTaskSample(goal);
      const main = goalDeliverable(goal);
      if (sample === null || main.length === 0) {
        return { ok: false, note: "题面样例：没法判（题面里没有【样例输入】/【样例输出】，或认不出主产物文件名）" };
      }
      return runSampleCheck(workspaceOf(this.swarmId), main, sample);
    } catch (error) {
      return { ok: false, note: "题面样例：跑不动（" + String(error).slice(0, 80) + "）" };
    }
  }

  private nudgeGreenDelivery(agent: string, tool: string, result: ToolResult): void {
    const detail = result.detail ?? "";
    const greenNow = looksLikeGreenCheck(tool, detail);
    const hollow = greenNow ? hollowGreenLine(result.observation ?? "") : "";
    if (hollow.length > 0) {
        /* P13-c：退出码 0 但一个用例都没跑到 —— 不算验收通过，也不算「可以交付了」的依据。
           calc-r1 实测：sidney 的 unittest discover 跑 0 个用例返回 0，系统照播「跑绿了」并催交付。 */
      if (!this.greenNudged.has(agent)) {
        this.greenNudged.add(agent);
        sendMail(this.store, {
          swarmId: this.swarmId,
          from: "system",
          to: [addressOf(agent, this.swarmId)],
          subject: "【空绿】这次验收一个用例都没跑，不算证据",
          body:
            "你跑的「" + detail.slice(0, 80) + "」退出码是 0，但输出里写着没跑到任何用例：" + "\n" + hollow + "\n" + "\n"
            + "这不是「验收通过」—— 0 个用例的退出码 0 什么也没证明。" + "\n"
            + "要么让你的验收脚本真的跑到用例，要么直接对着题面的验收用例改（系统每轮自己会跑那 24 条）。",
          kind: "verify",
        });
        this.appendSystemTrace("system", "空绿点名：" + agent + " 的验收一个用例都没跑到（" + detail.slice(0, 60) + "）");
      }
      return;
    }
    if (greenNow) {
      this.lastGreenAt = clock();
      this.lastGreenSha = headSha(this.swarmId);
      this.greenCount += 1;
    }
    try {
      if (SWARM_DELIVER_NUDGE_CAP <= 0) return;
      if (this.greenNudged.size >= SWARM_DELIVER_NUDGE_CAP) return;
      if (this.greenNudged.has(agent)) return;
      if (!greenNow) return;
      const claim = this.store.listClaims(this.swarmId).find((item) => item.agent === agent)?.slice;
      if (!claim) return;
      this.greenNudged.add(agent);
      sendMail(this.store, {
        swarmId: this.swarmId,
        from: "system",
        to: [addressOf(agent, this.swarmId)],
        subject: "【可以交付了】你刚跑绿了：" + detail.slice(0, 60),
        body:
          "你刚跑绿了一次验收（" + detail.slice(0, 120) + "）。" + "\n" +
          "现在就调用 complete_slice 把它交掉 —— 你认领的是「" + claim + "」：" + "\n" +
          '  complete_slice(slice="' + claim + '", evidence="做完了：…｜怎么验的：<把这次的命令和输出里的数字原样贴上>｜没做完：…")' + "\n" +
          "不用等别人、也不用再打磨：验收绿了就交，剩下的没做完的部分写进 evidence 就行。" + "\n" +
          "没交付的片在复盘里等于零产出 —— 这是这一轮最容易犯的错。",
        kind: "verify",
      });
      this.appendSystemTrace("system", "绿跑点名：" + agent + " 的验收跑绿了（" + detail.slice(0, 60) + "），系统催其交付「" + claim.slice(0, 24) + "」");
    } catch (error) {
      console.error("[runner] 绿跑点名失败:", error);
    }
  }

  /**
   * 收口兜底（B3）：墙钟最后一截，把「已认领但没交付」的片按现状入账。
   * 用系统身份直接写 slice.completed（**故意不过验收闸** —— 半成品 + 说清边界 > 零产出），
   * 证据里带上工作区 git 版本状态和验收脚本的真实结果，下一轮接着干时不用从零开始。
   */
  private autoShipBoard(): void {
    try {
      const board = this.store.listSlices(this.swarmId).filter((info) => info.status === "claimed");
      if (board.length === 0) return;
      const files = this.store.listFiles(this.swarmId);
      const gate = runWorkspaceChecks(this.swarmId);
      const shipped: string[] = [];
      for (const info of board) {
        const claimers = this.store
          .listClaims(this.swarmId)
          .filter((claim) => claim.slice === info.slice)
          .map((claim) => claim.agent);
        const evidence = autoShipEvidence({
          slice: info.slice,
          claimers,
          files,
          checkOk: gate.ok,
          checkNote: gate.note,
        });
        this.store.append({
          type: "slice.completed",
          swarmId: this.swarmId,
          slice: info.slice,
          agent: "system",
          evidence,
          time: clock(),
        });
        shipped.push(info.slice);
      }
      if (shipped.length === 0) return;
      const list = shipped.map((name) => "  - " + name.slice(0, 40)).join("\n");
      this.mailTeam(
        "【系统自动交付】" + String(shipped.length) + " 片按现状入账",
        "系统在墙钟最后 " + String(Math.round((1 - SWARM_AUTOSHIP_FRACTION) * 100)) + "% 把没人交付的片按现状入了账：" + "\n" + list + "\n\n" +
          "这些片不是 agent 确认完成的，证据由系统按当时的工作区写（git 版本 + 验收脚本结果）。" + "\n" +
          "下一轮接着干的人：先 read_inbox 看这些交付，别从零开始；哪一片其实是半成品，就在广播里说清还差什么。",
        "verify",
      );
      this.appendSystemTrace(
        "system",
        "收口兜底：墙钟 " + Math.round(SWARM_AUTOSHIP_FRACTION * 100) + "%，系统自动交付 " + String(shipped.length) + " 片",
      );
    } catch (error) {
      console.error("[runner] 收口兜底失败:", error);
    }
  }

  private commitWorkspace(agent: string, tool: string, result: ToolResult): void {
    try {
      const goal = this.store.getSwarm(this.swarmId)?.goal ?? "";
      /* 提交之前先拍一张「谁写过什么」的快照 —— 换手检测比的就是它 */
      const before = this.store.listFiles(this.swarmId);
      const commit = commitStep(this.swarmId, agent, tool, result.detail ?? "", goal);
      if (!commit || commit.changed.length === 0) return;
      for (const change of commit.changed) {
        this.store.append({
          type: "file.written",
          swarmId: this.swarmId,
          path: change.path,
          agent,
          tool,
          bytes: change.bytes,
          commit: commit.commit,
          time: clock(),
        });
      }
      /* P10-c：验收之后再动产物 = 证据作废。实测 p2482-p9：08:25:43 验收通过，08:26:31 betty
         回滚了 p2482.cpp，最终交付的版本根本没验过 —— 那 80 秒里没人知道。这里当场广播
         （同一个版本号只喊一次），让 agent 还有时间重跑验收。 */
      {
        const mainName = goalDeliverable(this.store.getSwarm(this.swarmId)?.goal ?? "");
        const touchedMain = mainName.length > 0 && commit.changed.some((change) => change.path.endsWith(mainName));
        if (
          touchedMain &&
          /* 一轮最多喊 3 次，免得变成刷屏 */
          this.postGreenWarned.size < 3 &&
          this.lastGreenSha.length > 0 &&
          commit.commit !== this.lastGreenSha &&
          !this.postGreenWarned.has(commit.commit)
        ) {
          this.postGreenWarned.add(commit.commit);
          this.mailTeam(
            "【证据作废】产物在最后一次验收之后又被改了",
            "刚才 " + agent + " 改了 " + mainName + "（新版本 " + commit.commit + "）。"
              + "最后一次验收跑绿是在 " + this.lastGreenAt + "、版本 " + this.lastGreenSha + " —— 也就是说**现在这个版本没验过**。" + "\n\n"
              + "要么重跑一次验收（跑绿了再交），要么在 evidence 里明写「未经验收」。别把过期证据当交付依据。",
            "verify",
          );
          this.appendSystemTrace(
            "system",
            "证据作废警示：" + agent + " 在验收（" + this.lastGreenAt + "，" + this.lastGreenSha + "）之后改了 " + mainName + "（" + commit.commit + "），已广播全队",
          );
        }
      }
      /* P13-b：产物每次被改动，系统就重跑一次题面验收；分数往下掉了立刻全队广播。
         calc-r1 实测：louise 做到 23/24，别人「改 1 处」砸成 0/24，连砸 7 次、8 分钟没人知道。 */
      {
        const mainNow = goalDeliverable(this.store.getSwarm(this.swarmId)?.goal ?? "");
        const touchedNow = mainNow.length > 0 && commit.changed.some((change) => change.path.endsWith(mainNow));
        if (touchedNow) {
          const nowReport = this.sampleReport();
          const nowScore = acceptScore(nowReport.note);
          /* P14-a：跑不起来（语法错 / import 失败）不是「没量到」，是最惨的一种退步。
             以前 acceptScore 对这种情况给 null，比较直接跳过 —— calc2-r1 实测：43/59 的产物被
             olivia 一个字符改坏（: 打成 ;），最后 24 秒的这次退步一条警报都没发，收尾就是语法错。 */
          const nowRank = nowScore === null ? -1 : nowScore;
          const nowText = nowScore === null ? "跑不起来（连 import 都过不去）" : String(nowScore) + " 分";
          const prevText = this.acceptRankSeen
            ? (this.acceptRank < 0 ? "跑不起来" : String(this.acceptRank) + " 分")
            : "还没量过";
          if (
            this.acceptRankSeen &&
            nowRank < this.acceptRank &&
            this.regressWarned.size < 3 &&
            !this.regressWarned.has(commit.commit)
          ) {
            this.regressWarned.add(commit.commit);
            /* P14-b：警报里直接给出「最后一个好版本」和一句能整份拿回来的命令 ——
               calc2-r1 里 ray 确实从 2 分救回了 40 分，但花了 3.5 分钟；把 sha 和命令摆到眼前能省掉找人问。 */
            const best = this.acceptBestSha.slice(0, 7);
            const rescue = best.length > 0
              ? "最后一个好版本是 " + best + "（" + String(this.acceptBestRank) + " 分）。照抄这句就能整份拿回来：\n"
                + "  git show " + best + ":" + mainNow + " > " + mainNow + "\n"
                + "  git commit -am '恢复 " + best + "'\n\n"
              : "现在还没有量到过能跑起来的版本，先照着题面把最小可跑版本弄出来。\n\n";
            this.mailTeam(
              "【退步警报】题面验收的分数掉了",
              "刚才 " + agent + " 改了 " + mainNow + "：题面验收从 " + prevText + " 掉到 " + nowText + "。\n"
                + nowReport.note + "\n\n" + rescue
                + "这不是「还没做完」—— 这是把已经过了的用例改坏了。先把分数拿回来再往下走。",
              "verify",
            );
            this.appendSystemTrace(
              "system",
              "退步警报：" + agent + " 把题面验收从 " + prevText + " 砸到 " + nowText + "（版本 " + commit.commit.slice(0, 7) + "）",
            );
          }
          this.acceptRankSeen = true;
          this.acceptRank = nowRank;
          if (nowRank >= 0 && nowRank >= this.acceptBestRank) {
            this.acceptBestRank = nowRank;
            this.acceptBestSha = commit.commit;
          }
        }
      }
      /* 换手播报：这一版动了别人的文件。系统不做裁判，只负责把「你那版被顶掉了、怎么拿回来」说出口 */
      for (const handoff of detectHandoffs(before, commit.changed, agent)) {
        this.appendSystemTrace(
          "system",
          "文件换手：" + handoff.path + " 由 " + handoff.prevAgent + " → " + agent + "（上一版 " + (handoff.prevCommit || "?") + "）",
        );
        this.mailHandoff(handoff);
      }
    } catch {
      /* 留档失败不能影响跑 */
    }
  }

  /** 换手通知：点对点告诉上一版作者「你那版被谁改了、怎么取回来」。带节流和单轮上限。 */
  private mailHandoff(handoff: Handoff): void {
    try {
      const key = handoff.path + "|" + handoff.prevAgent + "|" + handoff.agent;
      const now = Date.now();
      const last = this.handoffMailed.get(key) ?? 0;
      if (now - last < SWARM_HANDOFF_THROTTLE_MS) return;
      if (this.handoffMailCount >= SWARM_HANDOFF_MAIL_CAP) return;
      this.handoffMailed.set(key, now);
      this.handoffMailCount += 1;
      const text = handoffMailText(handoff);
      sendMail(this.store, {
        swarmId: this.swarmId,
        from: "system",
        to: [addressOf(handoff.prevAgent, this.swarmId)],
        subject: text.subject,
        body: text.body,
        kind: "verify",
      });
    } catch (error) {
      console.error("[runner] 换手通知发送失败:", error);
    }
  }

  /** 大脑和工具看到的现场：全部来自事件账本，没有隐藏状态（所以重放后决定一致） */
  private context(agent: string, swarmName: string, goal: string, model?: string): BrainContext {
    const swarm = this.store.getSwarm(this.swarmId);
    const roster = (swarm?.agents ?? []).filter((name) => name !== "system");
    /* 看板必须**动态**读：切片生成器会在开跑前/中途往板上加片，
       给大脑看的清单要是静态的，它根本不知道有新活可认领（只能自己另发明一条）。 */
    const open = this.store
      .listSlices(this.swarmId)
      .filter((info) => info.status !== "completed")
      .map((info) => info.slice);
    return {
      store: this.store,
      boardFraction: SWARM_RUN_MAX_MS > 0 ? Math.min(1, (Date.now() - this.boardT0) / Math.max(1, SWARM_RUN_MAX_MS * SWARM_BOARD_DEADLINE_FRACTION)) : 0,
      swarmId: this.swarmId,
      swarmName,
      goal,
      slices: open.length > 0 ? open : this.slices,
      agents: roster,
      agent,
      workDir: workspaceOf(this.swarmId),
      model,
    };
  }

  /** M5 熔断：花超预算就不再让任何智能体行动 */
  private overBudget(): boolean {
    const swarm = this.store.getSwarm(this.swarmId);
    return swarm ? swarm.cost >= swarm.budget : false;
  }

  /** 记行为流 + 记账。两件事分开：行为流给人看，账本给刹车用。 */
  private record(
    agent: string,
    model: string,
    tool: string,
    result: ToolResult,
    ms: number,
    usage?: StepUsage,
  ): StepRecord {
    const elapsed = Math.max(1, ms);
    this.steps += 1;
    /* 真模型：token 直接来自 API 的 usage；mock：还是按上下文长度估算 */
    const tokens = usage
      ? usage.readTokens + usage.writeTokens + usage.cacheRead + usage.cacheWrite
      : this.mockTokens(tool, result);

    const trace: TraceEventData = {
      id: messageId(),
      swarmId: this.swarmId,
      time: clock(),
      agent,
      /* 类型 = 工具名本身（M8）；只有特例（重试/系统干预）才自己指定 */
      type: result.traceType ?? (tool as TraceType),
      detail: result.detail,
      ms: elapsed,
      /* error 是"执行了但结果不理想"（命令退出码非零），也算错误状态，但它不触发重试 */
      status: result.refused || result.error ? "error" : "ok",
    };
    this.store.append({ type: "trace.appended", event: trace });
    /* 工作区版本留档（M12）：每一步之后由**系统**提交。
       归因靠工作区 diff —— agent 用 bash heredoc 写的文件也跑不掉（B2/B10 的教训）。 */
    this.commitWorkspace(agent, tool, result);
    this.nudgeGreenDelivery(agent, tool, result);
    this.nudgeHang(agent, tool, result);
    this.trackNoTool(agent, tool);
    this.store.append({
      type: "usage.recorded",
      swarmId: this.swarmId,
      agent,
      model,
      readTokens: usage ? usage.readTokens : Math.floor(tokens * 0.7),
      writeTokens: usage ? usage.writeTokens : tokens - Math.floor(tokens * 0.7),
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      tokens,
      cost: usdForTokens(tokens),
      ms: elapsed,
      /* 只有"工具压根没执行"才算失败：命令报错是正常观察结果，不该污染失败计数 */
      failed: result.refused === true,
      time: clock(),
    });

    return {
      agent,
      tool,
      detail: result.detail,
      observation: result.observation,
      ms: elapsed,
      tokens,
      cost: usdForTokens(tokens),
      done: result.done === true,
      refused: result.refused === true,
      reason: result.reason ?? "",
      confirm: result.confirm ?? "",
      stop: result.stop ?? "done",
    };
  }

  /**
   * mock 的 token 消耗：跟"这一步喂了多少上下文"挂钩，不是凭空一个常数。
   * 读收件箱要把它全塞进上下文 → 贵；收工一句话 → 便宜。
   * M8 接真模型后这个函数退休，token 直接取 API 响应的 usage。
   */
  private mockTokens(tool: string, result: ToolResult): number {
    const base = this.tokensPerTurn;
    const weight: Record<string, number> = {
      read_inbox: 2.2,
      list_mailboxes: 1.8,
      reply: 1.5,
      send_mail: 1.4,
      broadcast: 1.6,
      claim_slice: 0.7,
      release_slice: 0.5,
      complete_slice: 0.6,
      mark_read: 0.4,
      archive: 0.4,
      done: 0.3,
      decide: 0.2,
    };
    // 观察结果越长，塞回上下文的 token 越多 —— 跟真实消耗同构
    const observed = Math.ceil(result.observation.length / 3);
    return Math.round(base * (weight[tool] ?? 1) + observed);
  }

  private goalOf(): string {
    const goal = this.store.listMessages(this.swarmId, "primary").find((message) => message.kind === "goal");
    /* 2026-09-19：旧值 120 只够一句话 —— 让 agent 自己立板就必须让它看到完整题目。 */
    return goal?.body.slice(0, SWARM_GOAL_CHARS) ?? "";
  }
}

export { addressOf };
