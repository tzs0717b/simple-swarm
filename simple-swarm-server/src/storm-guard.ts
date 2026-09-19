/*
 * 闸门（M3.5）：写路径共用的「能不能发」判定 + 违约事件落盘。
 *
 * 判定是纯查询（计数器从投影里算，无隐藏状态，重放结果一致）；
 * 审计事件由这里 append，于是「谁被限流、谁被暂停」在事件日志里可查。
 */
import type { EventStore } from "./eventstore.ts";
import { localOf } from "./mail.ts";
import { RATE_EXEMPT, STORM } from "./storm.ts";
import { clock } from "./time.ts";

export interface SendRefusal {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 发信前的闸门。返回 null = 放行；否则返回要回复的错误。
 * 闸 5（集群硬闸）优先于闸 2（个人限流）：先看整个集群是不是已经烧起来了。
 */
export function guardSend(store: EventStore, swarmId: string, from: string): SendRefusal | null {
  const swarmRecent = store.recentSendCount(swarmId, null, STORM.windowSec);
  if (swarmRecent >= STORM.swarmPerMinute) {
    // 只在「活着 → 暂停」这一刻落事件，避免每封都被拒时刷屏
    if (store.getSwarm(swarmId)?.state !== "stopped") {
      store.append({
        type: "swarm.paused",
        swarmId,
        reason: `消息风暴：${STORM.windowSec} 秒内 ${swarmRecent} 封 > ${STORM.swarmPerMinute}`,
        count: swarmRecent,
        limit: STORM.swarmPerMinute,
        time: clock(),
      });
    }
    return {
      status: 429,
      body: {
        error: "集群因消息风暴被暂停",
        swarmId,
        count: swarmRecent,
        limit: STORM.swarmPerMinute,
        hint: "等风暴过去后用 POST /api/swarms/:id/start 恢复",
      },
    };
  }

  if (!RATE_EXEMPT.has(localOf(from))) {
    const mine = store.recentSendCount(swarmId, from, STORM.windowSec);
    if (mine >= STORM.agentPerMinute) {
      store.append({
        type: "mail.rate_limited",
        swarmId,
        from,
        count: mine,
        limit: STORM.agentPerMinute,
        time: clock(),
      });
      return {
        status: 429,
        body: {
          error: "发信过快",
          from,
          count: mine,
          limit: STORM.agentPerMinute,
          windowSec: STORM.windowSec,
          hint: "先读完收件箱再回；群发请显式写 to: [\"all@<swarm>.swarm\"]",
        },
      };
    }
  }

  return null;
}
