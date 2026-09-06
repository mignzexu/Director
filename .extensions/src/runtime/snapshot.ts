// 状态快照：事件日志重放结果的缓存。日志永远是权威事实源，
// 快照缺失、损坏或 schema 版本过旧时总是可以从日志完整重建。
import type { StateStore } from "../core/types.ts"
import { SCHEMA_VERSION, type RuntimeState } from "./types.ts"

export class StateSnapshot {
  private store: StateStore
  private file: string

  constructor(store: StateStore, file = "state.json") {
    this.store = store
    this.file = file
  }

  async save(state: RuntimeState): Promise<void> {
    await this.store.write(this.file, state)
  }

  // 缓存语义：任何读取/解析错误、结构损坏或 schemaVersion 不匹配
  // 都视为缓存未命中，返回 undefined 由调用方从权威事件日志完整重放。
  async load(): Promise<RuntimeState | undefined> {
    let loaded: RuntimeState | undefined
    try {
      loaded = await this.store.read<RuntimeState>(this.file)
    } catch {
      return undefined
    }
    if (!loaded) {
      return undefined
    }
    if (
      loaded.schemaVersion !== SCHEMA_VERSION ||
      typeof loaded.revision !== "number" ||
      !Array.isArray(loaded.goals) ||
      typeof loaded.tasks !== "object" ||
      loaded.tasks === null ||
      !Array.isArray(loaded.observations) ||
      !Array.isArray(loaded.actions) ||
      !Array.isArray(loaded.notes) ||
      typeof loaded.facts !== "object" ||
      loaded.facts === null ||
      typeof loaded.evidence !== "object" ||
      loaded.evidence === null ||
      typeof loaded.plan !== "object" ||
      loaded.plan === null ||
      typeof loaded.plan.nodes !== "object" ||
      loaded.plan.nodes === null ||
      !Array.isArray(loaded.plan.reviews) ||
      typeof loaded.plan.churn !== "object" ||
      loaded.plan.churn === null ||
      typeof loaded.plan.churn.created !== "number" ||
      typeof loaded.plan.churn.cancelled !== "number" ||
      typeof loaded.solvers !== "object" ||
      loaded.solvers === null ||
      typeof loaded.memory !== "object" ||
      loaded.memory === null ||
      typeof loaded.memory.lessons !== "object" ||
      loaded.memory.lessons === null ||
      typeof loaded.research !== "object" ||
      loaded.research === null ||
      typeof loaded.research.questions !== "object" ||
      loaded.research.questions === null ||
      typeof loaded.research.hypotheses !== "object" ||
      loaded.research.hypotheses === null
    ) {
      return undefined
    }
    return loaded
  }
}
