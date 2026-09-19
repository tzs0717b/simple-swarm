import Fastify from "fastify";
import { HOST, MOCK_LLM, PORT, SWARM_HOME, VERSION } from "./config.ts";
import { EventStore } from "./eventstore.ts";
import { registerRoutes } from "./routes.ts";
import { registerAgentRoutes } from "./routes-agents.ts";
import { registerMailRoutes } from "./routes-mail.ts";
import { registerWriteRoutes } from "./routes-write.ts";
import { registerDeleteRoutes } from "./routes-delete.ts";
import { attachWebSocket } from "./ws.ts";

const store = new EventStore(SWARM_HOME);
const boot = await store.load();

console.log(`[boot] simple-swarm-server v${VERSION}  SWARM_HOME=${SWARM_HOME}`);
console.log(
  `[boot] 事件库: ${boot.files} 个日志文件, 快照 seq=${boot.snapshotSeq}, 重放 ${boot.replayed} 条` +
    (store.corrupt > 0 ? `, 跳过损坏行 ${store.corrupt}` : ""),
);

/* 事件库为空就是空的 —— 不再播种任何编造数据。
   界面上的每一条都得是真跑出来的：新建集群 → 点「▶ 跑起来」。 */

console.log(`[boot] 内存投影: ${store.totals().swarms} 个集群 / ${store.totals().live} 个在线 / ${store.listAgents().length} 个智能体`);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// CORS：前端 dev/preview（4173）与后端（8787）不同源，必须放行
app.addHook("onRequest", async (request, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  reply.header("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") {
    reply.code(204).send();
  }
});

registerRoutes(app, store);
registerWriteRoutes(app, store);
registerAgentRoutes(app, store);
registerMailRoutes(app, store);
registerDeleteRoutes(app, store);

let detachWebSocket: (() => void) | undefined;
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[shutdown] 收到 ${signal}，正在优雅退出…`);
  try {
    detachWebSocket?.();
    await app.close();
    await store.snapshot();
    await store.flush();
    console.log(`[shutdown] 快照已写入，事件落盘完成（lastSeq=${store.lastSeq}）`);
  } catch (error) {
    console.error("[shutdown] 退出时出错:", error);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: HOST, port: PORT });
detachWebSocket = attachWebSocket(app.server, store);
console.log(`[ready] http://${HOST}:${PORT}  (MOCK_LLM=${MOCK_LLM ? "on" : "off"})`);
