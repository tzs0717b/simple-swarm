/*
 * 线程构造工具（M3.4）。
 *
 * 房间语义：
 *   public  —— 公开房间，成员是该话题的参与者
 *   private —— 私信房间，**正好 2 个成员**，天然隔离
 *
 * 私信的房间 id 由两人名字排序拼成，因此同一个组合永远复用同一个房间（幂等）：
 *   dm-human-peliscout
 */
import type { ThreadData } from "./types.ts";
import { clock } from "./time.ts";

/** 私信房间 id：两个人名排序后拼接，与顺序无关 */
export function dmThreadId(left: string, right: string): string {
  const pair = [left.trim().toLowerCase(), right.trim().toLowerCase()].sort();
  return `dm-${pair[0]}-${pair[1]}`;
}

export function dmThreadTitle(left: string, right: string): string {
  return `私信 · ${left} ↔ ${right}`;
}

/** 生成一个线程（调用方负责 append） */
export function makeThread(input: {
  swarmId: string;
  id: string;
  title: string;
  visibility: "public" | "private";
  members: string[];
  createdBy: string;
  primary?: boolean;
}): ThreadData {
  return {
    id: input.id,
    swarmId: input.swarmId,
    title: input.title,
    primary: input.primary ?? false,
    visibility: input.visibility,
    /* 必须是 running —— ThreadState = "running" | "dormant" */
    state: "running",
    members: input.members.map((name) => ({ name, count: 0 })),
    createdBy: input.createdBy,
    createdAt: clock(),
    messageCount: 0,
    activity: 0,
    preview: "",
    previewAgent: "",
    // 时间线刻度用的伪随机种子：由 id 派生，保证同一线程每次重放都一样
    seed: hashSeed(input.id),
  };
}

function hashSeed(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) % 97;
}

/**
 * 有新内容进房间：更新预览与活跃度。
 *
 * member.count 已经**不在这里**自增了 —— 它现在的语义是"该成员在本集群的真实工作步数"
 * （工具调用/思考），由 EventStore 在 trace.appended 时统一刷。
 * 原因：发消息 ≠ 干活，工具调用也压根不是线程消息。
 */
export function bumpThread(thread: ThreadData, speaker: string, body: string): ThreadData {
  return {
    ...thread,
    messageCount: thread.messageCount + 1,
    activity: 1,
    preview: body.slice(0, 140),
    previewAgent: speaker,
  };
}
