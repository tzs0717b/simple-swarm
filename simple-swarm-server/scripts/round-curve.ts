/* 一轮的复判仪：把某个集群的每个 git 版本都重跑一遍题面验收，打印分数曲线。
 * 用法：node scripts/round-curve.ts <swarmId> [goalFile]
 * 为什么固化：每轮结论都必须有「逐版本分数」的证据，临时脚本写一次错一次（踩过 cd 跑偏、
 * 引号闭合、@BSN@ 转义这些坑），固化之后每轮一条命令、结论可比。 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseAcceptanceCases, parseTaskEntry } from "../src/agent/versions.ts";
import { runAcceptanceCases } from "../src/agent/tools.ts";

const swarmId = process.argv[2];
if (!swarmId) {
  console.error("用法：node scripts/round-curve.ts <swarmId> [goalFile]");
  process.exit(2);
}
const goalFile = process.argv[3] ?? path.join(os.homedir(), ".dsh", "calc2-goal.txt");
const goal = readFileSync(goalFile, "utf8");
const entry = parseTaskEntry(goal);
const cases = parseAcceptanceCases(goal);
if (entry === null || cases.length === 0) {
  console.error("题面里没有【入口】或验收用例：" + goalFile);
  process.exit(2);
}
const ws = path.join(import.meta.dirname, "..", "workspace", swarmId);
const tmp = path.join(os.homedir(), ".dsh", "curve-" + swarmId);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

let log: string[] = [];
try {
  log = execSync("git log --reverse --format=%h@@%ad@@%s --date=format:%H:%M:%S -- " + entry.file, { cwd: ws, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
} catch (error) {
  console.error("读不到 " + ws + " 的 git 历史：" + String(error).slice(0, 120));
  process.exit(2);
}
console.log("  " + swarmId + "（" + entry.file + "，满分 " + String(cases.length) + "）");
console.log("  版本     时间      分数   谁/干了什么");
let prev = "";
for (const raw of log) {
  const piece = raw.split("@@");
  const message = piece.slice(2).join("@@");
  const source = execSync("git show " + piece[0] + ":" + entry.file, { cwd: ws, encoding: "utf8", maxBuffer: 1 << 22 });
  writeFileSync(path.join(tmp, entry.file), source);
  const report = runAcceptanceCases(tmp, entry, cases);
  const matched = /([0-9]+)\/([0-9]+)/.exec(report.note);
  const score = matched ? matched[1].padStart(2) : " X";
  console.log("  " + piece[0] + "  " + (piece[1] ?? "") + (score === prev ? "   " : " ★ ") + score + "/" + String(cases.length) + "  " + message.slice(0, 40));
  prev = score;
}
const final = runAcceptanceCases(ws, entry, cases);
console.log("  ---- 工作区现状（含未提交）: " + final.note.slice(0, 110));
console.log("  ---- 峰值判断交给报告：上面每个版本的分都是机器重跑的，不是谁的自述。");
rmSync(tmp, { recursive: true, force: true });

