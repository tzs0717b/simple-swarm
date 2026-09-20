/*
 * 文件版本 / 换手（M12-P2）
 *
 * 工作区是 git 仓库、系统每步自动提交（M12-P1）。这里放的是**纯函数**：
 * 谁该被通知、通知里说什么、现场提示里怎么讲版本。抽出来是为了能单测（scripts/git-check.ts）。
 *
 * 为什么需要「换手播报」：实测 agent 多数用 `cat > p2482.cpp << 'CPPEOF'` 这样写文件，
 * 覆盖别人的实现毫无痕迹、也没人知道自己的版本被谁顶掉了（B2/B10）。git 给了版本号，
 * 但还得有人把这件事**说出口** —— 这正是系统该干的活（去中心化：不做裁判，只做广播）。
 */
import type { FileInfo } from "../eventstore.ts";

export interface Handoff {
  path: string;
  prevAgent: string;
  prevCommit: string;
  agent: string;
}

/**
 * 换手 = 这一版动了别人的文件。
 * - 新文件（before 里没有）不算换手；
 * - 一直是自己在写也不算。
 */
export function detectHandoffs(
  before: FileInfo[],
  changed: { path: string }[],
  agent: string,
): Handoff[] {
  const byPath = new Map<string, FileInfo>();
  for (const file of before) byPath.set(file.path, file);
  const out: Handoff[] = [];
  for (const change of changed) {
    const prev = byPath.get(change.path);
    if (!prev || !prev.lastAgent) continue;
    if (prev.lastAgent === agent) continue;
    out.push({
      path: change.path,
      prevAgent: prev.lastAgent,
      prevCommit: prev.lastCommit,
      agent,
    });
  }
  return out;
}

/** 换手通知的文案（点对点发给"上一版作者"）。 */
export function handoffMailText(handoff: Handoff): { subject: string; body: string } {
  const rev = handoff.prevCommit || "HEAD";
  return {
    subject: "【文件换手】" + handoff.path + " 被 " + handoff.agent + " 改过了",
    body: [
      handoff.path + " 刚被 " + handoff.agent + " 写过，工作区里现在是他那份。",
      "你那版没丢，随时能拿回来（工作区是 git 仓库，每步都提交过）：",
      "  取回自己那版： git show " + rev + ":" + handoff.path + " > " + handoff.path,
      "  先看差了什么： git diff " + rev + " HEAD -- " + handoff.path,
      "如果他那版更好，就不用管这封；如果该以你那版为准，取回来之后在广播里说一声（别闷头改回去）。",
    ].join("\n"),
  };
}

/** 现场提示里的「文件版本」若干行（只讲和这个人相关的）。 */
export function fileVersionLines(files: FileInfo[], agent: string, limit = 6): string[] {
  const lines: string[] = [];
  for (const file of files.slice(0, limit)) {
    const mine = file.commits.filter((commit) => commit.agent === agent);
    const lastMine = mine.length > 0 ? mine[mine.length - 1] : undefined;
    const others = file.writers.filter((writer) => writer.agent !== agent);
    const othersCount = others.reduce((sum, writer) => sum + writer.count, 0);
    const parts: string[] = [];
    parts.push(
      mine.length > 0
        ? "你写过 " + String(mine.length) + " 次（你那版 " + (lastMine ? lastMine.commit : "?") + "）"
        : "你没写过",
    );
    parts.push(
      othersCount > 0
        ? "别人动过 " + String(othersCount) + " 次（最新是 " + file.lastAgent + " 的 " + file.lastCommit + "）"
        : "没有别人动过",
    );
    lines.push(file.path + "：" + parts.join("；"));
  }
  return lines;
}

export interface AutoShipInput {
  slice: string;
  claimers: string[];
  files: FileInfo[];
  checkOk: boolean;
  checkNote: string;
}

/**
 * 收口兜底的交付证据（B3）。
 * 两轮实测：产物明明能编译、测试脚本也真跑起来了，但**没有 agent 调用 complete_slice** —— 交付率 0。
 * 半成品 + 说清边界 > 零产出，所以墙钟最后一截由系统按现状入账，并把当时的工作区状态写进证据。
 */
export function autoShipEvidence(input: AutoShipInput): string {
  const lines: string[] = [];
  lines.push("【系统自动交付】墙钟到点，认领人没有调用 complete_slice —— 系统按现状入账（未经 agent 确认）。");
  lines.push("认领人：" + (input.claimers.length > 0 ? input.claimers.join("、") : "（无人认领）"));
  if (input.files.length > 0) {
    lines.push("工作区文件 " + String(input.files.length) + " 个（最后写者 + 版本号）：");
    for (const file of input.files.slice(0, 8)) {
      lines.push("  " + file.path + " ← " + (file.lastAgent || "?") + " " + (file.lastCommit || "?"));
    }
    if (input.files.length > 8) lines.push("  …还有 " + String(input.files.length - 8) + " 个");
  } else {
    lines.push("工作区没有任何留档文件（这一片没有产出）。");
  }
  const note = input.checkNote.length > 220 ? input.checkNote.slice(0, 220) + "…" : input.checkNote;
  lines.push(input.checkOk ? "验收脚本：通过 " + note : "验收脚本：未通过 / 未跑 -> " + (note || "（工作区里没有验收脚本）"));
  return lines.join("\n");
}

/** 刚跑绿的验收（P5）：bash + 退出码 0 + 命令看着像验收 -> 现在就是交付的时机。 */
/** 光看不跑的段（列目录、打印文件、看 git 历史）永远不算验收。 */
const LOOK_ONLY = /^(ls|cat|echo|cd|pwd|head|tail|wc|find|grep|sed|awk|file|stat|tree|true|printf|which|env|date|whoami|git show|git log|git status|git diff --stat|export|set)( |$)/;
/** 真的把东西跑起来的段。 */
const RUN_LIKE = /g[+][+]|gcc|clang|python|pytest|node|make|cargo|go run|cmp|diff|check|verify|[.]sh|对拍|样例|复检|验收|assert/i;

/**
 * 「验收跑绿」判定（P8 收紧）。
 * 2026-09-19 实测：上一版只看 detail 里有没有 test/check 字样，于是
 *   $ ls -la && echo "---" && cat test_script.py 2>/dev/null | head   → 退出码 0
 * 被误判成「验收跑绿」，系统还去点名催交付 —— 假信号污染了交付时机提示。
 * 现在按 **命令段** 判：必须有一段真的把东西跑起来（编译/执行/对拍/diff），
 * 纯 ls/cat/echo/git show 不算。注意 git show 是取版本，不是验收。
 */
export function looksLikeGreenCheck(tool: string, detail: string): boolean {
  if (tool !== "bash") return false;
  if (!/退出码 0/.test(detail)) return false;
  const m = /[$>] *([^→]*)→ *退出码 *0/.exec(detail);
  const cmd = m ? m[1] : detail;
  return cmd.split(/&&|;|[|][|]/).some((seg) => {
    const one = seg.trim();
    if (one.length === 0) return false;
    if (LOOK_ONLY.test(one)) return false;
    if (one.startsWith("./")) return true;
    return RUN_LIKE.test(one);
  });
}

/**
 * 挂死判定（P10-a）：被强杀的退出码（124=超时，137=SIGKILL，143=SIGTERM）。
 * 实测 p2482-p9：三个 agent 都看到过「退出码 124（30032ms）」，可系统这边它只是一条普通
 * 观察 —— 不点名、不记账、不进交接班提醒。跑一个程序 30 秒被强杀，本该是红灯。
 */
export function looksLikeHang(tool: string, detail: string): boolean {
  if (tool !== "bash") return false;
  if (/被强杀/.test(detail)) return true;
  return /退出码 (124|137|143)/.test(detail);
}

/**
 * 验收脚本「嘴上说失败、退出码却是 0」的判定（P10-b）。
 * 实测 p2482-p9 的 test_script.py：对不上只 print(测试用例 N 失败)，从不非零退出，而系统的
 * 验收闸只看退出码 —— 于是「对不上」被判成「验收闸通过」。
 */
export function acceptanceLooksFailed(output: string): boolean {
  return /失败|FAIL|failed|❌|Traceback|AssertionError|assert/i.test(output);
}

/** 收工体检里的「挂死」一行（P10-a）：没人挂过就返回空串。 */
export function hangNotice(count: number, lastAt: string, lastAgent: string): string {
  if (count === 0) return "";
  return "本轮有 " + String(count) + " 次「跑挂死」（最近一次 " + lastAt + " 由 " + lastAgent + " 触发，被 30 秒强杀）";
}

/** 题面里的样例（P11-b）：系统自己知道标准答案，才谈得上独立判对错。 */
export interface TaskSample {
  input: string;
  expected: string;
}

/**
 * 从题面里抽【样例输入】/【样例输出】。抽不到就返回 null —— 没有样例的题目，机器不假装
 * 自己会判（只说「没法替你判」）。
 */
export function parseTaskSample(goal: string): TaskSample | null {
  const IN = "【样例输入】";
  const OUT = "【样例输出】";
  const i = goal.indexOf(IN);
  if (i < 0) return null;
  const j = goal.indexOf(OUT, i);
  if (j < 0) return null;
  const input = goal.slice(i + IN.length, j).trim();
  const rest = goal.slice(j + OUT.length);
  const stop = rest.indexOf("【");
  const expected = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  if (input.length === 0 || expected.length === 0) return null;
  return { input, expected };
}

/** 样例对比：忽略行尾空格与首尾空行（做题最常见的假失败）。 */
export function sampleMatches(actual: string, expected: string): boolean {
  const norm = (text: string): string => text.replace(/[ ]+$/gm, "").trim();
  return norm(actual) === norm(expected);
}

/**
 * 最终体检结论（P8）：把「最后一次验收跑绿的版本」和「最终版本」摆在一起。
 * 实测 p2482-p4：交付发生在 90%，之后 agent 还在改主产物，最后一次改动甚至落在
 * 墙钟结束之后 —— 于是「证据看着是真的、产物却是坏的」。这里把它明说出来。
 */
export function verifiedVerdict(finalSha: string, greenSha: string, greenAt: string): string {
  if (!greenSha) return "本轮系统从没见过一次「验收跑绿」—— 最终版本 " + finalSha + " 是未经验收的。";
  if (greenSha === finalSha) return "最终版本 " + finalSha + " 就是最后一次验收跑绿的版本（" + greenAt + "）。";
  return "最终版本 " + finalSha + " 在最后一次验收（" + greenAt + "，版本 " + greenSha + "）之后又被改动过 —— 现在这个产物是未经验收的。";
}

/**
 * 现场提示里的「你已经可以交付了」那一行（P5）。
 * 2026-09-19 实测：76 次调用里 complete_slice 被调用 **0 次** —— 不是不敢交，
 * 是干着干着忘了「交付」这个动作存在。所以在这两个时刻把它摆到眼前：
 * ① 有产出时（这里）；② 刚把验收跑绿时（runner 的绿跑点名）。
 */
export function deliverReadyLine(claim: string, files: FileInfo[], agent: string): string {
  const mine = files.filter((file) => file.commits.some((commit) => commit.agent === agent));
  if (mine.length === 0 || !claim || claim === "（还没认领）") return "";
  const newestMine = mine[0];
  const myCommits = newestMine.commits.filter((commit) => commit.agent === agent);
  const sha = myCommits.length > 0 ? myCommits[myCommits.length - 1].commit : "?";
  return (
    "- 你认领的「" + claim + "」已经有产出了（" + newestMine.path + " 你写过 " + String(myCommits.length) +
    " 次，你那版 " + sha + "）。**只要它现在能跑，就交付**：" +
    'complete_slice(slice="' + claim + '", evidence="做完了：…｜怎么验的：<把命令和输出里的数字原样贴上>｜没做完：…")。' +
    "交了的片才算产出；没交的，复盘里等于零。"
  );
}

/**
 * 空转 / 哑火时的具体指令（P6）。
 * 2026-09-19 实测（p2482-p3）：jeanette 15 分钟里 0 认领、0 文件、0 邮件 —— 全程在旁边看；
 * bill 两次「模型没有调用任何工具」。这两种状态讲道理没用，只能把**下一步那一个动作**塞到脸上。
 */
export function idleNudgeBody(freeSlices: string[], hasClaim: boolean, filesTouched: number, agent: string): string {
  if (!hasClaim && freeSlices.length > 0) {
    return (
      agent + "：你到现在**还没有认领任何切片**。板上还没人接的有：" + freeSlices.slice(0, 3).join("、") + "。" +
      "现在就调 claim_slice 接一片（接完可以接着接第二片），别再读了。"
    );
  }
  if (!hasClaim) {
    return (
      agent + "：板上没有空片了。两条路，随便挑一条立刻做：" +
      "① claim_slice 加入一片正在干的（同一片多人同干是系统鼓励的协作）；" +
      "② publish_slice 立一片新的（把缺的验收 / 对拍 / 边界用例接过来）。"
    );
  }
  if (filesTouched === 0) {
    return (
      agent + "：你认领了切片，但工作区里**还没有任何属于你的产出**。" +
      "现在就动手写第一个文件或跑第一条命令（系统每步都会自动提交并署你的名，写坏了也能取回）。" +
      "验收一跑绿就 complete_slice 交付。"
    );
  }
  return agent + "：你已经有产出但还没交付。把手上这片收口：跑一次验收，然后 complete_slice。";
}

/** 连续几次「模型没有调用任何工具」之后才点名（P6）。 */
export const NO_TOOL_STREAK_LIMIT = 2;

