# 计划图 Schema（dpn-plan-graph v2.3 —— 复合 id + stage 封装 + 演化式网络）

> 仅在开始产出计划图、且上下文没有 `schemaVersion: 2` 的计划图时读取。规划前读取（fact-query/plan-query/memory-recall）阶段禁止读本文件——避免格式驱动建模。

计划图是 Director 规划的唯一中间产物：**先画出整张图，自查通过后按 `plan-translation.md` 机械翻译成 Runtime 声明**。字段与 Runtime 的 plan-node 参数逐一对齐——格式化是为了配合字段匹配，翻译零损耗。

## 结构语义（先于字段）

**计划是网状，不是线性，也不是树**。从当前状态到目标状态：有串行、有并行、有跨阶段的依赖回流。三组概念各司其职：

- **物理封装**：nodes 封装在各 stages 内——node 必须归属其阶段部分，组织一目了然。
- **复合 id = 身份内嵌位置**：`{stage}-{step}-{serial}`（如 `S1-1-1`、`S2-1-2`）。看到 id 即知"哪个阶段、第几步、第几个节点"——跨阶段引用时来源自携带，多会话协作人人可定位。
- **依赖是唯一的顺序约束**：`dependsOn` 用复合 id 引用（**可跨阶段**）——一个 stage 节点的产物是其他 stage 的前置，这正是复合 id 的设计理由。网状展开不受封装限制。
- **step = 阶段内的批次软分组**：step 之间**没有隐含顺序**——step 间的推进顺序仍用 dependsOn 显式声明，保持"依赖是唯一顺序约束"原则。
- **stage = 监督主干**：stage 顺序用于监督分组；每个 stage 由翻译器自动合成一个 milestone 节点（nodeId = stage.id），阶段完成 = milestone done。
- **mission = 节点的身份包**：type/kind/title/intent 打包；**mission 多态**——不同 kind 携带不同的类型扩展字段（见多态表），翻译时序列化进 intent。
- **parallelGroup 已废弃**：其调度语义由复合 id 的 step/serial 段承载。
- **网络是演化的（统一方法论）**：四象限问题（现状/目标 × 已知/未知）是**未知密度谱**，不是四种模板——Director 执行同一个演化循环：**骨架先立（当前认知下的最大骨架）→ 未知显式（provisional 节点 + discovery 节点）→ 发现驱动（discovery 产出落账 → 演化操作兑现）→ 持续演化（直到 unknown 清空、占位全部兑现，进入纯执行态）**。象限 1 循环转零轮（骨架即全图），象限 4 转到认知收敛为止。

## 最小结构

```json
{
  "goal": "端到端目标陈述",
  "schemaVersion": 2,
  "outcome": {
    "id": "O1",
    "mission": {
      "type": "outcome",
      "kind": "hybrid",
      "title": "目标锚点一句话",
      "intent": "端到端的成果定义"
    }
  },
  "context": {
    "known": ["已确证事实（来自 fact-query）"],
    "unknown": ["未解问题——将声明为 fact.unknown 并可能成为门控"],
    "constraints": ["约束"],
    "risks": ["风险"]
  },
  "stages": [
    {
      "id": "S1",
      "title": "阶段名",
      "exit": "阶段出口判据（= 该 stage 合成的 milestone 完成判据）",
      "nodes": [
        {
          "id": "S1-1-1",
          "mission": {
            "type": "task | verification | recovery",
            "kind": "research | engineering | analysis | decision | communication | hybrid",
            "title": "唯一职责一句话",
            "intent": "为什么存在 + 产出什么",
            "…": "按 kind 的类型扩展字段（见多态表）"
          },
          "dependsOn": ["必须先完成的节点复合 id（可跨阶段）"],
          "preconditionFacts": ["必须 VERIFIED 的事实键 entity::property"],
          "verifier": "完成判据：'run: 命令' 或 可判定完成陈述（provisional 节点可缺省，启动前必须补齐）",
          "uncertainty": "E0 | E1 | E2 | E3 | E4",
          "deliverable": "产出物描述"
        }
      ]
    }
  ]
}
```

## 复合 id 规则

`{stage}-{step}-{serial}` 三段：

| 段 | 规则 | 示例 |
|---|---|---|
| `{stage}` | 所属阶段 id（S1、S2…） | `S2` |
| `{step}` | 阶段内的批次**软分组**序号（1,2,3…）；step 间无隐含顺序，推进顺序用 dependsOn 声明 | `1` |
| `{serial}` | 步骤内**节点序号**：串行步骤恰 1 个节点 → `1`；并行步骤多个节点 → `2,3,4…` 依次 | `2` |

示例：`S1-1-1`（S1 的第 1 步，串行单节点）；`S2-1-2`、`S2-1-3`（S2 的第 1 步，两个并行节点）。

## 字段语义与 Runtime 映射表

| 计划图字段 | Runtime 去向 | 激活的机制 |
|---|---|---|
| `outcome` | plan-node created（type: outcome，nodeId = outcome.id，parent 无） | 目标锚点（所有 milestone 的 parent） |
| `goal` | fact-record（project::goal） | 目标入账（goal.set 工具化是候选） |
| `context.unknown` | fact-record (action: unknown) / preconditionFacts | 显式盲区 → 可成为任务门控 |
| `stages[].id` | 翻译器合成 milestone 节点（nodeId = stage.id, parent = outcome） | 阶段的结构承载：阶段完成 = milestone done（Director 在 exit 判据满足时落账） |
| `stages[].exit` | 合成 milestone 的完成判据（verifier） | 阶段出口门禁 |
| `nodes[].id`（复合） | plan-node nodeId **原样透传** | 拓扑身份（人类可读可定位） |
| `nodes[].mission.type` / `.title` / `.intent` | plan-node created 同名字段 | 网络结构 + 认知锚点 |
| `nodes[].mission.kind` | 并入 intent 前缀（如 `[research]`） | 教义路由键（不进 Runtime）：执行方法论路由 |
| `nodes[].mission.<扩展字段>` | 序列化进 intent 结构化段 | 类型特有语义（Runtime 零分叉） |
| `nodes[].dependsOn` | plan-node created 同名字段（复合 id 引用，可跨阶段） | **唯一的顺序约束** |
| `nodes[].preconditionFacts` | plan-node created 同名字段 | 世界门控（非 VERIFIED 不能启动） |
| `nodes[].verifier`（run: 前缀） | plan-node created 同名字段 | 完成门禁（必须亲证且通过才能完成） |
| `nodes[].verifier`（陈述式） | plan-node created 同名字段 | 完成判据声明（attested 依据，监督时对照） |
| `nodes[].uncertainty` | plan-node created 同名字段 | 资源与方法分级信号 |
| `nodes[].deliverable` | 并入 intent | 产出物描述 |

`step` 与 `serial` 不进 Runtime（组织信息内嵌于复合 id）；Director 派工时按复合 id 分配并发名额。

## mission 多态表（按 kind 的类型扩展字段）

通用核心（所有 kind 必填）：`type / kind / title / intent`。类型扩展按 kind 附加——翻译时序列化进 intent 的结构化段，Runtime 零分叉。

| kind | 扩展字段 | 语义 | 翻译去向 |
|---|---|---|---|
| `engineering` | `scope: string[]` | 文件/符号级写边界（新增显式标注） | intent 段 `scope: a.ts, b.ts(新)` |
| `research` | `question: string` | 该实验/调查回答的研究问题 | intent 段 `question: …`（可关联 research.question） |
| `decision` | `options: string[]` | 候选方案清单 | intent 段 `options: …`（决策记录另入账） |
| `communication` | `audience: string[]` | 干系人清单 | intent 段 `audience: …` |
| `analysis` | `focus: string[]` | 分析焦点/维度 | intent 段 `focus: …` |
| `hybrid` | 按 E 级与子结构声明主要 kind 后套用上表 | — | — |

## 占位节点（provisional node）

未知密度高的象限里，骨架中"知道需要、尚不知道细节"的工作声明为占位节点：

- `intent` 前缀 `[pending]` + 一句话说明等什么发现（如 `[pending] 等 S1-1-1 的选型结论`）；
- `uncertainty` E3/E4；`verifier` 可缺省；
- **兑现义务**：其 discovery 节点产出落账后，Director 必须 refine（补齐字段、去 `[pending]` 前缀）——**started 前必须补齐 verifier**（Runtime 在 completed 时强制 run: 门禁，逃不掉）；
- provisional 节点**合法存在于已获批的计划中**——PLANNING 的完成判据是"已知范围内结构完整 + 占位显式标注"，不是"无占位"。

## 演化操作词汇表（网络动态构建的四类操作）

| 操作 | Runtime 原语 | 适用条件 | 反例（禁止） |
|---|---|---|---|
| **refine** | plan-node updated（填充占位字段、去 pending） | discovery 产出落账后、节点启动前；网络结构不变 | 结构性错误时硬填（应 supersede） |
| **supersede** | 新节点 created（supersedes 旧）+ 旧节点 cancelled | 方向性错误、refine 不再适用；circuit breaker 打开后 | 可 refine 时推倒重来 |
| **derive** | plan-node created（新节点，dependsOn 指向 discovery 产出） | discovery 揭示计划外工作 | 无 discovery 依据凭空造节点（锚定强制兜底） |
| **retire** | plan-node cancelled | 工作不再需要（前提被事实证伪/目标演化淘汰） | 已 done 的节点（不可取消） |

四操作与 Runtime 原语一一对应——网络动态构建零新机制，只有纪律。

## 有效性规则（落账前自查，全部机械可判）

1. **依赖是唯一顺序约束**：所有 `dependsOn` 引用的复合 id 已存在且无环；跨阶段依赖合法且引用完整复合 id。step 顺序不代表执行顺序。
2. **复合 id 格式**：`{stage}-{step}-{serial}` 三段、stage 段与所在封装一致、step/serial 为正整数；同 stage 内 id 唯一。
3. **stage 完整性**：每个 stage 有 `title` 与 `exit`；根级 outcome 恰一个；stage 合成的 milestone 以 outcome 为 parent。
4. **mission 通用核心必填**：type/kind/title/intent 缺一不可；类型扩展字段严格按多态表（未定义的 kind 扩展字段不写入）。
5. **verifier 义务（时点修订）**：engineering 类（及一切可命令验证者）最终必须以 `run: 命令` 声明——**provisional 节点 created 时可缺省，started 前必须补齐**（Runtime 在 completed 时强制 run: 门禁，逃不掉）；不可命令验证者用可判定陈述——接受 attested 前想清楚谁做判定。
6. **unknown 显式化**：会改变结构的未知 → `preconditionFacts` 门控 + `context.unknown`；禁止把猜测写成 known。
7. **unknown 闭环**：每个 `context.unknown` 条目必须对应一个 kind=research/analysis 的 **discovery 节点**（负责把它变成已知）或一条 `preconditionFacts` 门控（等外部事实）——未知不许悬空。
8. 无实际信息的字段省略，不写空占位；`schemaVersion` 只出现在图根。
9. 简单任务 = 单 stage 单节点端到端，不建复杂网络。
