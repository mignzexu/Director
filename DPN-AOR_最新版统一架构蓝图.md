# DPN-AOR 最新统一架构蓝图

## 1. 系统定位

DPN-AOR（Dynamic Plan Network Autonomous Outcome
Runtime）是一套面向复杂任务、工程构建、研究型问题和未知问题的自主问题求解系统。

核心目标：

    Current State → Goal State

系统不是简单的多 Agent 协作，而是通过：

-   Runtime
-   Global Director
-   Solver
-   Dynamic Plan Network
-   Evidence Verification

持续完成目标状态转换。

------------------------------------------------------------------------

# 2. 核心原则

## 一个 DPN，两种状态空间

DPN 不仅包含任务计划，还包含：

    Dynamic Plan Network

    +

    World State

    +

    Epistemic State

## World State

描述：

> 现实世界已经确认的事实。

例如：

    代码已经编译通过
    数据库已经部署
    设备 PWM 没有输出

状态：

    UNKNOWN
    OBSERVED
    PARTIAL
    VERIFIED
    STALE
    INVALID

## Epistemic State

描述：

> 系统当前对问题的理解。

包括：

    Question
    Unknown
    Hypothesis
    Assumption
    Claim
    Confidence
    Contradiction
    Anomaly

核心原则：

    Fact ≠ Hypothesis

------------------------------------------------------------------------

# 3. 为什么修改 Planner-Executor 架构

传统：

    Planner
     ↓
    Executor
     ↓
    Reviewer

存在：

    Plan–Execution Semantic Gap

原因：

Planner 知道：

-   为什么这样规划
-   哪些假设重要
-   哪些路径被放弃

Executor 只知道：

-   当前任务是什么

导致：

-   上下文损失
-   意图损失
-   反馈无法快速影响规划

------------------------------------------------------------------------

# 4. 最新角色体系

最终结构：

    Runtime

        |

    Global Director / Primary Solver

        |

    Global DPN

        |

    Subgraph Solver

        |

    Tools / Actions

------------------------------------------------------------------------

# 5. Runtime

Runtime 是事实控制中心。

负责：

    Authoritative State
    Event Log
    Reducer
    Plan Storage
    Evidence Storage
    Scheduler
    Capability Gateway
    Verification
    Recovery
    Completion

Runtime 不负责：

-   理解用户目标
-   选择技术路线
-   判断最佳解决策略

------------------------------------------------------------------------

# 6. Director / Primary Solver

Director 是全局问题求解主体。

负责：

## 目标理解

    用户真正需要什么？

## Global Gap

持续计算：

    Current State 距离 Goal State 还有什么？

## 全局规划

负责：

-   Milestone
-   Critical Path
-   子图划分
-   Delegation
-   Replan
-   Reframe

Director 不是：

    只生成计划的人

而是：

    Plan
    ↓
    Act
    ↓
    Observe
    ↓
    Replan

持续循环。

------------------------------------------------------------------------

# 7. Solver 模型

Solver 是真正执行问题解决的主体。

拥有：

    Problem Model
    Plan Ownership
    Execution Feedback
    Local Memory
    Decision Context

可以：

-   规划
-   调查
-   执行
-   验证
-   调整局部路线

------------------------------------------------------------------------

# 8. 全局与局部责任

## Global Director

负责：

    Global Goal
    Global Gap
    Global DPN
    Critical Path
    Major Decisions

## Local Solver

负责：

    Subgraph Goal
    Local Planning
    Local Execution
    Local Recovery

原则：

> 全局意图集中，局部智能分布。

------------------------------------------------------------------------

# 9. 双循环模型

## Global Control Loop

    读取 Runtime State

    ↓

    比较 Goal

    ↓

    计算 Global Gap

    ↓

    评估 Plan Health

    ↓

    选择关键路径

    ↓

    委派 Subgraph

    ↓

    等待重要事件

    ↓

    重新调整策略

------------------------------------------------------------------------

## Local Solver Loop

    读取 Task Contract

    ↓

    Local Plan

    ↓

    Execute

    ↓

    Observe

    ↓

    Adjust

    ↓

    Verify

    ↓

    提交结果

------------------------------------------------------------------------

# 10. Dynamic Plan Network

DPN 表示：

> 当前最佳的问题求解路径。

包含：

    Outcome Node
    Milestone Node
    Task Node
    Verification Node
    Recovery Node

不是所有操作都进入 DPN。

------------------------------------------------------------------------

# 11. Plan Ownership

核心原则：

> 负责规划的人必须持续拥有该计划的认知所有权。

因此：

    Plan Ownership
    =
    Execution Ownership
    =
    Local Adaptation Ownership

------------------------------------------------------------------------

# 12. Plan Node

每个节点：

    Precondition

    ↓

    Action

    ↓

    Postcondition

    ↓

    Verification

包含：

    Goal
    Intent
    Decision Context
    Expected Result
    Risk
    Capability
    Verifier

------------------------------------------------------------------------

# 13. Fast Path

简单任务不能被复杂系统拖慢。

例如：

    修改配置
    修改文档
    简单代码修复

直接：

    Read
    Modify
    Verify

不创建复杂研究图。

------------------------------------------------------------------------

# 14. Lazy Epistemic Expansion

研究能力按需启动。

默认：

    Execute

如果：

    Unknown 阻塞 Goal

才展开：

    Question

    ↓

    Hypothesis

    ↓

    Experiment

    ↓

    Evidence

    ↓

    Resolution

------------------------------------------------------------------------

# 15. Uncertainty Level

节点：

    E0 Deterministic
    E1 Minor Unknown
    E2 Investigation
    E3 Research
    E4 Open Discovery

根据不确定性调整资源。

------------------------------------------------------------------------

# 16. Planner 目标

目标：

    Best Known Feasible Plan

评价：

    Goal Progress

    +

    λ × Information Gain

    -

    Cost

    -

    Risk

    -
    Complexity

λ 根据未知程度动态调整。

------------------------------------------------------------------------

# 17. Research 与 Engineering 融合

研究不是独立模式。

而是 Solver 能力。

流程：

    Build

    ↓

    Unknown

    ↓

    Investigate

    ↓

    Resolve

    ↓

    Continue Build

------------------------------------------------------------------------

# 18. Verification

执行者不能证明自己成功。

流程：

    Executor Result

    ↓

    Verifier

    ↓

    Evidence

    ↓

    Runtime State Update

------------------------------------------------------------------------

# 19. Failure Recovery

三级：

## Local Repair

处理：

-   小 Bug
-   工具失败
-   重试

## Subgraph Replan

处理：

-   局部路线错误
-   关键假设失败

## Global Replan

处理：

-   问题理解错误
-   架构方向错误

------------------------------------------------------------------------

# 20. Problem Reframing

Replan：

    问题不变
    路线改变

Reframe：

    问题理解改变

系统必须允许：

    当前问题模型本身错误

------------------------------------------------------------------------

# 21. Graph Critique

DPN 必须能够检查：

    当前图是否正确？

    是否遗漏变量？

    是否错误拆分？

    是否大量节点失效？

    是否需要重新定义问题？

------------------------------------------------------------------------

# 22. Graph Churn

增加：

    Graph Churn Rate

如果：

    计划持续失效

说明：

    Problem Model 可能错误

需要：

    Reframe

------------------------------------------------------------------------

# 23. 宏观与微观规划

## Macro Node

例如：

    实现登录系统

## Task Node

例如：

    实现 Token Refresh

## Internal Action

例如：

    修改代码
    运行测试

只有重要状态转换进入 DPN。

------------------------------------------------------------------------

# 24. 最终架构

                     USER GOAL

                         |

                         v

              GLOBAL DIRECTOR

                         |

                         v

                  GLOBAL DPN

                         |

            -------------------------

            |          |            |

            v          v            v

        Solver A   Solver B    Solver C

            |          |            |

        Local Loop Local Loop Local Loop

                         |

                         v

                      Runtime

                         |

                         v

                  Verified State

------------------------------------------------------------------------

# 25. 最终系统定义

DPN-AOR 是：

> 一个由 Runtime 保证事实一致性，由 Director 保持全局目标和战略，由
> Solver 持有局部计划并执行，通过 Dynamic Plan Network 持续将 Current
> State 转换为 Goal State 的自主问题求解系统。

核心循环：

    理解目标

    ↓

    观察现实

    ↓

    计算差距

    ↓

    规划路径

    ↓

    执行行动

    ↓

    验证结果

    ↓

    更新状态

    ↓

    重新规划
