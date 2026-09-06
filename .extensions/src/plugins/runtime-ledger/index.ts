// runtime-ledger —— DPN Runtime 的第一个增强插件：给 agent 接上事实账本、计划网络、执行者名册、导演制度与验证器。
//
//   fact-record / fact-query：把 agent 的事实陈述写进事件账本、查询世界状态。
//   plan-node / plan-query：声明与驱动 DPN 计划节点、查询带就绪度推导的计划。
//   solver-spawn / solver-report / solver-query：雇佣执行者、以执行者身份汇报、查询合同与履历。
//   director-tick / director-review：控制循环观察仪表盘、决策落账。
//   verify-run：执行验证命令并把结果自动落账为亲证证据（medium 风险——本地进程执行 + 审计）。
//
// 所有规则（状态迁移、铁律、就绪度、并发上限、证据裁定、run: 门禁）由 Runtime
// 强制；本插件只是工具装配层。
// 私有模块：facts.ts（事实工具）、plan.ts（计划工具）、solvers.ts（执行者工具）、
// director.ts（导演工具）、verifiers.ts（验证器工具），仅 index.ts 对外。
//
// 威胁模型（README 上线检查清单第 3 条）：facts/plan/solver/director 工具只写
// <directory>/.extensions/state/runtime/ 下的 events.jsonl 与 state.json；
// verify-run 额外执行本地命令（medium：超时进程树强杀、输出上限 64KB、审计
// 落 audit.jsonl）并写同一目录。无网络调用、无目录外写入。
// 工具风险等级：除 verify-run 为 medium 外全部 low（Phase 3 原则种子：声明
// 义务；首个 medium 工具触发 Gateway 最小化 = 登记 + 审计 + 权限键）。
import type { ExtensionPlugin } from "../../plugins/types.ts"
import { createRuntime, type DpnRuntime } from "../../runtime/index.ts"
import { buildFactTools } from "./facts.ts"
import { buildPlanTools } from "./plan.ts"
import { buildSolverTools } from "./solvers.ts"
import { buildDirectorTools } from "./director.ts"
import { buildVerifierTools } from "./verifiers.ts"
import { buildMemoryTools } from "./memory.ts"
import { buildResearchTools } from "./research.ts"

export function createRuntimeLedgerExtension(): ExtensionPlugin {
  let runtime: DpnRuntime | undefined
  const ensure = (): DpnRuntime => {
    if (!runtime) {
      throw new Error("runtime-ledger is not initialized: setup() must run before tools execute")
    }
    return runtime
  }

  return {
    id: "runtime-ledger",
    description:
      "DPN-AOR Runtime ledger — agents record facts, query world state, drive the plan network and manage solvers",
    setup: async (ctx) => {
      runtime = await createRuntime({ directory: ctx.directory })
      ctx.log("debug", `runtime-ledger ready (directory: ${ctx.directory})`)
    },
    tools: {
      ...buildFactTools(ensure),
      ...buildPlanTools(ensure),
      ...buildSolverTools(ensure),
      ...buildDirectorTools(ensure),
      ...buildVerifierTools(ensure),
      ...buildMemoryTools(ensure),
      ...buildResearchTools(ensure),
    },
  }
}

// L2 注册表登记用的单例
export const runtimeLedgerExtension: ExtensionPlugin = createRuntimeLedgerExtension()
