/* trace 事件类型的配色与中文说明（TracePage 与 agent 窗口共用）
 *
 * 类型就是**真实工具名**（M8）。配色按"在做哪种事"分组，扫一眼颜色就知道这一步是动手、
 * 是协作、还是系统干预：
 *   • 动手（bash/read/write/edit）—— 蓝青紫粉
 *   • 协作（邮件 + 看板）—— 绿/橙/红
 *   • 状态（thinking/retry/system/done）—— 灰阶
 */
import type { TraceType } from "../data";

export const TYPE_COLOR: Record<TraceType, string> = {
  bash: "#0891b2",
  read: "#2563eb",
  write: "#7c3aed",
  edit: "#db2777",
  read_inbox: "#059669",
  list_mailboxes: "#0d9488",
  mark_read: "#64748b",
  archive: "#78716c",
  send_mail: "#b45309",
  reply: "#c2410c",
  broadcast: "#dc2626",
  publish_slice: "#7c3aed",
  claim_slice: "#4f46e5",
  release_slice: "#6d28d9",
  complete_slice: "#16a34a",
  done: "#111827",
  thinking: "#9a9a95",
  retry: "#d97706",
  system: "#6b7280",
};

export const TYPE_LABEL: Record<TraceType, string> = {
  bash: "跑命令",
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  read_inbox: "看收件箱",
  list_mailboxes: "列邮箱",
  mark_read: "标已读",
  archive: "归档",
  send_mail: "发信",
  reply: "回信",
  broadcast: "广播",
  publish_slice: "发布工作",
  claim_slice: "认领切片",
  release_slice: "释放切片",
  complete_slice: "交付切片",
  done: "收工",
  thinking: "思考",
  retry: "自动重试",
  system: "系统干预",
};

/** 老账本里的类型（post/inbox/render…）不在词表里，取值一律走这两个函数兜底，
 *  免得界面上出现 undefined 或者被当成"未知类型"整行变灰。 */
export function typeColor(type: string): string {
  return TYPE_COLOR[type as TraceType] ?? "#5c5c58";
}

export function typeLabel(type: string): string {
  return TYPE_LABEL[type as TraceType] ?? type;
}

/** 大数字压缩：1290780 → 1.29M；387900 → 387.9k */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 珠链上不显示的东西（用户口径 2026-09-18）：
 *  retry（单步失败后的自动重试）和大脑报错（跳过本轮：大脑异常 / 模型网关 XXX）——
 *  它们是系统噪声，不是 agent 干的事，挂在串上只会让人以为 agent 一直在失败。 */
export function hiddenBead(event: { action?: string; detail?: string }): boolean {
  const action = String(event.action ?? "");
  const detail = String(event.detail ?? "");
  if (action === "retry") return true;
  if (detail.includes("大脑异常") || detail.includes("跳过本轮")) return true;
  if (detail.includes("模型网关") || detail.includes("模型调用失败")) return true;
  return false;
}
