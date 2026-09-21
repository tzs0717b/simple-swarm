/* P17/P25：跨代经验 —— 一个集群跑完，把本轮的坑留给下一代。
 *
 * P25（用户口径）：经验 Skill 记的是**开发时的注意点** —— 工具语义、环境限制、权限与路径、
 * 验证纪律、并发协作、提交与收尾。它**不是**某道题的解法（哪个函数怎么改、哪个输入返回什么）。
 *
 * 三层文件，读时按「环境 -> 通用 -> 任务族」合并（越具体越靠前）：
 *   data/skills/env-local.md            本机环境（Termux/Android、Node、python、文件系统、服务）
 *   data/skills/global-development.md   跨任务通用开发纪律（write/edit/read、提交、验收、回滚）
 *   data/skills/skill-<hash>.md         同一任务族的过程协作经验（不含任何解法）
 *
 * 红线：
 *   1) 不许泄题：代码行、题面用例字面量、具体解法一律丢。
 *   2) 不许把上一代的话当事实：注入时标「上一代的说法，不是事实」；系统草稿另标「待验证」。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_SECTIONS = 3;
const MAX_LINES_PER_FILE = 24;

/** 经验按「任务族」分文件：同一份题面 → 同一个 key（不同任务的经验不会互相污染）。 */
export function skillKey(goal: string): string {
  return createHash("sha1").update(goal).digest("hex").slice(0, 10);
}

export function skillsDir(): string {
  return path.join(import.meta.dirname, "..", "..", "data", "skills");
}

/** 本机环境经验：只对本部署成立（Termux/Android、Node、python、本地文件系统），换题目仍然成立。 */
export function envSkillFile(dir: string = skillsDir()): string {
  return path.join(dir, "env-local.md");
}

/** 跨任务通用开发纪律。 */
export function globalSkillFile(dir: string = skillsDir()): string {
  return path.join(dir, "global-development.md");
}

/** 某一任务族的过程协作经验。 */
export function skillFilePath(goal: string, dir: string = skillsDir()): string {
  return path.join(dir, "skill-" + skillKey(goal) + ".md");
}

/** 环境 / 工具类：只对本部署或本工具链成立，但换题目仍然成立。 */
const ENV_WORDS = [
  "write", "edit", "read", "bash", "heredoc", "引号", "换行", "分号", "反斜杠", "转义", "编码",
  "权限", "EACCES", "路径", "目录", "相对路径", "临时文件", "清理", "依赖", "安装", "环境",
  "版本", "node", "python", "pip", "pytest", "服务", "重启", "端口", "日志", "超时", "重试",
  "工具", "命令", "脚本", "文件系统", "android", "termux",
];

/** 通用开发纪律：跨任务、跨环境都该遵守。 */
const GLOBAL_WORDS = [
  "提交", "commit", "git", "备份", "回滚", "恢复", "小步", "验收", "验证", "自检", "量",
  "跑一遍", "跑一次", "重跑", "退步", "警报", "回归", "覆盖", "改动", "复现", "证据",
];

/** 任务族内的过程协作：只进该任务族的文件。 */
const TASK_WORDS = [
  "认领", "切片", "片", "看板", "板", "分工", "协作", "沟通", "邮件", "广播", "同步",
  "交付", "收尾", "交作业", "冲突", "抢", "等待", "对齐", "拆", "并行", "经验", "复盘", "教训",
];

const CODE_LIKE = /(^|\s)(def |import |return |class |lambda |==|!=|\*\*|\/\/|<=|>=)/;

export type SkillBucket = "env" | "global" | "task";

/** 一条经验该进哪一层：环境 -> 通用 -> 任务族；三层都不是就丢掉。 */
export function bucketOf(line: string): SkillBucket | null {
  if (ENV_WORDS.some((word) => line.includes(word))) return "env";
  if (GLOBAL_WORDS.some((word) => line.includes(word))) return "global";
  if (TASK_WORDS.some((word) => line.includes(word))) return "task";
  return null;
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

/** 消毒：代码行、题面指纹、以及三层都不属于的句子一律丢掉。 */
export function sanitizeExperience(text: string, cases: string[]): { kept: string[]; dropped: number } {
  const prints = fingerprints(cases);
  const kept: string[] = [];
  let dropped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.length > 220) { dropped += 1; continue; }
    if (CODE_LIKE.test(line)) { dropped += 1; continue; }
    if (bucketOf(line) === null) { dropped += 1; continue; }
    if (prints.some((piece) => line.includes(piece))) { dropped += 1; continue; }
    kept.push(line);
    if (kept.length >= MAX_LINES_PER_FILE) break;
  }
  return { kept, dropped };
}

/** 收尾整理：整行去重 + 只留最近 MAX_SECTIONS 段 + 每文件限行。
 *  实测教训：经验每轮追加一段、只增不减，10 轮后 prompt 里全是陈年旧账（重复居多）。 */
function trimSkillFile(file: string): void {
  const text = readFileSync(file, "utf8");
  const blocks = text.split(/\n(?=## )/);
  const head = blocks.length > 0 && !blocks[0].startsWith("## ") ? blocks[0].trim() : "";
  const sections = blocks.filter((item) => item.startsWith("## "));
  const seen = new Set<string>();
  const kept: string[] = [];
  let linesUsed = 0;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const parts = sections[i].split("\n");
    const body = parts.slice(1).filter((line) => {
      const key = line.trim();
      if (key.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (body.length > 0 && linesUsed < MAX_LINES_PER_FILE) {
      kept.unshift(parts[0] + "\n" + body.join("\n") + "\n");
      linesUsed += body.length;
    }
    if (kept.length >= MAX_SECTIONS) break;
  }
  writeFileSync(file, head + "\n\n" + kept.join("\n"), "utf8");
}

const FILE_HEAD: Record<SkillBucket, string> = {
  env: "# 本机环境经验（上一代集群写的，机器只做消毒；这是「上一代的说法」，不是事实）\n> 适用范围：本部署（Termux/Android、Node、python3、本地文件系统与工具链）",
  global: "# 跨任务通用开发经验（上一代集群写的，机器只做消毒；这是「上一代的说法」，不是事实）",
  task: "# 本任务族的经验（上一代集群写的，机器只做消毒；这是「上一代的说法」，不是事实）",
};

function targetOf(bucket: SkillBucket, goal: string, dir: string): string {
  if (bucket === "env") return envSkillFile(dir);
  if (bucket === "global") return globalSkillFile(dir);
  return skillFilePath(goal, dir);
}

/** 收下本轮的经验：消毒 → 分三层 → 各自追加去重。 */
export function absorbExperience(input: {
  goal: string;
  workspace: string;
  swarmId: string;
  cases: string[];
  dir?: string;
}): { kept: number; dropped: number; file: string; files: string[] } {
  const dir = input.dir ?? skillsDir();
  /* 两份都要：集群手写的（白名单过得少但最真）+ 系统草稿（保证至少有过程经验）。各标来源，不混。 */
  const wanted: Array<[string, string]> = [
    [path.join(input.workspace, "EXPERIENCE.md"), "集群手写"],
    [path.join(input.workspace, "EXPERIENCE_DRAFT.md"), "系统草稿·待验证"],
  ];
  const grouped = new Map<string, { bucket: SkillBucket; tag: string; lines: string[] }>();
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
    for (const line of one.kept) {
      const bucket = bucketOf(line);
      if (bucket === null) continue;
      const key = bucket + "|" + tag;
      if (!grouped.has(key)) grouped.set(key, { bucket, tag, lines: [] });
      const slot = grouped.get(key);
      if (slot) slot.lines.push(line);
      keptTotal += 1;
    }
  }
  if (grouped.size === 0) return { kept: 0, dropped, file: "", files: [] };
  const written: string[] = [];
  for (const slot of grouped.values()) {
    const file = targetOf(slot.bucket, input.goal, dir);
    mkdirSync(path.dirname(file), { recursive: true });
    const head = existsSync(file) ? "" : FILE_HEAD[slot.bucket] + "\n";
    appendFileSync(file, head + "\n## " + input.swarmId + "（" + slot.tag + "）\n" + slot.lines.map((line) => "- " + line).join("\n") + "\n", "utf8");
    trimSkillFile(file);
    written.push(file);
  }
  return { kept: keptTotal, dropped, file: written[0], files: written };
}

/** 读上一代留下的经验：环境 -> 通用 -> 任务族，合并后按 limit 截断（没有就空串）。 */
export function readSkill(goal: string, limit = 2200, dir: string = skillsDir()): string {
  const layers: Array<[string, string]> = [
    ["本机环境", envSkillFile(dir)],
    ["通用开发", globalSkillFile(dir)],
    ["本任务族", skillFilePath(goal, dir)],
  ];
  const parts: string[] = [];
  for (const [title, file] of layers) {
    if (!existsSync(file)) continue;
    let body = "";
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(">"));
    if (lines.length === 0) continue;
    parts.push("【" + title + "】" + lines.join(" ／ "));
  }
  return parts.join("\n").slice(0, limit);
}

