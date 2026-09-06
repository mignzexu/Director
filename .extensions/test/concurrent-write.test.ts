// 多实例并发写入（Phase 12 调试预备——真实使用入场券）：
// opencode 多会话/多进程会产生多个 runtime 实例，各自内存缓存互相不可见。
// 本测试用两个 JsonlEventStore 实例指向同一账本文件，确定性复现并发窗口：
// 全部 append 必须落账、seq 严格连续无重复、重放不炸。
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { JsonlEventStore } from "../src/runtime/event-store.ts"
import { replay } from "../src/runtime/reducer.ts"
import { createRuntime } from "../src/runtime/index.ts"
import type { RuntimeEvent } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-concurrent-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("multi-instance concurrent append", () => {
  test("two stores racing on one ledger: every append lands, seq strictly continuous", async () => {
    const file = path.join(dir, "events.jsonl")
    const a = new JsonlEventStore(file)
    const b = new JsonlEventStore(file)
    // 预热两个实例的缓存（模拟两个已启动的会话：都认为账本是空的）
    assert.deepEqual(await a.readAll(), [])
    assert.deepEqual(await b.readAll(), [])

    const N = 10
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? a : b).append({ type: "note.added", source: `sess-${i % 2}`, payload: { content: `n${i}` } }),
      ),
    )

    // 落盘后从磁盘重读（模拟第三个实例重放）
    const third = new JsonlEventStore(file)
    const all = await third.readAll()
    assert.equal(all.length, N, `expected ${N} events on disk, got ${all.length}`)
    const seqs = all.map((e) => e.seq)
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
      "seq must be strictly continuous with no duplicates",
    )
    const uniqueIds = new Set(results.map((r) => r.id))
    assert.equal(uniqueIds.size, N, "returned events must all be distinct")
    assert.doesNotThrow(() => replay(all as RuntimeEvent[]), "the ledger must replay cleanly")
  })


describe("multi-runtime facade (two createRuntime on one ledger)", () => {
  test("a session catching up after another session's writes: state converges, dispatch succeeds", async () => {
    const root = path.join(dir, "rt")
    const first = await createRuntime({ directory: dir, root })
    await first.dispatch({ type: "note.added", source: "s1", payload: { content: "seed" } })

    // 第二个会话启动（读到含 seed 的账本）并写入
    const second = await createRuntime({ directory: dir, root })
    await second.dispatch({ type: "note.added", source: "s2", payload: { content: "from b" } })

    // 第一个会话 unaware of s2's write：dispatch 必须自动补齐他方事件后成功
    const event = await first.dispatch({ type: "note.added", source: "s1", payload: { content: "after b" } })
    assert.equal(event.seq, 3)
    const state = first.getState()
    assert.equal(state.revision, 3)
    assert.deepEqual(state.notes.map((n) => n.content), ["seed", "from b", "after b"], "first session's state converged")
  })

  test("two facades racing dispatches both converge to identical state", async () => {
    const root = path.join(dir, "rt2")
    const a = await createRuntime({ directory: dir, root })
    const b = await createRuntime({ directory: dir, root })
    await Promise.all([
      a.dispatch({ type: "note.added", source: "a", payload: { content: "a1" } }),
      b.dispatch({ type: "note.added", source: "b", payload: { content: "b1" } }),
      a.dispatch({ type: "note.added", source: "a", payload: { content: "a2" } }),
      b.dispatch({ type: "note.added", source: "b", payload: { content: "b2" } }),
    ])
    // 活性语义：空闲实例的 getState() 是诚实的时间点快照（可能落后）；
    // 任意一次 dispatch 都会自动补齐他方事件、收敛到权威账本
    await a.dispatch({ type: "note.added", source: "a", payload: { content: "a3" } })
    await b.dispatch({ type: "note.added", source: "b", payload: { content: "b3" } })
    assert.ok(a.getState().revision >= 5, "dispatch converges to at least its own write + prior writes")
    // 显式同步：refresh() 从权威账本重建——确定性收敛（无协调的空闲收敛不存在）
    await a.refresh()
    await b.refresh()
    assert.equal(a.getState().revision, 6)
    assert.equal(b.getState().revision, 6)
    assert.deepEqual(
      a.getState().notes.map((n) => n.content).sort(),
      ["a1", "a2", "a3", "b1", "b2", "b3"],
    )
    assert.deepEqual(b.getState(), a.getState(), "both sessions converge to the identical state")
  })
})
  test("lock contention: a held lock is awaited, not silently dropped", async () => {
    const file = path.join(dir, "events.jsonl")
    const store = new JsonlEventStore(file)
    // 直接占用锁文件模拟另一个进程持锁
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(`${file}.lock`, "held", "utf8")

    let settled = false
    const p = store.append({ type: "note.added", source: "test", payload: { content: "contended" } }).then((e) => {
      settled = true
      return e
    })
    // 锁在 50ms 后释放（模拟对方写完）
    setTimeout(() => {
      void fs.rm(`${file}.lock`, { force: true })
    }, 50)
    const event = await p
    assert.equal(settled, true)
    assert.equal(event.seq, 1, "the contended append must still land with seq 1")
    const all = await new JsonlEventStore(file).readAll()
    assert.equal(all.length, 1)
  })
})
