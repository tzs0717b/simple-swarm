/* P17：跨代经验 —— 一个集群跑完，把本轮的坑留给下一代。
 *
 * 素材都来自四轮实测（机器可查的血案，且都不泄题）：
 *   - r4：每改一处就调 check_acceptance → 零退步；r1/r2：收尾前 24 秒盲改 → 一个字符砸坏 / 57 砸到 44。
 *   - 多处 write: 写入 calc.py（6xxx 字符）= 整份覆盖别人的版本。
 *
 * 两条设计红线：
 *   1) 不许泄题：题面自带用例里的字面量、以及代码行，入库前一律丢掉（sanitizeExperience）。
 *   2) 不许把上一代的话当事实：注入时明确标注「这是上一代的说法，不是事实」。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 经验按「任务族」分文件：同一份题面 → 同一个 key（不同任务的经验不会互相污染）。 */
export function skillKey(goal: string): string {
  return createHash("sha1").update(goal).digest("hex").slice(0, 10);
}

export function skillFilePath(goal: string): string {
  return path.join(import.meta.dirname, "..", "..", "data", "skills", "skill-" + skillKey(goal) + ".md");
}

/** 读上一代留下的经验（没有就空串）。 */
export function readSkill(goal: string, limit = 1500): string {
  const file = skillFilePath(goal);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").slice(0, limit);
  } catch {
    return "";
  }
}

/** 从题面用例里抽出「字面量指纹」——经验行只要碰到它，就说明在往题面上抄答案。 */
function fingerprints(cases: string[]): string[] {
  const found = new Set<string>();
  for (const line of cases) {
    for (const piece of line.match(/[^'\s]{2,}/g) ?? []) {
      const cjk = /[^\x00-\x7F]/.test(piece);
      if (!cjk && piece.length < 4) continue;
      if (!cjk && !/[0-9]/.test(piece) && !/[^A-Za-z0-9_]/.test(piece)) continue;
      found.add(piece);
    }
  }
  return [...found];
}

/* P19：白名单比黑名单靠谱。
 * 实测（calc2-r6）：集群写的复盘里「函数参数里要用 self._expr() 而不是 self.expr()」这种
 * 就是**解法本身** —— 黑名单（代码行 / 题面字面量）没拦住它，因为它既不像代码行、也不含用例字面量。
 * 所以改成：只让**过程 / 协作 / 工具**主题的句子过（含下面这些词之一），其余一律丢。
 * 代价是具体技术细节进不来 —— 但那正是会泄题的部分，本来就不该进。 */
const PROCESS_WORDS = [
  "验收", "验证", "自检", "量", "跑一遍", "跑一次", "重跑", "退步", "警报", "回滚", "恢复", "回归",
  "改", "提交", "commit", "git", "覆盖", "write", "edit", "read", "备份", "回退", "小步",
  "认领", "片", "板", "分工", "协作", "沟通", "邮件", "广播", "同步", "交付", "收尾", "交作业",
  "对齐", "拆", "并行", "冲突", "抢", "等待", "超时", "挂", "经验", "工具", "教训", "复盘",
];

const CODE_LIKE = /(^|\s)(def |import |return |class |lambda |==|!=|\*\*|\/\/|<=|>=)/;

/** 消毒：只认「过程 / 协作 / 工具」经验；代码行和题面指纹一律丢掉。 */
export function sanitizeExperience(text: string, cases: string[]): { kept: string[]; dropped: number } {
  const prints = fingerprints(cases);
  const kept: string[] = [];
  let dropped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.length > 220) { dropped += 1; continue; }
    if (CODE_LIKE.test(line)) { dropped += 1; continue; }
    if (!PROCESS_WORDS.some((word) => line.includes(word))) { dropped += 1; continue; }
    if (prints.some((piece) => line.includes(piece))) { dropped += 1; continue; }
    kept.push(line);
    if (kept.length >= 14) break;
  }
  return { kept, dropped };
}

/** 收下本轮的经验：消毒后追加到任务族的经验文件里。 */
/** 收尾整理：整行去重 + 只留最近 3 段。
 *  实测教训：经验每轮追加 2 段、只增不减，10 轮后 prompt 里塞满陈年旧账（重复的还居多）。 */
function trimSkillFile(file: string): void {
  const text = readFileSync(file, "utf8");
  const blocks = text.split(/\n(?=## )/);
  const head = blocks.length > 0 && !blocks[0].startsWith("## ") ? blocks[0].trim() : "";
  const sections = blocks.filter((item) => item.startsWith("## "));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const lines = sections[i].split("\n");
    const body = lines.slice(1).filter((line) => {
      const key = line.trim();
      if (key.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (body.length > 0) kept.unshift(lines[0] + "\n" + body.join("\n") + "\n");
    if (kept.length >= 3) break;
  }
  const headText = head.length > 0 ? head + "\n" : "# 跨代经验（集群自己写、机器只做消毒；这是「上一代的说法」，不是事实）\n";
  writeFileSync(file, headText + "\n" + kept.join("\n"), "utf8");
}
export function absorbExperience(input: {
  goal: string;
  workspace: string;
  swarmId: string;
  cases: string[];
}): { kept: number; dropped: number; file: string; source: string } {
  const file = skillFilePath(input.goal);
  /* 两份都要：集群手写的（白名单过得少但最真）+ 系统草稿（保证至少有过程经验）。
   * 实测 calc2-r6：集群手写的那份里「函数参数要用 self._expr()」就是解法 —— 白名单把它丢了，
   * 但那份里能过的也就剩沟通那一条；草稿那五条才是稳定有营养的部分。各标来源，不混。 */
  const wanted: Array<[string, string]> = [
    [path.join(input.workspace, "EXPERIENCE.md"), "集群手写"],
    [path.join(input.workspace, "EXPERIENCE_DRAFT.md"), "系统草稿"],
  ];
  const parts: string[] = [];
  const tags: string[] = [];
  let keptTotal = 0;
  let dropped = 0;
  for (const [source, tag] of wanted) {
    if (!existsSync(source)) continue;
    let text = "";
    try {
      text = readFileSync(source, "utf8");
    } catch {
      continue;
    }
    const one = sanitizeExperience(text, input.cases);
    dropped += one.dropped;
    if (one.kept.length === 0) continue;
    keptTotal += one.kept.length;
    parts.push("## " + input.swarmId + "（" + tag + "）\n" + one.kept.map((line) => "- " + line).join("\n"));
    tags.push(tag);
  }
  if (parts.length === 0) return { kept: 0, dropped, file, source: "" };
  mkdirSync(path.dirname(file), { recursive: true });
  const header = existsSync(file) ? "" : "# 跨代经验（集群自己写、机器只做消毒；这是「上一代的说法」，不是事实）\n";
  appendFileSync(file, header + "\n" + parts.join("\n") + "\n", "utf8");
  trimSkillFile(file);
  return { kept: keptTotal, dropped, file, source: tags.join("+") };
}

