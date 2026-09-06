import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, planHealth, reduce, replay } from "../src/runtime/reducer.ts"
import { MAX_NODE_RETRIES } from "../src/runtime/types.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-recovery-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "director"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: `2026-09-06T00:00:${String(seq % 60).padStart(2, "0")}.000Z` }
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

function failed(seq: number, nodeId: string, extra: Record<string, unknown> = {}, source = "worker"): RuntimeEvent {
  return ev(seq, "plan.node.failed", { nodeId, reason: "broke", ...extra }, source)
}

function reopened(seq: number, nodeId: string, extra: Record<string, unknown> = {}, source = "director"): RuntimeEvent {
  return ev(seq, "plan.node.reopened", { nodeId, reason: "retry with a fix", ...extra }, source)
}

function retryLoop(times: number): RuntimeEvent[] {
  const events: RuntimeEvent[] = [created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w")]
  let seq = 3
  for (let i = 0; i < times; i++) {
    events.push(failed(seq, "t1"), reopened(seq + 1, "t1"))
    seq += 2
    if (i < times - 1) {
      events.push(ev(seq, "plan.node.started", { nodeId: "t1" }, "w"))
      seq += 1
    }
  }
  return events
}

describe("plan.node.reopened (local repair restart)", () => {
  test("failed → pending with retryCount, owner cleared, fresh spawn possible", () => {
    const state = fold([
      created(1, "t1"),
      ev(2, "plan.node.started", { nodeId: "t1" }, "worker"),
      failed(3, "t1"),
      reopened(4, "t1"),
      ev(5, "solver.spawned", { nodeId: "t1", solverId: "s2", executor: "worker-b" }, "director"),
    ])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.status, "active", "re-opened node can be claimed again")
    assert.equal(node.owner, "s2", "ownership handed to the fresh solver")
    assert.equal(node.retryCount, 1)
    // reopen 后 pending 时 owner 已清空（failed 状态残留的 owner 不延续）
    const afterReopen = fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "worker"), failed(3, "t1"), reopened(4, "t1")])
    assert.equal(afterReopen.plan.nodes["t1"]?.owner, undefined)
    assert.equal(afterReopen.plan.nodes["t1"]?.status, "pending")
  })

  test("reason is required and recorded as the node note", () => {
    assert.throws(
      () => fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w"), failed(3, "t1", { reason: undefined })]),
      /'reason' must be/,
    )
    const state = fold([
      created(1, "t1"),
      ev(2, "plan.node.started", { nodeId: "t1" }, "w"),
      failed(3, "t1"),
      reopened(4, "t1", { reason: "patched the flaky mock" }),
    ])
    assert.equal(state.plan.nodes["t1"]?.note, "patched the flaky mock")
  })

  test("only failed nodes reopen; pending/active/done/cancelled refuse", () => {
    assert.throws(() => fold([created(1, "t1"), reopened(2, "t1")]), /cannot reopen plan node in status pending/)
    assert.throws(
      () => fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w"), reopened(3, "t1")]),
      /cannot reopen plan node in status active/,
    )
    assert.throws(
      () =>
        fold([
          created(1, "t1"),
          ev(2, "plan.node.started", { nodeId: "t1" }, "w"),
          ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }, "w"),
          reopened(4, "t1"),
        ]),
      /cannot reopen plan node in status done/,
    )
    assert.throws(
      () => fold([created(1, "t1"), ev(2, "plan.node.cancelled", { nodeId: "t1", reason: "x" }), reopened(3, "t1")]),
      /cannot reopen plan node in status cancelled/,
    )
  })
})

describe("circuit breaker (retry ceiling is an institution)", () => {
  test(`reopen succeeds up to ${MAX_NODE_RETRIES} retries, then the breaker opens`, () => {
    const atLimit = fold(retryLoop(MAX_NODE_RETRIES))
    assert.equal(atLimit.plan.nodes["t1"]?.status, "pending")
    assert.equal(atLimit.plan.nodes["t1"]?.retryCount, MAX_NODE_RETRIES)
    assert.throws(
      () =>
        fold([
          ...retryLoop(MAX_NODE_RETRIES),
          ev(11, "plan.node.started", { nodeId: "t1" }, "w"),
          failed(12, "t1"),
          reopened(13, "t1"),
        ]),
      /exhausted 3 retries: circuit breaker open — replan instead/,
    )
  })

  test("breaker state is visible in planHealth (retryable vs exhausted)", () => {
    const state = fold([
      ...retryLoop(MAX_NODE_RETRIES),
      ev(11, "plan.node.started", { nodeId: "t1" }, "w"),
      failed(12, "t1"),
    ])
    const health = planHealth(state)
    assert.deepEqual(health.retryableFailures, [], "retry budget spent")
    assert.deepEqual(
      health.exhaustedFailures.map((n) => n.id),
      ["t1"],
    )
    // reopen 后节点回到 pending（不再是失败态）——breaker 视图只在 failed 态可见
    const mid = planHealth(
      fold([
        ...retryLoop(1),
        ev(5, "plan.node.started", { nodeId: "t1" }, "w"),
        failed(6, "t1"),
      ]),
    )
    assert.deepEqual(
      mid.retryableFailures.map((n) => n.id),
      ["t1"],
    )
    assert.deepEqual(mid.exhaustedFailures, [])
  })
})

describe("failure classification (taxonomy as data)", () => {
  test("plan.node.failed accepts a valid class and records it", () => {
    const state = fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w"), failed(3, "t1", { failureClass: "tool" })])
    assert.equal(state.plan.nodes["t1"]?.failureClass, "tool")
  })

  test("invalid classes are rejected on both failure paths", () => {
    assert.throws(() => fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w"), failed(3, "t1", { failureClass: "vibes" })]), /'failureClass' must be one of/)
    assert.throws(
      () =>
        fold([
          created(1, "t1"),
          ev(2, "solver.spawned", { nodeId: "t1", solverId: "s1", executor: "w" }),
          ev(3, "solver.reported", { solverId: "s1", outcome: "failure", summary: "x", reason: "y", failureClass: "vibes" }),
        ]),
      /'failureClass' must be one of/,
    )
  })

  test("solver failure propagates its class to the contract node", () => {
    const state = fold([
      created(1, "t1"),
      ev(2, "solver.spawned", { nodeId: "t1", solverId: "s1", executor: "w" }),
      ev(3, "solver.reported", { solverId: "s1", outcome: "failure", summary: "broke", reason: "approach dead", failureClass: "logic" }),
    ])
    assert.equal(state.solvers["s1"]?.status, "failed")
    assert.equal(state.plan.nodes["t1"]?.failureClass, "logic", "node inherits the solver's classification")
  })

  test("failureClass is optional (absent stays absent)", () => {
    const state = fold([created(1, "t1"), ev(2, "plan.node.started", { nodeId: "t1" }, "w"), failed(3, "t1", {}, "w")])
    assert.equal(state.plan.nodes["t1"]?.failureClass, undefined)
  })
})

describe("supersedes (subgraph replan structure)", () => {
  test("replacement must target an existing failed node", () => {
    assert.throws(() => fold([created(1, "t2", { supersedes: "ghost" })]), /unknown supersedes target/)
    assert.throws(() => fold([created(1, "t1"), created(2, "t2", { supersedes: "t1" })]), /must be a failed node/)
  })

  test("valid replacement links to the failed node", () => {
    const state = fold([
      created(1, "t1"),
      ev(2, "plan.node.started", { nodeId: "t1" }, "w"),
      failed(3, "t1", { failureClass: "logic" }),
      created(4, "t2", { supersedes: "t1", intent: "different approach" }),
    ])
    const replacement = state.plan.nodes["t2"]!
    assert.equal(replacement.supersedes, "t1")
    assert.equal(replacement.status, "pending")
    assert.equal(state.plan.nodes["t1"]?.status, "failed", "failed node stays failed — replacement runs beside it")
  })
})

describe("retry then completion unblocks dependents (derived recovery)", () => {
  test("reopen → complete → dependent gate reopens automatically", () => {
    const state = fold([
      created(1, "t1"),
      created(2, "t2", { dependsOn: ["t1"] }),
      ev(3, "plan.node.started", { nodeId: "t1" }, "w"),
      failed(4, "t1"),
      reopened(5, "t1"),
      ev(6, "plan.node.started", { nodeId: "t1" }, "w"),
      ev(7, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }, "w"),
      ev(8, "plan.node.started", { nodeId: "t2" }, "w2"),
    ])
    assert.equal(state.plan.nodes["t2"]?.status, "active", "dependent proceeds after the retried prerequisite completes")
  })
})

describe("purity and replay determinism", () => {
  test("recovery events do not mutate inputs", () => {
    const state = initialState()
    const frozen0 = JSON.parse(JSON.stringify(state))
    const s1 = reduce(state, created(1, "t1"))
    assert.deepEqual(state, frozen0)
    const frozen1 = JSON.parse(JSON.stringify(s1))
    const s1b = reduce(s1, ev(2, "plan.node.started", { nodeId: "t1" }, "w"))
    const frozen2 = JSON.parse(JSON.stringify(s1b))
    const s2 = reduce(s1b, failed(3, "t1", {}, "w"))
    assert.deepEqual(s1b, frozen2)
    const frozen3 = JSON.parse(JSON.stringify(s2))
    const s3 = reduce(s2, reopened(4, "t1"))
    assert.deepEqual(s2, frozen3, "reopened must not mutate its input")
    assert.notEqual(s3, s2)
    assert.equal(s3.plan.nodes["t1"]?.status, "pending")
  })

  test("replay rebuilds recovery state identically", () => {
    const events = [
      ...retryLoop(2),
      ev(8, "plan.node.started", { nodeId: "t1" }, "w"),
      ev(9, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }, "w"),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
