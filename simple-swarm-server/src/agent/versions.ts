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

