/*
 * 静态扫描：每个源文件里「用到的标识符」是否都有 import 或声明。
 *
 * 立这条规矩的直接原因（2026-09-19）：我用脚本去重 import 时误删了 llm.ts 的两行、
 * runner.ts 的 5 个、routes-write.ts 一行 —— 局部 diff 看不出来，直到真跑起来
 * 全员第一轮 SWARM_NEGOTIATE_BOARD is not defined 才发现，白烧 $1.87。
 * 后来给 board-check.ts 加用例又犯了同一类错（用了 talkFirstPending 却没 import）。
 * 所以：改完必须跑这个。
 *
 * 跑法：node scripts/import-check.ts
 */
import { readFileSync, readdirSync } from "node:fs";

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => dir + "/" + name);
}

const files = tsFiles("src").concat(tsFiles("src/agent"), tsFiles("scripts"));
const NAME = /\b(SWARM_[A-Z_0-9]+|talkFirstPending|boardHintText|negotiateKickoffText|boardDeadlineReached|boardTimeoutText|genericSlices)\b/g;
const problems: string[] = [];

for (const file of files) {
  /* 扫描器自己不算：它源码里就是这些名字的正则（第一版扫自己报了 4 条假警）。 */
  if (file === "scripts/import-check.ts") continue;
  const src = readFileSync(file, "utf8");
  const body = src.replace(/process\.env\.(SWARM_[A-Z_0-9]+)/g, "ENV_$1");
  const names = new Set<string>();
  for (const m of body.matchAll(NAME)) names.add(m[1]);
  for (const name of names) {
    if (name === "SWARM_HOME") continue;
    /* 作为对象键出现的（SWARM_ID: ctx.swarmId）不是标识符用法 */
    const asKey = new RegExp("\\b" + name + "\\s*:").test(body);
    const imported = new RegExp("import[^;]*\\b" + name + "\\b[^;]*;", "s").test(src);
    const declared = new RegExp("(const|let|var|function|class)\\s+" + name + "\\b").test(src);
    if (!imported && !declared && !asKey) problems.push(file + " 缺 " + name);
  }
}

if (problems.length > 0) {
  console.log("\u274c 有文件用到了没有 import/声明的标识符：");
  for (const p of problems) console.log("   " + p);
  process.exit(1);
}
console.log("\u2705 import 静态扫描通过（" + String(files.length) + " 个文件，0 处缺失）");
