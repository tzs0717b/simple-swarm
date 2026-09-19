# simple-swarm-server

Simple Swarm System 后端（M1：脚手架 + 事件库 + 只读 REST API）。

- **本地优先**：单进程即可跑，不依赖数据库/消息队列。
- **零原生模块**：只用 `fastify` / `ws` / `zod` 三个纯 JS 依赖，x86_64 / arm64 / musl(Alpine) / Termux 通用。
- **事件溯源**：一切变更都追加到 `data/events-YYYY-MM-DD.jsonl`，内存里是投影，可随时重放/快照。
- **契约即前端类型**：API 返回形状与 `simple-swarm-web/src/data.ts` 完全一致，前端切换零组件改动。

## 运行

```bash
npm install
npm start                    # 默认 http://127.0.0.1:8787
PORT=9000 SWARM_HOME=/var/lib/simple-swarm npm start
curl -s localhost:8787/api/health
```

数据落在 `SWARM_HOME`（默认 `./data`）：
- `events-YYYY-MM-DD.jsonl` — append-only 事件日志，每行一个 JSON
- `snapshot-latest.json` — 快照（事件重放加速）

## API（M1 只读）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/health` | 服务状态、事件数、最后 seq |
| GET | `/api/swarms` | `{ swarms: SwarmData[], totals: { swarms, live } }` |
| GET | `/api/swarms/:id` | `SwarmData` |
| GET | `/api/swarms/:id/threads` | `ThreadData[]` |
| GET | `/api/swarms/:id/threads/:threadId` | `ThreadData` |
| GET | `/api/swarms/:id/threads/:threadId/messages?limit=&before=` | `MessageData[]`（倒序） |
| GET | `/api/swarms/:id/trace?limit=` | `TraceEventData[]`（倒序） |
| GET | `/api/agents` | `AgentInfo[]` |
| GET | `/api/events?since=` | 原始事件流（调试/后续 WS 用） |

## 里程碑

- **M1（当前）**：脚手架 + EventStore + 只读 REST
- M2：WebSocket 推送 + 生命周期写接口 + 前端 `data.ts` 切 live
- M3：Agent worker + SwarmKit
- M4：预算熔断 + DoD + 冲突仲裁
- M5：LLM Gateway 接真模型
- M6：systemd / Dockerfile 部署件

详见 `../BACKEND_PLAN.md`。
