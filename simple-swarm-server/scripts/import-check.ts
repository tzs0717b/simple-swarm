/*
 * 静态扫描：每个源文件里「用到的标识符」是否都有 import 或声明。
 *
 * 为什么有这条规矩（2026-09-19）：我用脚本去重 import 时误删了 llm.ts 的两行、runner.ts 5 个、
 * routes-write.ts 一行 —— 局部 diff 看不出来，直到真跑起来全员第一轮
 * SWARM_NEGOTIATE_BOARD is not defined 才发现，白烧 $1.87。
 * 后来给 board-check.ts 加用例又犯了同一类错（用了 talkFirstPending 却没 import）。
 *
 * 实现要点：扫描前先剥掉注释和字符串字面量 —— 否则注释/文案里出现的 env 名字会全部误报
 * （第一版就报了 9 条假警，包括它自己源码里的正则）。动态 import 的解构
 * （const { genericSlices } = await import(...)）算已声明，不算缺失。
 *
 * 跑法：node scripts/import-check.ts   （失败 exit 1）
 */
import { readFileSync, readdirSync } from "node:fs";

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => dir + "/" + name);
}

/** 剥注释与字符串字面量：剩下的才是「真的在代码里用到」。 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\]|\\.)*"/g, "\"\"")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const NAMES = /\b(SWARM_[A-Z_0-9]+|talkFirstPending|boardHintText|negotiateKickoffText|boardDeadlineReached|boardTimeoutText|genericSlices)\b/g;
const SELF = "scripts/import-check.ts";
const files = tsFiles("src").concat(tsFiles("src/agent"), tsFiles("scripts"));
const problems: string[] = [];

for (const file of files) {
  if (file === SELF) continue;
  const raw = readFileSync(file, "utf8");
  const body = codeOnly(raw).replace(/process\.env\.(SWARM_[A-Z_0-9]+)/g, "ENV_$1");
  const names = new Set<string>();
  for (const m of body.matchAll(NAMES)) names.add(m[1]);
  for (const name of names) {
    if (name === "SWARM_HOME") continue;
    /* 作为对象键出现的（env: { SWARM_ID: ctx.swarmId }）不是标识符用法 */
    if (new RegExp("\\b" + name + "\\s*:").test(body)) continue;
    /* 把所有 import 语句整段抓出来再查名字：原来那句 import[^;]*\bNAME\b[^;]*; 在跨行/多个 import 挨着时会漏（routes-write.ts 就漏了）。 */
    const importText = raw.match(/import[\s\S]*?from\s*"[^"]+";/g)?.join(" ") ?? "";
    const imported = new RegExp("\\b" + name + "\\b").test(importText);
    const declared = new RegExp("(const|let|var|function|class)\\s+" + name + "\\b").test(body);
    const destructured = new RegExp("const\\s*\\{[^}]*\\b" + name + "\\b[^}]*\\}").test(body);
    if (!imported && !declared && !destructured) problems.push(file + " 缺 " + name);
  }
}

if (problems.length > 0) {
  console.log("\u274c 有文件用到了没有 import/声明的标识符：");
  for (const p of problems) console.log("   " + p);
  process.exit(1);
}
console.log("\u2705 import 静态扫描通过（" + String(files.length) + " 个文件，0 处缺失）");
