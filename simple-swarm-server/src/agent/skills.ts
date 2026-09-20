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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
    if (prints.some((piece) => line.includes(piece))) { dropped += 1; continue; }
    kept.push(line);
    if (kept.length >= 14) break;
  }
  return { kept, dropped };
}

/** 收下本轮的经验：消毒后追加到任务族的经验文件里。 */
export function absorbExperience(input: {
  goal: string;
  workspace: string;
  swarmId: string;
  cases: string[];
}): { kept: number; dropped: number; file: string } {
  const source = path.join(input.workspace, "EXPERIENCE.md");
  const file = skillFilePath(input.goal);
  if (!existsSync(source)) return { kept: 0, dropped: 0, file };
  let text = "";
  try {
    text = readFileSync(source, "utf8");
  } catch {
    return { kept: 0, dropped: 0, file };
  }
  const { kept, dropped } = sanitizeExperience(text, input.cases);
  if (kept.length === 0) return { kept: 0, dropped, file };
  mkdirSync(path.dirname(file), { recursive: true });
  const header = existsSync(file) ? "" : "# 跨代经验（集群自己写、机器只做消毒；这是「上一代的说法」，不是事实）\n";
  appendFileSync(file, header + "\n## " + input.swarmId + "\n" + kept.map((line) => "- " + line).join("\n") + "\n", "utf8");
  return { kept: kept.length, dropped, file };
}

