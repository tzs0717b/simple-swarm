# Simple Swarm System — 后端方案（本地优先，兼容任意 Linux）

> 状态：方案文档（未动工）。前端在 `simple-swarm-web/`，`src/data.ts` 是前后端接缝。
> 目标：现在只在本地跑（Termux/Android、Linux 桌面、WSL 都能跑），未来无缝搬到服务器。

---

## 0. 设计原则

1. **本地优先**：单机单进程即可完整运行；不依赖外部服务（数据库/消息队列/容器都不必须）。
2. **任意 Linux 兼容**：第一阶段**零原生模块**——只用纯 JS 依赖，x86_64 / arm64 / musl(Alpine) / Termux 全都能跑，不需要编译工具链。
3. **中心控制面 + 去中心协作面**：控制面管生命周期/预算/权限/DoD/仲裁；协作面里 agent 之间直接互发消息、认领切片。
4. **事件溯源**：一切皆事件（append-only）。状态是事件的投影，天然可回放、可审计。
5. **前后端接缝不变**：`data.ts` 的类型（`SwarmData / ThreadData / MessageData / TraceEventData`）就是 API 契约，前端组件零改动切换。

---

## 1. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 20（推荐 22 LTS） | 前端 Vite 8 已要求同版本；Termux/Alpine/WSL 都有包 |
| HTTP | **Fastify**（纯 JS） | 快、schema 校验内置、日志内置 |
| 实时 | **ws**（纯 JS） | WebSocket，前端订阅 swarm 事件流 |
| 存储 | **append-only JSONL 事件日志 + 内存投影 + 定期快照** | 零原生依赖；`data/` 目录就是数据库；任意 Linux 可写文件即可 |
| 持久化升级（可选，阶段 2） | `node:sqlite`（Node ≥ 22.13 内置）或 better-sqlite3 | 只在需要复杂查询时启用；接口不变 |
| Worker | **worker_threads**（Node 内置） | 每个 agent 一个 worker，本地并发不跨进程 |
| 校验 | zod（纯 JS） | 事件/API schema 双用 |

**明确不用（第一阶段）**：原生模块（better-sqlite3/sqlite3/ sharp）、Redis、Postgres、Docker（可选提供但不依赖）。

---

## 2. 总体架构

```
┌─────────────────────────────── 单 Node 进程（本地模式） ───────────────────────────────┐
│                                                                                      │
│  控制面 (Control Plane)                       协作面 (Collaboration Plane)             │
│  ┌─────────────────────────┐                 ┌─────────────────────────────────┐     │
│  │ SwarmManager 生命周期    │                 │  Agent Worker ×N (worker_threads)│     │
│  │ BudgetLedger 预算/记账   │   EventBus      │  ┌───────────────────────────┐  │     │
│  │ Gatekeeper 权限/仲裁     │ ←──────────────→│  │ SwarmKit 工具集            │  │     │
│  │ DoD 完成判定             │   (pub/sub)     │  │ list_agents/send_message   │  │     │
│  │ EventStore 追加日志      │                 │  │ broadcast/read_messages    │  │     │
│  │ LLM Gateway(持有 API key)│                 │  │ claim_slice/done           │  │     │
│  └─────────────────────────┘                 │  └───────────────────────────┘  │     │
│         ↑ REST + WS (Fastify)                        ↑ 只能通过 Kit 调控制面          │
└─────────┼────────────────────────────────────────────┼───────────────────────────────┘
          ↓                                            ↓
   前端 simple-swarm-web                        事件日志 data/events-*.jsonl
   (fetch + WebSocket 替换 data.ts)             + 快照 data/snapshot-*.json
```

- **控制面**是唯一写入口：所有状态变更都变成事件落盘。agent 不能直接写共享状态。
- **协作面**：agent 之间通过 `send_message / broadcast` 互通（经 EventStore 转发 + WS 推送），实现视频里的"互相看板"。
- **仲裁**：两个 agent 认领同一切片 → 控制面发 `collision.detected`，按策略（先到先得 / 优先级 / 人工）裁决。

---

## 3. 目录结构（新建 `simple-swarm-server/`）

```
simple-swarm-server/
├── package.json            # fastify ws zod 三个依赖，无其他
├── tsconfig.json
├── data/                   # 运行时生成（.gitignore）
│   ├── events-2026-09-13.jsonl
│   └── snapshot-latest.json
├── .env.example            # DEEPSEEK_API_KEY= 等占位
└── src/
    ├── index.ts            # 启动：加载快照→重放事件→起 Fastify+WS
    ├── config.ts           # SWARM_HOME / PORT / 预算默认值（env 优先）
    ├── types.ts            # 与前端 data.ts 对齐的契约类型 + 事件类型
    ├── eventstore.ts       # append-only JSONL：append/repair/replay/snapshot
    ├── bus.ts              # EventBus：内存 pub/sub，WS hub 桥接
    ├── swarm-manager.ts    # 生命周期：create/start/stop/retire/complete
    ├── budget.ts           # 记账：token/cost 累加、阈值告警(60%/90%)、超限熔断
    ├── gatekeeper.ts       # 权限：agent 只能写自己的 artifacts/、认领仲裁
    ├── dod.ts              # DoD 判定：标准列表 + 逐条核验 → swarm.completed
    ├── llm-gateway.ts      # 唯一持有 API key：chat/tools 计量、限流、重试
    ├── kit/
    │   └── tools.ts        # SwarmKit：暴露给 agent worker 的 6 个工具
    ├── workers/
    │   └── agent-worker.ts # worker 入口：收任务→调 LLM→用 Kit 协作→done()
    └── routes/
        ├── swarms.ts       # REST
        ├── threads.ts
        ├── events.ts       # SSE/WS 事件流
        └── static.ts       # 托管 simple-swarm-web/dist（生产模式）
```

---

## 4. 事件模型（一切皆事件）

```ts
type SwarmEvent =
  | { type: "swarm.created";     swarm: SwarmData }
  | { type: "swarm.started";     swarmId: string; at: string }
  | { type: "agent.registered";  swarmId: string; agent: AgentInfo }
  | { type: "agent.done";        swarmId: string; agent: string; reason: string }
  | { type: "thread.created";    thread: ThreadData }
  | { type: "message.posted";    message: MessageData }          // agent 或 human
  | { type: "claim.taken";       swarmId: string; agent: string; slice: string }
  | { type: "claim.released";    swarmId: string; agent: string; slice: string }
  | { type: "collision.detected";swarmId: string; slice: string; holders: string[]; verdict: string }
  | { type: "budget.warning";    swarmId: string; used: number; ratio: number }
  | { type: "budget.exhausted";  swarmId: string }
  | { type: "dod.passed";        swarmId: string; criterion: string; evidence: string }
  | { type: "swarm.completed";   swarmId: string; dod: DodResult[] }
  | { type: "trace.appended";    swarmId: string; event: TraceEventData };  // bash/read/edit… 工具轨迹
```

- **落盘**：每行一个 JSON（JSONL），写前 `fs.appendFile` + 可选 fsync；损坏行自动跳过并告警（repair）。
- **重放**：启动时按序重放 → 内存投影（swarms/threads/messages/claims/budget），与前端 `data.ts` 的形状一致。
- **快照**：每 N 条事件或每 5 分钟写一次 snapshot，重放 = 快照 + 增量事件。

---

## 5. REST + WS API（契约 = 前端 data.ts 类型）

### REST
```
GET    /api/swarms                          → SwarmData[]（含 SWARM_TOTALS）
POST   /api/swarms                          → 新建（goal 文本、预算、模型、agentCount）
GET    /api/swarms/:id                      → SwarmData
POST   /api/swarms/:id/start|stop|complete  → 生命周期（complete 需 DoD 通过）
GET    /api/swarms/:id/threads              → ThreadData[]
GET    /api/swarms/:id/threads/:tid         → ThreadData
GET    /api/swarms/:id/threads/:tid/messages?before=<cursor>&limit=50
                                            → MessageData[]（倒序分页，同当前 UI）
POST   /api/swarms/:id/threads/:tid/messages → 人类插话（agent 走 Kit，不走 REST）
POST   /api/swarms/:id/claims               → {agent, slice}；冲突返回 409 + holders
DELETE /api/swarms/:id/claims/:agent        → 释放认领
GET    /api/swarms/:id/events?cursor=...    → TraceEventData[]（增量）
GET    /api/swarms/:id/agents               → AgentInfo[]
POST   /api/agents/:name/done               → 退役该 agent（≠ swarm 完成）
GET    /api/health                          → {ok, version, uptime, events}
```

### WebSocket `/ws`
```
客户端→ 服务端: { "sub": "swarm:perfect-pelican" }        订阅
服务端→ 客户端: message.posted | claim.taken | collision.detected
              | budget.warning | dod.passed | agent.done | swarm.completed
              | trace.appended
心跳: ping/pong 30s；断线重连后用 ?cursor= 补拉增量
```

---

## 6. 关键机制

### 6.1 预算与记账（BudgetLedger）
- 记账粒度：每次 LLM 调用记录 `agent / tokens / cost / calls / ms` → 追加 `trace.appended`。
- 阈值：60% `budget.warning`（黄）、90% `budget.warning`（红，前端进度条变红）、100% `budget.exhausted`（熔断：暂停所有 worker，只读）。
- 超限后允许人类 `POST /api/swarms/:id/budget` 追加，事件留痕。

### 6.2 DoD 完成判定（不是"所有 agent done"）
- swarm 创建时带 DoD 标准列表，如：
  1. `final_output/` 存在且可渲染
  2. ≥2 次**独立**测量型评审（附数字证据）
  3. ≥1 次对抗性验证通过
  4. 预算内完成
- `done()` 只退役 agent；**swarm.completed 只由 dod.ts 判定**。
- DoD 条件本身也是事件（`dod.passed` 带 evidence），前端可展示"完成度清单"。

### 6.3 认领与冲突仲裁（Gatekeeper）
- `claim_slice(agent, slice)`：先到先得；重复认领 → `collision.detected`。
- 仲裁策略（可配）：`first-wins`（默认）/ `priority`（按 agent 等级）/ `human`（挂起等人在 UI 点）。
- 写权限：agent 只能写 `artifacts/<agent>/`，`final_output/` 只有 assembly owner（第一个完成完整草稿者）可写——对应视频里 pelican 仲裁规则。

### 6.4 LLM Gateway（唯一持钥方）
- agent worker 里**绝不出现 API key**；worker 只调 gateway 的本地端口。
- 职责：按 swarm 模型路由（deepseek/glm/…）、token 计量入账、限流、指数退避重试、超时熔断。
- 本地无 key 时：`MOCK_LLM=1` 走内置假模型（脚本化回复），前后端联调不依赖外部 API。

### 6.5 SwarmKit（agent 唯一入口）
```ts
const kit = {
  list_agents(swarmId): AgentInfo[],
  send_message(threadId, body): void,      // → message.posted
  broadcast(swarmId, body): void,
  read_messages(threadId, {since}): MessageData[],
  claim_slice(swarmId, slice): ClaimResult, // 冲突时返回 collision
  done(reason): void,                        // 退役自己
};
```
- Kit 内部全部经本地 HTTP/MessagePort 调控制面；worker 无文件系统直写权（除自己 artifacts 目录）。

### 6.6 身份与提示词分发（身份固定，活不固定）

**原则：名字在启动时就写进提示词；具体干哪块活不写，留给看板认领。身份只有名字，不带性格设定。**

- 名字来自**预置名字池**（服务端内置，复用现有 24 个名字：`peliscout` / `pixelprowl` / `skein` / `doubter` / `critic` … ；`system` 是系统占位，不入池）。
- `POST /api/swarms` 传 `agentCount: N` → 服务端从池中取 N 个名字。**单次 swarm 内名字唯一**；跨 swarm 允许重名（与现有 mock 一致，如 `skein` 同时在 pelican 与 raytracer）。
- 每个 agent 启动时拿到的系统提示词 = Mission + DoD + 自己的名字 + 协作规则：

```text
你是 peliscout。你属于 swarm「PERFECT PELICAN」。

【任务】<Mission + DoD，所有人完全相同>
【你的身份】peliscout —— 名字已定，不要改名。
【你的活】没有预先分配。先 read_messages 看板 + list_agents 看有谁，
         然后自己找还没人认领的切片 claim_slice。想换就 release 再认领。
【规矩】认领别人已认领的切片会被判冲突；干完 done()；不要空转等人分配。
```

- **不写进提示词的**：负责哪个切片、步骤顺序、跟谁配合 —— 全部运行时协商产生。
- **事件**：`agent.registered` 携带 `{ name }`；`role` 字段初始为空，只在 `claim.taken` 时写入（前端"当前在干什么"永远是动态的）。
- **好处**：名字稳定可预期（UI 第一帧就显示名字，不会出现两个 agent 抢同一个名字）、省掉一次"起名"的 LLM 调用、同一 goal 可复现；而"活由谁干"保持涌现。

### 6.7 进程模型
- **本地模式**（默认）：单进程，每 swarm 一个 worker 池（N agent = N worker_threads），内存 EventBus。
- **服务器模式**：同一份代码；`PORT=8080 SWARM_HOME=/var/lib/swarm`，systemd 托管；WS 直连不变。多机扩展是阶段 3（EventBus 换 Redis pub/sub，接口不变，本期不做）。

---

## 7. Linux 兼容清单

| 项 | 做法 |
|---|---|
| 原生模块 | 阶段 1 零原生依赖 → x86_64/arm64/musl/Termux 全通 |
| 路径 | 一律 `path.join(SWARM_HOME, ...)`，`SWARM_HOME` 默认 `./data`，服务器 `/var/lib/swarm` |
| 权限 | 不监听特权端口（默认 8787）；文件权限 0600 |
| 进程守护 | 附 `swarm.service`（systemd）示例；Termux 用 `termux-services`/`nohup` |
| 优雅退出 | SIGTERM/SIGINT → 停 worker → flush 事件 → 写快照 → 关服务 |
| 日志 | pino 到 stdout；`systemd`/`logrotate` 接管；本地可 `> swarm.log 2>&1` |
| 时区 | 事件时间一律 ISO-8601 UTC 存储，展示层转本地 |
| Docker（可选） | 附 `Dockerfile`（node:22-alpine，挂载 /data），非依赖项 |

---

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 脚手架 + EventStore + REST 只读 API（返回当前 mock 同形状数据） | `curl /api/swarms` 与前端 `data.ts` 字段一致 |
| M2 | WS 推送 + 生命周期（create/start/stop）+ 前端切 live（fetch+WS 替换 data.ts） | UI 上发消息实时出现；刷新不丢 |
| M3 | Agent worker + SwarmKit（mock LLM） | 2 个 mock agent 在线程里互发消息 + 认领 |
| M4 | Budget + DoD + 冲突仲裁 | 预算告警进 UI；重复认领被仲裁；DoD 通过触发 completed |
| M5 | LLM Gateway 接真模型（key 在服务端） | 真实 agent 跑通 pelican 式任务，trace 全落盘 |
| M6 | 部署件：systemd unit + Dockerfile + 备份脚本 | 任意 Linux 一条命令起服务 |

---

## 8.5 LLM 接入：复用隔壁的 API Key Pool（已定）

**结论：不自己写 key 管理，直接复用 `~/api-keys`。**

它是一个**已经跑起来的 OpenAI 兼容代理**（`http://127.0.0.1:3131/v1`），手里 43 个可用 key / 20 个提供商。

```
每个 AI → 我们的网关 → Key Pool(3131/v1) → 43 个 key → 20 个上游
            ↑记账/预算/并发闸   ↑选key/轮询/429降级
```

| 它替我们解决的 | 我们必须自己做的 |
|---|---|
| 43 key 加权轮询，单 key 不会被打爆 | **从响应的 usage 算钱**（池子不管钱） |
| 429/5xx 自动冷却换 key | **预算熔断**、每 agent 配额 |
| 按首 token 延迟排序，快的优先 | **并发闸**（池子是反应式的，没有主动限速） |
| key 加密落盘 | 超时/重试策略 |

**给池子提的两个补丁（待确认）**：
1. 429 目前走「其他错误」分支 → 累计 3 次标 `invalid` **永久移出轮换**。swarm 高并发下 429 是常态，应改为 **429 → cooldown（自动恢复）**，只有 401/403 才 disabled。
2. 可选：给池子加 per-key RPM 主动节流，从"撞墙再降温"变成"提前不撞"。

**对里程碑的影响**：原 M8「真 LLM 网关」缩水为「接 3131/v1 + 读 usage 记账」；M5「预算/熔断」不变。

## 9. 前端切换方式（预留的接缝）

```ts
// src/data.ts 改为：
import { api } from "./lib/api";           // fetch + WS 封装
export const SWARM_TOTALS = await api.totals();
export function swarmById(id) { return api.swarm(id); }
// …函数签名不变，内部从内存数组换成 API 调用 + SWR 缓存
```
组件层零改动；`MessageData/TraceEventData` 增加可选 `cursor` 字段用于分页。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| JSONL 无并发写锁 | 单进程内串行 append（Promise 队列）；多机是阶段 3 的事 |
| 事件文件膨胀 | 快照 + 按月切分 + 归档压缩（gzip） |
| worker 崩溃 | 父进程捕获 exit → `agent.registered` 反向事件 + 自动重启（计数上限） |
| LLM 费用失控 | 熔断 + 每 agent 子预算 + 人类追加需显式事件 |
| Termux 后台被杀 | 建议服务器/桌面跑常驻；Termux 用 `termux-wake-lock` + termux-services |
