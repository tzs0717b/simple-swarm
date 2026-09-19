# 实现 vs 方案 — 差异全清单

> 对照物：`BACKEND_PLAN.md`（我写的后端方案）、`SIMPLE_SWARM_DESIGN.md`（另一个 AI 的设计）、`simple-swarm-server/` + `simple-swarm-web/`（实际代码）
> 对账时间：代码现状（595 事件 / 24 智能体 / 4 集群 / 426 trace）
> 统计：**37 处差异**，分四类

---

## 结论先行

实现出来的东西，**是方案里"控制面"的骨架 + 协作面的公告板，但缺了协作面的执行主体**。

- 两份方案的**核心**——Agent Runner / SwarmKit / Worker Threads / LLM 调用循环——**一行都没写**。
- 现在 24 个"智能体"是**种子数据**，不是进程；它们不会动、不会说话、不会认领。
- 已经落地的是：事件溯源存储、投影、REST 只读、WS 推送、认领/冲突检测、前端控制台。
- **最危险的三个缺口**：没有预算控制（真跑会无上限烧钱）、没有 DoD（不会自己停）、没有 agent（系统还不"活"）。

---

## A. 路线级差异（3 处）— 走的路和某一份方案不同了

### A1. 持久化：SQLite 五张表 → append-only JSONL 事件日志

| | |
|---|---|
| DESIGN §3.1/3.2 | `better-sqlite3` + `swarms` / `agents` / `messages` / `events` / `slices` 五张表 |
| 实现 | **0 处 sqlite**。`data/events-YYYY-MM-DD.jsonl` + 内存投影 + `snapshot-latest.json` |
| PLAN | 采纳 JSONL（sqlite 列为"阶段 2 可选"）→ **与 PLAN 一致，与 DESIGN 不一致** |

**影响**：`slices` 表不存在 → 看板没有实体（见 C7）。但换来零原生模块（Termux/arm64/musl 免编译）。

### A2. 依赖：4 个（含原生）→ 3 个纯 JS

| | |
|---|---|
| DESIGN §3.1 | fastify + @fastify/websocket + better-sqlite3 + openai SDK |
| 实现 | `fastify@5` + `ws@8` + `zod@4`，**零原生模块** |
| PLAN | 明确要求 3 个纯 JS 依赖 → 一致 |

### A3. 没有 Agent —— 最大的差距

| | |
|---|---|
| 两份方案 | 整个核心是 Agent Runner + SwarmKit + worker_threads + LLM 循环 |
| 实现 | **0 处 `worker_threads`**；没有 runner、没有 Kit、没有一次 LLM 调用 |
| PLAN §3 | `swarm-manager.ts` / `budget.ts` / `gatekeeper.ts` / `dod.ts` / `llm-gateway.ts` / `kit/tools.ts` / `workers/agent-worker.ts` —— **全部不存在** |

**影响**：后端现在是**纯记录系统**（黑板 + 推送），不是"多智能体系统"。界面上的动静全靠种子数据摆出来。

---

## B. 同类功能、做法不同（11 处）

### B1. 事件类型：11 种 vs 方案 14 种 / 命名风格不同

实现的 11 种：
```
swarm.created  swarm.updated  thread.created  thread.updated
agent.registered  agent.done  message.posted  trace.appended
claim.taken  claim.released  collision.detected
```
- PLAN 有但**没实现**：`swarm.started`、`budget.warning`、`budget.exhausted`、`dod.passed`、`swarm.completed`
- 实现里**多出来**（两份方案都没有）：`swarm.updated`、`thread.updated`（维护计数用）
- DESIGN 用的是完全另一套命名（`agent_started` / `message_new` / `event_log` / `slice_claimed` / `budget_update` / `swarm_stopped`）—— 我们采用了 PLAN 的 `x.y` 风格

### B2. `agent.registered` 载荷不带 `swarmId`

- PLAN：`{ type:"agent.registered"; swarmId: string; agent: AgentInfo }`
- 实现：`{ type:"agent.registered"; agent: AgentInfo }` —— 智能体注册表是**全局**的
- 理由：一个 agent 可属于多个集群（`SwarmData.agents: string[]` 反查）；名字池跨集群

### B3. REST 没有 `/api/v1` 前缀

- DESIGN：`/api/v1/swarms`
- 实现：`/api/swarms`（PLAN 也是无前缀 → 与 PLAN 一致）

### B4. 释放认领的路径不同

- PLAN：`DELETE /api/swarms/:id/claims/:agent`
- 实现：`DELETE /api/swarms/:id/claims?slice=&agent=`（query 参数）
- 理由：一个 agent 可能同时持有多块切片

### B5. 增量事件流拆成了两条

- PLAN：`GET /api/swarms/:id/events?cursor=...`（按集群的 trace 增量）
- 实现：`GET /api/swarms/:id/trace?limit=`（全量倒序）**+** `GET /api/events?since=`（全局事件游标）
- 缺：**没有"按集群的 trace 增量游标"**

### B6. 列表接口的聚合方式不同

- PLAN：`GET /api/swarms → SwarmData[]（含 SWARM_TOTALS）`
- 实现：`GET /api/swarms → { swarms: SwarmData[]; totals: SwarmTotals }`
- PLAN：`GET /api/swarms/:id/agents`
- 实现：`GET /api/agents`（全局），前端自己按集群过滤 → **缺按集群的 agents 接口**

### B7. `MessageData` 字段与方案冲突

| | |
|---|---|
| PLAN §9 | 增加可选 `cursor` 字段用于分页 → **未加** |
| DESIGN §3.2 | `recipient_id`（NULL=广播）、`type` = `message\|claim\|system\|signoff` |
| 实现 | 7 字段 `{id, threadId, time, agent, chars, kind, body}`；**无 recipient**；`kind` 有 **9 种**：`agent/system/goal/collision/claim/verify/question/answer/signoff` |

### B8. 冲突裁决只有一种策略，且硬编码

- PLAN §2：策略（先到先得 / 优先级 / 人工）可配
- 实现：`verdict: "first-wins"` 直接写在 `routes-write.ts` 里，**没有策略层**（`gatekeeper.ts` 不存在）

### B9. 快照/落盘细节比方案弱

| | PLAN | 实现 |
|---|---|---|
| 快照时机 | 每 N 条事件或每 5 分钟 | **只在优雅退出时写一次** |
| fsync | `appendFile` + 可选 fsync | `appendFile`，**无 fsync**（掉电可能丢尾部） |
| 文件切分 | 按月 + gzip 归档 | **按天**，无归档无压缩 |
| 并发写 | 单进程串行 Promise 队列 | ✅ 一致 |

### B10. 消息时间格式与 PLAN 的时区约定冲突

- PLAN §7：`事件时间一律 ISO-8601 UTC 存储，展示层转本地`
- 实现：事件信封 ✅ 有 `at: new Date().toISOString()`；但 **`MessageData.time` 直接存 `"17:02:07"` 这种本地时钟字符串**（前端契约要求）
- 影响：**未来跨时区/跨天会痛**，排序靠字符串比较

### B11. 日志：pino → console.log

- PLAN §7：pino 到 stdout，systemd/logrotate 接管
- 实现：`console.log` 手写 `[boot]` 之类（Fastify 5 默认不启用 logger）

---

## C. 方案里有、实现里没有（10 组缺口）

### C1. Agent 运行时（全缺）
- `workers/agent-worker.ts`（worker_threads 进程模型）
- **SwarmKit 6 个工具**（PLAN）：`list_agents` / `send_message` / `broadcast` / `read_messages` / `claim_slice` / `done`
- **DESIGN 多出来的工具**：`complete_slice` / `budget` / `think` / `write_file` / `read_file` / `bash`
- 消息轮询循环、单 agent 最大轮次、超时"求助广播"、上下文压缩
- **提示词模板拼装**（Mission + DoD + 名字 + 协作规则）—— §6.6 只写了"装什么内容"，没有模板代码

### C2. 预算与记账（`budget.ts` 不存在）
- 每次 LLM 调用的 token/cost 累加 —— 现在**只有种子里的静态数字，没有任何代码在扣减**
- 三档阈值告警（剩 20% / 5% / ≤0）→ `budget.warning` / `budget.exhausted`
- 超限熔断、每 agent 子预算、人类追加预算（需显式事件）
- `budget()` 工具

### C3. DoD 完成判定（`dod.ts` 不存在）
- `final_output_file` 解析与产物核验
- 对抗性验证事件判定
- 两个独立签署（`signoff`）判定
- `dod.passed` / `swarm.completed` 事件
- 前端 `DoDPanel`

### C4. 生命周期（`swarm-manager.ts` 不存在）
- `swarm.started` 事件
- `POST /api/swarms/:id/start|stop|complete`、`DELETE /api/swarms/:id` —— **全缺**
- 状态机：现在**没有 `pending → running → stopped`**，`POST /api/swarms` 直接给 `live`；`stopSwarm`/回收线程不存在
- PLAN M2 要求 start/stop → **M2 只完成了一半**

### C5. Gatekeeper 权限
- agent 只能写自己 `artifacts/<agent>/` 的隔离、文件锁、工作区子目录
- 认领仲裁策略层
- 现在**完全没有写权限概念**（因为还没有 agent 写文件这回事）

### C6. LLM Gateway（`llm-gateway.ts` 不存在）
- 唯一持有 API key、chat/tools 计量、限流、重试
- DESIGN 的 `POST /api/v1/swarms` body 含 `baseUrl` / `apiKey` → 实现**只收 model，不收 key**
- `MOCK_LLM` 环境变量存在，但**没有任何代码读它**

### C7. 切片（Slices）整块缺失
- `slices` 表 / `Slice` 实体**完全不存在**
- Slice Generator（用 LLM 把 prompt 拆成切片菜单）**不存在**
- 现在的 `slice` 只是一个**字符串**，没有 id / 描述 / 状态
- **没有 `available → claimed → completed` 状态机**（只有 claimed 一个动作）
- 前端 `SliceBoard`（Kanban 三列）**不存在**
- AgentsPage 上那 4 条"认领"是**种子塞的字符串**，不是真认领

### C8. 前端缺口
| 方案组件 | 状态 |
|---|---|
| `BudgetMeter`（预算进度条） | ❌ 缺 |
| `DoDPanel` | ❌ 缺 |
| `SliceBoard`（看板） | ❌ 缺 |
| `@nickname` 高亮 | ❌ 缺 |
| DESIGN 三栏工作台（左事件流/中线程/右 agent+DoD/底看板） | ❌ 现在是顶部导航 + 独立页面（**用户明确要求**，非疏漏） |
| `ThreadView` 按切片分 Tab | ⚠️ 我们按**真线程**分 Tab，不是切片 |
| Zustand | ⚠️ 换成 `useSyncExternalStore` 手写 store（功能等价） |
| 首连推 `swarm_snapshot` 全量 | ⚠️ 改成"进页面 REST 拉全量 + WS 只推增量" |
| 断线续传 offset | ✅ 用 `seq`（等价） |

### C9. 部署件（M6，全缺）
- systemd unit、Dockerfile、备份脚本
- 静态托管 `simple-swarm-web/dist`（生产单端口）
- 认证（PLAN 说本地不需要，但确实也没做）

### C10. 运维健壮性
- 事件文件按月切分 + gzip 归档
- worker 崩溃自动重启（没有 worker，无从谈起）
- fsync 保证落盘
- 多机扩展（PLAN 说阶段 3，**不算缺口**）

---

## D. 实现里有、方案里没写（13 处补充）

| # | 补充项 | 说明 |
|---|---|---|
| D1 | `names.ts` 500 个英文名字池 | PLAN §6.6 只说"预置名字池"，没给实现方式 |
| D2 | CORS 放行 | 两份方案都没提；局域网前端 4173 调 8787 必需 |
| D3 | `activity` 字段（0~1 活跃度） | 两份方案都没有，前端排序用 |
| D4 | **AgentInfo 5 → 18 字段** | 两份方案都只有 `nickname/status/token_count/cost_usd/last_seen` |
| D5 | `/api/agents/:name`、`/api/agents/:name/events`、`/api/search` | 方案里没有全局搜索 |
| D6 | `trace.status: ok\|error` + 失败分类 | 方案没提失败可观测性 |
| D7 | store 的 WS 退避重连 + `since` 补拉 + 按 id 去重 | PLAN 只说"断线重连补拉"，没细化 |
| D8 | `smoke.ts` / `ws-check.ts` / `e2e.ts` 三个自检脚本 | 两份方案**都没有测试计划** |
| D9 | `seed.ts` 演示数据播种 | 方案没有；为了让前端先能看 |
| D10 | WS 的 `hello` / `catchup` + 30s 心跳 | PLAN 提了心跳，没提这两个消息 |
| D11 | `HOST` 环境变量、`SEED_ON_BOOT` 开关 | PLAN 只写了 `PORT` / `SWARM_HOME` |
| D12 | 消息按 id 去重、`before` 游标分页 | PLAN 提了分页，没提去重 |
| D13 | 事件文件**按天**切分 | PLAN §10 写的是"按月切分" |

---

## E. 里程碑对账

### PLAN 的里程碑

| 阶段 | 方案要求 | 实际 |
|---|---|---|
| M1 | 脚手架 + EventStore + 只读 API | ✅ **完成**（超出：18 字段 agent、搜索） |
| M2 | WS 推送 + 生命周期(create/**start/stop**) + 前端切 live | ⚠️ **半完成**：WS ✅ / create ✅ / 前端 live ✅ / **start·stop ✗** |
| M3 | Agent worker + SwarmKit（mock LLM） | ❌ **未开始** |
| M4 | Budget + DoD + 冲突仲裁 | ⚠️ 只有**冲突检测**（无策略层）；Budget ✗ DoD ✗ |
| M5 | LLM Gateway 接真模型 | ❌ 未开始 |
| M6 | 部署件 | ❌ 未开始 |

### DESIGN 的路线图

| 阶段 | 方案要求 | 实际 |
|---|---|---|
| P1 | Fastify + SQLite + WS + SwarmKit | ⚠️ Fastify ✅ WS ✅ **SQLite ✗ SwarmKit ✗** |
| P2 | Worker Threads + LLM 循环 + bash/file 工具 | ❌ 未开始 |
| P3 | 消息总线 + claim/**complete** + 预算 + DoD | ⚠️ 消息总线 ✅ claim ✅ **complete ✗ 预算 ✗ DoD ✗** |
| P4 | 前端控制台（列表+工作台+事件流+预算+线程+看板） | ✅ **完成并超出**（agent 窗口 + 全局搜索） |
| P5 | 打磨（死锁/超时/重连/并发锁/对抗验证） | ❌ 未开始 |

---

## F. 最要紧的 5 个

1. **没有 Agent** → 系统不"活"。所有界面数据都是种子。
2. **没有预算控制** → 一旦接了真模型，**没有任何东西阻止烧钱无上限**。这是唯一"会造成真实损失"的缺口。
3. **没有 DoD / 终止条件** → 跑起来不会自己停，只能人工 kill。
4. **没有切片实体** → 看板、切片状态机、`complete_slice` 全部做不了；现在认领是字符串。
5. **`MessageData.time` 是本地时钟字符串**，与 PLAN 的"UTC 存储、展示转本地"冲突 → 越晚改越痛。

---

## G. 建议的顺序

```
① 补 M2 欠账：swarm.started + start/stop/complete 接口（半天）
② M3：Agent Runner + SwarmKit + MOCK_LLM 脚本化 agent（真正让系统活起来）
③ 紧接 M4 的预算：在 ② 里就要带 token 记账 + 熔断（别等，否则一接真模型就失控）
④ 切片实体化：把 slice 从字符串升成 {id, name, status, claimedBy}（看板随之可做）
⑤ 时间格式统一：MessageData 加 ISO 字段，time 降级为展示派生
⑥ 再回 M5 真模型 / M6 部署件
```

> 注：④ 和 ⑤ 不是"方案要求"，是**改起来成本随时间上升**的两处，建议早做。
