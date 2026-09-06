// 完成门禁强化（Phase 12 调试阶段第 2 项）：装灯不装锁。
// 三件事：① 完成档案 executionTrail（active 窗口内黑匣子定格——零动作交卷
// 自证其伪）；② 完成分级 witnessed/attested（attested 合法但显形）；
// ③ planHealth/tick 发癫检测数据面。判定与处理归智能（Director/教义）。
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, planHealth, reduce, replay } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-gate-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, at?: string, source = "worker"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: at ?? `2026-09-06T00:00:${String(seq % 60).padStart(2, "0")}.000Z` }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

const WITNESS = { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 }

function action(seq: number, at: string, name: string, source = "flight-recorder"): RuntimeEvent {
  return ev(seq, "action.executed", { name, outcome: "…", ok: true }, at, source)
}

describe("startedAt and completionKind derivation", () => {
  test("witnessed completion via verify-run evidence", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      ev(2, "plan.node.started", { nodeId: "t1" }),
      ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }),
    ])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.startedAt, "2026-09-06T00:00:02.000Z", "startedAt frozen at the started event")
    assert.equal(node.completionKind, "witnessed")
  })

  test("attested completion via declared evidence (legal, but visible)", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      ev(2, "plan.node.started", { nodeId: "t1" }),
      ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "external" } }),
    ])
    assert.equal(state.plan.nodes["t1"]?.completionKind, "attested")
  })
})

describe("executionTrail (the active window freeze)", () => {
  test("counts only actions inside the started→completed window, with tool distribution", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      action(2, "2026-09-06T00:00:00.500Z", "bash"), // started 之前——不计入
      ev(3, "plan.node.started", { nodeId: "t1" }),
      action(4, "2026-09-06T00:00:03.000Z", "bash", "flight-recorder"),
      action(5, "2026-09-06T00:00:04.000Z", "bash", "flight-recorder"),
      action(6, "2026-09-06T00:00:05.000Z", "edit", "flight-recorder"),
      ev(7, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }),
      action(8, "2026-09-06T00:00:30.000Z", "bash", "flight-recorder"), // completed 之后——不计入
    ])
    const node = state.plan.nodes["t1"]!
    assert.deepEqual(node.executionTrail, { count: 3, tools: ["bash×2", "edit"] })
  })

  test("zero-action completion is visible (the hallucinated hand-in)", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      ev(2, "plan.node.started", { nodeId: "t1" }),
      ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "external" } }),
    ])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.completionKind, "attested")
    assert.deepEqual(node.executionTrail, { count: 0, tools: [] }, "no black-box records in the window")
    const health = planHealth(state)
    assert.deepEqual(
      health.attestedDone.map((n) => n.id),
      ["t1"],
    )
    assert.equal(health.attestedDone[0]?.executionTrail?.count, 0, "zero-action hand-in glows on the dashboard")
    assert.deepEqual(health.witnessedDone, [])
  })

  test("solver success inherits the same grading and trail", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      ev(2, "solver.spawned", { nodeId: "t1", solverId: "s1", executor: "w" }),
      action(3, "2026-09-06T00:00:03.000Z", "bash", "flight-recorder"),
      ev(4, "solver.reported", {
        solverId: "s1",
        outcome: "success",
        summary: "done",
        evidence: { type: "external" },
      }),
    ])
    const node = state.plan.nodes["t1"]!
    assert.equal(node.completionKind, "attested")
    assert.equal(node.executionTrail?.count, 1)
  })
})

describe("planHealth witnessed/attested split", () => {
  test("done nodes split by completion kind", () => {
    const state = fold([
      ev(1, "plan.node.created", { nodeId: "tW", type: "task", title: "w" }),
      ev(2, "plan.node.started", { nodeId: "tW" }),
      ev(3, "plan.node.completed", { nodeId: "tW", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }),
      ev(4, "plan.node.created", { nodeId: "tA", type: "task", title: "a" }),
      ev(5, "plan.node.started", { nodeId: "tA" }),
      ev(6, "plan.node.completed", { nodeId: "tA", evidence: { type: "external" } }),
    ])
    const health = planHealth(state)
    assert.deepEqual(
      health.witnessedDone.map((n) => n.id),
      ["tW"],
    )
    assert.deepEqual(
      health.attestedDone.map((n) => n.id),
      ["tA"],
    )
    assert.equal(health.doneNodes, 2, "total unchanged — grading is additive visibility")
  })
})

describe("purity and replay determinism", () => {
  test("completion events do not mutate inputs", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    const after = reduce(state, ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }))
    assert.deepEqual(state, frozen)
    assert.notEqual(after, state)
  })

  test("replay rebuilds grading and trail identically", () => {
    const events = [
      ev(1, "plan.node.created", { nodeId: "t1", type: "task", title: "x" }),
      action(2, "2026-09-06T00:00:01.000Z", "bash", "flight-recorder"),
      ev(3, "plan.node.started", { nodeId: "t1" }),
      action(4, "2026-09-06T00:00:04.000Z", "edit", "flight-recorder"),
      ev(5, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
