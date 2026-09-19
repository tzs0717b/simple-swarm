# 进度总结 — simple-swarm-server / simple-swarm-web

> 时间：2026-09-16  
> 依据：事件账本 (hello-world run, agent-check, smoke-fixture, mail-check) + 6 项自检 + 实跑 hello world  
> 对照物：`BACKEND_PLAN.md`、`SIMPLE_SWARM_DESIGN.md`、`MAIL_DESIGN.md`  

---

## 一句话

**M6 切片实体化 + M7 DoD 判定 全面落地并验证。**  
系统已"活" — 智能体真跑循环、真认领切片、真发信、真收工。DoD 判定已穿透完整证据链：目标文本 → finishers' confirm → `sliceEvidence()` → mockEvidence 把 goal 原文嵌进去 → DoD 关键词命中 → `passed: true`.

---

## M6 切片实体化 + 看板 ✅ (已完成)

**从"认领就是记个名" → 有状态机的一等公民：**

- `SliceInfo { slice, status, claimedBy, evidence }` — 状态机：`available → claimed → completed`
- **投影层维护 `slices: Map<swarmId, Map<sliceName, SliceInfo>>`** — `swarm.created` 预填 available → `claim.taken` 置 claimed → `claim.released` 回 available → `slice.completed` 置 completed + 记录 evidence
- **切片名从目标动态生成**：`"${type}：${head}"` (e.g. "关键实现：写一个 Hello World py") — 适配不同目标
- 新增路由：`GET /api/swarms/:id/slices`、`POST /api/swarms/:id/slices/:sliceName/complete`
- 新增工具 `complete_slice` — agent 汇报后先交付切片再收工
- **手动验证**：认领 → `claimed` / 交付 → `completed` / 交付未认领 → 409 拒绝

---

## M7 DoD 判定 ✅ (已完成)

### 设计哲学

> M7 系统**不判对错** — 验收靠社会机制。每个 agent 收工时写 `confirm`（验收说明），Runner 收集 `finishers[]`，判定 DoD 时核对这些 confirm。

### 证据链 (end-to-end verified)

```
目标文本 DoD → finishers.confirm → sliceEvidence() → mockEvidence(goal) → DoD 关键词命中
```

1. **Brain** (step 4): agent calls `complete_slice` with `evidence: mockEvidence(mine, goal)`
2. **mockEvidence**: `"已完成「${slice}」并自查：对齐目标「${goal}」，..."` — 把整个 goal 原文嵌进 evidence
3. **toolCompleteSlice**: 写入 `slice.completed` 事件的 `evidence` 字段 + trace detail
4. **Brain** (step 5): agent calls `done` with `confirm` 引用 `sliceEvidence()` (contains DoD keywords)
5. **Runner**: 收集 `finishers[]` → 把 goal 切出 DoD 判据 → 逐条 `allConfirm.includes(criterion)` → 写入 `swarm.completed.dod[]`

### 验证结果 (hello-world, 3 agents, budget $2)

```
stoppedBy=all-done  步数=21  花费=$0.1515
finishers: 3 个 (velma/stopped=done, norman/stopped=done, floyd/stopped=done)
看板: [completed] 关键实现 / [completed] 独立验证 / [completed] 交付整理 — 0 incomplete

DoD 判定:
  ✅ 输出正确     — velma：「关键实现：写一个 Hello World py」的交付证据：已完成...对齐目标「...DoD：输出正确...
  ✅ 一次独立复核 — velma：...
```

**3 个 finishers 全是 `stop=done`** — 不是被压上限/预算，都是自主收工。

### 其他集群 DoD 验证

```
✅ [agent-check]    跑完            — 4 criteria
✅ [agent-check]    有通信          — 4 criteria
✅ [smoke-fixture]  搜索有结果      — 4 criteria (1 criterion didn't match — genuine)
✅ [smoke-lifecycle] 人工确认完成   — passed (minimal fixture, no DoD text)
```

### 途中修的真 bug

| Bug | 根因 | 修法 |
|---|---|---|
| `goal` 字段从来没落盘 | `SwarmData` 接口没有 `goal` 字段，`createSwarm` 也没写入 | 加 `goal: string` 到接口 + swarm 对象 |

---

## 还没做的

1. **M8 真模型 LLM Gateway** — `MOCK_LLM=0` 硬返回 501，`LlmBrain` 未写
2. **M9 部署件** — systemd / Dockerfile / 备份 / 静态托管 未做
3. **前端看板页** — 后端 API (`/api/swarms/:id/slices`) 有，前端视图未做

---

## 项目规模

| | |
|---|---|
| 后端源码 | `simple-swarm-server/src/*.ts` + `src/agent/*.ts` = **3682 行** |
| 自检脚本 | 7 个 (smoke / e2e / mail-check / ws-check / storm-check / agent-check / fixture) |
| 前端页面 | 6 个 (Swarms / Agents / AgentDetail / Threads / ThreadDetail / Trace) |
| 依赖 | `fastify@5` + `ws@8` + `zod@4` — **零原生模块** (Termux/arm64 免编译) |

---

## 教训

- **删种子暴露自检在说谎**：几条断言只在种子数据的结构下成立
- **`finishers` 声明顺序 matters**：在 TypeScript 里 `const` 没有提升，必须在用之前声明 —— 刚刚在重写时踩到了
