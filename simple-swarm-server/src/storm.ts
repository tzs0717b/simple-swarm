/*
 * 防风暴策略（M3.5）。
 *
 * 邮箱模型最大的风险是组合爆炸：N 个 agent「回所有人」，
 * 每封进 N 个收件箱，看到别人广播再回一封 → O(N²)，再叠加 LLM 调用直接把预算烧穿。
 * reply-all 是人类邮件史上最著名的自伤机制，多智能体场景下会被自动化放大。
 *
 * 这里只放「阈值 + 判定」，不放副作用，方便单测；写路径统一走 storm-guard.ts。
 */

export const STORM = {
  /** 闸 2：每个 agent 每分钟最多发多少封 */
  agentPerMinute: 12,
  /** 闸 3：收件人未读达到这个数就拒绝继续投递，要求先读 */
  unreadQuota: 400,
  /** 闸 4：广播合并窗口（秒） */
  broadcastWindowSec: 30,
  /** 闸 5：整个集群每分钟的上限，超过就把集群暂停 */
  swarmPerMinute: 300,
  /** 频率统计窗口（秒） */
  windowSec: 60,
} as const;

/** 人类操作者与 system 不受发信限流约束 —— 它们不是「自走」的循环 */
export const RATE_EXEMPT: ReadonlySet<string> = new Set(["human", "system"]);

/** "HH:MM:SS" → 当天秒数（跨天比较要用环形差值） */
export function secondOfDay(time: string): number {
  const parts = time.split(":").map(Number);
  const [hour, minute, second] = parts;
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return -1;
  return hour * 3600 + minute * 60 + second;
}

/**
 * thenTime 是否落在 nowTime 之前的 windowSec 秒内。
 * 用环形差值：跨午夜也对；时间串在未来（时差错位）时差值会很大 → 不计入，宁可放过也不误杀。
 */
export function withinWindow(nowTime: string, thenTime: string, windowSec: number): boolean {
  const now = secondOfDay(nowTime);
  const then = secondOfDay(thenTime);
  if (now < 0 || then < 0) return false;
  const delta = (now - then + 86400) % 86400;
  return delta <= windowSec;
}

/** 收件人里写了别名（all@ / agents@ / humans@）就是广播 —— 用来标记「这条是群发」 */
export function isBroadcast(raws: string[], aliases: ReadonlySet<string>): boolean {
  return raws.some((raw) => aliases.has(raw.split("@")[0].toLowerCase()));
}
