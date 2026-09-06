import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, memoryRecall, reduce, replay } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-memory-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "agent"): RuntimeEvent {
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

function lesson(seq: number, overrides: Record<string, unknown> = {}, source = "agent"): RuntimeEvent {
  return ev(
    seq,
    "memory.lesson.recorded",
    {
      subject: "verify-runs",
      lesson: "always set timeoutMs >= 90s for integration test runs",
      anchors: ["seq:1"],
      ...overrides,
    },
    source,
  )
}

// 底账（seq 1–8）：director 合同 + 失败节点 + 取消节点 + needs-replan 决策
function backdrop(): RuntimeEvent[] {
  return [
    created(1, "o1", { type: "outcome", title: "ship it" }),
    ev(2, "solver.spawned", { nodeId: "o1", solverId: "d1", role: "director" }),
    created(3, "t-ok"),
    created(4, "t-fail", { title: "doomed" }),
    ev(5, "plan.node.started", { nodeId: "t-fail" }, "worker"),
    ev(6, "plan.node.failed", { nodeId: "t-fail", reason: "build unrecoverable" }, "worker"),
    ev(7, "plan.node.cancelled", { nodeId: "t-ok", reason: "obsolete" }),
    ev(8, "director.reviewed", { directorId: "d1", nodeId: "o1", assessment: "needs-replan", reasoning: "dead end" }),
  ]
}

// 底账 + 两条 lesson（seq 9–10）
function full(): RuntimeEvent[] {
  return [...backdrop(), lesson(9), lesson(10, { subject: "db-migrations", lesson: "backup first" })]
}

describe("lesson anchoring (fabrication is rejected)", () => {
  test("empty anchors, unknown evidence/node, out-of-range seq are rejected", () => {
    assert.throws(() => fold([lesson(1, { anchors: [] })]), /non-empty array/)
    assert.throws(() => fold([lesson(1, { anchors: ["ev:id-99"] })]), /unknown evidence anchor/)
    assert.throws(() => fold([lesson(1, { anchors: ["ghost-node"] })]), /unknown node anchor/)
    assert.throws(() => fold([lesson(1, { anchors: ["seq:9"] })]), /out of range/)
    assert.throws(() => fold([lesson(1, { anchors: ["seq:0"] })]), /out of range/)
    assert.throws(() => fold([lesson(1, { anchors: [""] })]), /non-empty strings/)
  })

  test("valid anchors pass: evidence, in-range seq, existing node; duplicates dedupe", () => {
    const state = fold([
      created(1, "t-ok"),
      ev(2, "fact.observed", {
        entity: "db",
        property: "deployed",
        value: true,
        evidence: { type: "tool_output", mechanism: "verify-run", command: "deploy.sh" },
      }),
      lesson(3, { anchors: ["ev:id-2", "seq:1", "t-ok", "seq:1"] }),
    ])
    const entry = state.memory.lessons["ls:id-3"]!
    assert.equal(entry.subject, "verify-runs")
    assert.deepEqual(entry.anchorIds, ["ev:id-2", "seq:1", "t-ok"], "duplicates removed, order kept")
    assert.equal(entry.retired, undefined)
  })

  test("lesson id is derived from the event id (agent cannot choose it)", () => {
    const state = fold([created(1, "t1"), lesson(2)])
    assert.ok(state.memory.lessons["ls:id-2"])
  })
})

describe("lesson retirement (re-ranked out, never deleted)", () => {
  test("retire stamps reason and keeps the entry", () => {
    const state = fold([
      created(1, "t1"),
      lesson(2),
      ev(3, "memory.lesson.retired", { lessonId: "ls:id-2", reason: "disproven by run #42" }),
    ])
    const entry = state.memory.lessons["ls:id-2"]!
    assert.equal(entry.retired, true)
    assert.equal(entry.retireReason, "disproven by run #42")
    assert.ok(entry.retiredAt)
    assert.equal(entry.lesson, "always set timeoutMs >= 90s for integration test runs", "content preserved")
  })

  test("unknown lesson, double retire, missing reason are rejected", () => {
    assert.throws(() => fold([ev(1, "memory.lesson.retired", { lessonId: "ls:ghost", reason: "x" })]), /unknown lesson/)
    assert.throws(
      () =>
        fold([
          created(1, "t1"),
          lesson(2),
          ev(3, "memory.lesson.retired", { lessonId: "ls:id-2", reason: "a" }),
          ev(4, "memory.lesson.retired", { lessonId: "ls:id-2", reason: "b" }),
        ]),
      /already retired/,
    )
    assert.throws(
      () => fold([created(1, "t1"), lesson(2), ev(3, "memory.lesson.retired", { lessonId: "ls:id-2" })]),
      /'reason' must be/,
    )
  })
})

describe("memoryRecall views", () => {
  test("lessons view filters by subject, hides retired by default, active before retired", () => {
    const state = fold([
      ...full(),
      ev(11, "memory.lesson.retired", { lessonId: "ls:id-9", reason: "disproven" }),
    ])
    const recall = memoryRecall(state)
    assert.equal(recall.lessons.length, 1, "retired hidden by default")
    assert.equal(recall.lessons[0]?.subject, "db-migrations")
    const withRetired = memoryRecall(state, { showRetired: true })
    assert.equal(withRetired.lessons.length, 2)
    assert.equal(withRetired.lessons[0]?.retired, undefined, "active first")
    assert.equal(withRetired.lessons[1]?.retired, true)
    assert.deepEqual(
      memoryRecall(state, { subject: "db-migrations" }).lessons.map((l) => l.subject),
      ["db-migrations"],
    )
  })

  test("failures view aggregates failed nodes and solvers", () => {
    const state = fold([
      ...full(),
      created(11, "t-solver-fail"),
      ev(12, "solver.spawned", { nodeId: "t-solver-fail", solverId: "s1", executor: "worker" }),
      ev(13, "solver.reported", { solverId: "s1", outcome: "failure", summary: "broke", reason: "dead end" }),
    ])
    const failures = memoryRecall(state).failures
    assert.deepEqual(
      failures.nodes.map((n: { id: string }) => n.id),
      ["t-fail", "t-solver-fail"],
      "solver failure couples its contract node into the failure view",
    )
    assert.ok(failures.nodes.some((n: { note?: string }) => n.note === "build unrecoverable"))
    assert.deepEqual(
      failures.solvers.map((s: { id: string }) => s.id),
      ["s1"],
    )
  })

  test("decisions view carries recent reviews", () => {
    const decisions = memoryRecall(fold(full())).decisions
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]?.assessment, "needs-replan")
  })

  test("problems view carries goals, outcomes and known unknowns", () => {
    const events: RuntimeEvent[] = [
      ev(1, "goal.set", { goal: "ship it" }, "director"),
      ...backdrop().map((e) => ({ ...e, seq: e.seq + 1, id: `id-${e.seq + 1}` })),
      created(10, "o9", { type: "outcome", title: "second goal", intent: "because users wait" }),
      created(11, "t-gated", { preconditionFacts: ["net::up"] }),
    ]
    const problems = memoryRecall(fold(events)).problems
    assert.deepEqual(problems.goals as string[], ["ship it"])
    assert.ok(problems.outcomes.some((o: { intent?: string }) => o.intent === "because users wait"))
    assert.ok(problems.unknownFacts.includes("net::up"))
  })

  test("include slices restrict views", () => {
    const view = memoryRecall(fold(full()), { include: "failures" })
    assert.deepEqual(view.lessons, [])
    assert.deepEqual(view.decisions, [])
    assert.deepEqual(view.problems.goals, [])
    assert.equal(view.failures.nodes.length, 1)
  })
})

describe("purity and replay determinism", () => {
  test("memory events do not mutate inputs", () => {
    const state = initialState()
    const frozen0 = JSON.parse(JSON.stringify(state))
    const afterCreate = reduce(state, created(1, "t1"))
    assert.deepEqual(state, frozen0)
    assert.notEqual(afterCreate, state)
    const frozen1 = JSON.parse(JSON.stringify(afterCreate))
    const afterLesson = reduce(afterCreate, lesson(2))
    assert.deepEqual(afterCreate, frozen1)
    assert.notEqual(afterLesson, afterCreate)
  })

  test("replay rebuilds lessons identically", () => {
    const events = [
      ...full(),
      ev(11, "memory.lesson.retired", { lessonId: "ls:id-9", reason: "x" }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
