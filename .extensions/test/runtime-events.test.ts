import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { JsonlEventStore } from "../src/runtime/event-store.ts"
import { initialState, reduce, replay } from "../src/runtime/reducer.ts"
import { StateSnapshot } from "../src/runtime/snapshot.ts"
import { createRuntime } from "../src/runtime/index.ts"
import { DefaultCapabilityRegistry } from "../src/core/capability-registry.ts"
import { JsonlAuditLogger } from "../src/state/audit.ts"
import { FileStateStore } from "../src/state/state-store.ts"
import { createAgentPlatform } from "../src/core/platform.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-runtime-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function event(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "test"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: "2026-09-05T00:00:00.000Z" }
}

describe("event store", () => {
  test("append assigns unique ids and monotonic seq", async () => {
    const store = new JsonlEventStore(path.join(dir, "events.jsonl"))
    const a = await store.append({ type: "note.added", source: "test", payload: { content: "a" } })
    const b = await store.append({ type: "note.added", source: "test", payload: { content: "b" } })
    assert.notEqual(a.id, b.id)
    assert.equal(a.seq, 1)
    assert.equal(b.seq, 2)
    const all = await store.readAll()
    assert.equal(all.length, 2)
    assert.deepEqual(all[1].payload, { content: "b" })
  })

  test("readSince returns only newer events", async () => {
    const store = new JsonlEventStore(path.join(dir, "events.jsonl"))
    await store.append({ type: "note.added", source: "test", payload: { content: "1" } })
    await store.append({ type: "note.added", source: "test", payload: { content: "2" } })
    await store.append({ type: "note.added", source: "test", payload: { content: "3" } })
    const since = await store.readSince(2)
    assert.equal(since.length, 1)
    assert.equal(since[0].seq, 3)
  })

  test("rejects unknown type and empty source without writing", async () => {
    const file = path.join(dir, "events.jsonl")
    const store = new JsonlEventStore(file)
    await assert.rejects(
      () => store.append({ type: "nope" as never, source: "test" }),
      /unknown runtime event type/,
    )
    await assert.rejects(() => store.append({ type: "note.added", source: "" }), /source must be a non-empty string/)
    await assert.rejects(() => fs.access(file), "nothing may be persisted on invalid input")
  })

  test("corrupt log line fails loud on read", async () => {
    const file = path.join(dir, "events.jsonl")
    const store = new JsonlEventStore(file)
    await store.append({ type: "note.added", source: "test", payload: { content: "ok" } })
    await fs.appendFile(file, "{not json}\n", "utf8")
    const fresh = new JsonlEventStore(file)
    await assert.rejects(() => fresh.readAll(), /corrupt event log line/)
  })
})

describe("reducer", () => {
  test("applies each event type to state", () => {
    let state = initialState()
    state = reduce(state, event(1, "goal.set", { goal: "ship it" }, "director"))
    state = reduce(state, event(2, "task.created", { taskId: "t1", title: "do a" }))
    state = reduce(state, event(3, "task.updated", { taskId: "t1", status: "done" }))
    state = reduce(state, event(4, "action.executed", { name: "npm test", ok: true, outcome: "3 passed" }))
    state = reduce(state, event(5, "observation.recorded", { content: "tests green" }))
    state = reduce(state, event(6, "note.added", { content: "remember x" }))
    assert.equal(state.revision, 6)
    assert.equal(state.goals[0]?.goal, "ship it")
    assert.equal(state.tasks["t1"]?.status, "done")
    assert.equal(state.actions[0]?.ok, true)
    assert.equal(state.observations[0]?.content, "tests green")
    assert.equal(state.notes[0]?.content, "remember x")
  })

  test("is pure: inputs are not mutated", () => {
    const state: RuntimeState = {
      ...initialState(),
      goals: [{ goal: "g", source: "s", setAt: "t" }],
    }
    const frozen = JSON.parse(JSON.stringify(state))
    reduce(state, event(1, "note.added", { content: "n" }))
    assert.deepEqual(state, frozen)
  })

  test("rejects seq gaps, duplicate tasks, unknown tasks, bad payload, unknown type", () => {
    const base = reduce(initialState(), event(1, "task.created", { taskId: "t1", title: "x" }))
    assert.throws(() => reduce(initialState(), event(2, "note.added", { content: "gap" })), /does not continue/)
    assert.throws(() => reduce(base, event(2, "task.created", { taskId: "t1", title: "dup" })), /already exists/)
    assert.throws(() => reduce(base, event(2, "task.updated", { taskId: "nope", status: "done" })), /unknown task/)
    assert.throws(() => reduce(base, event(2, "note.added", {})), /must be a non-empty string/)
    assert.throws(
      () => reduce(base, event(2, "mystery" as never, {})),
      /unknown runtime event type/,
    )
    assert.throws(() => reduce(base, event(2, "task.updated", { taskId: "t1", status: "wat" })), /invalid task status/)
  })

  test("replay rebuilds identical state", () => {
    const events = [
      event(1, "goal.set", { goal: "g" }),
      event(2, "task.created", { taskId: "t1", title: "a" }),
      event(3, "note.added", { content: "n" }),
    ]
    const state = replay(events)
    assert.equal(state.revision, 3)
    assert.equal(state.goals.length, 1)
    assert.equal(state.tasks["t1"]?.title, "a")
  })
})

describe("state snapshot", () => {
  test("save/load roundtrip", async () => {
    const snapshot = new StateSnapshot(new FileStateStore(path.join(dir, "state")))
    const state = replay([event(1, "goal.set", { goal: "g" })])
    await snapshot.save(state)
    const loaded = await snapshot.load()
    assert.deepEqual(loaded, state)
  })

  test("missing or corrupt snapshot returns undefined (cache miss)", async () => {
    const root = path.join(dir, "state")
    const snapshot = new StateSnapshot(new FileStateStore(root))
    assert.equal(await snapshot.load(), undefined)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "state.json"), "{oops", "utf8")
    assert.equal(await snapshot.load(), undefined)
  })
})

describe("runtime facade", () => {
  test("dispatch is the only mutation path and persists event + snapshot", async () => {
    const root = path.join(dir, "rt")
    const runtime = await createRuntime({ directory: dir, root })
    await runtime.dispatch({ type: "goal.set", source: "director", payload: { goal: "build runtime" } })
    await runtime.dispatch({ type: "task.created", source: "solver-a", payload: { taskId: "t1", title: "step" } })
    const state = runtime.getState()
    assert.equal(state.revision, 2)
    assert.equal(state.goals[0]?.goal, "build runtime")
    assert.equal(state.tasks["t1"]?.status, "open")
    assert.equal(await fs.access(path.join(root, "events.jsonl")).then(() => true, () => false), true)
    assert.equal(await fs.access(path.join(root, "state.json")).then(() => true, () => false), true)
    assert.equal(runtime.lastSnapshotError, undefined)
  })

  test("invalid payload is rejected before reaching the log", async () => {
    const runtime = await createRuntime({ directory: dir, root: path.join(dir, "rt2") })
    await assert.rejects(() => runtime.dispatch({ type: "note.added", source: "test", payload: {} }), /non-empty string/)
    await runtime.dispatch({ type: "note.added", source: "test", payload: { content: "fine" } })
    const all = await runtime.events.readAll()
    assert.equal(all.length, 1, "rejected event must not poison the log")
    assert.equal(all[0].seq, 1)
  })

  test("rehydrate: snapshot + event delta equals full replay", async () => {
    const root = path.join(dir, "rt3")
    const first = await createRuntime({ directory: dir, root })
    await first.dispatch({ type: "goal.set", source: "director", payload: { goal: "g1" } })
    await first.dispatch({ type: "note.added", source: "solver", payload: { content: "n1" } })

    const second = await createRuntime({ directory: dir, root })
    assert.equal(second.getState().revision, 2)
    assert.deepEqual(second.getState(), first.getState())

    await second.dispatch({ type: "task.created", source: "solver", payload: { taskId: "t1", title: "x" } })
    const third = await createRuntime({ directory: dir, root })
    assert.equal(third.getState().revision, 3)
    assert.equal(third.getState().tasks["t1"]?.title, "x")
  })

  test("refresh rebuilds from the authoritative log", async () => {
    const root = path.join(dir, "rt4")
    const runtime = await createRuntime({ directory: dir, root })
    await runtime.dispatch({ type: "note.added", source: "test", payload: { content: "a" } })
    await runtime.dispatch({ type: "note.added", source: "test", payload: { content: "b" } })
    const refreshed = await runtime.refresh()
    assert.equal(refreshed.revision, 2)
    assert.deepEqual(refreshed, runtime.getState())
  })

  test("serialized dispatch keeps seq order under concurrency", async () => {
    const runtime = await createRuntime({ directory: dir, root: path.join(dir, "rt5") })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runtime.dispatch({ type: "note.added", source: "test", payload: { content: `n${i}` } }),
      ),
    )
    const all = await runtime.events.readAll()
    assert.equal(all.length, 8)
    assert.deepEqual(
      all.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
    assert.equal(runtime.getState().revision, 8)
  })
})

describe("platform integration", () => {
  test("createAgentPlatform exposes the runtime slot", async () => {
    const runtime = await createRuntime({ directory: dir, root: path.join(dir, "rt6") })
    const platform = createAgentPlatform({
      directory: dir,
      capabilities: new DefaultCapabilityRegistry(),
      runtime,
      state: new FileStateStore(path.join(dir, "state")),
      audit: new JsonlAuditLogger(path.join(dir, "audit.jsonl")),
    })
    assert.equal(platform.runtime, runtime)
    await platform.runtime.dispatch({ type: "note.added", source: "platform", payload: { content: "hello" } })
    assert.equal(platform.runtime.getState().revision, 1)
    // Phase 12 诚实化：四真实槽位（假占位已移除，让渡项见接口文档）
    assert.ok(platform.capabilities)
    assert.ok(platform.state)
    assert.ok(platform.audit)
  })
})
