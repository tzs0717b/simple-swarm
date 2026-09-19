/*
 * 重试策略自检（M8.1）
 *
 * 两级重试，各验一次：
 *   第一级 llm.ts（HTTP 层）：429/503/超时 → 退避重试，Retry-After 优先，带抖动
 *   第二级 runner.ts（轮次层）：重试完还是失败 → 本轮跳过、下一轮再叫它；
 *                              连续 N 次才放弃，且放弃要如实报 brain-error
 *
 * 场景 A：网关永远连不上 → 必须如实失败，绝不能显示成"全员收工、跑完了"
 * 场景 B：网关只抽一下 → agent 不该被当场判死，照常跑完
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/eventstore.ts";
import { AgentRunner } from "../src/agent/runner.ts";
import { LlmBrain, retryAfterMsOf } from "../src/agent/llm.ts";
import type { Brain, DecisionResult } from "../src/agent/brain.ts";
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

type LooseEvent = { type?: string; swarmId?: string; event?: { type?: string; swarmId?: string } };
const of = (store: EventStore, swarmId: string): LooseEvent[] =>
  (store.listEvents() as LooseEvent[]).filter(
    (event) => event.swarmId === swarmId || event.event?.swarmId === swarmId,
  );

const TMP = await mkdtemp(path.join(tmpdir(), "swarm-retry-"));

console.log("[0] Retry-After 解析");
ok("秒数（2 → 2000ms）", retryAfterMsOf("2") === 2000);
ok("缺失返回 undefined", retryAfterMsOf(null) === undefined);
ok("乱码不炸", retryAfterMsOf("not-a-date") === undefined);

console.log();
console.log("[A] 网关一直挂：必须如实失败");
{
  const store = new EventStore(path.join(TMP, "a"));
  await store.load();
  const created = seedSwarm(store, { id: "retry-dead", agents: ["ana", "bob"] });
  const id = created.swarm.id;
  store.append({ type: "swarm.started", swarmId: id, time: clock() });

  const runner = new AgentRunner({
    store,
    swarmId: id,
    slices: store.getSwarm(id)!.slices,
    /* 9 端口没人监听：连接必然失败（不是超时，是立刻 ECONNREFUSED） */
    brain: new LlmBrain({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "self-check", defaultModel: "x" }),
    maxTurns: 8,
    maxSparkMails: 5,
    tokensPerTurn: 1000,
  });
  const run = await runner.run();

  ok("如实报告 brain-error（不是 all-done）", run.stoppedBy === "brain-error", "实际 " + run.stoppedBy);
  ok("记录了错误原文", run.errors.length > 0, "errors=" + run.errors.length);
  ok("没有落 swarm.completed", of(store, id).filter((e) => e.type === "swarm.completed").length === 0);
  const retries = of(store, id).filter((e) => e.type === "trace.appended" && e.event?.type === "retry");
  ok("重试留下了痕迹（retry 追踪）", retries.length > 0, "retry=" + retries.length);
  const skips = run.report.filter((s) => s.tool === "system");
  ok("失败的那一轮是「跳过」不是「收工」", skips.length > 0, "skips=" + skips.length);
  ok(
    "放弃时才写原因，且写清是连续失败",
    run.finishers.length === 2 && run.finishers.every((f) => f.reason.includes("连续")),
    JSON.stringify(run.finishers.map((f) => f.reason)),
  );
  await store.flush();
}

console.log();
console.log("[B] 网关只抽一下：agent 不该被判死");
{
  class FlakyBrain implements Brain {
    readonly name = "flaky";
    private left: number;
    constructor(times: number) {
      this.left = times;
    }
    async decide(): Promise<DecisionResult> {
      if (this.left > 0) {
        this.left -= 1;
        throw new Error("假装网关抽了一下（503）");
      }
      return { decision: { tool: "done", reason: "自检完成", confirm: "自检" } };
    }
  }

  const store = new EventStore(path.join(TMP, "b"));
  await store.load();
  const created = seedSwarm(store, { id: "retry-flaky", agents: ["zoe"] });
  const id = created.swarm.id;
  store.append({ type: "swarm.started", swarmId: id, time: clock() });

  const runner = new AgentRunner({
    store,
    swarmId: id,
    slices: store.getSwarm(id)!.slices,
    brain: new FlakyBrain(1),
    maxTurns: 6,
    maxSparkMails: 5,
    tokensPerTurn: 1000,
  });
  const run = await runner.run();

  ok("抽一下就恢复 → 照常跑完（all-done）", run.stoppedBy === "all-done", "实际 " + run.stoppedBy);
  ok("抖动被如实记录", run.errors.length === 1, "errors=" + run.errors.length);
  ok(
    "agent 完成了，不是被判死",
    run.finishers.length === 1 && run.finishers[0].reason === "自检完成",
    JSON.stringify(run.finishers),
  );
  await store.flush();
}

await rm(TMP, { recursive: true, force: true });
console.log();
console.log(fail === 0 ? "✅ 重试自检全部通过  （" + pass + " 通过 / 0 失败）" : "❌ 重试自检失败  （" + pass + " 通过 / " + fail + " 失败）");
process.exit(fail === 0 ? 0 : 1);
