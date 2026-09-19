/*
 * 工作区版本留档（git）—— M12
 *
 * 为什么是 git 而不是「文件名加后缀」：后缀靠模型自觉（实测 B2 被 bash heredoc 一绕就废），
 * git 由**系统侧每步提交**，agent 用什么通道写文件都跑不掉（B10 的正解）。
 *
 * 设计要点：
 * - 一个分支（main）线性历史：不需要谁来做 merge（那会变成变相经理）。
 * - 二进制/超大文件不进库（实测一个工作区 168K 里 142K 是编译产物）。
 * - 工作区外的影子裸仓库（gitrepos/<id>.git）：agent rm -rf .git 也删不掉历史。
 * - 所有函数**永不抛**：留档失败只是少一条记录，绝不能打断跑。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "../config.ts";
import { workspaceOf } from "./workspace.ts";

/** 工作区外的影子仓库根：与工作区同级，agent 的工作目录里看不到它 */
export const GIT_MIRROR_ROOT = path.resolve(
  process.env.SWARM_GIT_MIRROR ?? path.join(WORKSPACE_ROOT, "..", "gitrepos"),
);

/** 超过这个大小的文件不进库（二进制/数据集会把历史撑爆） */
const MAX_BLOB_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 20000;
const UNIT = String.fromCharCode(31);

export interface GitChange {
  path: string;
  bytes: number;
}

export interface GitCommitResult {
  commit: string;
  changed: GitChange[];
  skipped: string[];
}

export interface GitHistoryEntry {
  commit: string;
  agent: string;
  subject: string;
  time: string;
}

interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

/** 跑一条 git 命令；永远不抛。 */
function git(cwd: string, args: string[]): GitRun {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: String(out), err: "" };
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message?: string };
    const err = e.stderr ? String(e.stderr) : e.message ?? "";
    return { ok: false, out: "", err: err.trim().slice(0, 300) };
  }
}

function mirrorOf(swarmId: string): string {
  return path.join(GIT_MIRROR_ROOT, swarmId + ".git");
}

function repoReady(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

const GITIGNORE_SEED = [
  "# 系统自动生成：编译产物 / 临时文件不进版本库",
  "*.o",
  "*.out",
  "*.exe",
  "*.class",
  "*.pyc",
  "__pycache__/",
  "node_modules/",
  "bin/",
  "obj/",
  "",
].join("\n");

/** 原始题面（不改写、不加工）；规格/合同仍然不进仓库（闭卷） */
export const TASK_FILE = "TASK.md";

/** 把某条路径永久排除出版本库（不然每一步都会因为它「脏」而反复提交）。 */
function ignorePathOnce(dir: string, rel: string): void {
  try {
    const ignorePath = path.join(dir, ".gitignore");
    const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : GITIGNORE_SEED;
    const line = "/" + rel.replace(/^\.\//, "");
    const already = current.split("\n").some((l) => l.trim() === line || l.trim() === rel);
    if (already) return;
    appendFileSync(ignorePath, (current.endsWith("\n") ? "" : "\n") + line + "\n", "utf8");
  } catch {
    /* 忽略失败无所谓 */
  }
}

/** 把历史推到工作区外的影子仓库（本地推送，毫秒级）。 */
function pushMirror(swarmId: string): void {
  try {
    const mirror = mirrorOf(swarmId);
    if (!existsSync(mirror)) {
      mkdirSync(path.dirname(mirror), { recursive: true });
      const init = git(path.dirname(mirror), ["init", "--bare", "-q", "-b", "main", mirror]);
      if (!init.ok) return;
    }
    git(workspaceOf(swarmId), ["push", "-q", mirror, "main"]);
  } catch {
    /* 影子仓库丢了不影响主流程 */
  }
}

/**
 * 建仓（幂等）。taskText 只在第一次写入 TASK.md。
 * .git 不见了也能从影子仓库把历史和工作区一起恢复回来。
 */
export function ensureRepo(swarmId: string, taskText?: string): boolean {
  try {
    const dir = workspaceOf(swarmId);
    if (!repoReady(dir)) {
      const init = git(dir, ["init", "-q", "-b", "main"]);
      if (!init.ok) return false;
      git(dir, ["config", "user.name", "swarm"]);
      git(dir, ["config", "user.email", "swarm@local"]);
      const mirror = mirrorOf(swarmId);
      if (existsSync(mirror)) {
        const fetched = git(dir, ["fetch", "-q", mirror, "main"]);
        if (fetched.ok) git(dir, ["reset", "-q", "--hard", "FETCH_HEAD"]);
      }
    }
    const ignorePath = path.join(dir, ".gitignore");
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, GITIGNORE_SEED, "utf8");
    if (taskText && taskText.trim() && !existsSync(path.join(dir, TASK_FILE))) {
      writeFileSync(path.join(dir, TASK_FILE), taskText.trim() + "\n", "utf8");
    }
    return repoReady(dir);
  } catch {
    return false;
  }
}

/**
 * 每步之后提交一次（工作区脏了才提交）。返回 null = 没有变化 / 失败。
 * 归因靠的是**工作区 diff**，所以 bash heredoc 写的文件也算数（B10）。
 */
export function commitStep(
  swarmId: string,
  agent: string,
  tool: string,
  detail: string,
  taskText?: string,
): GitCommitResult | null {
  try {
    if (!ensureRepo(swarmId, taskText)) return null;
    const dir = workspaceOf(swarmId);
    /* 绝大多数步（思考/读信/广播）工作区根本没动：一次 git status 就结束，省时间 */
    const dirtyFirst = git(dir, ["status", "--porcelain"]);
    if (!dirtyFirst.ok || !dirtyFirst.out.trim()) return null;
    const staged = git(dir, ["add", "-A", "--", "."]);
    if (!staged.ok) return null;

    const skipped: string[] = [];
    const numstat = git(dir, ["diff", "--cached", "--numstat"]);
    if (numstat.ok) {
      for (const line of numstat.out.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const rel = parts.slice(2).join("\t");
        const binary = parts[0].trim() === "-";
        let big = false;
        try {
          big = statSync(path.join(dir, rel)).size > MAX_BLOB_BYTES;
        } catch {
          big = false;
        }
        if (!binary && !big) continue;
        git(dir, ["reset", "-q", "--", rel]);
        skipped.push(rel);
        ignorePathOnce(dir, rel);
      }
    }
    if (skipped.length > 0) git(dir, ["add", "-A", "--", ".gitignore"]);

    const dirty = git(dir, ["status", "--porcelain"]);
    if (!dirty.ok || !dirty.out.trim()) return null;

    const message = "[" + agent + "] " + tool + (detail ? ": " + detail.slice(0, 120) : "");
    /* 作者 = 这个 agent（不是仓库默认的 swarm）：谁干的活，git log 里就署谁的名 */
    const committed = git(dir, [
      "-c",
      "user.name=" + agent,
      "-c",
      "user.email=" + agent + "@swarm.local",
      "commit",
      "-q",
      "-m",
      message,
    ]);
    if (!committed.ok) return null;

    const sha = git(dir, ["rev-parse", "--short", "HEAD"]);
    const names = git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"]);
    const changed: GitChange[] = [];
    for (const raw of names.out.split("\n")) {
      const rel = raw.trim();
      if (!rel) continue;
      let bytes = 0;
      try {
        bytes = statSync(path.join(dir, rel)).size;
      } catch {
        bytes = 0;
      }
      changed.push({ path: rel, bytes });
    }
    pushMirror(swarmId);
    return { commit: sha.ok ? sha.out.trim() : "", changed, skipped };
  } catch {
    return null;
  }
}

/** 某个文件的历史（最新在前）。 */
export function fileHistory(swarmId: string, filePath: string, limit = 10): GitHistoryEntry[] {
  try {
    const dir = workspaceOf(swarmId);
    if (!repoReady(dir)) return [];
    const n = String(Math.max(1, Math.min(50, limit)));
    const res = git(dir, [
      "log",
      "-n",
      n,
      "--pretty=format:%h" + UNIT + "%an" + UNIT + "%s" + UNIT + "%ad",
      "--date=iso-strict",
      "--",
      filePath,
    ]);
    if (!res.ok || !res.out.trim()) return [];
    return res.out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(UNIT);
        return {
          commit: parts[0] ?? "",
          agent: parts[1] ?? "",
          subject: parts[2] ?? "",
          time: parts[3] ?? "",
        };
      });
  } catch {
    return [];
  }
}

/** 工作区当前 HEAD 的短 sha（交付证据用）。 */
export function headSha(swarmId: string): string {
  try {
    const dir = workspaceOf(swarmId);
    if (!repoReady(dir)) return "";
    const res = git(dir, ["rev-parse", "--short", "HEAD"]);
    return res.ok ? res.out.trim() : "";
  } catch {
    return "";
  }
}

/** 工作区里被 git 跟踪的文件清单。 */
export function trackedFiles(swarmId: string): string[] {
  try {
    const dir = workspaceOf(swarmId);
    if (!repoReady(dir)) return [];
    const res = git(dir, ["ls-files"]);
    return res.ok ? res.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

