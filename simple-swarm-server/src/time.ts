/*
 * 时间与 id：全项目统一。
 * 展示格式是 HH:MM:SS 的时钟串（与前端 mock 数据一致），信封上另有 ISO 的 at。
 */

export function clock(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

let counter = 0;

/** 消息 / 邮件 id：`m-<base36 毫秒>-<base36 序号>`，同一进程内不会重复。 */
export function messageId(): string {
  counter += 1;
  return `m-${Date.now().toString(36)}-${counter.toString(36)}`;
}
