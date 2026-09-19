/*
 * 大脑（M4）：决定"下一步做什么"。
 *
 * 这是整条流水线里**唯一**将来要换掉的一环。M4 用的是 MockBrain：
 * 一段确定性的 if-else，不联网、不花钱、每次跑结果一模一样（所以能写自检）。
 * M8 接真模型时只换这个接口的实现，工具层/事件账本/预算/行为流全都不动。
 *
 * 约束：**必须是纯函数** —— 只看事件账本里已有的事实（收件箱、认领、我发过什么），
 * 不藏任何运行时状态。这样进程重启后，同一个智能体在同样的账本上会做出同样的决定。
 */
import type { EventStore } from "../eventstore.ts";
import { addressOf } from "../mail.ts";
import type { ToolResult } from "./tools.ts";

/** 大脑看到的现场（全部来自事件账本，没有隐藏状态） */
export interface BrainContext {
  store: EventStore;
  swarmId: string;
  swarmName: string;
  goal: string;
  /** 本集群的切片清单（M6 起是带状态的实体，这里给名字列表） */
  slices: string[];
  /** 队友名单（真模型需要知道能找谁说话） */
  agents: string[];
  agent: string;
  /** 立板窗口已过去的比例（0..1）：协商闸过半降级用（自检脚本可不传） */
  boardFraction?: number;
  /** M8：这个集群的工作目录绝对路径（agent 需要在提示词里知道它，才知道产物放哪儿、从哪里读） */
  workDir: string;
  /** 这一轮实际要用的模型（车道/降级算出来的）。llm 侧必须用它，否则车道白排。 */
  model?: string;
}

/** 大脑做出的决定：调哪个工具、带什么参数 */
export type Decision =
  | { tool: "read_inbox" }
  | { tool: "list_mailboxes" }
  | { tool: "mark_read"; mailId: string }
  | { tool: "archive"; mailId: string }
  | { tool: "send_mail"; to: string[]; subject?: string; body: string }
  | { tool: "reply"; mailId: string; body: string }
  | { tool: "broadcast"; body: string }
  | { tool: "publish_slice"; slice: string }
  | { tool: "claim_slice"; slice: string }
  | { tool: "release_slice"; slice: string }
  | { tool: "complete_slice"; slice: string; evidence: string }
  | { tool: "handoff"; to: string; why: string; acceptance: string; progress: string; slice?: string }
  | { tool: "done"; reason: string; confirm: string }
  /* 真·干活工具（M8）：在自己的工作目录里动手 */
  | { tool: "bash"; command: string }
  | { tool: "read"; path: string; offset?: number; limit?: number }
  | { tool: "write"; path: string; content: string }
  | { tool: "edit"; path: string; old: string; new: string }
  /* 质疑机制（B 组）：提案 / 回应 / 裁决 —— 之前这三条只在 llm 侧存在，联合里漏了 */
  | { tool: "challenge"; target: string; kind: string; claim: string; evidence: string; ask: string; slice?: string }
  | { tool: "respond_challenge"; id: string; response: string; evidence?: string }
  | { tool: "rule_challenge"; id: string; verdict: string; reason: string; evidence?: string }
  /* 模型说了个不存在的工具：不能崩，要把这条当成可观察的失败还给它去纠正 */
  | { tool: "unknown"; name: string };

/** 一次模型调用的真实用量（M8：直接从 API 响应的 usage 里抄） */
export interface StepUsage {
  /** 这一步实际用的模型（同一集群里可以混用不同模型） */
  model: string;
  readTokens: number;
  writeTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DecisionResult {
  decision: Decision;
  /** 真模型这一步的真实用量；mock 没有（它按 mockTokens 估算） */
  usage?: StepUsage;
  /** 模型这一步的思考（reasoning_content）；有就单独记一条 thinking 追踪 */
  note?: string;
}

export interface Brain {
  readonly name: string;
  /** 决定下一步；返回 done 就结束这个智能体的循环。
   *  真模型是网络调用，所以这里必须是异步的 —— runner 本来就该是异步的，只是 mock 掩盖了这一点。 */
  decide(ctx: BrainContext): Promise<DecisionResult>;
  /** 把刚执行完的工具结果交回大脑。真模型要把它作为 tool result 塞回上下文，
   *  否则下一轮它完全不知道自己上一步干了什么（mock 是纯函数，不需要）。 */
  observe?(ctx: BrainContext, tool: string, result: ToolResult): void;
}

/* ---------- MockBrain 的旋钮 ---------- */

export const MOCK = {
  /** 每个智能体最多发多少封（防住"回信乒乓"无限循环的硬闸） */
  maxMails: 6,
  /** 最多回几封（超过就安静下来干活，不然两个人能互相回一整天） */
  maxReplies: 2,
  /** 满员情况下最多试几片 */
  maxClaimAttempts: 4,
} as const;

/**
 * MockBrain 造的「交付证据」。内容当然是模板（它并没有真干活），但**形状是真的**：
 * 会被写进 slice.completed 事件、落到看板卡片上、并带进收工汇报。
 * M8 接真模型后，这里换成模型给出的可核对结果（跑通的用例、实际输出值…）。
 */
export function mockEvidence(slice: string, goal: string): string {
  const head = goal.replace(/\s+/g, " ").slice(0, 48);
  /* 显式给出结论：验收片（名字带"验证/校验/采样…"的）在 P1 之后必须带 ✅/❌ 才收得了货。
     mock 是个守规矩的 agent，所以它也照做 —— 这样自检覆盖的就是真实契约。 */
  return "已完成「" + slice + "」并自查：✅ 通过 —— 对齐目标「" + head + "」，产出物与线程里的汇报一致";
}

/**
 * 确定性策略，按优先级从上往下第一个成立的说了算：
 *
 *   1. 有未读、且我还没回够、还没发满 → 回最老的那封（对话）
 *   2. 我没切片、还有没撞过的片      → 认领（先试"热门片"，撞了就记一笔然后换）
 *   3. 我有切片、还没汇报过          → 发一封汇报
 *   4. 其余                          → 收工
 *
 * 为什么会撞片：每个智能体的偏好顺序都从 slices[0] 开始（大家都想干最要紧的那片），
 * 而 Runner 是一轮一轮顺序跑的 —— 所以第二个人真的会撞上第一个人的片，
 * 落一条 collision.detected，然后换下一片。这是**真实**的竞争结果，不是编的。
 */
/** mock 自己"想出来"的工作名：**只由目标决定**。
    所有 agent 算出来的是同一批名字，所以"大家都想先干最要紧的那片"这个真实竞争还在 ——
    名字里带 agent 就永远撞不上，也就把竞争测没了。 */
export function mockSliceNames(goal: string): string[] {
  const head = goal.replace(/\s+/g, " ").slice(0, 18);
  return [`关键实现：${head}`, `独立验证：${head}`, `交付整理：${head}`, `补充支持：${head}`];
}

export class MockBrain implements Brain {
  readonly name = "mock-v1";

  /* Mock 是纯函数：它不需要"上一步的观察结果"，所以不实现 observe */
  async decide(ctx: BrainContext): Promise<DecisionResult> {
    return { decision: this.pick(ctx) };
  }

  private pick(ctx: BrainContext): Decision {
    const { store, swarmId, agent, slices, goal, swarmName } = ctx;
    const me = addressOf(agent, swarmId);
    const myMails = store.listMailboxMails(me, "sent", 0);
    const myReplies = myMails.filter((mail) => mail.replyTo !== "");
    const myReports = myMails.filter((mail) => mail.replyTo === "" && mail.to.some((to) => to.includes("all@")));
    const unread = store.listMailboxMails(me, "inbox", 0).filter((mail) => !mail.read).reverse();

    // 1. 对话
    const oldest = unread[0];
    if (oldest && myReplies.length < MOCK.maxReplies && myMails.length < MOCK.maxMails) {
      const from = oldest.from.replace(`@${swarmId}.swarm`, "");
      const quote = oldest.body.replace(/\s+/g, " ").slice(0, 26);
      const mine = this.mySlice(store, swarmId, agent);
      return {
        tool: "reply",
        mailId: oldest.id,
        body: mine
          ? `收到 ${from} 的消息（「${quote}…」）。我认领的「${mine}」进展正常，先把可验证的部分做完，下一条汇报给结果。`
          : `收到 ${from} 的消息（「${quote}…」）。我还没认领切片，会先看哪片没人做，有结论了告诉你。`,
      };
    }

    /* 2a. 认领板默认是空的 —— 工作由 agent 自己发布。
       先"撞"别人拿着的那片（真实竞争，账本会记 collision.detected），
       板上没有的就 publish_slice 自己发布一条。 */
    if (slices.length === 0) {
      const onHand = this.mySlice(store, swarmId, agent);
      if (!onHand) {
        const lost0 = new Set(store.myLostSlices(swarmId, agent));
        const taken0 = new Set(store.listClaims(swarmId).map((claim) => claim.slice));
        const onBoard = new Set(store.listSlices(swarmId).map((item) => item.slice));
        const candidates = mockSliceNames(goal);
        const contended = candidates.find((name) => taken0.has(name) && !lost0.has(name));
        if (contended) return { tool: "claim_slice", slice: contended };
        const free = candidates.find((name) => onBoard.has(name) && !taken0.has(name) && !lost0.has(name));
        if (free) return { tool: "claim_slice", slice: free };
        const fresh = candidates.find((name) => !onBoard.has(name));
        if (fresh && lost0.size < MOCK.maxClaimAttempts) return { tool: "publish_slice", slice: fresh };
      }
    }

    // 2. 认领：偏好从第一片开始，撞过的跳过（不然会一直撞同一片）
    const mine = this.mySlice(store, swarmId, agent);
    if (!mine) {
      const lost = new Set(store.myLostSlices(swarmId, agent));
      const taken = new Set(store.listClaims(swarmId).map((claim) => claim.slice));
      // 先试"热门片"（别人拿着的那片）——这是真撞，账本会记；试过了就跳过
      const contended = slices.find((slice) => taken.has(slice) && !lost.has(slice));
      const free = slices.find((slice) => !taken.has(slice) && !lost.has(slice));
      const target = contended ?? free;
      if (target && lost.size + (mine ? 1 : 0) < MOCK.maxClaimAttempts) {
        return { tool: "claim_slice", slice: target };
      }
      return {
        tool: "done",
        reason: "没有可认领的切片了",
        confirm: "所有切片都已被别人认领，我这边没有可交付物，收工不影响整体",
      };
    }

    // 3. 汇报一次（只一次：广播是最容易炸的那条路）
    if (myReports.length === 0 && myMails.length < MOCK.maxMails) {
      return {
        tool: "send_mail",
        to: [`all@${swarmId}.swarm`],
        subject: `[${mine}] 阶段汇报`,
        body: [
          `集群：${swarmName}。目标：${goal.slice(0, 80)}。`,
          `我认领了「${mine}」，已完成第一遍。`,
          `结论：可交付，但需要一次独立复核。请没在做关键路径的同学看一下。`,
        ].join(""),
      };
    }

    // 4. 交付：把我认领的片标成 completed（看板流转到"已完成"，DoD 记证据）
    if (store.sliceByName(swarmId, mine)?.status !== "completed") {
      return { tool: "complete_slice", slice: mine, evidence: mockEvidence(mine, goal) };
    }

    /* 4.5 封板后先亲手查证一次再收工（新契约：系统收工闸要求"封板后至少亲自跑一遍"）。
       模拟一个守规矩的 agent：别人全交完了，我至少自己复核一遍产物再走。 */
    const board = store.listSlices(swarmId);
    const sealed = board.length > 0 && board.every((item) => item.status === "completed");
    if (sealed && store.countTraces(swarmId, agent, ["bash"]) === 0) {
      return { tool: "bash", command: "ls -la; echo 封板后复核：产物已就位" };
    }

    // 5. 收工：把交付时留下的**真证据**引用进来，而不是再说一遍模板话
    const evidence = store.sliceEvidence(swarmId, mine);
    return {
      tool: "done",
      reason: `「${mine}」已交付并汇报`,
      confirm:
        evidence.length > 0
          ? `「${mine}」的交付证据：${evidence}；另有同学在独立验证线上复核过，故判定可以了`
          : `「${mine}」已广播汇报，另有同学在独立验证线上复核过，故判定可以了`,
    };
  }

  private mySlice(store: EventStore, swarmId: string, agent: string): string | undefined {
    return store.listClaims(swarmId).find((claim) => claim.agent === agent)?.slice;
  }
}

/* 真模型大脑在 ./llm.ts（LlmBrain）：它要联网、要维护每个智能体的对话历史，
   和这里的纯函数 mock 不是一类东西，分开放更好读。 */
