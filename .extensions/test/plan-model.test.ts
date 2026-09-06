import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, nodeReadiness, reduce, replay } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-plan-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function planEvent(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "director"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: "2026-09-05T00:00:00.000Z" }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

function created(seq: number, nodeId: string, extra: Record<string, unknown> = {}, source?: string): RuntimeEvent {
  return planEvent(seq, "plan.node.created", { nodeId, type: "task", title: `node ${nodeId}`, ...extra }, source)
}

function startedT1(): RuntimeEvent[] {
  return [created(1, "t1"), planEvent(2, "plan.node.started", { nodeId: "t1" })]
}

// outcome ← milestone ← task 骨架（声明顺序：容器先于成员）
function skeleton(): RuntimeEvent[] {
  return [
    created(1, "o1", { type: "outcome", title: "ship it" }),
    created(2, "m1", { type: "milestone", parent: "o1", title: "core works" }),
    created(3, "t1", { parent: "m1", title: "build core" }),
  ]
}

describe("plan node creation discipline", () => {
  test("created defaults to pending with empty graph fields", () => {
    const state = fold([created(1, "t1")])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.status, "pending")
    assert.deepEqual(node.dependsOn, [])
    assert.deepEqual(node.preconditionFacts, [])
    assert.deepEqual(node.evidenceIds, [])
    assert.equal(node.type, "task")
    assert.equal(node.parent, undefined)
  })

  test("duplicate id, bad type, unknown dependency/parent, self dependency are rejected", () => {
    assert.throws(() => fold([created(1, "t1"), created(2, "t1")]), /already exists/)
    assert.throws(
      () => fold([planEvent(1, "plan.node.created", { nodeId: "t1", type: "dream", title: "x" })]),
      /'type' must be one of/,
    )
    assert.throws(() => fold([created(1, "t1", { dependsOn: ["ghost"] })]), /unknown dependency node/)
    assert.throws(() => fold([created(1, "t1", { parent: "ghost" })]), /unknown parent node/)
    assert.throws(() => fold([created(1, "t1", { dependsOn: ["t1"] })]), /cannot depend on itself/)
  })

  test("precondition facts must be 'entity::property' keys (need not exist yet)", () => {
    assert.throws(() => fold([created(1, "t1", { preconditionFacts: ["db"] })]), /expected 'entity::property'/)
    assert.throws(() => fold([created(1, "t1", { preconditionFacts: ["a::b::c"] })]), /expected 'entity::property'/)
    const state = fold([created(1, "t1", { preconditionFacts: ["db::deployed"] })])
    assert.deepEqual(state.plan.nodes["t1"]?.preconditionFacts, ["db::deployed"])
  })
})

describe("readiness gating (the plan listens to world state)", () => {
  test("start is blocked with precise reasons", () => {
    const factGated: RuntimeEvent[] = [
      created(1, "t1", { preconditionFacts: ["db::deployed"] }),
      planEvent(2, "plan.node.started", { nodeId: "t1" }),
    ]
    assert.throws(() => fold(factGated), /unmet facts: db::deployed/)

    const depGated: RuntimeEvent[] = [
      created(1, "t1"),
      created(2, "t2", { dependsOn: ["t1"] }),
      planEvent(3, "plan.node.started", { nodeId: "t2" }),
    ]
    assert.throws(() => fold(depGated), /unmet dependencies: t1/)
  })

  test("OBSERVED is not enough — only VERIFIED facts open the gate", () => {
    const base: RuntimeEvent[] = [
      created(1, "t1", { preconditionFacts: ["db::deployed"] }),
      planEvent(2, "fact.observed", { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }, "agent"),
    ]
    assert.throws(() => fold([...base, planEvent(3, "plan.node.started", { nodeId: "t1" })]), /unmet facts/)
    const opened = fold([
      ...base,
      planEvent(3, "fact.verified", { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }, "ci"),
      planEvent(4, "plan.node.started", { nodeId: "t1" }),
    ])
    assert.equal(opened.plan.nodes["t1"]?.status, "active")
    assert.equal(opened.plan.nodes["t1"]?.owner, "director", "owner defaults to the event source")
  })

  test("nodeReadiness reports both unmet lists at once", () => {
    const state = fold([
      created(1, "t1"),
      created(2, "t2", { dependsOn: ["t1"], preconditionFacts: ["db::deployed"] }),
    ])
    const readiness = nodeReadiness(state, state.plan.nodes["t2"]!)
    assert.deepEqual(readiness, { ready: false, unmetDependencies: ["t1"], unmetFacts: ["db::deployed"] })
  })
})

describe("lifecycle state machine", () => {
  test("started requires pending; completed requires active + non-agent_claim evidence", () => {
    assert.throws(
      () => fold([...startedT1(), planEvent(3, "plan.node.started", { nodeId: "t1" })]),
      /only pending nodes start/,
    )
    assert.throws(
      () => fold([created(1, "t1"), planEvent(2, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } })]),
      /start it first/,
    )
    assert.throws(
      () =>
        fold([
          ...startedT1(),
          planEvent(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "agent_claim" } }),
        ]),
      /executors cannot prove their own success/,
    )
  })

  test("completion with real evidence registers it and records the summary", () => {
    const state = fold([
      ...startedT1(),
      planEvent(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test" }, summary: "3 tests green" }),
    ])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.status, "done")
    assert.deepEqual(node.evidenceIds, ["ev:id-3"])
    assert.equal(node.note, "3 tests green")
    assert.equal(state.evidence["ev:id-3"]?.reliability, 0.9)
    assert.equal(state.evidence["ev:id-3"]?.source, "director")
  })

  test("done nodes cannot be updated or cancelled", () => {
    const done: RuntimeEvent[] = [
      ...startedT1(),
      planEvent(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
    ]
    assert.throws(
      () => fold([...done, planEvent(4, "plan.node.updated", { nodeId: "t1", title: "x" })]),
      /cannot update plan node in status done/,
    )
    assert.throws(() => fold([...done, planEvent(4, "plan.node.cancelled", { nodeId: "t1" })]), /cannot cancel completed/)
  })

  test("failed requires active and records the reason", () => {
    assert.throws(
      () => fold([created(1, "t1"), planEvent(2, "plan.node.failed", { nodeId: "t1", reason: "boom" })]),
      /only active nodes fail/,
    )
    const state = fold([
      ...startedT1(),
      planEvent(3, "plan.node.failed", { nodeId: "t1", reason: "build broke" }),
    ])
    assert.equal(state.plan.nodes["t1"]?.status, "failed")
    assert.equal(state.plan.nodes["t1"]?.note, "build broke")
  })

  test("cancelling a prerequisite blocks dependents (derived, no cascade events)", () => {
    const state = fold([
      created(1, "t1"),
      created(2, "t2", { dependsOn: ["t1"] }),
      planEvent(3, "plan.node.cancelled", { nodeId: "t1", reason: "obsolete approach" }),
    ])
    assert.equal(state.plan.nodes["t1"]?.status, "cancelled")
    const readiness = nodeReadiness(state, state.plan.nodes["t2"]!)
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.unmetDependencies, ["t1"], "cancelled prerequisite still blocks — derived from graph")
  })
})

describe("plan.node.updated guards", () => {
  test("mutable fields update; type and status are immutable", () => {
    const state = fold([
      ...startedT1(),
      planEvent(3, "plan.node.updated", { nodeId: "t1", title: "build core v2", verifier: "npm test", owner: "solver-a" }),
    ])
    assert.equal(state.plan.nodes["t1"]?.title, "build core v2")
    assert.equal(state.plan.nodes["t1"]?.verifier, "npm test")
    assert.equal(state.plan.nodes["t1"]?.owner, "solver-a")
    assert.throws(
      () => fold([created(1, "t1"), planEvent(2, "plan.node.updated", { nodeId: "t1", type: "outcome" })]),
      /'type' is immutable/,
    )
    assert.throws(
      () => fold([created(1, "t1"), planEvent(2, "plan.node.updated", { nodeId: "t1", status: "done" })]),
      /lifecycle events/,
    )
  })

  test("dependency cycles are rejected", () => {
    const events: RuntimeEvent[] = [
      created(1, "a"),
      created(2, "b", { dependsOn: ["a"] }),
      planEvent(3, "plan.node.updated", { nodeId: "a", dependsOn: ["b"] }),
    ]
    assert.throws(() => fold(events), /would create a cycle/)
  })
})

describe("purity and replay determinism", () => {
  test("plan events do not mutate inputs", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    reduce(state, created(1, "t1"))
    assert.deepEqual(state, frozen)
  })

  test("replay rebuilds the plan identically", () => {
    const events: RuntimeEvent[] = [
      ...skeleton(),
      created(4, "t9", { parent: "m1", preconditionFacts: ["db::deployed"] }),
      planEvent(5, "fact.observed", { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }, "agent"),
      planEvent(6, "fact.verified", { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }, "ci"),
      planEvent(7, "plan.node.started", { nodeId: "t9" }),
      planEvent(8, "plan.node.completed", { nodeId: "t9", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
