/*
 * 收工闸 / 孤儿切片回收 / 累计失败放弃 —— 自检（M10）
 *
 * 这三条都是 PELICAN 3 尸检出来的系统病，全部是**系统层硬机制**（不靠提示词）：
 *   [A] 自己名下的片没交付 → 不准收工
 *   [B] 别人手上的片没交付 → 也不准收工（验证者不许先撤）
 *   [C] 全部交付 + 封板后查证 → 才允许全员收工（且 swarm.completed 才落）
 *   [D] 全交付了但没亲自查证 → 先回去验一遍再收工
 *   [E] 负责人大脑连挂被放弃 → 他名下没交付的片**退回板上**，别人能接
 *   [F] 失败不是连续的（被成功一次次打断）→ 累计到阈值也该放弃（louis 就是这么耗死的）
 *
 * P1 验收闭环 / P2 停滞轮换（"测试不过继续造"）：
 *   [G] 验收报 ❌ → **照收留档**（测不过是有价值的交付）+ 系统自动开片修复 + 修完必须重跑出 ✅ 才收工
 *   [H] 验收片证据读不出结论 → 交付被拒（没结论的验收等于没验）
 *   [I] 产物在验收之后又被改 → 收工被挡（那次 PASS 过期）+ 系统自动开一片复检；
 *       复检片不能由"产物最后改动者"自己签收；换人复检 ✅ 之后才允许全员收工
 *   [J] 认领后长时间没动作 → 先催办、再强制退还回板（louis 那种锁死不靠 agent 自觉）
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/eventstore.ts";
import { addressOf } from "../src/mail.ts";
import { AgentRunner } from "../src/agent/runner.ts";
import type { Brain, BrainContext, Decision, DecisionResult } from "../src/agent/brain.ts";
import { clock } from "../src/time.ts";
import { seedSwarm } from "./fixture.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass += 1;
    console.log("  ✅ " + name);
  } else {
    fail += 1;
    console.log("  ❌ " + name + (extra.length > 0 ? "  " + extra : ""));
  }
}

type LooseEvent = { type?: string; swarmId?: string; event?: { type?: string; swarmId?: string; detail?: string } };
const of = (store: EventStore, swarmId: string): LooseEvent[] =>
  (store.listEvents() as LooseEvent[]).filter((e) => e.swarmId === swarmId || e.event?.swarmId === swarmId);
const traces = (store: EventStore, swarmId: string): string[] =>
  (store.listEvents() as any[])
    .filter((e) => e.type === "trace.appended" && e.event?.swarmId === swarmId)
    .map((e) => String(e.event?.detail ?? ""));
const hasTrace = (store: EventStore, swarmId: string, needle: string): boolean =>
  traces(store, swarmId).some((detail) => detail.includes(needle));

/** 脚本化大脑：按"第几步"给决定，用来精确摆出闸门要拦的场面 */
class ScriptBrain implements Brain {
  readonly name = "script";
  private readonly counts = new Map<string, number>();
  private readonly script: (agent: string, step: number) => Decision;
  constructor(script: (agent: string, step: number) => Decision) {
    this.script = script;
  }
  async decide(ctx: BrainContext): Promise<DecisionResult> {
    const step = this.counts.get(ctx.agent) ?? 0;
    this.counts.set(ctx.agent, step + 1);
    return { decision: this.script(ctx.agent, step) };
  }
}

/** 隔一步抽一次：连续计数永远到不了阈值，只有累计才看得见（louis 的病例） */
class FlakyBrain implements Brain {
  readonly name = "flaky";
  private n = 0;
  async decide(): Promise<DecisionResult> {
    this.n += 1;
    if (this.n % 2 === 1) throw new Error("模型网关 400：上游返回 400（模型 minimax-m2.7）");
    return { decision: { tool: "read_inbox" } };
  }
}

const TMP = await mkdtemp(path.join(tmpdir(), "swarm-gate-"));
const mk = async (id: string, agents: string[], slices: string[]): Promise<{ store: EventStore; id: string }> => {
  const store = new EventStore(path.join(TMP, id));
  await store.load();
  const created = seedSwarm(store, { id, agents, slices });
  store.append({ type: "swarm.started", swarmId: created.swarm.id, time: clock() });
  return { store, id: created.swarm.id };
};

console.log("[A] 自己名下的片没交付 → 不准收工");
{
  const { store, id } = await mk("gate-a", ["ana"], ["造轮子"]);
  const brain = new ScriptBrain((_a, step) =>
    step === 0
      ? { tool: "claim_slice" as const, slice: "造轮子" }
      : { tool: "done" as const, reason: "我觉得可以了", confirm: "自认为完成" },
  );
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: ["造轮子"], brain, maxTurns: 4, tokensPerTurn: 10 }).run();
  ok("没有全员收工", run.stoppedBy !== "all-done", "实际 " + run.stoppedBy);
  ok("收工被闸拦下并留痕", hasTrace(store, id, "收工被挡"));
  ok("没有落 swarm.completed", of(store, id).filter((e) => e.type === "swarm.completed").length === 0);
  ok("那片还在他名下（没被偷偷当成完成）", store.listSlices(id).filter((s) => s.status === "claimed").length === 1);
}

console.log();
console.log("[B] 别人手上的片没交付 → 也不准收工（验证者不许先撤）");
{
  const { store, id } = await mk("gate-b", ["ana", "bob"], ["甲", "乙"]);
  const brain = new ScriptBrain((agent, step) => {
    if (agent === "ana") {
      if (step === 0) return { tool: "claim_slice", slice: "甲" };
      if (step === 1) return { tool: "complete_slice", slice: "甲", evidence: "甲做好了" };
      return { tool: "done", reason: "我这片做完了", confirm: "甲已交付" };
    }
    if (step === 0) return { tool: "claim_slice", slice: "乙" };
    return { tool: "done", reason: "我不想做了", confirm: "没做但想走" };
  });
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: ["甲", "乙"], brain, maxTurns: 4, tokensPerTurn: 10 }).run();
  ok("没有全员收工（乙还没交付）", run.stoppedBy !== "all-done", "实际 " + run.stoppedBy);
  ok(
    "两个人的收工都被闸拦下",
    run.report.filter((s: any) => s.tool === "done" && !s.done).length >= 2,
    JSON.stringify(run.report.filter((s: any) => s.tool === "done").map((s: any) => s.done)),
  );
  ok("一个人都没被算作收工", of(store, id).filter((e) => e.type === "agent.done").length === 0);
  const y = store.listSlices(id).find((s) => s.slice === "乙");
  ok("乙仍在认领中（没被静默吞掉）", y?.status === "claimed", JSON.stringify(y));
}

console.log();
console.log("[C] 全部交付 + 封板后查证 → 才允许全员收工");
{
  const { store, id } = await mk("gate-c", ["ana", "bob"], ["甲", "乙"]);
  const brain = new ScriptBrain((agent, step) => {
    const mine = agent === "ana" ? "甲" : "乙";
    if (step === 0) return { tool: "claim_slice", slice: mine };
    if (step === 1) return { tool: "complete_slice", slice: mine, evidence: mine + "已交付" };
    if (step === 2) return { tool: "bash", command: "echo 复现一遍" };
    return { tool: "done", reason: mine + "已交付并复核", confirm: mine + "的验证通过" };
  });
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: ["甲", "乙"], brain, maxTurns: 10, tokensPerTurn: 10 }).run();
  ok("全员收工", run.stoppedBy === "all-done", "实际 " + run.stoppedBy);
  ok("落了 swarm.completed", of(store, id).filter((e) => e.type === "swarm.completed").length === 1);
  ok("履约统计如实（2/2/2）", run.deliverables?.completed === 2 && run.deliverables?.total === 2, JSON.stringify(run.deliverables));
}

console.log();
console.log("[D] 全交付了但没亲自查证 → 先回去验一遍");
{
  const { store, id } = await mk("gate-d", ["ana"], ["甲"]);
  const brain = new ScriptBrain((_a, step) => {
    if (step === 0) return { tool: "claim_slice", slice: "甲" };
    if (step === 1) return { tool: "complete_slice", slice: "甲", evidence: "甲已交付" };
    if (step === 2) return { tool: "done", reason: "交完了", confirm: "别人说没问题" };
    if (step === 3) return { tool: "bash", command: "echo 亲自复核" };
    return { tool: "done", reason: "亲手复核过了", confirm: "复核通过" };
  });
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: ["甲"], brain, maxTurns: 10, tokensPerTurn: 10 }).run();
  ok("没查证前被拦下", hasTrace(store, id, "封板后未亲自查证"));
  ok("补了查证之后才收工", run.stoppedBy === "all-done", "实际 " + run.stoppedBy);
  ok("收工恰好一次（被拦那次没算收工）", of(store, id).filter((e) => e.type === "agent.done").length === 1);
}

console.log();
console.log("[E] 负责人被放弃 → 他名下没交付的片退回板上，别人能接");
{
  const { store, id } = await mk("gate-e", ["ana", "bob"], ["主产物"]);
  /* bob 是状态机：那片不在自己手上就等着（不抢别人的、也不越权替别人交付） */
  const bobBrain: Brain = {
    name: "bob",
    async decide(ctx: BrainContext): Promise<DecisionResult> {
      const mine = ctx.store.listSlices(ctx.swarmId).find((s) => s.slice === "主产物");
      if (!mine) return { decision: { tool: "read_inbox" } };
      if (mine.status === "available") return { decision: { tool: "claim_slice", slice: "主产物" } };
      if (mine.status === "claimed" && mine.claimedBy === "bob") {
        return { decision: { tool: "complete_slice", slice: "主产物", evidence: "我接手做完了" } };
      }
      if (mine.status === "completed") {
        if (ctx.store.countTraces(ctx.swarmId, "bob", ["bash"]) === 0) {
          return { decision: { tool: "bash", command: "echo 复核" } };
        }
        return { decision: { tool: "done", reason: "接手交付完成", confirm: "独立复核通过" } };
      }
      return { decision: { tool: "read_inbox" } };
    },
  };
  /* ana = 那个模型一直 400 的人：先认领主产物，然后连挂被放弃 */
  const brain: Brain = {
    name: "mixed",
    async decide(ctx: BrainContext): Promise<DecisionResult> {
      if (ctx.agent === "ana") {
        const first = ctx.store.listSlices(ctx.swarmId).find((s) => s.slice === "主产物");
        if (first?.status === "available" || first?.claimedBy === "ana") {
          if (first.claimedBy !== "ana") return { decision: { tool: "claim_slice", slice: "主产物" } };
        }
        throw new Error("模型网关 400：上游返回 400（模型 minimax-m2.7）");
      }
      return bobBrain.decide(ctx);
    },
  };
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: ["主产物"], brain, maxTurns: 12, tokensPerTurn: 10 }).run();
  ok("放弃被如实报告（brain-error）", run.stoppedBy === "brain-error", "实际 " + run.stoppedBy);
  ok("退片留痕", hasTrace(store, id, "退回切片「主产物」"));
  ok("退了认领（claim.released）", of(store, id).filter((e) => e.type === "claim.released").length >= 1);
  ok("别人接手并交付完成", store.listSlices(id)[0]?.status === "completed", JSON.stringify(store.listSlices(id)));
}

console.log();
console.log("[F] 失败不连续（被成功打断）→ 累计到阈值也该放弃");
{
  const { store, id } = await mk("gate-f", ["ana"], []);
  const run = await new AgentRunner({ handoffGate: false, independentRecheck: false, store, swarmId: id, slices: [], brain: new FlakyBrain(), maxTurns: 20, tokensPerTurn: 10 }).run();
  const giveup = run.report.find((s: any) => s.stop === "brain-giveup");
  ok("累计失败也会被放弃（不是只靠连续计数）", run.stoppedBy === "brain-error", "实际 " + run.stoppedBy);
  ok("放弃理由写清了累计次数", String(giveup?.reason ?? "").includes("累计"), String(giveup?.reason ?? "").slice(0, 90));
}

console.log();
console.log();
console.log("[G] 验收报 ❌ → 照收留档 + 系统自动开片修复 + 修完必须重跑出 ✅ 才收工");
{
  const { store, id } = await mk("gate-g", ["ana", "bob"], ["主产物", "独立验证：主产物"]);
  const VERIFY = "独立验证：主产物";
  const state = { anaChecked: false, bobChecked: false };
  const brain: Brain = {
    name: "g",
    async decide(ctx: BrainContext): Promise<DecisionResult> {
      const board = ctx.store.listSlices(ctx.swarmId);
      const main = board.find((s) => s.slice === "主产物")!;
      const verify = board.find((s) => s.slice === VERIFY)!;
      const fix = board.find((s) => s.slice.startsWith("修复："));
      const re = board.find((s) => s.slice.startsWith("复检："));
      const count = (types: string[]): number => ctx.store.countTraces(ctx.swarmId, ctx.agent, types);
      if (ctx.agent === "ana") {
        /* 1) 先造出产物 */
        if (main.status === "available") return { decision: { tool: "claim_slice", slice: "主产物" } };
        if (main.status === "claimed" && count(["write"]) === 0) {
          return { decision: { tool: "write", path: "out.svg", content: "<svg>v1</svg>" } };
        }
        if (main.status === "claimed") {
          return { decision: { tool: "complete_slice", slice: "主产物", evidence: "v1 已写出" } };
        }
        /* 2) 被验出问题之后去修（接系统开的那片修复任务） */
        if (fix && fix.status === "available") return { decision: { tool: "claim_slice", slice: fix.slice } };
        if (fix && fix.status === "claimed" && fix.claimedBy === "ana" && count(["edit"]) === 0) {
          return { decision: { tool: "edit", path: "out.svg", old: "v1", new: "v2" } };
        }
        if (fix && fix.status === "claimed" && fix.claimedBy === "ana") {
          return { decision: { tool: "complete_slice", slice: fix.slice, evidence: "已按 4.2px 那条断言改掉耦合，自测 1.7px" } };
        }
        if (!state.anaChecked) {
          state.anaChecked = true;
          return { decision: { tool: "bash", command: "echo 封板后复核" } };
        }
        return { decision: { tool: "done", reason: "修完了", confirm: "产物已交付 + 等别人复检" } };
      }
      /* bob = 验一次（如实报 ❌）+ 修完之后复检 ✅ */
      if (verify.status === "available") return { decision: { tool: "claim_slice", slice: VERIFY } };
      if (verify.status === "claimed" && verify.claimedBy === "bob") {
        if (count(["read"]) === 0) return { decision: { tool: "read", path: "out.svg" } };
        return {
          decision: {
            tool: "complete_slice", slice: VERIFY,
            evidence: "❌ FAIL 脚-踏板距离 4.2px（要求 ≤2px），60 帧采样",
          },
        };
      }
      if (re && re.status === "available") return { decision: { tool: "claim_slice", slice: re.slice } };
      if (re && re.status === "claimed" && re.claimedBy === "bob") {
        return { decision: { tool: "complete_slice", slice: re.slice, evidence: "✅ 修后重跑：距离最大 1.8px（要求 ≤2px）" } };
      }
      if (re && re.status === "completed" && !state.bobChecked) {
        state.bobChecked = true;
        return { decision: { tool: "bash", command: "echo 封板后复核" } };
      }
      return { decision: { tool: "done", reason: "验收与复检完成", confirm: "✅ 数字达标" } };
    },
  };
  const run = await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["主产物", VERIFY], brain, maxTurns: 26, tokensPerTurn: 10,
  }).run();
  const v = store.listSlices(id).find((s) => s.slice === VERIFY);
  ok(
    "❌ 结论照收留档（测试员的活没白干）",
    v?.status === "completed" && String(v.evidence).includes("❌"),
    JSON.stringify(v),
  );
  ok("系统自动开了一片修复任务", store.listSlices(id).some((s) => s.slice.startsWith("修复：")));
  ok(
    "全队收到点名邮件",
    store.listMailboxMails(addressOf("ana", id), "inbox", 0).some((m) => m.subject.includes("验收没过")),
  );
  ok("修完之前的收工被挡（缺改动之后的 ✅）", hasTrace(store, id, "缺少「改动之后」的复检 PASS"));
  ok("换人复检 ✅ 之后才全员收工", run.stoppedBy === "all-done", "实际 " + run.stoppedBy);
}

console.log("[H] 验收片证据没有结论 → 交付被拒（没结论的验收等于没验）");
{
  const { store, id } = await mk("gate-h", ["bob"], ["独立验证：产物"]);
  const brain = new ScriptBrain((_a, step) =>
    step === 0
      ? { tool: "claim_slice", slice: "独立验证：产物" }
      : step === 1
        ? { tool: "complete_slice", slice: "独立验证：产物", evidence: "脚本跑完了，输出在 test.log 里" }
        : { tool: "read_inbox" },
  );
  await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["独立验证：产物"], brain, maxTurns: 6, tokensPerTurn: 10,
  }).run();
  ok("没结论的交付被拒", hasTrace(store, id, "验收证据没有结论"));
  ok("切片没变成 completed", store.listSlices(id)[0]?.status !== "completed", JSON.stringify(store.listSlices(id)));
}

console.log();
console.log("[I] 产物在验收之后又被改 → 收工被挡 + 系统自动开复检（换人签收才放行）");
{
  const { store, id } = await mk("gate-i", ["ana", "bob"], ["主产物", "独立验证：主产物"]);
  const VERIFY = "独立验证：主产物";
  const state = { anaChecked: false, bobChecked: false, anaReleased: false };
  const brain: Brain = {
    name: "i",
    async decide(ctx: BrainContext): Promise<DecisionResult> {
      const board = ctx.store.listSlices(ctx.swarmId);
      const main = board.find((s) => s.slice === "主产物")!;
      const verify = board.find((s) => s.slice === VERIFY)!;
      const re = board.find((s) => s.slice.startsWith("复检："));
      const count = (types: string[]): number => ctx.store.countTraces(ctx.swarmId, ctx.agent, types);
      const rejected = ctx.store
        .listEvents()
        .some((e: any) => String(e.event?.detail ?? "").includes("复检片不能由产物最后改动者签收"));
      if (ctx.agent === "ana") {
        if (main.status === "available") return { decision: { tool: "claim_slice", slice: "主产物" } };
        if (main.status === "claimed" && count(["write"]) === 0) {
          return { decision: { tool: "write", path: "out.svg", content: "<svg>v1</svg>" } };
        }
        if (main.status === "claimed") return { decision: { tool: "complete_slice", slice: "主产物", evidence: "v1 已写出" } };
        if (count(["edit"]) === 0) {
          return { decision: { tool: "edit", path: "out.svg", old: "v1", new: "v2" } };
        }
        /* 被试过"不能自己签收"之后就别再抢了，让给别人（不然她每轮都抢回来，bob 永远接不到） */
        if (re && re.status === "available" && !state.anaReleased) {
          return { decision: { tool: "claim_slice", slice: re.slice } };
        }
        if (re && re.status === "claimed" && re.claimedBy === "ana") {
          if (rejected) {
            state.anaReleased = true;
            return { decision: { tool: "release_slice", slice: re.slice } };
          }
          return { decision: { tool: "complete_slice", slice: re.slice, evidence: "✅ 我自己跑了一遍，全过" } };
        }
        if (!state.anaChecked) {
          state.anaChecked = true;
          return { decision: { tool: "bash", command: "echo 封板后复核" } };
        }
        return { decision: { tool: "done", reason: "全交完了", confirm: "产物已交付" } };
      }
      if (verify.status === "available") return { decision: { tool: "claim_slice", slice: VERIFY } };
      if (verify.status === "claimed" && verify.claimedBy === "bob") {
        if (count(["read"]) === 0) return { decision: { tool: "read", path: "out.svg" } };
        return {
          decision: { tool: "complete_slice", slice: VERIFY, evidence: "✅ 独立复跑：脚-踏板距离最大 1.8px（要求 ≤2px）" },
        };
      }
      if (re && re.status === "available") return { decision: { tool: "claim_slice", slice: re.slice } };
      if (re && re.status === "claimed" && re.claimedBy === "bob") {
        return { decision: { tool: "complete_slice", slice: re.slice, evidence: "✅ 独立复跑 60 帧：最大 1.7px（要求 ≤2px）" } };
      }
      if (re && re.status === "completed" && !state.bobChecked) {
        state.bobChecked = true;
        return { decision: { tool: "bash", command: "echo 封板后复核" } };
      }
      return { decision: { tool: "done", reason: "验收与复检都过了", confirm: "✅ 独立复核" } };
    },
  };
  const run = await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["主产物", VERIFY], brain, maxTurns: 24, tokensPerTurn: 10,
  }).run();
  ok(
    "改动之后的收工被挡（那次 PASS 已过期）",
    hasTrace(store, id, "缺少「改动之后」的复检 PASS"),
    "收工类留痕：" + traces(store, id).filter((d) => d.includes("收工")).slice(-3).join(" ｜ "),
  );
  ok("系统自动开了一片复检", store.listSlices(id).some((s) => s.slice.startsWith("复检：")));
  ok("复检片不能由产物最后改动者自己签收", hasTrace(store, id, "复检片不能由产物最后改动者签收"));
  ok(
    "换人复检 ✅ 之后才全员收工",
    run.stoppedBy === "all-done",
    "实际 " + run.stoppedBy + " ｜ 末段留痕：" + traces(store, id).slice(-22).join(" ｜ "),
  );
  ok("落了 swarm.completed（且是在复检通过之后）", of(store, id).filter((e) => e.type === "swarm.completed").length === 1);
}

console.log();
console.log("[J] 停滞轮换：认领后没动作 → 先催办、再强制退还回板");
{
  const { store, id } = await mk("gate-j", ["ana", "bob"], ["僵尸片"]);
  const brain = new ScriptBrain((agent, step) =>
    agent === "ana" && step === 0
      ? { tool: "claim_slice", slice: "僵尸片" }
      : { tool: "read_inbox" },
  );
  await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["僵尸片"], brain, maxTurns: 12, tokensPerTurn: 10, stallSteps: 3,
  }).run();
  ok("先催办（留痕）", hasTrace(store, id, "催办：「僵尸片」"));
  ok("再强制收回（留痕）", hasTrace(store, id, "停滞收回"));
  ok("切片退回 available（别人能接）", store.listSlices(id)[0]?.status === "available", JSON.stringify(store.listSlices(id)));
  ok(
    "全队收到换人邮件",
    store.listMailboxMails(addressOf("bob", id), "inbox", 0).some((m) => m.subject.includes("切片换人")),
  );
}

console.log();
console.log("[K] 工具炸了不能带走整个 run（真跑里一次 EISDIR 让 6 个 agent 全陪葬）");
{
  const { store, id } = await mk("gate-k", ["ana", "bob"], ["甲", "乙"]);
  const brain = new ScriptBrain((agent, step) => {
    const mine = agent === "ana" ? "甲" : "乙";
    /* 0 先把工作目录造出来；1 对**目录**读（旧代码在这里 EISDIR）；2 换成读文件就正常 */
    if (step === 0) return { tool: "write", path: "out.txt", content: "产物" };
    if (step === 1) return { tool: "read", path: "." };
    if (step === 2) return { tool: "read", path: "out.txt" };
    if (step === 3) return { tool: "claim_slice", slice: mine };
    if (step === 4) return { tool: "complete_slice", slice: mine, evidence: mine + "已交付" };
    if (step === 5) return { tool: "bash", command: "echo 复核" };
    return { tool: "done", reason: mine + "干完了", confirm: mine + "验证通过" };
  });
  const run = await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["甲", "乙"], brain, maxTurns: 12, tokensPerTurn: 10,
  }).run();
  ok("读目录被挡成可观察的失败（没有抛出去）", hasTrace(store, id, "这是目录"));
  ok("整个 run 没被带走（全员照常收工）", run.stoppedBy === "all-done", "实际 " + run.stoppedBy);
  ok("两片都交付完成", store.listSlices(id).filter((s) => s.status === "completed").length === 2);
}

console.log();
console.log("[L] 看门狗：卡住时必须往账本留痕（真跑里出现过账本静止 17 分钟、零留痕）");
{
  const { store, id } = await mk("gate-l", ["ana"], ["甲"]);
  /* 这个大脑每步故意磨蹭 1.5 秒；看门狗阈值调到 80ms → 必须留下「卡在哪个阶段」 */
  const brain: Brain = {
    name: "slow",
    async decide(): Promise<DecisionResult> {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { decision: { tool: "read_inbox" } };
    },
  };
  await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["甲"], brain, maxTurns: 2, tokensPerTurn: 10, watchdogMs: 80,
  }).run();
  ok("卡住时留痕了", hasTrace(store, id, "看门狗："));
  ok("留痕写清了卡在哪个阶段", hasTrace(store, id, "看门狗：「") && hasTrace(store, id, "秒没动静"));
  ok("看门狗不会把 run 带崩", store.listSlices(id).length === 1);
}

console.log();
console.log("[M] reject 模式（可用 SWARM_FAIL_MODE=reject 切）：验收报 ❌ → 交付被拒 + 退回板上");
{
  const { store, id } = await mk("gate-m", ["bob"], ["独立验证：产物"]);
  const brain = new ScriptBrain((_a, step) =>
    step === 0
      ? { tool: "claim_slice", slice: "独立验证：产物" }
      : step === 1
        ? { tool: "complete_slice", slice: "独立验证：产物", evidence: "❌ FAIL 距离 4.2px（要求 ≤2px）" }
        : { tool: "read_inbox" },
  );
  await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["独立验证：产物"], brain, maxTurns: 4, tokensPerTurn: 10, failMode: "reject",
  }).run();
  ok("交付被拒（没算交付）", hasTrace(store, id, "交付被拒：验收未通过"));
  ok("切片退回 available", store.listSlices(id)[0]?.status === "available", JSON.stringify(store.listSlices(id)));
  ok("reject 模式不自动开修复片", !store.listSlices(id).some((s) => s.slice.startsWith("修复：")));
}

console.log();
console.log("[N] 跑完必须留痕（真跑里跑满轮数结束是静默的，账本零事件、state 还是 live，看着像卡死）");
{
  const { store, id } = await mk("gate-n", ["ana", "bob"], ["甲", "乙"]);
  const brain = new ScriptBrain((_a, _s) => ({ tool: "read_inbox" }));
  await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["甲", "乙"], brain, maxTurns: 1, tokensPerTurn: 10,
  }).run();
  ok("跑完留下了「本轮跑完」留痕", hasTrace(store, id, "本轮跑完"));
  ok("留痕说清了是跑满步数上限", hasTrace(store, id, "跑满步数上限"));
  ok("留痕提醒 swarm 仍是 live 可续跑", hasTrace(store, id, "仍为 live"));
}

console.log();
console.log("[O] 有备用模型时，不许在「连续失败」处决（真跑里这让人白死：换模型那一步永远轮不到）");
{
  const { store, id } = await mk("gate-o", ["ana"], ["甲"]);
  let calls = 0;
  const brain: Brain = {
    name: "broken",
    async decide(): Promise<DecisionResult> {
      calls += 1;
      throw new Error("模型网关 503：上游返回 503");
    },
  };
  const run = await new AgentRunner({
    handoffGate: false, independentRecheck: false,
    store, swarmId: id, slices: ["甲"], brain, maxTurns: 8, tokensPerTurn: 10,
    maxBrainErrors: 2, maxBrainErrorsTotal: 3, failoverAfter: 1, fallbackModels: ["m-a", "m-b"],
  }).run();
  ok("换过模型（留下了故障转移留痕）", hasTrace(store, id, "模型故障转移"));
  ok("一路撑到累计上限才放弃（不是连续 2 次就死）", hasTrace(store, id, "累计 3 次模型调用失败"));
  ok("大脑确实被叫了 3 次（撑住了 2 次本会致命的连续失败）", calls === 3, "实际 " + calls);
  ok("该放弃时仍然放弃（上限兜底）", run.stoppedBy === "brain-error", "实际 " + run.stoppedBy);
}

try {
  await rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  /* 落盘是异步的，清理失败不该让自检翻车 */
}
console.log();
if (fail === 0) console.log("✅ 收工闸 / 孤儿回收 / 累计放弃 自检全部通过  （" + pass + " 通过 / 0 失败）");
else console.log("❌ 自检有失败  （" + pass + " 通过 / " + fail + " 失败）");
process.exit(fail === 0 ? 0 : 1);

