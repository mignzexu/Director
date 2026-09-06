# 计划图翻译 —— 计划图 → Runtime 声明序列

> 仅在计划图自查通过、准备落账时读取。翻译是机械映射：字段 1:1、复合 id 原样透传、不做任何即兴调整。

## 翻译规则

按 **outcome → goal → unknown → 逐 stage（milestone 合成 → 阶段内 nodes）** 的次序翻译；依赖边随节点声明自动建立：

```text
1. outcome（图根）                  → plan-node { action: "created", nodeId: <outcome.id>,
                                      type: "outcome", title, intent: mission 序列化 }
2. goal                            → fact-record { entity: "project", property: "goal",
                                      action: "observed", value: <goal>, evidenceType: "human" }
3. context.unknown 逐项            → fact-record { entity: <subject>, property: <property>,
                                      action: "unknown", note: <原文> }
4. 逐 stage（stages 数组顺序）：
   a. stage → milestone 合成        → plan-node { action: "created", nodeId: <stage.id>,
                                      type: "milestone", title: stage.title, parent: <outcome.id>,
                                      intent: "阶段: " + stage.title + "；出口: " + stage.exit,
                                      verifier: stage.exit }
   b. stage.nodes 逐个              → plan-node { action: "created", nodeId: <复合 id 原样>,
                                      mission.type → type, mission.title → title,
                                      intent: "[kind] " + mission.intent
                                             + 扩展段（scope/question/options/audience/focus）
                                             +（"; 产出: " + deliverable）,
                                      parent: <stage.id>, dependsOn?,
                                      preconditionFacts?, verifier?, uncertainty? }
   c. dependsOn 用复合 id 原样引用（可跨阶段）——Runtime 不受封装边界限制
```

- mission 展开：通用核心（type/kind/title/intent）→ plan-node 同名字段；kind 并入 intent 前缀；类型扩展字段按多态表序列化为 intent 的结构化段——Runtime 零分叉。
- 复合 id 原样透传为 nodeId（如 `S2-1-2`）——Runtime nodeId 接受任意字符串，拓扑身份人类可读。
- `step` / `serial` 不翻译（组织信息内嵌于 id）；派工时 Director 按复合 id 分配并发名额。
- `preconditionFacts` 引用的 `entity::property` 必须与第 3 步声明的 unknown 键一致（或引用 fact-query 已有的键）。
- 落账后执行 planning.md §4 自查清单；任何声明被 Runtime 拒绝（依赖不存在/环/门控键非法）→ 修计划图重翻，不带病落账。

## 翻译后的一致性核对（网状结构专项）

- [ ] 阶段出口闭合：每个 stage 的 exit 判据 = 合成 milestone 的 verifier
- [ ] milestone 依赖方向：后 stage 的 milestone 不依赖前 stage 的 milestone（阶段推进由节点依赖驱动）
- [ ] 跨阶段依赖方向正确：无"后阶段节点被前阶段依赖"除非显式回流（如 recovery）
- [ ] 复合 id 一致：dependsOn 引用与节点封装的 stage 段吻合（跨阶段引用除外）

## 落账后

转 SUPERVISING 阶段（手册待填）：监督节拍（按 stage 分组检视完成度）、信号-动作映射见 SKILL.md 阶段索引。
