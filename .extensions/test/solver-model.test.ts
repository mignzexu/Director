import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, reduce, replay, solverContract } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-solver-"))
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

const OBSERVED = { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }
const VERIFIED = { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }

function spawn(seq: number, solverId: string, extra: Record<string, unknown> = {}, source = "director"): RuntimeEvent {
  return planEvent(seq, "solver.spawned", { nodeId: "t1", solverId, executor: "private", ...extra }, source)
}

// t1 带事实门控并已被 s1 认领
function gatedAndSpawned(): RuntimeEvent[] {
  return [
    created(1, "t1", { preconditionFacts: ["db::deployed"] }),
    planEvent(2, "fact.observed", OBSERVED, "agent"),
    planEvent(3, "fact.verified", VERIFIED, "ci"),
    spawn(4, "s1"),
  ]
}

describe("solver.spawned: atomic contract handover", () => {
  test("claims the node: node active + owner=solver, solver active with identities", () => {
    const state = fold(gatedAndSpawned())
    assert.equal(state.plan.nodes["t1"]?.status, "active")
    assert.equal(state.plan.nodes["t1"]?.owner, "s1")
    assert.equal(state.solvers["s1"]?.status, "active")
    assert.equal(state.solvers["s1"]?.executor, "private")
    assert.equal(state.solvers["s1"]?.spawnedBy, "director")
    assert.equal(state.solvers["s1"]?.nodeId, "t1")
    assert.deepEqual(state.solvers["s1"]?.progress, [])
  })

  test("spawn requires an explicit solverId (auto-numbering lives in the tool layer)", () => {
    assert.throws(
      () =>
        fold([
          created(1, "t1"),
          planEvent(2, "solver.spawned", { nodeId: "t1" }, "director"),
        ]),
      /'solverId' must be a non-empty string/,
    )
  })

  test("duplicate id, unknown node, self-service on claimed node are rejected", () => {
    // 重复 id：另一个 pending 节点上不能复用已有工牌号
    assert.throws(
      () => fold([...gatedAndSpawned(), created(5, "t2"), spawn(6, "s1", { nodeId: "t2" })]),
      /solver already exists/,
    )
    assert.throws(() => fold([spawn(1, "s1")]), /unknown plan node/)
    // s1 已认领后，节点不再是 pending，第二人无法认领
    assert.throws(() => fold([...gatedAndSpawned(), spawn(5, "s2")]), /only pending nodes can be claimed/)
    assert.throws(
      () => fold([created(1, "t1", { parent: "ghost" }), spawn(2, "s1")]),
      /unknown parent node/,
    )
    assert.throws(
      () => fold([created(1, "t1"), planEvent(2, "solver.spawned", { nodeId: "t1", solverId: "s1", parentSolver: "ghost" })]),
      /unknown parent solver/,
    )
  })

  test("spawn respects readiness gates (unverified fact blocks hiring)", () => {
    const events: RuntimeEvent[] = [
      created(1, "t1", { preconditionFacts: ["db::deployed"] }),
      planEvent(2, "fact.observed", OBSERVED, "agent"),
      spawn(3, "s1"),
    ]
    assert.throws(() => fold(events), /unmet facts: db::deployed/)
  })

  test("max 4 active solvers; finished ones free their slot", () => {
    const events: RuntimeEvent[] = [
      created(1, "t1"),
      created(2, "t2"),
      created(3, "t3"),
      created(4, "t4"),
      created(5, "t5"),
      spawn(6, "s1", { nodeId: "t1" }),
      spawn(7, "s2", { nodeId: "t2" }),
      spawn(8, "s3", { nodeId: "t3" }),
      spawn(9, "s4", { nodeId: "t4" }),
    ]
    assert.throws(
      () => fold([...events, spawn(10, "s5", { nodeId: "t5" })]),
      /active solver limit reached \(4\)/,
    )
    // s1 交卷成功后腾出名额
    const freed = fold([
      ...events,
      planEvent(10, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
      spawn(11, "s5", { nodeId: "t5" }),
    ])
    assert.equal(freed.solvers["s5"]?.status, "active")
    assert.equal(freed.solvers["s1"]?.status, "finished")
  })
})

describe("progress / blocked / resumed", () => {
  test("progress appends the trail and updates note", () => {
    const state = fold([
      ...gatedAndSpawned(),
      planEvent(5, "solver.progress", { solverId: "s1", summary: "scaffold done", detail: "3 files" }),
      planEvent(6, "solver.progress", { solverId: "s1", summary: "handlers wired" }),
    ])
    assert.equal(state.solvers["s1"]?.progress.length, 2)
    assert.equal(state.solvers["s1"]?.progress[0]?.summary, "scaffold done")
    assert.equal(state.solvers["s1"]?.progress[0]?.detail, "3 files")
    assert.equal(state.solvers["s1"]?.note, "handlers wired")
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.progress", { solverId: "ghost", summary: "x" })]),
      /unknown solver/,
    )
  })

  test("blocked pauses; progress is refused while blocked; resumed reactivates", () => {
    const blocked = fold([...gatedAndSpawned(), planEvent(5, "solver.blocked", { solverId: "s1", reason: "waiting on keys" })])
    assert.equal(blocked.solvers["s1"]?.status, "blocked")
    assert.equal(blocked.solvers["s1"]?.note, "waiting on keys")
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.blocked", { solverId: "s1", reason: "x" }), planEvent(6, "solver.progress", { solverId: "s1", summary: "x" })]),
      /not allowed in solver status blocked/,
    )
    const resumed = fold([
      ...gatedAndSpawned(),
      planEvent(5, "solver.blocked", { solverId: "s1", reason: "waiting on keys" }),
      planEvent(6, "solver.resumed", { solverId: "s1", note: "keys arrived" }),
    ])
    assert.equal(resumed.solvers["s1"]?.status, "active")
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.resumed", { solverId: "s1" })]),
      /not allowed in solver status active/,
    )
  })
})

describe("solver.reported: verdict couples solver and node", () => {
  test("blocked solver cannot deliver", () => {
    assert.throws(
      () =>
        fold([
          ...gatedAndSpawned(),
          planEvent(5, "solver.blocked", { solverId: "s1", reason: "x" }),
          planEvent(6, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
        ]),
      /not allowed in solver status blocked/,
    )
  })

  test("success needs verifiable evidence and completes the node with the same evidence", () => {
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.reported", { solverId: "s1", outcome: "success", summary: "done" })]),
      /'evidence' must be an object/,
    )
    assert.throws(
      () =>
        fold([
          ...gatedAndSpawned(),
          planEvent(5, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "agent_claim" } }),
        ]),
      /executors cannot prove their own success/,
    )
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.reported", { solverId: "s1", outcome: "wat", summary: "done" })]),
      /'outcome' must be/,
    )
    const state = fold([
      ...gatedAndSpawned(),
      planEvent(5, "solver.reported", { solverId: "s1", outcome: "success", summary: "core built", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
    ])
    assert.equal(state.solvers["s1"]?.status, "finished")
    assert.equal(state.solvers["s1"]?.note, "core built")
    const node = state.plan.nodes["t1"]!
    assert.equal(node.status, "done")
    assert.equal(node.note, "core built")
    assert.deepEqual(node.evidenceIds, ["ev:id-5"])
    assert.equal(state.evidence["ev:id-5"]?.reliability, 0.9)
  })

  test("failure fails both solver and node with the reason", () => {
    assert.throws(
      () => fold([...gatedAndSpawned(), planEvent(5, "solver.reported", { solverId: "s1", outcome: "failure", summary: "broke" })]),
      /'reason' must be a non-empty string/,
    )
    const state = fold([
      ...gatedAndSpawned(),
      planEvent(5, "solver.reported", { solverId: "s1", outcome: "failure", summary: "broke", reason: "build unrecoverable" }),
    ])
    assert.equal(state.solvers["s1"]?.status, "failed")
    assert.equal(state.plan.nodes["t1"]?.status, "failed")
    assert.equal(state.plan.nodes["t1"]?.note, "build unrecoverable")
  })
})

describe("solver.stopped: release the contract", () => {
  test("node returns to pending without owner; a fresh solver can be hired", () => {
    const state = fold([
      created(1, "t1"),
      spawn(2, "s1"),
      planEvent(3, "solver.stopped", { solverId: "s1", reason: "swap in a specialist" }),
    ])
    assert.equal(state.solvers["s1"]?.status, "stopped")
    assert.equal(state.plan.nodes["t1"]?.status, "pending")
    assert.equal(state.plan.nodes["t1"]?.owner, undefined)
    const rehired = fold([
      created(1, "t1"),
      spawn(2, "s1"),
      planEvent(3, "solver.stopped", { solverId: "s1", reason: "swap" }),
      spawn(4, "s2", {}, "director"),
    ])
    assert.equal(rehired.plan.nodes["t1"]?.owner, "s2")
  })

  test("terminal states are immutable", () => {
    const stoppedEvents: RuntimeEvent[] = [...gatedAndSpawned(), planEvent(5, "solver.stopped", { solverId: "s1", reason: "x" })]
    assert.throws(
      () => fold([...stoppedEvents, planEvent(6, "solver.progress", { solverId: "s1", summary: "x" })]),
      /not allowed in solver status stopped/,
    )
    const finishedEvents: RuntimeEvent[] = [
      ...gatedAndSpawned(),
      planEvent(5, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
    ]
    assert.throws(
      () => fold([...finishedEvents, planEvent(6, "solver.stopped", { solverId: "s1", reason: "x" })]),
      /not allowed in solver status finished/,
    )
  })
})

describe("solver contract derivation", () => {
  test("contract assembles ancestors, prerequisite outputs and gate facts", () => {
    const state = fold([
      created(1, "o1", { type: "outcome", title: "ship it" }),
      created(2, "m1", { type: "milestone", parent: "o1", title: "core works" }),
      created(3, "t0", { title: "prep env" }),
      created(4, "t1", { parent: "m1", dependsOn: ["t0"], preconditionFacts: ["db::deployed"] }),
      planEvent(5, "fact.observed", OBSERVED, "agent"),
      planEvent(6, "fact.verified", VERIFIED, "ci"),
      planEvent(7, "plan.node.started", { nodeId: "t0" }, "someone"),
      planEvent(8, "plan.node.completed", { nodeId: "t0", evidence: { type: "test", mechanism: "verify-run", command: "npm test" }, summary: "env ready" }),
      spawn(9, "s1"),
    ])
    const contract = solverContract(state, "s1")
    assert.deepEqual(
      contract.ancestors.map((n) => n.id),
      ["m1", "o1"],
    )
    assert.deepEqual(
      contract.prerequisiteOutputs.map((n) => n.id),
      ["t0"],
    )
    assert.deepEqual(
      contract.gateFacts.map((f) => f.key),
      ["db::deployed"],
    )
    assert.equal(contract.node.id, "t1")
    assert.throws(() => solverContract(state, "ghost"), /unknown solver/)
  })
})

describe("purity and replay determinism", () => {
  test("solver events do not mutate inputs", () => {
    const state = initialState()
    const frozen0 = JSON.parse(JSON.stringify(state))
    const afterCreate = reduce(state, created(1, "t1"))
    assert.deepEqual(state, frozen0, "created must not mutate its input")
    assert.notEqual(afterCreate, state)
    const frozen1 = JSON.parse(JSON.stringify(afterCreate))
    const afterSpawn = reduce(afterCreate, spawn(2, "s1"))
    assert.deepEqual(afterCreate, frozen1, "spawned must not mutate its input")
    assert.notEqual(afterSpawn, afterCreate)
    assert.equal(afterSpawn.solvers["s1"]?.status, "active")
  })

  test("replay rebuilds the roster identically", () => {
    const events: RuntimeEvent[] = [
      ...gatedAndSpawned(),
      planEvent(5, "solver.progress", { solverId: "s1", summary: "step 1" }),
      planEvent(6, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
