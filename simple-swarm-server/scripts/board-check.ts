/*
 * 协商立板自检（2026-09-19）
 * 跑法：node scripts/board-check.ts
 * 验的是「去掉派工员之后，系统自己那部分」——开工广播文案、立板截止判断、空板提示。
 */
import {
  boardDeadlineReached,
  boardHintText,
  boardTimeoutText,
  talkFirstPending,
  negotiateKickoffText,
} from "../src/board.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log("  \u2705 " + name);
  } else {
    fail++;
    console.log("  \u274c " + name);
  }
}

const GOAL = "\u3010\u9898\u76ee\u3011\u8f93\u51fa\u4e00\u6bb5\u4fe1\u5965 C++ \u4ee3\u7801\uff0c\u6c42\u7ed9\u5b9a\u6570\u5b57\u4e32\u63d2 K \u4e2a\u4e58\u53f7\u7684\u6700\u5927\u4e58\u79ef\u3002";
const k = negotiateKickoffText("demo", 4, 270000, GOAL);

console.log("=== \u5f00\u5de5\u5e7f\u64ad\uff08\u6ce8\u5165\u5230\u6bcf\u4e2a\u4eba\u624b\u91cc\u7684\u90a3\u6bb5\u8bdd\uff09===");
ok(k.includes(GOAL), "\u5e7f\u64ad\u91cc\u5e26\u5b8c\u6574\u9898\u76ee\uff08\u4e0d\u622a\u65ad\uff09");
ok(k.includes("4 \u4e2a\u4eba"), "\u5e7f\u64ad\u91cc\u5e26\u4eba\u6570");
ok(k.includes("5 \u5206\u949f"), "\u5e7f\u64ad\u91cc\u5e26\u7acb\u677f\u7a97\u53e3\uff08270s \u2192 5 \u5206\u949f\uff09");
ok(k.includes("publish_slice") && k.includes("send_mail"), "\u5e7f\u64ad\u6559\u4e86\u5de5\u5177\u600e\u4e48\u7528");
ok(k.includes("并行优先") && k.includes("合成一片") && k.includes("多人同干一片"), "广播教并行优先 + 串行链合成一片 + 允许多人同干（旧的三类必备片教条已废）");
ok(k.includes("主导") && k.includes("多人同干一片"), "广播既划主导负责人边界、又允许硬骨头协作（旧的禁止重复劳动教条已废）");
ok(!/SVG|svg|\u8f66\u8f6e|\u9e48\u9e49|\u90e8\u4ef6/.test(k), "\u5e7f\u64ad\u4e0d\u542b\u4efb\u4f55\u5199\u6b7b\u7684\u4efb\u52a1\u7c7b\u578b");

console.log("=== \u7acb\u677f\u622a\u6b62\u5224\u65ad ===");
ok(boardDeadlineReached(269999, 900000, 0.3) === false, "\u672a\u5230 30% \u4e0d\u515c\u5e95");
ok(boardDeadlineReached(270000, 900000, 0.3) === true, "\u5230 30% \u5373\u515c\u5e95");
ok(boardDeadlineReached(999999, 0, 0.3) === false, "\u6ca1\u6709\u5899\u949f\uff08budget=0\uff09\u4e0d\u515c\u5e95");

console.log("=== \u7a7a\u677f\u63d0\u793a / \u8d85\u65f6\u6587\u6848 ===");
ok(boardHintText(0).includes("\u7acb\u677f"), "\u63d0\u793a\u91cc\u53eb\u4eba\u5148\u7acb\u677f");
ok(boardHintText(600000).includes("10 \u5206\u949f"), "\u63d0\u793a\u91cc\u5e26\u5269\u4f59\u65f6\u95f4");
ok(boardTimeoutText(11).includes("11"), "\u8d85\u65f6\u6587\u6848\u5e26\u7247\u6570");
ok(!/SVG|svg|\u8f66\u8f6e|\u9e48\u9e49/.test(boardHintText(300000) + boardTimeoutText(11)), "\u63d0\u793a/\u8d85\u65f6\u90fd\u6ca1\u6709\u4efb\u52a1\u5047\u8bbe");

console.log("");
console.log("=== 先商量再挂片（talkFirstPending）===");
ok(talkFirstPending(["a","b","c","d"], ["a","b","c","d"], false, true).length === 0, "四人都说过 -> 放行");
ok(talkFirstPending(["a","b","c","d"], ["a"], false, true).length === 3, "只有一人说过 -> 还挡 3 人");
ok(talkFirstPending(["a","b","c","d"], [], false, true).length === 4, "没人说过 -> 挡 4 人");
ok(talkFirstPending(["a","b"], [], true, true).length === 0, "板已有片 -> 门自动失效（兜底不会死锁）");
ok(talkFirstPending(["a","b"], [], false, false).length === 0, "开关关掉 -> 不挡");
console.log("\uff08" + String(pass) + " \u901a\u8fc7 / " + String(fail) + " \u5931\u8d25\uff09");
process.exit(fail === 0 ? 0 : 1);
