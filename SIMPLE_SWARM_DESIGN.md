# Simple Swarm System 设计方案

> 多智能体协作平台 —— 让一群 AI Agent 像团队一样自主工作、直接沟通、共享资源、协同交付。

---

## 1. 项目概述

**Simple Swarm System** 是一个去中心化的多智能体协作平台（P2P Agent Swarm）。它区别于传统"编排者-工作者"的层级多智能体框架，采用**扁平化对等拓扑**：没有中央调度器，每个 Agent 地位平等，可以主动发起协作、认领任务、直接通信，并共享同一预算池，按"完成定义（DoD）"协同收敛到一个可交付成果。

### 1.1 核心设计目标
| 目标 | 说明 |
|------|------|
| **去中心化** | 无中央编排器，Agent 对等发消息、自主认领 | 
| **可观测** | Web UI 实时展示事件流、Token、预算、线程 |
| **自治收敛** | Agent 自行起名/认领切片，输出 `done` 结束 |
| **全局预算** | 共享预算池，防无限消耗，预算耗尽即终止 |
| **协同交付** | DoD 明确，"全员 done + 对抗性验证"才最终停止 |

### 1.2 运行环境
- 目标平台：Node.js 18+ LTS（兼容 Termux / Android 环境）
- 单机部署、低资源占用
- 前端 + 后端 + 内置消息总线，一键启动的 Web 控制台

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│                        前端 Web UI                         │
│  Swarm 总览 · Thread 线程 · Agent 列表 · 事件流 · DoD 面板  │
└───────────────────────────────┬────────────────────────────┘
                                │  WebSocket (实时推送)
                                ▼
┌────────────────────────────────────────────────────────────┐
│                     后端 Swarm Core                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ SwarmManager │ │BudgetControl │ │ DoD Monitor     │    │
│  └──────────────┘ └──────────────┘ └──────────────────┘    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ EventLogger  │ │  Message Bus │ │ Slice Generator  │    │
│  └──────────────┘ └──────────────┘ └──────────────────┘    │
│  ┌────────────────────────────────────────────────────┐    │
│  │              SQLite (可选持久化)                    │    │
│  └────────────────────────────────────────────────────┘    │
└───────────────────────────────┬────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────┐
│                   Agent 工作线程集群                        │
│  [Agent-01] [Agent-02] [Agent-03] ... [Agent-N]            │
│    ▲            ▲            ▲             ▲               │
│    └────────────┴────────────┴─────────────┘               │
│                  共享文件工作区 (Workspace)                  │
└────────────────────────────────────────────────────────────┘
```

**核心思想**：单进程内通过 Worker Threads 承载多个 Agent，所有 Agent 运行在同一进程内，通过内存队列共享消息总线，天然单机高效、无需跨进程网络。SQLite 可选用于持久化。

---

## 3. 后端设计

### 3.1 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 运行时 | Node.js 18+ LTS | Termux 下最稳定、生态成熟 |
| HTTP 框架 | Fastify | 高性能、原生插件化、TypeScript 友好 |
| 实时通信 | @fastify/websocket | 原生 WebSocket 支持 |
| 数据持久化 | better-sqlite3 | 单文件轻量、同步 API 简单、Termux 可用 |
| 并发模型 | worker_threads | 多 Agent 并行但不带进程级开销 |
| LLM 接入 | OpenAI SDK / fetch | OpenAI 兼容协议，支持任意 baseURL+key |

### 3.2 数据模型（SQLite Schema）

```sql
-- Swarm 任务实例
CREATE TABLE swarms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  llm_base_url TEXT NOT NULL,
  llm_api_key  TEXT NOT NULL,        -- 生产环境需加密
  llm_model    TEXT NOT NULL,
  budget_usd   REAL NOT NULL,
  prompt       TEXT NOT NULL,        -- 任务提示词（Mission + DoD）
  status       TEXT DEFAULT 'pending', -- pending|running|stopped
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent 实例
CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  swarm_id    TEXT REFERENCES swarms(id),
  nickname    TEXT NOT NULL,         -- 启动时从预置名字池分配并写进提示词，不可自改名
  role        TEXT,                  -- 当前认领的切片名（动态，初始为 NULL，由 claim 写入）
  status      TEXT DEFAULT 'pending',-- pending|talking|working|done
  token_count INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0,
  last_seen   DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 消息（P2P 通信载体）
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  swarm_id     TEXT REFERENCES swarms(id),
  thread_id    TEXT,                 -- 关联的任务切片
  sender_id    TEXT REFERENCES agents(id),
  recipient_id TEXT NULL,            -- NULL = 广播给所有人
  type         TEXT DEFAULT 'message', -- message|claim|system|signoff
  content      TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 事件日志（可观测性）
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id   TEXT REFERENCES swarms(id),
  agent_id   TEXT NULL,
  type       TEXT NOT NULL,          -- bash|edit|think|claim|done|budget
  content    TEXT,
  metadata   TEXT,                   -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 任务切片（看板）
CREATE TABLE slices (
  id          TEXT PRIMARY KEY,
  swarm_id    TEXT REFERENCES swarms(id),
  name        TEXT NOT NULL,
  description TEXT,
  claimed_by  TEXT NULL REFERENCES agents(id),
  status      TEXT DEFAULT 'available', -- available|claimed|completed
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3.3 后端 API 设计

#### REST 端点
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/swarms` | 列出所有 Swarm |
| POST | `/api/v1/swarms` | 创建 Swarm（body: name, prompt, budget, model, agentCount, baseUrl, apiKey）|
| GET | `/api/v1/swarms/:id` | 获取 Swarm 详情（含状态统计）|
| POST | `/api/v1/swarms/:id/start` | 启动 Swarm（生成切片、拉起 Agent 线程）|
| POST | `/api/v1/swarms/:id/stop` | 手动停止 |
| DELETE | `/api/v1/swarms/:id` | 删除 |

#### 实时 WebSocket 通道
连接地址：`ws://<host>:<port>/ws/swarm/:id`

**服务端 → 前端** 事件类型：
- `agent_started` `{agent_id, nickname}`
- `agent_status` `{agent_id, status}`
- `message_new` `{message}`
- `event_log` `{event}`（bash/edit/think 等）
- `budget_update` `{spent_tokens, spent_usd, remaining_usd}`
- `slice_claimed` `{agent_id, slice_id}`
- `slice_completed` `{agent_id, slice_id}`
- `swarm_stopped` `{reason: all_done|budget_exhausted|manual}`

**前端 → 服务端** 事件类型：
- `subscribe` `{swarm_id}`
- `ping`（心跳保活）

---

## 4. 核心模块设计

### 4.1 SwarmKit（注入 Agent 的 P2P 工具集）

这是整个系统去中心化的关键。每个 Agent 被注入一组"对等通信"工具：

| 工具 | 签名 | 说明 |
|------|------|------|
| `list_agents` | `() => AgentInfo[]` | 发现网络中的其他 Agent |
| `send_message` | `(to, content) => Result` | 点对点私聊 |
| `broadcast` | `(content) => Result` | 广播给所有 Agent |
| `read_messages` | `(since) => Message[]` | 拉取新消息（轮询 new_消息）|
| `claim_slice` | `(sliceId) => Result` | 认领任务切片 |
| `complete_slice` | `(sliceId) => Result` | 标记切片完成 |
| `done` | `() => Result` | 输出完成信号 |
| `budget` | `() => {spent, remaining}` | 查询共享预算 |
| `think` | `(content) => void` | 记录思考到事件流 |
| `write_file` / `read_file` | `(path, data) => Result` | 读写共享工作区 |
| `bash` | `(cmd) => {stdout...}` | 执行 shell 命令 |

**消息轮询循环**：每轮 Agent 先 `read_messages()` 获取其他 Agent 的新消息，把新消息拼进上下文，再调用 LLM 决定下一步动作；动作可能是工具调用或输出普通回复，最终产出文件、发送广播、直到输出 `done`。

### 4.2 Agent Runner（执行循环）

```
初始化（身份由 swarm 在提示词里给定，Agent 不自行起名）：
  1. 读入 Mission 提示词 + DoD + 初始看板切片
  2. 读入本次分发给自己的**名字**（已在系统提示词里写死：你是 peliscout，不要改名）
  3. broadcast 声明"我上线了"（只报名字，**不报固定岗位**）

主循环（while not done & budget>0 & 未超时）：
  a. read_messages() → 取回广播 + 私信 + 群聊新内容
  b. 组装上下文（历史 + 新消息 + 看板状态 + 预算）
  c. 调用 LLM → 得到工具调用或回复
  d. 执行工具（含 write/bash/claim/done 等）
  e. 记录 think 事件到 EventLogger
  f. 判断是否满足自身 DoD 切片 → 是则 done()
```

**约束**：单 Agent 最大轮次上限；`read_messages` 轮询间隔可配；超时自动进入"求助广播"模式，防止 Agent 互相等待导致死锁。

### 4.3 Slice Generator（任务切片）

- 初始创建时，控制器先对用户 Prompt 做一次 LLM 调用，让其"把任务拆成无序的任务切片菜单"（bicycle 几何、鹈鹕解剖、构图配色、渲染工具、组装、怀疑验证等）。
- 每个切片写入 `slices` 表，状态 `available`。
- 切片在看板上暴露，Agent 自行认领（`claim_slice`），认领后状态变 `claimed`，归属该 Agent。

### 4.4 BudgetController（预算控制）

- 启动时读取 `budget_usd` 作为共享池。
- 每次 LLM API 返回 `usage` 后，按模型价格换算成本并累计扣减。
- 三档阈值：剩余 20% → 广播"预算警告，加快收敛"；剩余 5% → 广播"紧急，只做关键动作"；剩余 ≤ 0 → 触发 `swarm_stopped(budget_exhausted)`。
- 提供 `budget()` 工具供 Agent 自查节奏。

### 4.5 DoD Monitor（完成定义监测）

- 解析提示词中的 `final_output_file: <path>`，作为交付物硬性校验点。
- 持续监测：目标文件是否生成、是否至少一个对抗性验证事件、两个独立签署（`signoff` 类型消息）是否出现。
- 当 **全部 Agent 都输出 done** 或 **预算耗尽** 时，调用 `stopSwarm(reason)`，广播 `swarm_stopped` 并回收所有线程。

---

## 5. 前端设计

### 5.1 技术选型
| 组件 | 技术 | 理由 |
|------|------|------|
| 框架 | React 18 + TypeScript | 类型安全、生态成熟 |
| 构建 | Vite | 秒级 HMR、开箱即用 |
| 样式 | Tailwind CSS + Headless UI | 原子化、快速布局 |
| 状态 | Zustand | 轻量、devtools 友好 |
| 实时 | WebSocket API | 原生低延迟 |

### 5.2 前端路由与页面结构

```
/                    → Swarm 列表页（Dashboard 卡片）
/:swarmId            → Swarm 工作台（单任务指挥室）
  ├─ 顶栏: 名称 / 模型徽章 / 预算进度 / Token / 运行时长
  ├─ 左侧: 实时事件流（Raw Event Trace，滚动）
  ├─ 中部: 任务线程视图（按切片分 Tab 的聊天 + 动作）
  ├─ 右侧: Agent 列表（状态/角色/成本） + DoD 面板
  └─ 底部: 任务看板（切片认领状态）
/:swarmId/threads/:threadId → 聚焦单个线程讨论
```

### 5.3 核心组件

**SwarmDashboard**
- 展示 Swarm 名称、当前模型、总 Token、花费、运行时长
- 预算进度条（剩余/总数）

**BudgetMeter**
- `剩余 $ / 总 $` + 百分比
- 三档颜色（绿/黄/红）

**EventTrace**
- 所有 `event_log` 滚动列表
- 按类型着色：`bash`(蓝)、`edit`(紫)、`think`(灰斜体)、`claim`(绿)、`done`(金)

**ThreadView**
- 按切片分 Tab（如 `PELICAN ANATOMY`、`BICYCLE GEOMETRY`）
- 每条消息显示发送者昵称 + 类型徽章 + 时间
- 支持 `@nickname` 高亮

**AgentList**
- 所有 Agent 昵称 + 当前状态色点
- 点击展开详情（角色、Token、成本、最近动作）

**DoDPanel**
- 固定显示 `final_output_file` + 完成 checklist
- 显示当前已完成/总条件、独立签署数、对抗性验证状态

**SliceBoard（看板）**
- Kanban 三列：available / claimed / completed
- 每卡片显示切片名 + 认领人

### 5.4 状态管理

```typescript
interface SwarmStore {
  swarms: Record<string, SwarmMeta>;
  current: {
    events: Event[];                // 事件流
    threads: Record<string, Thread>; // 线程 -> 消息
    agents: Record<string, Agent>;  // Agent 状态
    slices: Slice[];                // 看板
    budget: {spent: number; remaining: number};
    status: string;
  };
  ws: WebSocket | null;
  actions: { 
    connect(id, onEvent), disconnect, 
    createSwarm, startSwarm, stopSwarm, sendMessage
  };
}
```

### 5.5 实时协议

- 进入工作台即 `connect(swarmId)` 建立 WebSocket
- 首次连接受 `swarm_snapshot`（历史事件/线程/Agent/切片全量）
- 之后增量接收 `event_log` / `message_new` / `budget_update` 等
- 断线自动重连 + 断点续传（用累计 offset 补齐缺失事件）

---

## 6. 端到端流程

### 6.1 创建与热启动
1. 用户在 Web UI `创建任务`：填 baseUrl / apiKey / model / 预算 / 提示词 / Agent 数量
2. POST `/api/v1/swarms` → 落库 `pending`
3. 点击 `启动` → POST `/start` → Slice Generator 拆切片、为每个 Agent 置一个 Worker Thread 注入 SwarmKit、广播 mission
4. Agent 热启动：看板认领、自起名、声明分工 —— 前端实时看到 nick 与 claim 冒出

### 6.2 协作执行
- Agent 循环 `read_messages → LLM → 工具`，写共享文件、执行 bash、私聊/广播、互 @ 协商
- 前端事件流实时滚动；预算按调用实时扣减
- 出现 `doubtter`/`skeptic` 角色做对抗性验证，产生独立签署

### 6.3 终止交付
- 各 Agent 满足自身 DoD 后输出 `done`
- 全部 Agent done 或预算耗尽 → DoD Monitor 触发 `swarm_stopped`
- 前端显示完成报告 + 产出物链接

---

## 7. 开发路线图

| 阶段 | 内容 | 交付 |
|------|------|------|
| **P1** | 后端骨架：Fastify + SQLite + WebSocket + SwarmKit | 能创建/启动单 Agent |
| **P2** | Agent 核心：Worker Threads + LLM 对话循环 + bash/file 工具 | 单 Agent 完整闭环 |
| **P3** | 通信与切片：消息总线、claim/complete、预算控制、DoD Monitor | 多 Agent 协作跑通 |
| **P4** | 前端：列表页 + 工作台 + 事件流 + 预算 + 线程 + 看板 | Web 控制台可观测 |
| **P5** | 打磨：死锁/超时/重连/并发文件锁、对抗验证流程 | 生产可用 |

---

## 8. 关键挑战与对策

| 挑战 | 对策 |
|------|------|
| Agent 互相等待死锁 | `await_response`/`read_messages` 设超时；超时转广播求助 |
| 文件并发冲突 | 文件锁 + 切片归属隔离工作区子目录 |
| Token 爆炸 | 小步快跑（shallow loops）；预算三档预警；轮次上限 |
| 上下文膨胀 | 每轮只注入"新消息 + 摘要"，旧历史压缩 |
| 冷启动过热 | 拆切片的初始 LLM 调用单独一次；后续可复用 |
| 终端资源（Termux） | 单进程 worker_threads；SQLite 单文件；避免 Redis |

---

## 9. 目录约定（未来实现参考）

```
swarm-factory/
  server/            # 后端
    index.ts
    db.ts            # SQLite 初始化
    swarmManager.ts
    budget.ts
    dodMonitor.ts
    sliceGenerator.ts
    ws.ts            # WebSocket 路由
    agentRunner.ts   # Worker Thread 逻辑
    swarmkit.ts      # 注入 Agent 的工具实现
  web/               # 前端
    src/
      pages/         # 列表页 / 工作台 / 线程页
      components/    # Budget/Event/Trace/Thread/Agent/DoD/SliceBoard
      stores/swarmStore.ts
      ws/client.ts   # WebSocket 客户端
  shared/            # 前后端共用类型（事件/API 类型）
```

---

> 本方案聚焦前端 + 后端架构设计，暂不写代码。如需，下一步可按 P1 开始搭建后端骨架、或先选定某个模块细化。
