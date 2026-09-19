/*
 * 认领切片的唯一实现（HTTP 路由与智能体工具共用）。
 * 冲突判定是这套系统的一个招牌行为（"两人抢同一片 → first-wins + 碰撞事件"），
 * 两处各写一遍迟早会跑偏，所以抽出来。
 */
import type { EventStore } from "./eventstore.ts";
import { SWARM_SHARE_SLICES } from "./config.ts";

export type ClaimOutcome =
  | { ok: true; slice: string; agent: string; shared?: string[] }
  | { ok: false; status: number; body: Record<string, unknown> };

/** 认领一片；已被别人占住时落一条 collision.detected（first-wins）并返回 409 */
export function takeSlice(store: EventStore, swarmId: string, agent: string, slice: string): ClaimOutcome {
  const holder = store.claimHolder(swarmId, slice);
  if (holder && holder !== agent) {
    const holders = [
      ...new Set([...store.listClaims(swarmId).filter((claim) => claim.slice === slice).map((claim) => claim.agent), agent]),
    ];
    /* 人多活少 → 允许"多人同干一片"：板上已经没有别的空活了，说明人手比活多，
       再把后来的人挡回去只会让他们空转；放进来一起干，并由工具层通知他们讨论合并。
       人少的时候（还有空活）保持 first-wins —— 撞了就换一片，别互相踩。 */
    /* 多人同干一片（2026-09-19，用户口径）：拆出来是线性链时，就该多人一起上关键路径，
       而不是把后来的人推到别的片上排队空转。SWARM_SHARE_SLICES=1（默认）永远允许加入；
       =0 退回老规矩：板上还有空活就 first-wins，撞了换一片。 */
    const free = store.listSlices(swarmId).filter((info) => info.status === "available").length;
    if (free > 0 && !SWARM_SHARE_SLICES) {
      store.append({ type: "collision.detected", swarmId, slice, holders, verdict: "first-wins" });
      return { ok: false, status: 409, body: { error: "切片已被认领（板上还有空活，去接一片新的）", slice, holders } };
    }
    store.append({ type: "claim.taken", swarmId, agent, slice });
    store.append({ type: "collision.detected", swarmId, slice, holders, verdict: "shared" });
    return { ok: true, slice, agent, shared: holders };
  }
  store.append({ type: "claim.taken", swarmId, agent, slice });
  return { ok: true, slice, agent };
}

/** 释放一片；只能释放自己认领的 */
export function releaseSlice(store: EventStore, swarmId: string, slice: string, agent?: string): ClaimOutcome {
  const holder = store.claimHolder(swarmId, slice);
  if (!holder) return { ok: false, status: 404, body: { error: "该切片无人认领", slice } };
  if (agent && agent !== holder) {
    return { ok: false, status: 409, body: { error: "只能释放自己认领的切片", slice, holders: [holder] } };
  }
  store.append({ type: "claim.released", swarmId, agent: holder, slice });
  return { ok: true, slice, agent: holder };
}
