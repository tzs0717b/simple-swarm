# 消息系统邮箱化 — 设计方案

> 目标：把消息通信从「线程广播公告板」改造成「**邮箱投递**」，让 `peliscout@swarm.org` 从**显示格式**变成**真实地址**。
> 约束：**已实现的当基础**（事件溯源 + 投影 + REST + WS + 前端），**不推倒重来**，并与 `BACKEND_PLAN.md` / `SIMPLE_SWARM_DESIGN.md` 结合。
> 前置阅读：`IMPL_VS_PLAN.md`（37 处差异清单）

---

## 0. 先划清：什么不动、什么要动

### 不动的（基础，直接复用）

| 资产 | 为什么能复用 |
|---|---|
| append-only JSONL 事件日志 + `seq` | 邮件投递状态**本身就是事件**（已读/归档/退回），天然契合 |
| 内存投影 + 快照 + 重放 | 邮箱索引是**派生数据**，重放即可重建，不需要独立数据库 |
| Fastify + zod + ws（3 个纯 JS 依赖） | 邮箱 REST 与 WS 订阅用同一套 |
| 前端 `api.ts` / `store.ts` / `useSyncExternalStore` | 通过兼容层，**线程页/智能体页/搜索页零改动** |
| `names.ts` 名字池、CORS、seed、三个自检脚本 | 直接沿用 |
| `MessageData` 的 `time`/`kind`/`chars` 契约 | 邮件投影回 MessageData，前端不感知 |

### 要动的

| 资产 | 怎么动 |
|---|---|
| `MessageData` | 加 `to` / `cc` / `subject` / `replyTo`（可选，向后兼容） |
| 事件类型 | 新增邮件类事件；`message.posted` **降级为兼容简写**（只读不写） |
| `eventstore.ts` | 加 `mails` 存储 + `mailboxes` 索引 |
| `routes-write.ts` | 发消息 → 内部转成**发信**（兼容层） |
| `ws.ts` | 新增订阅目标 `mailbox:<地址>` |
| 前端 | 新增「邮箱」页组；线程页保持原样 |

### 核心不变量

> **一份邮件只存一份，但投递到 N 个邮箱索引。**
> 存储不放大，查询不变慢，一致性天然保证。

---

## 1. 为什么邮箱模型值得做（它补上了现在的真实缺口）

| 现有缺口（见 IMPL_VS_PLAN） | 邮箱模型怎么解决 |
|---|---|
| **B7：没有 `recipient_id`，不能私聊** | `to: ["peliscout@..."]` → 点对点私信 |
| **没有投递/已读语义** | `mail.read` 事件 + 回执 → UI 能看到"谁读了" |
| **离线 agent 无明确语义** | 邮件躺在收件箱里，agent 重启后 `read_inbox(since)` 接着读 |
| **C7：切片认领只是字符串** | 认领 = 给 `board@<swarm>` 发一封带 `kind:"claim"` 的信，可查可审 |
| **没有邮箱这一层可观测对象** | 前端多一个「邮箱」视图：未读数、积压、风暴一眼可见 |
| **人类插话混在消息流里** | 人类有独立地址 `human@<swarm>`，可只给某人发、可群发 |

**这不是为了好看** —— 它把"谁发给谁、谁读了、谁没读"变成**一等数据**，而多智能体系统最容易失控的地方恰恰是通信量。

---

## 2. 地址与邮箱模型

### 2.1 地址

**每个集群是一个邮件域**（推荐，见 §10 决策 2）：

```
完整地址:  peliscout@perfect-pelican.swarm
同域内显示: peliscout                          ← 界面里就显示成这样
跨域显示:   peliscout@perfect-pelican.swarm
```

| 地址 | 含义 | 谁能收 |
|---|---|---|
| `all@<swarm>.swarm` | 集群全员（智能体 + 人类 + 系统） | 所有人 |
| `agents@<swarm>.swarm` | 仅智能体 | 所有 agent |
| `humans@<swarm>.swarm` | 仅人类操作者 | 人类 |
| `system@<swarm>.swarm` | 系统通知（goal、DoD、预算告警） | 所有人，只读 |
| `board@<swarm>.swarm` | 任务看板（认领/完成/冲突） | **共享邮箱**，所有成员可读 |
| `human@<swarm>.swarm` | 人类操作者 | **共享邮箱**（当前每集群一个，未来按人拆） |
| `<name>@<swarm>.swarm` | 单个成员 | 该成员 |

**保留字（重要）**：`human` / `system` / `board` 是共享邮箱的 local，**永远不能同时充当某个智能体的私人地址**。
- `names.ts` 的 `pickNames` 已把它们从名字池里剔除（第二道保险）
- `mailboxesFor` 跳过保留字名字（否则会覆盖共享邮箱）
- 现实踩坑：种子数据里 perfect-pelican 有个叫 `system` 的叙述者 → 它落在 `system@` 共享邮箱上，不建个人邮箱

> **域隔离解决了一个真问题**：名字池只保证**同集群内**不重名，跨集群允许重复。用域隔离，`peliscout@A.swarm` 与 `peliscout@B.swarm` 是两个不同地址，不会串信。

### 2.2 三个概念的关系（关键）

```
                 ┌──────────── 一封邮件 ────────────┐
                 │ from / to[] / cc[] / subject /   │
                 │ body / threadId / replyTo        │
                 └───────────────┬──────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
      ┌───────────────┐                    ┌───────────────┐
      │  邮箱视图      │                    │  线程视图      │
      │  「投递记录」  │                    │  「完整档案」  │
      ├───────────────┤                    ├───────────────┤
      │ 只显示**发给  │                    │ 显示该会话    │
      │ 我的**邮件    │                    │ **全部**邮件  │
      │ 有未读/归档   │                    │ 不过滤收件人  │
      │ 收件箱/已发送 │                    │ 按时间正序    │
      └───────────────┘                    └───────────────┘
```

**同一条邮件的两个视图，不是两套数据。**

这条规则顺带解决了一个棘手问题：**新加入的 agent 能不能看到历史广播？**
- 邮箱视图：看不到（广播发出时它不在场 —— 像邮件列表 archive）
- 线程视图：看得到（它是完整档案 —— 像聊天记录）

所以 agent 的读循环是：**线程档案找上下文，邮箱收件箱找新活。**

---

## 3. 存储模型：一份存储 + N 份索引（推荐）

### 3.1 对比

| | 方案 A：物理副本（真邮箱） | **方案 B：一份存储 + N 索引（推荐）** |
|---|---|---|
| 存储 | 一条邮件 × N 个收件人 = N 份 | **1 份** |
| 一致性 | 改一份要同步其它 N 份 | 天然一致 |
| 存储放大 | N× （20 agent 群发 → 20 倍） | 1× + 索引（约 3% 体积） |
| 删除/撤回 | 要遍历所有副本 | 改索引 |
| 查询速度 | 直接读自己邮箱 | 直接读自己邮箱（索引已建好） |
| 与现有事件溯源 | 要引入"副本 id"，历史事件难兼容 | **完美契合**（索引可由重放重建） |

**结论：方案 B。** 索引在**投影时**建立 —— 收到 `mail.sent` 时：

```
1. mails.set(mailId, mail)                      ← 唯一一份
2. 发件人邮箱加一条: folder="sent",   read=true
3. 每个解析后的收件人邮箱加一条: folder="inbox", read=false
4. 每个收件人 unread++ ; total++
```

**索引条目很小**：
```ts
interface MailEntry {
  folder: "inbox" | "sent" | "archive" | "trash";
  read: boolean;
  readAt: string;
  starred: boolean;
}
```

### 3.2 通配地址在投影时展开（"发给当时在场的人"）

`to: ["all@perfect-pelican.swarm"]` 在投影时按**当时的成员名单**展开成 N 个索引项。
邮件本身仍存 `to: ["all@..."]` 原样（可审计、可回放）。后加入的成员邮箱里没有这封（符合邮件语义）。

### 3.3 数据结构

```ts
interface MailData {
  id: string;          // "m-<seq>"
  swarmId: string;
  from: string;        // 完整地址
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  chars: number;
  kind: MessageKind;   // 复用现有 9 种 + 新增 "claim" 语义
  threadId: string;    // 会话容器（保留！）
  replyTo: string;     // 上一条 mailId，空 = 新会话
  time: string;        // "17:02:07"（保持现有前端契约）
  at: string;          // ISO（事件信封已有）
  seq: number;
}

interface Mailbox {
  address: string;
  swarmId: string;
  owner: string;                       // agent 名 / "human" / "list"
  kind: "agent" | "human" | "list";
  unread: number;
  total: number;
  sent: number;
  entries: Map<string, MailEntry>;     // mailId → 条目
}
```

---

## 4. 事件类型（在现有 11 种上增补）

### 新增

| 事件 | 载荷 | 用途 |
|---|---|---|
| `mailbox.created` | `{swarmId, address, owner, kind}` | 开邮箱（建集群/加人时自动） |
| `mail.sent` | `{mail: MailData}` | **发信**（替代 `message.posted` 作为新写入） |
| `mail.read` | `{mailId, reader, at}` | 已读回执 |
| `mail.moved` | `{mailId, owner, folder}` | 归档 / 删除 / 移回收件箱 |
| `mail.starred` | `{mailId, owner, starred}` | 星标 |
| `mail.bounced` | `{mailId, recipient, reason}` | 退信（地址不存在） |
| `mail.rate_limited` | `{swarmId, owner, window, limit}` | 触发限流 |
| `mail.quota_exceeded` | `{swarmId, owner, unread, limit}` | 收件箱积压超限 |

### 保留但降级

| 事件 | 新身份 |
|---|---|
| `message.posted` | **兼容简写**：等价 `mail.sent` 且 `to=["all@<swarm>"]`。**历史事件照常重放**，新代码不再写它 |

> **零迁移**：现有 129 条 `message.posted` 在重放时投影成广播邮件，进所有人的收件箱 + 发件人已发送。历史 JSONL 一个字节都不用改。

---

## 5. 接口

### 5.1 REST（新增）

```
GET    /api/mailboxes                          集群内所有邮箱概要（未读/总量）
GET    /api/mailboxes/:address                单个邮箱概要
GET    /api/mailboxes/:address/mails          收件箱/已发送/归档
         ?folder=inbox|sent|archive|trash &unread=1 &before=<mailId> &limit=
GET    /api/mails/:mailId                     单封邮件 + 投递回执（谁已读/谁未读）
POST   /api/mails                             发信
         body: {from, to[], cc[], subject, body, swarmId, threadId?, replyTo?}
POST   /api/mails/:mailId/read                标记已读  {reader}
POST   /api/mails/:mailId/folder              归档/删除  {owner, folder}
POST   /api/mails/:mailId/star                星标      {owner, starred}
```

### 5.2 兼容层（**现有前端零改动**）

```
POST /api/swarms/:id/threads/:tid/messages   ← 原样保留
     内部转成: mail.sent { from: agent, to: ["all@<swarm>"], threadId: tid }
     响应仍是 MessageData（投影回去）

GET  /api/swarms/:id/threads/:tid/messages   ← 原样保留
     返回该线程**全部**邮件，投影成 MessageData
```

### 5.3 WS

```
客户端 → 服务端
  { "sub": "swarm:<id>" }           整个集群（现状不变）
  { "sub": "mailbox:<address>" }    ★新增：只收发给我这个邮箱的
  { "since": <seq> }                补拉
  { "type": "ping" }

服务端 → 客户端
  mail.sent（带 recipient 视角）/ mail.read / mail.bounced
```

### 5.4 SwarmKit 工具（替代原方案的 `send_message`/`broadcast`/`read_messages`）

```ts
list_mailboxes()                    → Mailbox[]        // 通讯录（替代 list_agents）
read_inbox(since?)                  → Mail[]            // 只读我自己的新邮件
read_mail(mailId)                   → Mail
send_mail(to[], cc[], subject, body) → {mailId}         // 发信（点对点）
reply(mailId, body)                 → {mailId}         // ★默认只回发件人，不 reply-all
broadcast(subject, body)            → {mailId}         // = send_mail(["all@..."])
mark_read(mailId)                   → void             // 回执
archive(mailId)                     → void
```

对比原方案（`SIMPLE_SWARM_DESIGN` §4.1 的 `send_message(to, content)` / `broadcast` / `read_messages`）：
**语义完全兼容，只是把"内容"升级成"带主题与收件人的邮件"，并把 `read_messages` 换成邮箱语义的 `read_inbox`。**

---

## 6. 防风暴（**邮箱模型的最大风险，必须与邮箱同批上线**）

### 为什么危险

N 个 agent 都"回所有人" 是最经典的组合爆炸：

```
20 个 agent，每人每轮广播 1 封  →  20 封/轮
每封进入 20 个收件箱            →  400 次投递/轮
若 agent 看到别人广播后再回一封  →  O(N²) 增长
再叠加 LLM 调用                 →  直接烧穿预算
```

**这不是理论风险**：`reply-all` 就是人类邮件史上最著名的自伤机制。多智能体场景下它会被自动化放大。

### 四道闸（全部在 M3 一起做）

| 闸 | 规则 | 违约事件 |
|---|---|---|
| **默认不 reply-all** | `reply()` 只回原发件人；要群发必须显式写 `to: ["all@..."]` | — |
| **发信限流** | 每 agent 每分钟 ≤ 12 封；人类与 `system` 不受限 | `mail.rate_limited` |
| **收件箱配额** | 未读 ≥ 400 → **拒绝继续投递**，要求先读 | `mail.quota_exceeded` |
| **广播合并** | 同一线程 30s 内的重复广播合并为一条（显示"3 条新广播"） | — |
| **集群硬闸** | 全集群 ≤ 300 封/分钟 → 触发 `swarm.paused` | `swarm.paused` |

> 与 M5 预算控制**互补**：预算管"花了多少钱"，限流管"消息有多少"。多智能体系统两个都得有。

### 4.3 实现记录：第一次真实使用暴露的两个问题（用户跑了 hello world 之后）

用户在界面上真跑了一个集群，暴露出一个 bug 和一个观感问题 —— **真实使用才是最好的测试**：

| 问题 | 根源 | 修法 |
|---|---|---|
| 集群卡片「消息 1」，线程里明明 11 条 | `SwarmData.messages` 是**死字段**：只在 `createSwarm` 时设过 1，之后再没人更新 | 投影层 `mail.sent` → `swarm.messages + 1`，`createSwarm` 从 0 起步。现在 `SwarmData.messages ≡ 本集群 mail.sent 总数`，重放安全 |
| 回信复读机 +「未分配」+ 总被"发信上限"硬拦收工 | 回信模板是固定一句话，两人互相回信直到 `maxMails` 打满 | ① 回信**引用对方消息原文**；② 没认领切片时如实说"还没认领"，不再「未分配」；③ `maxReplies` 4→2，让 agent 以「已交付并汇报」自然收工 |

**修复前后同一个 hello world 对比**（2 智能体、预算 \$2）：

| | 修复前 | 修复后 |
|---|---|---|
| 步数 / 花费 | 15 步 / \$0.1261 | 11 步 / \$0.0829 |
| 集群卡片消息数 | 1（错） | 7（= 线程实际条数） |
| 收工理由 | 两人都是「已达到发信上限 5 封」 | 两人都是「已交付并汇报」 |
| 回信内容 | 每封一模一样的模板话 | 引用对方原文 |
| 真实撞车 | ✅ 有 | ✅ 仍有（luke 抢下需求拆解，scott 撞了换关键实现） |

全量 6 项自检在投影改动后重跑全绿。

### 4.0 实现记录：删掉假种子（M4 之后做的收尾）

**删了什么**：`src/seed.ts`（732 行）。它编了 4 个集群、24 个智能体、8 个房间、129 条消息、
180 条行为事件，还有一堆成本数字。它存在的唯一理由是 M2 时"让前端切到 API 后视觉不变"。

**为什么必须删**：它让界面**看起来**像智能体干了活，而实际上没有任何循环产生过那些事件。
有了 M4，真跑一轮只要一秒、不花钱 —— 继续留着假数据就是在骗自己。

**删了之后**：
- 事件库为空就是空的（`/api/health` 的 `events=0`）。界面上的每一条都得是真跑出来的。
- 前端的空态改成上手引导：① 新建集群 ② 点「▶ 跑起来」。

**自检怎么活下来的**：新增 `scripts/fixture.ts`。关键点是它**一行编造数据都没有** ——
造现场只走真实代码路径：

| fixture 动作 | 走的真实路径 |
|---|---|
| 建集群 | `src/swarm.ts` 的 `createSwarm()`（和人类点「新建集群」同一个函数） |
| 跑起来 | `AgentRunner` + `MockBrain`（和界面点「▶ 跑起来」同一套） |
| 发信 | `POST /api/mails`（和人类插话同一个接口） |

所以自检里的数据本身就是系统跑出来的 —— **检查行为 = 检查系统**，而不是检查数据长相。
为此把 `createSwarm` 也抽成了独立模块（第三个"唯一实现"，前两个是 `sendMail` / `takeSlice`）。

**顺带发现的几处"检查本身在说谎"**（都是删种子才暴露出来的）：

1. `smoke` 里搜索自检搜的是种子里的词 `pelican` → 现在 fixture 的目标文本里带一个
   唯一 token，搜自己的数据。
2. `mail-check` 有一条 `房间成员看到的 == 房间全部消息`，**只在"房间里每封都发给所有人"时才成立**。
   种子数据是 `message.posted`（投影成"发给全体成员"）所以碰巧成立；M4 之后闸 1 生效
   （回信只发给原发件人），公开房间里真的会有只投给一两个人的信。
   → 改成正确的不变式：**成员视图是房间档案的子集**（精确对齐由"逐封等于投递记录"那条保证）。
3. `storm-check` 里 `账本 mail.sent 数 == 灌进去的封数` —— 现在 fixture 建集群会各发一封
   **目标信**，所以要把那 3 封算出来（这本身也成了一条更有意义的断言）。
4. 我的批量改名把几处**字符串字面量**里的集群名也换了（`"FIXTURE"` / `/api/swarms/FIXTURE/...`），
   变成查不到的路径 → 一堆 404 假失败。教训：批量替换要区分标识符和字面量。

**新的清库命令**：`npm run reset`。

### 4.1 实现记录：Agent Runner（M4）

**循环的形状**（M8 接真模型时一行都不改，只换 `decide()` 的实现）：

```
decide(账本现状) → 调一个 SwarmKit 工具 → 观察结果写进行为流 → 记账 → 下一轮
```

| 文件 | 职责 |
|---|---|
| `src/agent/tools.ts` | SwarmKit 10 个工具。智能体**不能直接改状态**，只能调工具；工具落事实 + 返回一段文本观察结果 |
| `src/agent/brain.ts` | `Brain` 接口 + `MockBrain`（确定性 if-else）+ `LlmBrain`（M8，现在故意抛错） |
| `src/agent/runner.ts` | 循环 + 三条硬闸 + 记账。`turn()` 一次 = 一个工具调用 |
| `src/send.ts` | **发信的唯一实现**。人类的 `POST /api/mails` 和智能体的 `send_mail` 走同一条路 |
| `src/claims.ts` | **认领的唯一实现**。路由和工具共用，冲突判定只写一遍 |
| `POST /api/swarms/:id/run` | 跑一轮，同步返回报告 |

**为什么把 sendMail / takeSlice 抽出来**：抽之前，如果只给智能体新写一套发信，
那"agent 绕过了人类那条路上的限流"这种洞迟早会出现。现在两边物理上不可能跑偏 ——
agent-check 的 [6] 段专门验了这件事（把集群灌到 300 封/分，智能体一发信就撞上风暴闸）。

**MockBrain 的策略**（从上往下第一个成立的说了算）：

1. 有未读、还没回够、还没发满 → 回最老的那封
2. 我没切片 → 认领（**偏好顺序从 slices[0] 开始，所以第二个人真的会撞上第一个人的片**）
3. 我有切片、还没汇报 → 发一封汇报给 all@
4. 其余 → `done()`

**撞车不是安排好的**：Runner 一轮一轮顺序跑，而所有智能体的偏好都从第一片开始 ——
所以第二个人的 `claim_slice` 真的会撞上 409 + `collision.detected`，然后按 `myLostSlices`
换下一片。这是**真实竞争的结果**，不是脚本。自检里验的就是这条。

**三条硬闸**（少任何一条都会烧钱/烧时间）：

| 闸 | 防什么 |
|---|---|
| `maxTurns` 每智能体最多 N 步 | 死循环 |
| `maxMails` 每智能体最多 N 封 | **回信乒乓**（A 回 B、B 回 A，能对轰一整天） |
| 预算 >= budget 就停 | 烧钱 |

**踩到的坑（都是自检自己错，不是系统错）**：

1. **账本异步落盘**：事件先更新内存投影，JSONL 排队写。自检写完就去读文件，
   读到半截账本 → 报了一堆假失败（"通信是假的""收工 0 次"）。
   修法：读文件前先轮询等 `health.events` 追平文件行数。
2. `/api/agents` 返回**裸数组**，不是 `{agents:[...]}`。

**已知的小瑕疵**：预算是"先检查后花钱"，所以会小幅超出（实测超 $0.0016）。
这跟真实系统一样 —— 花之前不可能知道这一步要花多少。

### 4.2 实现记录：预算记账与熔断（M5）

**余额直接用 token 换算，不接真实计费**（用户决定）。理由：API Key Pool 里有 20 个 provider、
43 把 key，各家价格与计费口径都不同，想算准得给每家写解析器 —— 而我们要的只是"跑超了能刹车"，
不是"账对到分"。

```
花掉的钱 = token 数 × TOKEN_RATE_PER_MTOK / 1e6     // 默认 0.6 美元/百万 token，可设环境变量
```

- **token 是记下来的真数据**（M8 从 API 响应的 `usage` 里抄），**钱是算出来的**。
- `cost` 在落盘时就固定住 → 以后改换算率**不会改写历史账**。
- 每一步落一条 `usage.recorded`；`AgentInfo` 和 `SwarmData` 的 `cost/tokens/calls` 由投影累加。
- 自检验了最强的那条不变式：**接口投影出来的数 == 账本 JSONL 折叠出来的数**。

### 3.6 实现记录（已完成）

| 项 | 落地 |
|---|---|
| 「只看发给我的」 | 房间档案加开关 → `GET .../messages?to=<地址>`，只返回**真的进了你收件箱**的那几封 |
| 语义 | 房间 = 完整档案；这个开关 = 收件箱视角的同一个房间。**不是新页面**，是同一个列表换口径 |
| 判定层 | 后端 `deliveredTo(address, mailId)` 直接查投递索引（`sent` 条目也算 —— 自己发的那封在投递记录里） |
| 短地址 | `?to=human` 自动补上 `@<集群>.swarm`；跨集群地址查不到 → 空列表（域隔离） |
| 智能体详情页 | 每个集群一行：**地址** + `N 未读 / M 收件 / K 已发送`（`GET /api/mailboxes/:address`） |
| 契约 | 新增 `Mailbox` interface（13 字段），纳入 `smoke` 契约自检 |

**为什么人类在这个视图里最重要**：`human` 不在任何公开房间里（房间语义），所以他在公开房间的
「只看发给我的」里**一条都看不到** —— 直到有人真的点名他（`human@` 或 `all@`）。这正是这个开关的用处：
房间档案是整个房间的喧嚣，而这个视图是"确实落到我头上的那几封"。

**踩到并修掉的两个自检反模式**（都会让检查说谎）：

1. **不幂等**：断言写成"human 收件箱必须为空"，第二次跑就被上一轮自己发的信顶掉。改成集合等价
   （视图 == 该邮箱在这个房间的投递记录）与增量（+1 且排在最前）。
2. **漏了 `sent` 目录**：`deliveredTo` 把"自己发的那封"也算投递（发件人有一条 `sent` 条目），
   而对账只用 inbox/archive/trash → 恒不相等。两边口径必须一致。

**还有一个测试本身写错的地方**：`to: ["human@..."]` 且不给 `threadId` 时，"只有一个收件人"
会被自动判成 **2 人私信房间**，信不会落在公开房间里。要往公开房间里点名某人，必须显式给 `threadId`。
这不是 bug，是设计 —— 顺带证明"自动 2 人房间"这条规则真的在生效。

### 3.5 实现记录（已完成）

**闸门放在哪一层，是这一节最关键的判断。**

| 闸 | 判定层 | 为什么 |
|---|---|---|
| 1 默认不 reply-all | **路由**（缺省收件人） | 是"接口默认值"问题：`replyTo` 且没写 `to` → 只填原发件人 |
| 2 每 agent 12 封/分 | **路由**（拒绝 + 落审计事件） | 要能拒绝写入，投影不能拒绝（重放必须能重现同样的状态） |
| 3 未读 ≥400 停投 | **投影**（`projectMail` 里跳过） | 判定依赖"此刻的未读数"，而未读数本身就是投影的产物 → 重放结果完全一致 |
| 4 广播折叠 | **前端**（展示层） | 不丢数据，只把同一房间 30 秒内的连续群发折成一条 |
| 5 集群 300 封/分 → 暂停 | **路由**（拒绝 + `swarm.paused`） | 硬闸，最后一道防线 |

**计数器没有隐藏状态**：`recentSendCount()` 每次从投影里现算，不存额外的滑动窗口数组。
所以快照/重放之后限流行为和崩溃前完全一致 —— 事件溯源系统里，**任何不来自事件的运行时状态都是不能重建的谎言**。

**用的是邮件的 `time` 而不是事件的 `at`**：历史重放出来的老邮件，其事件 `at` 是"播种那一刻"，
拿它算频率会把限流器一次性点着。`time` 则是"这封信在对话里发生在几点"，语义正确。

**闸 5 复用 `stopped` 状态**而不是新增 `paused` 状态值：状态机的四种状态足够表达"它现在不动了"，
而"为什么不动"记在 `swarm.paused` 事件里（原始追踪页可查）。这样不用动前端的状态枚举。

**前端契约新增 `broadcast: boolean`**：`MailData.to` 存的是发件人写的原样，所以"这条是不是群发"
由后端在投影成 `MessageData` 时算好；前端据此把连续广播折叠成「📣 N 条新广播」，点击展开。

**顺带修掉一个会丢数据的快照 bug** 🐛：`snapshot()` 原来写 `this.seq`，而 `append()` 是「先 `++seq` 再 `apply()`」。
某个投影一旦抛异常，`this.seq` 就跑到 `events` 前面；此时按 `this.seq` 写快照，
重载时会跳掉所有 `seq ≤ snapshotSeq` 的日志行，而快照里并没有这些事件 → **静默丢数据**。
实测踩到：快照只有 80 条事件却声称 `seq=82`，677 行日志只重放出 637 条。
修法：`seq` 取「实际持有的事件里的最大 seq」。`storm-check` 里加了断言盯住这个不变式。

---

## 7. 前端

### 新增页面

| 路由 | 内容 |
|---|---|
| `/mailboxes` | 邮箱总览：每个 agent 一张卡片（地址 / 未读 / 收件 / 已发 / 积压条） |
| `/mailboxes/:address` | 单个邮箱：**收件箱 / 已发送 / 归档 / 星标** 四个 tab；未读加粗 + 左侧色条 |
| `/mails/:mailId` | 邮件详情：From / To / Cc / Subject / 正文 / 时间 + **投递回执表**（谁已读、何时） |

### 改动

- `Shell.tsx`：顶部导航加「邮箱」，带**未读角标**（实时）
- `AgentDetailPage`：标题区显示完整地址 `peliscout@perfect-pelican.swarm` + 未读数 / 发件量
- `SearchPanel`：搜索扩展到邮件（按主题/正文/发件人/收件人）
- **线程页 / 智能体页 / 集群页：不动**

---

## 8. 与两份原方案的关系

| 原方案 | 邮箱方案怎么处理 |
|---|---|
| BACKEND_PLAN §2「协作面：agent 之间直接互发消息」 | ✅ **正是本方案**，且补上了原方案缺的"投递给谁" |
| BACKEND_PLAN §6.6 身份与提示词 | ✅ 名字池不变；提示词里加上**自己的地址** |
| DESIGN §3.2 `messages.recipient_id`（NULL=广播） | ✅ 采纳其**意图**；实现为 `to[]` + `cc[]`（支持多收件人，比单个 recipient 更强） |
| DESIGN §3.2 `slices` 表 | ⏳ 仍未做（M6）；但**认领改走 `board@` 邮箱**，比字符串更可审 |
| DESIGN §4.1 `send_message/broadcast/read_messages` | ✅ 升级为 `send_mail/broadcast/read_inbox`，语义兼容 |
| DESIGN §5.2 三栏工作台 | ❌ 保持顶部导航（用户已定） |
| PLAN 的"事件溯源 + 投影" | ✅ 邮箱索引就是一层新投影，**架构不变** |

**结论：邮箱化不是推翻原方案，是把原方案里一直模糊的那句"agent 之间互相发消息"落成明确寻址的投递模型。**

---

### 3.4 实现记录（已完成）

**私信 = 一个只有两个人的私密房间**（不是一种新页面）

| 项 | 做法 |
|---|---|
| 建房间 | `POST /api/swarms/:id/threads`，`visibility: "private"` 时成员必须**正好 2 个** |
| 房间 id | `dm-<两个 local 排序后用 - 拼起来>`（`dm-human-peliscout`）→ **天然幂等**，谁先点谁创建，后来者 200 复用 |
| 房间标题 | `私信 · human ↔ peliscout` |
| 发信 | `POST /api/mails`：给「只有一个收件人」的信**自动找/建**两人的私信房间；发给多人则回落 `primary`（必要时自动建一个 `broadcast` 公开房间） |
| 退信 | 名单外的收件人进 `bounced[]` 并落一条 `mail.bounced` 事件，**其余正常投递**（一封坏地址不拖垮整封信） |
| 已读/归档 | `POST /api/mails/:id/read`（`reader`）、`POST /api/mails/:id/move`（`owner` + `folder`），都校验"这封信确实在你名下" |
| WS | 新增 `mailbox:<地址>` 订阅；默认订阅是 `"*"`，所以客户端要带 `"replace": true` 才能只收自己的信 |
| 前端 | 线程列表给私密房间加 🔒；线程详情徽章跟随 `visibility`；智能体详情页「✉ 发私信」→ 建房间 → 直接跳进去 |

**为什么不做"给人看的邮箱页组"**：你要的是"单个 swarm 点进去就是 thread 一列的页面"，单独的私信在那一列里就是一个新 thread。邮箱是**投递引擎**（发给谁／未读／回执），主要给 AI 的 `read_inbox` 用；人类看到的永远是**房间**。所以原计划里的「邮箱总览／单个信箱／邮件详情」三个页面正式取消。

**顺带修掉两个时间轴问题** 🐛：

1. **演示时钟倒流**：种子里的时间是从各线程 `createdAt` 递增生成的（最晚推到 17:3x），而真实发帖用的是此刻的时钟串。于是新消息带着 `12:xx` 排在 `17:xx` **前面**，看起来像时光倒流。修法：播种时把**所有**时钟字段整体平移，让演示会话正好在「3 分钟前」收工 —— 平移量动态取"演示最晚时点"，因为最晚的那个是算出来的不是写死的。
2. **建集群的目标还是旧格式**：`POST /api/swarms` 里的 goal 消息仍在发 `message.posted`。已改走 `mail.sent`（`from = system@<swarm>`，收件人 = primary 房间全体），现在写路径**完全不产生** `message.posted`，它只剩历史重放这一个用途。

**自检口径的一处修正**：投递数守恒原来按「收件人 = 线程成员」算，遇到两种合法情况会误报 —— 私信房间里有 `human`（共享地址，不在智能体名册里），以及 `all@` 这种**别名**（按集群名册展开，与线程成员无关）。现在改成**逐封邮件按它自己的 `to`/`cc` 对账**，别名按名册展开；而且口径是「**投递**」而非「躺在哪个文件夹」——归档一封信不该让它在账上凭空消失。

### 3.3 实现记录（已完成）

**「发消息」= 「发一封给本线程成员的信」**

| 项 | 做法 |
|---|---|
| 收件人 | **该线程的成员**（房间语义），不是整个集群 |
| 发件人 | `addressOf(发言者, swarmId)`；人类插话就是 `human@<swarm>` |
| 前端 | store 新增 `mail.sent` 分支，投影成 `MessageData`（`agent` = 地址的 local 部分） |
| 历史 | `message.posted` 保留在类型里，仅供旧数据重放；写路径不再产生 |

**为什么是「线程成员」而不是「全集群」**：线程 = 房间。canvas 有 13 个成员，但 `ADVERSARIAL REVIEW` 只有 3 个人 —— 把那 3 个人的讨论投递给全部 13 人是错的。实测投递数从 1377（全集群广播）降到 617（按房间），这才对。

**顺带修掉一个种子老 bug** 🐛：perfect-pelican 的线程成员里混进了 `feather`、`pedal`（其实属于 raytracer）和 `pellet`（不属于任何集群）。
这三个人从未发过言，纯粹是名单占位。修法：
- `pellet` 提升为 perfect-pelican 正式成员（鹈鹕主题的名字，本来就该在）
- `PELICAN ANATOMY + PALETTE` 的 `feather` → `pixelprowl`（配色 owner）
- `BICYCLE GEOMETRY` 的 `pedal` → `skein`（轮辐与车架几何 owner）

替换依据来自 `DEMO_CLAIMS` 里已写好的角色分工。新增断言 **「线程成员必须都是本集群成员」** 防止复发。

### 3.2 实现记录（已完成）

**投影结构（一份存储 + 两个索引）**

```
mail.sent { mail }
   ├─ mails:    Map<mailId, MailData>          唯一一份
   ├─ messages: Map<threadKey, MessageData[]>  线程视图索引（前端契约不变）
   └─ mailboxes: entries: Map<mailId, MailEntry>
        ├─ 发件人 → folder="sent"  (read=true)
        └─ 展开后的每个收件人 → folder="inbox" (read=false)
```

| 要点 | 做法 |
|---|---|
| 通配展开时机 | **投影时**按当时的 `swarm.agents` 展开 —— 广播只发给"在场的人"，逻辑天然可回放 |
| 别名存储 | `to` 里存发件人写的原样（`["all@x.swarm"]`），可审计；展开结果只进索引 |
| 自己发的不进自己未读 | 发件人已有 `sent` 条目 → 收件人循环跳过（也顺带去重） |
| 历史兼容 | `message.posted` → `legacyMail()` → 同一条 `projectMail()` 路径，**老前端零改动** |
| 计数器 | `unread`/`total`/`sent`/`archived`/`trashed`；`entries` 是内部索引，**不出接口**（Map 不能序列化） |

**又踩到一次 `system`**：perfect-pelican 名册里那个叫 `system` 的成员，会被 `all@` 当成个人展开，导致**共享的 system 邮箱被广播塞满**。
修法：`expandRecipients` 里先把保留字从名册剔除 —— 保留字不是"人"，只能通过 `system@` 显式寻址（落在共享邮箱上）。

### 3.1 实现记录（已完成）

| 项 | 落地 |
|---|---|
| 地址 | `<local>@<swarmId>.swarm`，同域内界面显示时省略域名 |
| 解析 | `parseAddress(raw, defaultSwarmId?)` 纯函数；大写归一化；多 `@`／错域／非法 local 一律报错 |
| 别名 | `all` / `agents` / `humans` —— **没有邮箱**，发信时展开成成员地址 |
| 共享邮箱 | `human` / `system` / `board` —— 真实存在，所有成员可读 |
| 开户 | `mailboxesFor(roster, createdAt)`：每个非保留字成员 + 3 个共享邮箱 |
| 展开 | `expandRecipients(raws, roster)` → `{ delivered[], bounced[] }`，去重、名单外退信、跨域退信 |
| 事件 | `mailbox.created { mailbox: MailboxMeta }` |
| 接口 | `GET /api/mailboxes?swarmId=`、`GET /api/mailboxes/:address`（带 `shortName`） |
| 自检 | `npm run mail-check`（51 项：纯函数单测 + 真实接口） |

**跨域投递暂不支持**（`ana@raytracer.swarm` 从 perfect-pelican 发出会被退信）。M3.4 再评估是否放开——放开的前提是"目标集群也必须存在且名单可查"。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| **消息风暴 / O(N²)** | §6 四道闸，与邮箱同批上线（不可后补） |
| 事件量增长（每封邮件 + 已读回执） | 回执只在**被读时**写；实测 1 封邮件 ≈ 1.3 条事件；快照 + 按月归档 |
| 索引与邮件不一致 | 索引纯派生 → 启动重放自动校正；自检脚本校验 |
| 通配展开歧义（后加入者） | 明确规则：投影时展开，线程档案兜底（§2.2） |
| 地址冲突（跨集群重名） | 域隔离（§2.1） |
| 前端复杂度上升 | 兼容层保证老页面零改动；邮箱页是**新增**不是改写 |
| 过度设计（用不上未读/归档） | §10 决策 1 提供"轻量版"退路 |

---

## 10. 需要你拍板的 5 个决策

| # | 决策 | 选项 A（推荐） | 选项 B |
|---|---|---|---|
| **1** | **做到什么程度** | **完整邮箱**：地址 + 收件箱/已发送/归档 + 未读 + 回执 + 配额限流，有独立邮箱页组 | **轻量版**：只加 `to`/`cc`/`subject`，邮箱=过滤视图，不做未读/归档/回执，约 1/3 工作量 |
| **2** | **地址域** | **每集群一个域** `name@<swarmId>.swarm`，天然解决跨集群重名 | 单域 `name@swarm.org`（完全等同视频观感，但要求**名字全局唯一**） |
| **3** | **存储模型** | **一份存储 + N 索引**（§3，不放大、好回放） | 物理副本（真正的"每人一个邮箱"，N 倍存储） |
| **4** | **线程是否保留** | **保留**：线程=完整档案，邮箱=投递记录，双视图 | 废弃线程，只有邮箱（前端线程页要重写） |
| **5** | 人类收件箱 | 人类有独立地址 `human@<swarm>`，能看到定向私信 | 人类只看线程，不参与邮箱投递 |

> **补充决策（同日）**：私信 = 2 人私密线程；**不做给人看的邮箱页组**。理由：消息文本已经在线程页里，再做一个"按收件人切"的重复页面收益低；私信作为新 thread 出现在线程列表即可同时满足"人在看"和"天然隔离"两个需求。

> **已拍板（2026-09-14）**
>
> | 决策 | 选择 |
> |---|---|
> | 邮箱机制 | **完整**（地址 + 投递 + 未读 + 归档 + 回执 + 配额限流） |
> | 地址域 | **每集群一个域** `name@<swarmId>.swarm` |
> | 存储 | **一份存储 + N 份索引** |
> | 线程 | **保留** |
> | 人类 | 有独立地址 `human@<swarm>` |
> | **私信** | **要 —— 走"2 人私密线程"**（房间只有两个成员，天然隔离） |
> | **给人看的邮箱网页** | **不做独立页组** —— 点进集群就是线程列表，**一条私信就是一个新 thread** |
>
> 收敛后的模型：
> ```
> 线程 = 房间（公开多人房 / 2 人私密房）  ← 人在网页上看的
> 邮箱 = 投递引擎（发给谁 / 未读 / 回执）  ← 主要给 AI 用（read_inbox）
> ```
> 因此原 M3.6 的「邮箱总览 / 单个信箱 / 邮件详情」三个页面**取消**，改为：
> 线程列表标出私密线程 + agent 详情页显示地址与未读数 + 线程页加「只看发给我的」开关。
>
> 因此实现按：邮箱是一等实体（未读/归档/回执/配额/限流 + 独立页组）、地址 `name@<swarmId>.swarm`、索引式投递、线程与邮箱双视图、`human@<swarm>` 参与投递。

---

## 11. 计划（以现有实现为基础）

```
       已完成的（基础，不动）
  M1 ✅ 事件溯源 + 投影 + 只读 REST
  M2 ✅ WS 推送 + 前端切 live + 智能体窗口 + 全局搜索
────────────────────────────────────────────────────────
  M2.5  补 M2 欠账 ──────────────── ✅ 已完成
        SwarmState 扩成 pending→live→stopped→done
        swarm.started / swarm.stopped / swarm.completed 事件
        POST /start /stop /complete（完成后重启 → 409）
        验收：✅ UI 顶栏有启停按钮；✅ 重放后状态保持；✅ smoke 新增 8 项断言全绿

  M3    邮箱核心 ─────────────────── 中 ×7
   3.1  地址与邮箱实体（mail.ts）─── ✅ 已完成
        地址解析 / 域隔离 / 通配展开 / 退信 / 开户
        GET /api/mailboxes（全部 + 按集群）、GET /api/mailboxes/:address
        验收：✅ 51 项自检全绿；✅ 43 个邮箱（31 个人 + 12 共享）；
              ✅ smoke / e2e 回归全绿；✅ 无界面变化（符合预期）
   3.2  邮件事件 + 投影 + 索引 ─────── ✅ 已完成
        mail.sent / mail.read / mail.moved / mail.starred / mail.bounced
        一份存储（mails）+ 线程索引（messages）+ 邮箱索引（entries）
        历史 message.posted 重放成广播邮件（零迁移）
        GET /api/mailboxes/:address/mails?folder=
        验收：✅ 72 项自检全绿；✅ 129 条历史全部投递（human 收 67 封）；
              ✅ 线程视图消息数与 agent 字段完全不变；✅ smoke / e2e 回归全绿
   3.3  兼容层：消息 = 线程广播邮件 ─── ✅ 已完成
        验收：✅ 现有前端零改动照常工作（回归 smoke/e2e 全绿）
              ✅ message.posted 只留给历史重放，写路径不再产生它
   3.4  REST + WS 邮箱订阅 ─────────── ✅ 已完成
        POST /api/swarms/:id/threads（私信房间，幂等）
        POST /api/mails（发信 / 别名展开 / 自动落房间 / 退信）
        POST /api/mails/:id/read、/move
        WS 订阅 mailbox:<地址>（带 "replace": true 才是"只推我自己的信箱"）
        验收：✅ mail-check 新增 [7] 段 25 项全绿（101 项总数）
              ✅ ws-check 并入信箱订阅：自己的信收到、别人的不收、已读回执收到
   3.5  防风暴四道闸（§6）─────────── ✅ 已完成
        闸 1 reply 默认只回发件人（路由层缺省值）
        闸 2 每 agent 12 封/分 → 429 + mail.rate_limited（人类/system 豁免）
        闸 3 未读 ≥400 停投 → mail.quota_exceeded（**在投影层**，重放结果一致）
        闸 4 同一房间 30s 内连续群发折叠成「📣 N 条新广播」
        闸 5 全集群 300 封/分 → 429 + swarm.paused + 集群按停
        验收：✅ storm-check 37 项全绿（临时事件库灌 300+ 封信测投影级闸门，
              真实接口测幂等性：恰好放行 12 封）
              ✅ 顺带修掉 snapshot() 的丢数据 bug
   3.6  前端（按新决策缩减）──────────── ✅ 已完成
        ✅ 线程列表：私密线程加 🔒 标记
        ✅ 线程详情：徽章跟随 visibility（🔒 私信 / 公开）
        ✅ 新建私信入口：智能体详情页「✉ 发私信」→ 建 2 人房间 → 直接跳进去
        ✅ 智能体详情页：每个集群显示地址 + N 未读 / M 收件 / K 已发送
        ✅ 线程详情：「只看发给我的」开关（?to=<地址>，收件箱视角的房间档案）
        验收：✅ mail-check 新增 [8] 段 13 项全绿（114 项总数）
              ✅ smoke 契约新增 Mailbox（13 字段）+ 未读 ≤ 收件不变式
   3.7  自检扩展：契约 / 邮箱隔离 / 未读计数 / 风暴保护
        ✅ 契约（数据形状前后端逐字段对齐）
        ✅ 邮箱隔离 / 未读计数 / 投递守恒（含别名与共享地址）
        ✅ 时间倒序（改成轮询，不再赌机器快慢）
        ⏳ 风暴保护（随 3.5）

  M4    Agent Runner + SwarmKit 邮箱版 ─── 大 ────── ✅ 已完成
        智能体用邮箱互发/回信/广播、认领切片、撞车记账、done() 收工
        验收：✅ agent-check 58 项全绿（含"通信是真的""撞车 first-wins"）
              ✅ 界面上「▶ 跑起来」按钮，一轮真跑 20+ 步、发 14 封信

  M5    预算记账 + 熔断 ──────────── 中（与 M4 同批）✅ 已完成
        ✅ 余额直接用 token 换算（不接真实计费，见下）
        验收：✅ 跑爆预算自动刹车 + swarm.stopped 写明原因；UI 实时动数字

  M5.5  删掉假种子，自检改自建 fixture ── ✅ 已完成（§4.0）
        ✅ src/seed.ts（732 行编造数据）删除；空库启动（events=0）
        ✅ scripts/fixture.ts 只走真实代码路径（createSwarm / AgentRunner / POST mails）
        ✅ 6 项自检全绿：smoke / e2e / mail-check 116 / ws-check / storm-check 39 / agent-check 58
        ✅ 前端空态改上手引导 + npm run reset

  M6    切片实体化 + 看板 ─────────── 中
        slice 从字符串升成 {id,name,status,claimedBy}；认领走 board@ 邮箱
        验收：available→claimed→completed 状态机；看板可拖

  M7    DoD 判定 + 完成报告 ───────── 中
        验收：产物核验通过 → swarm.completed

  M8    真模型 LLM Gateway ────────── 中
        验收：真 agent 跑通 pelican 式任务，trace 全落盘

  M9    部署件（systemd / Dockerfile / 备份 / 静态托管）── 小
        验收：任意 Linux 一条命令起服务
```

### 建议的开工顺序

```
M2.5 → M3.1 → M3.2 → M3.3 ←（到这里现有前端必须仍然全绿）
     → M3.4 → M3.5 → M3.6 → M3.7 → M4+M5
```

**M3.3 是安全阀**：如果兼容层做完发现老页面挂了，说明邮箱投影与 `MessageData` 的映射设计错了，此时回退成本最低。

---

## 12. 一句话总结

> 把"线程广播"升级成"**带地址的投递**"：邮件只存一份，投递成 N 个邮箱索引；线程是完整档案，邮箱是我的投递记录；老界面通过兼容层零改动；**限流与配额必须与邮箱同批上线**，否则 20 个 agent 的 reply-all 会烧穿预算。
