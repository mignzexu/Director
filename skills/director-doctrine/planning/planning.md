# PLANNING —— 端到端计划图（阶段路由器）

只在 Director 进入规划阶段时读本文件。本文件是**路由器**，不是操作手册——深度知识在 `references/` 与 `examples/`，按下方披露表按需读取。

## 1. 规划前读取（内联微规则，每次必做）

现实先于设计——动笔前先让 Runtime 告诉你已经知道什么，禁止基于记忆或假设规划：

```text
fact-query {}                        → 已确证事实与 UNKNOWN 清单（世界现状）
plan-query {}                        → 现有网络（续作防重复声明；残局先看清）
memory-recall { include: "all" }     → 相关经验与失败记录（lessons + failures）
```

读取后回答：目标与已知事实的差距是什么？哪些未知会改变结构（→ 显式门控）？历史经验可复用什么？

## 2. 流程骨架（演化循环）

```text
读取（§1）→ 骨架先立（产出计划图：读 references/plan-graph-schema.md）
         → 自查（§4 清单，内联）
         → 翻译落账（读 references/plan-translation.md）
         → 发现驱动（discovery 产出 → 演化操作兑现占位 → 回到自查）
         → ……直到 unknown 清空、占位全部兑现 → 转入纯执行态
```

- **演化式网络构建（统一方法论）**：四象限（现状/目标 × 已知/未知）是未知密度谱——Director 不判象限，执行同一个循环；象限 1 循环转零轮（骨架即全图），象限 4 转到认知收敛。
- Fast Path：简单到一眼可见端到端形态 → 计划图退化为**单 stage 单节点**（见 `examples/plan-graph-minimal.json`）。
- 复合问题 → **网状计划图**（nodes 封装于 stages + **复合 id** `{stage}-{step}-{serial}` + dependsOn 依赖网——见 `references/plan-graph-schema.md` 与 `examples/plan-graph-dag.json`）。
- **网状语义**：依赖是唯一顺序约束；stage 封装只是组织与监督视图——无依赖的跨阶段节点可并行（复合 id 让跨阶段引用自携带来源）。
- **演化操作**：refine（updated 填充占位）/ supersede（换路）/ derive（派生新发现）/ retire（撤销）——四操作与 Runtime 原语一一对应，适用条件见 schema「演化操作词汇表」。

## 3. 渐进披露表

| 条件 | 读取 |
|---|---|
| 开始产出计划图（schema 与字段语义） | `references/plan-graph-schema.md` |
| 自查通过、准备翻译落账（调用序列映射） | `references/plan-translation.md` |
| 对计划图形态不确定（Fast Path / 复合 DAG） | `examples/plan-graph-*.json` |

已掌握同版本 schema 时不重复读取；翻译阶段不回读 schema。

## 4. 落账后自查清单（内联微规则，逐项核对）

- [ ] plan-query 全景：节点数与计划图一致，无意外缺漏
- [ ] 依赖闭合：每个 dependsOn 指向已存在节点；readiness 无预期外阻塞
- [ ] 门控覆盖：依赖世界状态的任务都有 preconditionFacts；对应 unknown 已声明
- [ ] **unknown 闭环**：每个 context.unknown 都有 discovery 节点或门控——无悬空未知
- [ ] **占位显式**：provisional 节点全部带 `[pending]` 前缀 + E3/E4 + verifier 缺省已标注
- [ ] verifier 覆盖：非 provisional 的可命令验证任务已 run:；其余有可判定陈述
- [ ] Fast Path 复核：复杂度真的必要（能砍则砍）
- [ ] planHealth：churn 无异常跳变、无意外 failed
- [ ] **发现驱动纪律**：discovery 节点完成后必 tick + 演化操作兑现（refine/supersede/derive/retire）

## 5. 完成判据与边界

- **PLANNING 的完成判据（重定义）**：已知范围内结构完整 + 占位显式标注——**不是"无占位"**（未知密度高的象限里，占位是诚实状态）。
- PLANNING **不派工、不实现、不评审**——骨架与占位落账后转 SUPERVISING（手册待填）。
- **分解判据（颗粒度、拆 milestone 的时机、E 级评定）为留白**：待与所有者讨论基本逻辑后填充。
