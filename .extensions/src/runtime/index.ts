// Runtime 门面：dispatch 是唯一的状态变更入口。
// 流向：Agent Action → Event → Reducer → Runtime State。
// 每次 dispatch 先用影子事件试算归约，校验失败则拒绝且不落日志，
// 保证权威事件日志永远不会被坏 payload 污染。
import path from "node:path"
import { FileStateStore } from "../state/state-store.ts"
import { JsonlEventStore } from "./event-store.ts"
import { initialState, reduce, replay } from "./reducer.ts"
import { StateSnapshot } from "./snapshot.ts"
import { isRuntimeEventType, type RuntimeEvent, type RuntimeEventInput, type RuntimeState } from "./types.ts"

export interface DpnRuntime {
  readonly events: JsonlEventStore
  // 快照是缓存：写入失败不推翻 dispatch（事件已持久化、状态在内存），
  // 失败记录在 lastSnapshotError 供观测，refresh() 可随时重建。
  readonly lastSnapshotError: Error | undefined
  dispatch(input: RuntimeEventInput): Promise<RuntimeEvent>
  getState(): RuntimeState
  // 从权威事件日志完整重建状态（忽略快照）。
  refresh(): Promise<RuntimeState>
}

export async function createRuntime(input: {
  directory: string
  // 运行时数据根目录；默认 <directory>/.extensions/state/runtime（已被 gitignore）
  root?: string
}): Promise<DpnRuntime> {
  const root = input.root ?? path.join(input.directory, ".extensions", "state", "runtime")
  const events = new JsonlEventStore(path.join(root, "events.jsonl"))
  const snapshot = new StateSnapshot(new FileStateStore(root), "state.json")

  let currentState = await rehydrate(events, snapshot)
  let lastSnapshotError: Error | undefined

  let chain: Promise<unknown> = Promise.resolve()
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = chain.then(job)
    chain = next.catch(() => undefined)
    return next
  }

  async function persistSnapshot(state: RuntimeState): Promise<void> {
    try {
      await snapshot.save(state)
      lastSnapshotError = undefined
    } catch (error) {
      lastSnapshotError = error instanceof Error ? error : new Error(String(error))
    }
  }

  return {
    events,
    get lastSnapshotError() {
      return lastSnapshotError
    },
    getState: () => currentState,

    dispatch: (input) =>
      enqueue(async () => {
        if (!isRuntimeEventType(input.type)) {
          throw new Error(`unknown runtime event type: ${String(input.type)}`)
        }
        // 试算：坏 payload 在此抛出，事件不落日志
        reduce(currentState, {
          id: "probe",
          seq: currentState.revision + 1,
          type: input.type,
          source: input.source,
          payload: input.payload ?? {},
          timestamp: new Date().toISOString(),
        })
        const event = await events.append(input)
        if (event.seq !== currentState.revision + 1) {
          // 多会话：他方实例在他方会话里追加了事件——增量归约补齐（含本次事件），
          // 使本实例状态与权威账本收敛
          const missed = await events.readSince(currentState.revision)
          for (const e of missed) {
            currentState = reduce(currentState, e)
          }
        } else {
          currentState = reduce(currentState, event)
        }
        await persistSnapshot(currentState)
        return event
      }),

    refresh: () =>
      enqueue(async () => {
        currentState = replay(await events.readAll())
        await persistSnapshot(currentState)
        return currentState
      }),
  }
}

// 快照优先（缓存命中则只应用增量），否则完整重放事件日志。
async function rehydrate(events: JsonlEventStore, snapshot: StateSnapshot): Promise<RuntimeState> {
  const allEvents = await events.readAll()
  const lastSeq = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0
  const cached = await snapshot.load()
  if (cached && cached.revision <= lastSeq) {
    let state = cached
    for (const event of await events.readSince(cached.revision)) {
      state = reduce(state, event)
    }
    return state
  }
  if (allEvents.length === 0) {
    return initialState()
  }
  return replay(allEvents)
}
