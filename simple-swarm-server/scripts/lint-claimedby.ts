/* 静态回归闸：claimedBy 是 string（types.ts:125），不许当数组用。
   用户 2026-09-18 亲手抓到：runner.ts 写了 claimedBy[0] -> "pauline"[0] = "p"
   -> 点名催交付全部寄给 p@/a@/r@（不存在的地址）-> agent 照抄 -> 11 封退信 + 催办没送到。
   本文件刻意只用字符串方法，不用正则：这样在任何一层的转义里都不会被搞坏。 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BAD: Array<[string, string]> = [
  ["claimedBy[0]", "claimedBy 是 string，[0] 取到的是首字母（要全名直接用 claimedBy）"],
  ["claimedBy?.[0]", "同上"],
  ["claimedBy.join(", "string 没有 .join（会抛异常）"],
  ["claimedBy.map(", "string 没有 .map"],
  ["claimedBy.filter(", "string 没有 .filter"],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 去掉注释（行内 // 和跨行块注释），保留行号 */
function stripComments(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(String.fromCharCode(10))) {
    let t = raw;
    if (inBlock) {
      const end = t.indexOf("*/");
      if (end < 0) { out.push(""); continue; }
      t = t.slice(end + 2);
      inBlock = false;
    }
    let guard = 0;
    while (guard++ < 10) {
      const open = t.indexOf("/*");
      if (open < 0) break;
      const close = t.indexOf("*/", open + 2);
      if (close < 0) { t = t.slice(0, open); inBlock = true; break; }
      t = t.slice(0, open) + t.slice(close + 2);
    }
    const line = t.indexOf("//");
    if (line >= 0) t = t.slice(0, line);
    out.push(t);
  }
  return out;
}

const NL = String.fromCharCode(10);
let bad = 0;
for (const file of walk("src")) {
  const lines = stripComments(readFileSync(file, "utf8"));
  lines.forEach((line, i) => {
    for (const [needle, why] of BAD) {
      if (line.includes(needle)) {
        console.log("  X " + file + ":" + (i + 1) + "  " + why + NL + "      " + line.trim().slice(0, 110));
        bad++;
      }
    }
  });
}
if (!readFileSync("src/types.ts", "utf8").includes("claimedBy: string;")) {
  console.log("  X types.ts 里 claimedBy 不再是 string —— 请同时审计所有调用点");
  bad++;
}
console.log(bad === 0 ? "  OK claimedBy 用法静态检查通过（0 处违规）" : "  FAIL " + bad + " 处违规");
process.exit(bad === 0 ? 0 : 1);
