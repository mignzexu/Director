import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, planHealth, reduce, replay } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-director-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "director-agent"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: "2026-09-05T00:00:00.000Z" }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

function created(seq: number, nodeId: string, extra: Record<string, unknown> = {}): RuntimeEvent {
  return ev(seq, "plan.node.created", { nodeId, type: "task", title: `node ${nodeId}`, ...extra })
}

const OBSERVED = { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }
const VERIFIED = { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }

// outcome + 认领它的 director（role="director"）
function withDirector(seqStart = 1): RuntimeEvent[] {
  return [
    created(seqStart, "o1", { type: "outcome", title: "ship it" }),
    ev(seqStart + 1, "solver.spawned", { nodeId: "o1", solverId: "d1", role: "director" }),
  ]
}

function review(seq: number, extra: Record<string, unknown> = {}): RuntimeEvent {
  return ev(seq, "director.reviewed", { directorId: "d1", nodeId: "o1", assessment: "on-track", reasoning: "fine", ...extra })
}

describe("planHealth dimensions", () => {
  test("empty plan: zeroed counts and null churn rate", () => {
    const health = planHealth(initialState())
    assert.equal(health.totalNodes, 0)
    assert.equal(health.completionRatio, 0)
    assert.deepEqual(health.readyQueue, [])
    assert.deepEqual(health.unknownFacts, [])
    assert.equal(health.churnRate, null)
  })

  test("work is bucketed: ready / blocked / active / done / failed", () => {
    const state = fold([
      ...withDirector(),
      created(3, "t-ready"),
      created(4, "t-blocked", { preconditionFacts: ["db::deployed"] }),
      created(5, "t-active"),
      created(6, "t-done"),
      created(7, "t-failed"),
      ev(8, "plan.node.started", { nodeId: "t-active" }, "worker"),
      ev(9, "plan.node.started", { nodeId: "t-done" }, "worker"),
      ev(10, "plan.node.completed", { nodeId: "t-done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }, "worker"),
      ev(11, "plan.node.started", { nodeId: "t-failed" }, "worker"),
      ev(12, "plan.node.failed", { nodeId: "t-failed", reason: "boom" }, "worker"),
      ev(13, "fact.observed", OBSERVED, "agent"),
    ])
    const health = planHealth(state)
    assert.deepEqual(health.readyQueue.map((n) => n.id), ["t-ready"])
    assert.deepEqual(
      health.blockedNodes.map(({ node }) => node.id),
      ["t-blocked"],
    )
    assert.deepEqual(
      health.blockedNodes[0]?.readiness.unmetFacts,
      ["db::deployed"],
      "blocked nodes report their precise gaps",
    )
    // o1（director 的 outcome 合同）与 t-active 都在进行中；owner 是 solverId
    assert.deepEqual(
      health.activeWork.map(({ node, owner }) => [node.id, owner]),
      [
        ["o1", "d1"],
        ["t-active", "worker"],
      ],
    )
    assert.equal(health.doneNodes, 1)
    assert.equal(health.totalNodes, 6)
    assert.equal(health.completionRatio, 0.17, "ratios round to two decimals like confidence")
    assert.deepEqual(
      health.failedNodes.map((n) => n.id),
      ["t-failed"],
    )
  })

  test("cancelled nodes drop out of totals but feed churn", () => {
    const state = fold([
      ...withDirector(),
      created(3, "t1"),
      created(4, "t2"),
      ev(5, "plan.node.cancelled", { nodeId: "t2", reason: "obsolete" }),
    ])
    const health = planHealth(state)
    assert.equal(health.totalNodes, 2)
    assert.deepEqual(health.churn, { created: 3, cancelled: 1 })
    assert.equal(health.churnRate, 0.33)
  })

  test("stuck solvers and failed solvers are visible", () => {
    const state = fold([
      ...withDirector(),
      created(3, "t1"),
      ev(4, "solver.spawned", { nodeId: "t1", solverId: "s1", executor: "worker-a" }),
      ev(5, "solver.blocked", { solverId: "s1", reason: "waiting" }),
      created(6, "t2"),
      ev(7, "solver.spawned", { nodeId: "t2", solverId: "s2", executor: "worker-b" }),
      ev(8, "solver.reported", { solverId: "s2", outcome: "failure", summary: "broke", reason: "dead end" }),
    ])
    const health = planHealth(state)
    assert.deepEqual(
      health.stuckSolvers.map((s) => s.id),
      ["s1"],
    )
    assert.deepEqual(
      health.failedSolvers.map((s) => s.id),
      ["s2"],
    )
  })

  test("unknownFacts covers non-VERIFIED facts and gates of unfinished nodes", () => {
    const state = fold([
      ...withDirector(),
      created(3, "t1", { preconditionFacts: ["net::up"] }),
      created(4, "t-done", { preconditionFacts: ["db::deployed"] }),
      ev(5, "fact.observed", OBSERVED, "agent"),
      ev(6, "fact.observed", { entity: "mon", property: "health", value: "ok", evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }, "agent"),
      ev(7, "fact.verified", VERIFIED, "ci"),
      ev(8, "plan.node.started", { nodeId: "t-done" }, "worker"),
      ev(9, "plan.node.completed", { nodeId: "t-done", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }, "worker"),
    ])
    const health = planHealth(state)
    assert.deepEqual(
      health.unknownFacts.sort(),
      ["mon::health", "net::up"],
      "VERIFIED facts leave the list; OBSERVED and never-observed gates stay",
    )
  })
})

describe("director.reviewed discipline", () => {
  test("valid review appends to the archive", () => {
    const state = fold([
      ...withDirector(),
      review(3, { reasoning: "on the rails", nextActions: ["spawn t1 worker", "verify db fact"] }),
    ])
    assert.equal(state.plan.reviews.length, 1)
    const entry = state.plan.reviews[0]!
    assert.equal(entry.directorId, "d1")
    assert.equal(entry.nodeId, "o1")
    assert.equal(entry.assessment, "on-track")
    assert.deepEqual(entry.nextActions, ["spawn t1 worker", "verify db fact"])
  })

  test("five rejection classes", () => {
    // 未知 director
    assert.throws(() => fold([review(1)]), /unknown director/)
    // 非 active
    assert.throws(
      () => fold([...withDirector(), ev(3, "solver.stopped", { solverId: "d1", reason: "x" }), review(4)]),
      /is not active/,
    )
    // nodeId 与合同不匹配
    assert.throws(
      () => fold([...withDirector(), review(3, { nodeId: "o2" })]),
      /does not match the director's contract node/,
    )
    // 合同节点不是 outcome（nodeId 先匹配合同，才能触到 outcome 校验）
    assert.throws(
      () =>
        fold([
          created(1, "t1"),
          ev(2, "solver.spawned", { nodeId: "t1", solverId: "d1", role: "director" }),
          review(3, { nodeId: "t1" }),
        ]),
      /must be an outcome node/,
    )
    // 缺 reasoning / 枚举外 assessment / 坏 nextActions
    assert.throws(() => fold([...withDirector(), review(3, { reasoning: "" })]), /'reasoning' must be a non-empty string/)
    assert.throws(() => fold([...withDirector(), review(3, { assessment: "vibes" })]), /'assessment' must be one of/)
    assert.throws(
      () => fold([...withDirector(), review(3, { nextActions: ["", "ok"] })]),
      /'nextActions' must be an array of non-empty strings/,
    )
  })

  test("reviews are append-only by construction (each event appends)", () => {
    const state = fold([...withDirector(), review(3), review(4, { assessment: "needs-replan", reasoning: "drift" })])
    assert.equal(state.plan.reviews.length, 2)
    assert.equal(state.plan.reviews[0]?.assessment, "on-track")
    assert.equal(state.plan.reviews[1]?.assessment, "needs-replan")
  })
})

describe("purity and replay determinism", () => {
  test("plan and director events do not mutate inputs", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    const afterCreate = reduce(state, created(1, "o1", { type: "outcome", title: "x" }))
    assert.deepEqual(state, frozen)
    assert.notEqual(afterCreate, state)
    assert.equal(afterCreate.plan.churn.created, 1, "churn lives on the new state, not the input")
  })

  test("replay rebuilds reviews and churn identically", () => {
    const events: RuntimeEvent[] = [
      ...withDirector(),
      created(3, "t1"),
      ev(4, "plan.node.cancelled", { nodeId: "t1", reason: "x" }),
      review(5, { reasoning: "churn is fine", assessment: "on-track" }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
