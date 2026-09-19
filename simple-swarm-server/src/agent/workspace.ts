/*
 * 智能体的工作目录（M8）：每个集群一个独立目录，真工具都在这里面动手。
 *
 * 为什么单独一层而不直接让 agent 在当前目录跑：
 *   1) 隔离 —— 两个集群同时跑不会互相踩文件；
 *   2) 可读 —— 人类可以直接去 workspace/<swarmId>/ 看它们到底干出了什么；
 *   3) 可控 —— 读写路径全部解析到这个根之下，越界直接拒绝。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "../config.ts";

/** 集群的工作目录（不存在就建） */
export function workspaceOf(swarmId: string): string {
  const dir = path.join(WORKSPACE_ROOT, swarmId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把（模型给的）相对路径解析到工作目录内。
 * 允许 "." / "" 表示目录本身；任何跑出去的路径（../、绝对路径）直接抛错，
 * 工具层会把它变成一条被拒绝的观察结果给模型看，而不是真去动外面的文件。
 */
export function resolveInWorkspace(swarmId: string, relative: string): string {
  const root = workspaceOf(swarmId);
  const resolved = path.resolve(root, relative === "" ? "." : relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("路径越界，只允许在集群工作目录 " + root + " 之内：" + relative);
  }
  return resolved;
}

/** 相对工作目录的展示用路径（写进追踪里给人看） */
export function displayPath(swarmId: string, absolute: string): string {
  const root = workspaceOf(swarmId);
  return absolute.startsWith(root) ? absolute.slice(root.length + 1) || "." : absolute;
}
