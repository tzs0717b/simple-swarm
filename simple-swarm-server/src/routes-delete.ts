/*
 * 删除集群（M6）：删掉一个集群在本机留下的全部痕迹。
 * 前端 SwarmsPage 的删除按钮走这里。
 *
 * 删除**也是一条事件**（swarm.deleted）：这样重启后重放事件账本时，
 * 被删掉的集群不会"复活"。真正的清理只有一处实现 —— EventStore.removeSwarm()。
 */
import { clock } from "./time.ts";
import type { EventStore } from "./eventstore.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export function registerDeleteRoutes(app: FastifyInstance, store: EventStore): void {
  app.delete("/api/swarms/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "参数非法" });
    const swarm = store.getSwarm(params.data.id);
    if (!swarm) return reply.code(404).send({ error: "集群不存在", id: params.data.id });

    store.append({ type: "swarm.deleted", swarmId: swarm.id, time: clock() });
    return reply.code(200).send({ deleted: swarm.id });
  });
}
