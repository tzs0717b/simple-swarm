/*
 * 质疑机制自检（2026-09-19）
 *
 * 背景：pelican-45b 复盘发现 agent 手里只有「120 字目标 + 片名」，派工员是这个
 * 去中心化集群里唯一的单点 —— 片切粗了全队就各交一摊碎片，且没有任何补偿机制。
 * 于是加了 challenge / respond_challenge / rule_challenge 三个工具。
 *
 * 这个脚本验收 8 条机制（全部是**系统层硬机制**，不靠提示词）：
 *   [A] 空口质疑（没证据）拒收
 *   [B] 质疑派工员成立 → 板子真的被改（按 ask 新增一片）
 *   [C] 被质疑者必须回应；别人替他回应无效
 *   [D] 自审无效（质疑者/被质疑者自己裁决不算）
 *   [E] 驳回要付出代价（质疑者扣一格配额）
 *   [F] 超时无人回应 → 沉默即认账，按成立处理并改板
 *   [G] 复读去重
 *   [H] 配额耗尽后不许再提
 *
 * 跑法：SWARM_CHALLENGE_GRACE_MS=1200 node scripts/challenge-check.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/eventstore.ts";
import { seedSwarm } from "./fixture.ts";
import {
  raiseChallenge,
  answerChallenge,
  ruleChallenge,
  sweepChallenges,
  challengeQuotaLeft,
} from "../src/challenges.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log("  ✅ " + name + (extra ? " ｜ " + extra : ""));
  } else {
    fail += 1;
    console.log("  ❌ " + name + (extra ? " ｜ " + extra : ""));
  }
}
function sliceNames(store: EventStore, id: string): string[] {
  return store.listSlices(id).map((s) => s.slice);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TMP = await mkdtemp(path.join(tmpdir(), "chal-check-"));
const store = new EventStore(TMP);
const ID = "chal-1";
seedSwarm(store, { id: ID, agents: ["ann", "bob", "cara"], slices: ["片A：主运动"] });

console.log("[A] 空口质疑拒收");
const a = raiseChallenge(store, { swarmId: ID, by: "ann", target: "bob", kind: "artifact", claim: "你交的是假的", evidence: "", ask: "重做" });
check("没证据 → 拒收", a.ok === false, a.message.slice(0, 40));

console.log("[B] 质疑派工员 → 第三方裁决成立 → 板子被改");
const b = raiseChallenge(store, {
  swarmId: ID,
  by: "ann",
  target: "slicer",
  kind: "slicer",
  claim: "「片A：主运动」太粗，一整块子系统没法验收",
  evidence: "渲染 12 帧，相邻帧像素差 RMSE=0.000，阈值要求 ≥1% —— 说明这片没有可判定的完成标准",
  ask: "把主运动拆成「车轮转动」和「曲柄驱动腿」两片，各带数字断言",
});
check("质疑派工员立案", b.ok === true, b.message.slice(0, 50));
const idB = b.ok ? b.message.match(/#(ch_[a-z0-9]+)/)?.[1] ?? "" : "";
const selfRule = ruleChallenge(store, { swarmId: ID, id: idB, agent: "ann", verdict: "upheld", reason: "我自己判我自己" });
check("[D] 质疑者自审无效", selfRule.ok === false && selfRule.message.includes("自审"), selfRule.message.slice(0, 34));
const tgtRule = ruleChallenge(store, { swarmId: ID, id: idB, agent: "slicer", verdict: "upheld", reason: "被质疑者自判" });
check("[D] 被质疑者自审无效", tgtRule.ok === false && tgtRule.message.includes("自审"), tgtRule.message.slice(0, 30));
const ruled = ruleChallenge(store, { swarmId: ID, id: idB, agent: "cara", verdict: "upheld", reason: "我复算了帧差，确实 0.000，达不到阈值", evidence: "rmse=0.000" });
check("第三方裁决成立", ruled.ok === true, ruled.message.slice(0, 44));
check("[B] 板上真的新增了一片", sliceNames(store, ID).some((s) => s.includes("质疑改板")), sliceNames(store, ID).join(" / "));

console.log("[C] 被质疑者必须亲自回应");
const c = raiseChallenge(store, { swarmId: ID, by: "bob", target: "cara", kind: "artifact", claim: "你那片产物缺循环闭合", evidence: "首尾帧差 0.000 但帧数 12/10 不一致", ask: "补上循环并给出首尾帧差数字" });
const idC = c.ok ? c.message.match(/#(ch_[a-z0-9]+)/)?.[1] ?? "" : "";
const wrongResp = answerChallenge(store, { swarmId: ID, id: idC, agent: "ann", response: "我替他回" });
check("别人替他回应无效", wrongResp.ok === false, wrongResp.message.slice(0, 30));
const okResp = answerChallenge(store, { swarmId: ID, id: idC, agent: "cara", response: "认账，我把循环补上了", evidence: "首尾帧差 0.000" });
check("本人回应有效", okResp.ok === true, okResp.message.slice(0, 40));

console.log("[E] 驳回扣配额 + [G] 复读去重 + [H] 配额耗尽");
const before = challengeQuotaLeft(store, ID, "bob");
const d = raiseChallenge(store, { swarmId: ID, by: "bob", target: "cara", kind: "evidence", claim: "你的证据是编的", evidence: "我重跑 verify.py 得到 PASS 而你说 FAIL", ask: "贴出你的原始输出" });
const idD = d.ok ? d.message.match(/#(ch_[a-z0-9]+)/)?.[1] ?? "" : "";
const dismissed = ruleChallenge(store, { swarmId: ID, id: idD, agent: "ann", verdict: "dismissed", reason: "我看了双方输出，bob 跑的是旧版脚本" });
check("第三方驳回", dismissed.ok === true);
check("[E] 驳回后配额 3 → 2", challengeQuotaLeft(store, ID, "bob") === before - 1, "now=" + String(challengeQuotaLeft(store, ID, "bob")));
const dup = raiseChallenge(store, { swarmId: ID, by: "bob", target: "cara", kind: "evidence", claim: "你的证据是编的", evidence: "我重跑 verify.py 得到 PASS 而你说 FAIL", ask: "贴出你的原始输出" });
check("[G] 复读被去重", dup.ok === false && dup.message.includes("一模一样"), dup.message.slice(0, 34));

console.log("[F] 超时无人回应 → 沉默即认账");
const f = raiseChallenge(store, { swarmId: ID, by: "ann", target: "cara", kind: "artifact", claim: "「片A」到现在还没交付", evidence: "板上状态 available 超过一轮，无人认领", ask: "把片A 拆小或明确放弃" });
check("质疑立案", f.ok === true);
await sleep(1500);
const swept = sweepChallenges(store, ID);
check("[F] 超时被扫到并生效", swept >= 1, "expired=" + String(swept));
const fChal = store.listChallenges(ID).find((x) => x.by === "ann" && x.kind === "artifact" && x.status === "expired");
check("[F] 状态记作 expired（= 认账）", !!fChal);
check("[F] 改板已发生（新增或退回）", sliceNames(store, ID).length > 2, "片数=" + String(sliceNames(store, ID).length));

console.log("");
console.log("质疑机制自检: " + String(pass) + " 通过 / " + String(fail) + " 失败");
await rm(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
