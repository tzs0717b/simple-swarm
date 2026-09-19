# 协商立板（去掉派工员）

> 用户口径：「不应该让一个未知的东西来主导一个去中心化的东西的工作。应该把切片员去掉，
> 让 system 在开始的时候在每个人地方注入一段 system 提示词，让他们先在广播商量计划和分配工作。」

## 为什么拆掉派工员

旧设计：`/run` 时由**一次外部 LLM 调用**（`SWARM_SLICER_MODEL`，默认 gpt-5.6-sol）把整块板切好。三个问题：

| # | 问题 | 实测证据 |
|---|---|---|
| 1 | 它是外部单点 —— 一个未知的东西替去中心化集群定了全部工作方式 | 板子质量 = 那一句话的质量，agent 只能照做 |
| 2 | agent 手里只有「120 字目标 + 片名」，板就是全部信息环境 | `goalOf()` 只给 120 字 |
| 3 | 它切出来的是**一条串行依赖链**，集群并行优势消失 | pelican 45b：7/12 交付、4 个 `<animate>`；p1018：herman 一人写了整道题 |

## 新设计：板由 agent 自己立

系统只做两件事：

1. **开工广播（kickoff）** —— 把完整题目 + 立板规则作为**注入到每个人手里的 system 提示词**发出去，然后闭嘴；
2. **兜底** —— 到截止点板还是空的，才用通用保底切法架板（下策，不是主力）。

每轮上下文里还会带一句短提示（板空时）：「先立板，再干活」（`boardHintText`）。

## 立板规则（写进广播里的硬要求）

| 要求 | 为什么 |
|---|---|
| 先 `read_inbox` 看完整题目 | 题目全文在广播里，不再只有 120 字 |
| `send_mail` 给全队**广播计划**（做什么 / 怎么切 / 认领哪几片） | 交流变成**结构性需要**：不商量就没有板，没法开工 |
| 先看别人的广播再定自己那几片；同文件同功能只许一个负责人 | 防重复劳动（`claimedBy` 重复闸之外再加一层社会约定）|
| `publish_slice` 挂板（发布即认领），片名自带完成标准 | 可验收；「优化一下」这种片名不算 |
| 板必须含：集成/收口片、机械验收片（数字阈值）、独立复检片 | 保住底线 —— 这是保底切法给不了的东西 |
| 能并行就并行，别把整条依赖链串给一个人 | 直接针对 p1018 那轮「一人包全题」 |

## 旋钮

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `SWARM_NEGOTIATE_BOARD` | `1` | 开协商立板；`0` 退回旧的「/run 时外部 LLM 派工」 |
| `SWARM_BOARD_DEADLINE_FRACTION` | `0.3` | 立板截止（墙钟比例）：到这个点板还空 → 保底兜底 |
| `SWARM_GOAL_CHARS` | `4000` | 目标全文给 agent 的字符上限（旧值 120）|
| `SWARM_SLICER` | `1` | 旧的派工路径开关（协商模式开着时不生效）|

## 自检

~~~bash
cd swarm/simple-swarm-server
node scripts/board-check.ts                                  # 协商立板：14 条
SWARM_CHALLENGE_GRACE_MS=1200 node scripts/challenge-check.ts # 质疑机制：15 条
SWARM_NEGOTIATE_BOARD=0 SWARM_CHALLENGE_GRACE_MS=1200 node scripts/gate-check.ts  # 收工闸：52 条
~~~

注意：`gate-check` / `challenge-check` 测的是机制本身，场景要求**板上已经有片**，
所以它们要用 `SWARM_NEGOTIATE_BOARD=0` 跑（走旧派工路径），否则场景里没有板。

## 对照实验怎么跑

同题跑两轮即可对照：

~~~bash
# A：协商立板（新）
SWARM_NEGOTIATE_BOARD=1 ./start.sh restart && (建集群 + start + run)
# B：外部派工（旧）
SWARM_NEGOTIATE_BOARD=0 ./start.sh restart && (建集群 + start + run)
~~~

看三个数：**交付率**、**认领分布**（是不是又一个人包全题）、**板子是否贴题**。

