/* P25 自检：经验 Skill 三层（环境 / 通用 / 任务族）能不能读回来、能不能跨题复用、会不会泄题。
 * 跑法：node scripts/skill-check.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { absorbExperience, readSkill, envSkillFile, globalSkillFile, skillFilePath } from "../src/agent/skills.ts";

const root = path.join(homedir(), ".dsh", "skill-check");
rmSync(root, { recursive: true, force: true });
const dir = path.join(root, "skills");
mkdirSync(dir, { recursive: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (ok) {
    pass += 1;
    console.log("  ✅ " + name);
  } else {
    fail += 1;
    console.log("  ❌ " + name + (extra.length > 0 ? "｜" + extra : ""));
  }
}
function readOr(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
let seq = 0;
function wsWith(exp: string): string {
  seq += 1;
  const ws = path.join(root, "ws-" + String(seq));
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "EXPERIENCE.md"), exp, "utf8");
  return ws;
}

const GOAL_A = "【任务】算 2 的幂；入口 calc.py 暴露 evaluate(text)。\n【验收用例】\nassert evaluate('calc', '2**3') == 8\n";
const GOAL_B = "【任务】完全不同的另一道题；入口 other.py 暴露 evaluate(text)。\n【验收用例】\nassert evaluate('other', '1+1') == 2\n";

const ENV_LINE = "本机 write 原子写会 EACCES，改用 bash heredoc 落盘，写完要 read 确认";
const GLOBAL_LINE = "改完先跑最小验收，最后一次改动必须早于最后一次验收";
const TASK_LINE = "立板前先广播协商，避免多人同时发布同名切片";
const LEAK_LINE = "calc 的 evaluate 遇到 '2**3' 要返回 8";
const CODE_LINE = "def evaluate(text): return 0";

const first = absorbExperience({
  goal: GOAL_A,
  workspace: wsWith([ENV_LINE, GLOBAL_LINE, TASK_LINE, LEAK_LINE, CODE_LINE].map((line) => "- " + line).join("\n")),
  swarmId: "check-r1",
  cases: ["assert evaluate('calc', '2**3') == 8"],
  dir,
});

check("环境经验进 env-local.md", readOr(envSkillFile(dir)).includes("heredoc"));
check("通用纪律进 global-development.md", readOr(globalSkillFile(dir)).includes("最小验收"));
check("任务族经验进 skill-<hash>.md", readOr(skillFilePath(GOAL_A, dir)).includes("广播协商"));
check("解法行被丢掉", !readOr(envSkillFile(dir)).includes("要返回 8") && !readOr(skillFilePath(GOAL_A, dir)).includes("要返回 8"));
check("代码行被丢掉", !readOr(globalSkillFile(dir)).includes("def evaluate"));
check("丢弃计数大于 0", first.dropped >= 2, "dropped=" + String(first.dropped));
check("写入文件数 = 3 层", first.files.length === 3, "files=" + String(first.files.length));

const gotA = readSkill(GOAL_A, 4000, dir);
check("goalA 能读到三层", gotA.includes("heredoc") && gotA.includes("最小验收") && gotA.includes("广播协商"));

const gotB = readSkill(GOAL_B, 4000, dir);
check("换题目仍读到环境经验（跨题复用）", gotB.includes("heredoc"));
check("换题目仍读到通用纪律", gotB.includes("最小验收"));
check("换题目读不到别的任务族经验", !gotB.includes("广播协商"));

absorbExperience({ goal: GOAL_A, workspace: wsWith("- " + TASK_LINE), swarmId: "check-r2", cases: [], dir });
const taskFile = skillFilePath(GOAL_A, dir);
const hit = readOr(taskFile).split("\n").filter((line) => line.includes("广播协商")).length;
check("重复经验会去重", hit <= 1, "出现 " + String(hit) + " 次");

for (let i = 3; i <= 6; i += 1) {
  absorbExperience({ goal: GOAL_A, workspace: wsWith("- 第 " + String(i) + " 轮的切片协作经验，先广播认领再动手"), swarmId: "check-r" + String(i), cases: [], dir });
}
const sections = readOr(taskFile).split("\n").filter((line) => line.startsWith("## ")).length;
check("任务族文件只留最近 3 段", sections <= 3, "段数 " + String(sections));

let leaked = "";
for (const file of [envSkillFile(dir), globalSkillFile(dir), taskFile]) {
  const text = readOr(file);
  if (text.includes("2**3") || text.includes("def evaluate")) leaked = file;
}
check("全目录没有题面字面量 / 代码行", leaked.length === 0, leaked);

console.log("（" + String(pass) + " 通过 / " + String(fail) + " 失败）");
rmSync(root, { recursive: true, force: true });
if (fail > 0) process.exit(1);

