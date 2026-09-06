import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, reduce, replay, researchQuery } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-research-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "researcher"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: `2026-09-06T00:00:${String(seq % 60).padStart(2, "0")}.000Z` }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

function raised(seq: number, overrides: Record<string, unknown> = {}): RuntimeEvent {
  return ev(seq, "research.question.raised", { question: "which cache eviction policy fits our workload?", subject: "caching", ...overrides })
}

function created(seq: number, nodeId: string, extra: Record<string, unknown> = {}): RuntimeEvent {
  return ev(seq, "plan.node.created", { nodeId, type: "task", title: `node ${nodeId}`, ...extra })
}

// 底账：question → hypothesis(prior 0.5, de-novo) → 亲证证据
function backdrop(): RuntimeEvent[] {
  return [
    raised(1),
    ev(2, "research.hypothesis.proposed", {
      questionId: "q:id-1",
      statement: "LRU fits our read-heavy workload",
      prior: 0.5,
      rationale: "common default for read-heavy traces",
      lineage: { mechanism: "de-novo" },
    }),
    ev(3, "fact.observed", {
      entity: "trace-sim",
      property: "hit-rate-lru",
      value: 0.91,
      evidence: { type: "tool_output", mechanism: "verify-run", command: "node simulate.mjs", exitCode: 0 },
    }),
  ]
}

describe("question lifecycle", () => {
  test("raised derives its id and keeps motivation", () => {
    const state = fold([raised(1, { motivation: "gate blocks t1" })])
    const q = state.research.questions["q:id-1"]!
    assert.equal(q.question, "which cache eviction policy fits our workload?")
    assert.equal(q.subject, "caching")
    assert.equal(q.motivation, "gate blocks t1")
    assert.equal(q.resolved, undefined)
  })

  test("resolved requires the question to exist, be open, and carry a resolution", () => {
    assert.throws(() => fold([ev(1, "research.question.resolved", { questionId: "q:ghost", resolution: "x" })]), /unknown question/)
    assert.throws(
      () => fold([raised(1), ev(2, "research.question.resolved", { questionId: "q:id-1" })]),
      /'resolution' must be a non-empty string/,
    )
    const state = fold([raised(1), ev(2, "research.question.resolved", { questionId: "q:id-1", resolution: "LRU, backed by trace sim" })])
    assert.equal(state.research.questions["q:id-1"]?.resolved, true)
    assert.equal(state.research.questions["q:id-1"]?.resolution, "LRU, backed by trace sim")
  })

  test("double resolution is rejected", () => {
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.question.resolved", { questionId: "q:id-1", resolution: "a" }),
          ev(3, "research.question.resolved", { questionId: "q:id-1", resolution: "b" }),
        ]),
      /already resolved/,
    )
  })
})

describe("hypothesis.proposed discipline", () => {
  test("proposing requires an open question, valid prior and rationale", () => {
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.hypothesis.proposed", {
            questionId: "q:ghost",
            statement: "x",
            prior: 0.5,
            rationale: "r",
            lineage: { mechanism: "de-novo" },
          }),
        ]),
      /unknown question/,
    )
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.question.resolved", { questionId: "q:id-1", resolution: "done" }),
          ev(3, "research.hypothesis.proposed", {
            questionId: "q:id-1",
            statement: "x",
            prior: 0.5,
            rationale: "r",
            lineage: { mechanism: "de-novo" },
          }),
        ]),
      /already resolved/,
    )
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.hypothesis.proposed", {
            questionId: "q:id-1",
            statement: "x",
            prior: 1.5,
            rationale: "r",
            lineage: { mechanism: "de-novo" },
          }),
        ]),
      /'prior' must be a number in \[0, 1\]/,
    )
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.hypothesis.proposed", { questionId: "q:id-1", statement: "x", prior: 0.5, lineage: { mechanism: "de-novo" } }),
        ]),
      /'rationale' must be a non-empty string/,
    )
  })

  test("lineage: de-novo takes no parent; inspired-by/refine require one; refine requires a tested parent", () => {
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.hypothesis.proposed", {
            questionId: "q:id-1",
            statement: "x",
            prior: 0.5,
            rationale: "r",
            lineage: { mechanism: "de-novo", parentId: "h:id-1" },
          }),
        ]),
      /de-novo hypotheses have no parent/,
    )
    assert.throws(
      () =>
        fold([
          raised(1),
          ev(2, "research.hypothesis.proposed", { questionId: "q:id-1", statement: "x", prior: 0.5, rationale: "r", lineage: { mechanism: "refine" } }),
        ]),
      /'refine' requires a parentId/,
    )
    // 防泡沫：未经检验（无证据无 verdict）的假设不能 refine
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.proposed", {
            questionId: "q:id-1",
            statement: "refined too early",
            prior: 0.6,
            rationale: "tighter",
            lineage: { mechanism: "refine", parentId: "h:id-2" },
          }),
        ]),
      /cannot refine untested hypothesis/,
    )
    // parent 挂上证据后 refine 放行
    const tested = fold([
      ...backdrop(),
      ev(4, "research.hypothesis.belief.updated", {
        hypothesisId: "h:id-2",
        belief: 0.7,
        rationale: "sim evidence attached",
        evidenceId: "ev:id-3",
      }),
      ev(5, "research.hypothesis.proposed", {
        questionId: "q:id-1",
        statement: "refined variant",
        prior: 0.6,
        rationale: "tighter",
        lineage: { mechanism: "refine", parentId: "h:id-2" },
      }),
    ])
    assert.equal(tested.research.hypotheses["h:id-5"]?.lineage.parentId, "h:id-2")
  })
})

describe("belief updates (validation gate)", () => {
  test("belief moves only on real ledger evidence", () => {
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.85, rationale: "trust me", evidenceId: "ev:ghost" }),
        ]),
      /belief moves only on real ledger evidence/,
    )
  })

  test("valid move appends evidence (deduped) and freezes after verdict", () => {
    const state = fold([
      ...backdrop(),
      ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.85, rationale: "hit-rate 0.91 supports LRU", evidenceId: "ev:id-3" }),
      ev(5, "research.hypothesis.evaluated", {
        hypothesisId: "h:id-2",
        verdict: "supported",
        reasoning: "0.85 ≥ 0.8 with sim evidence",
        evidenceId: "ev:id-3",
      }),
    ])
    const h = state.research.hypotheses["h:id-2"]!
    assert.equal(h.belief, 0.85)
    assert.equal(h.verdict, "supported")
    assert.deepEqual(h.evidenceIds, ["ev:id-3"])
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.85, rationale: "r", evidenceId: "ev:id-3" }),
          ev(5, "research.hypothesis.evaluated", {
            hypothesisId: "h:id-2",
            verdict: "supported",
            reasoning: "x",
            evidenceId: "ev:id-3",
          }),
          ev(6, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.9, rationale: "r2", evidenceId: "ev:id-3" }),
        ]),
      /frozen at verdict 'supported'/,
    )
  })

  test("belief out of range is rejected", () => {
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 1.2, rationale: "r", evidenceId: "ev:id-3" }),
        ]),
      /'belief' must be a number in \[0, 1\]/,
    )
  })
})

describe("verdict thresholds (institution, not assertion)", () => {
  test("support below threshold is refused", () => {
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.7, rationale: "hopeful", evidenceId: "ev:id-3" }),
          ev(5, "research.hypothesis.evaluated", {
            hypothesisId: "h:id-2",
            verdict: "supported",
            reasoning: "wishing",
            evidenceId: "ev:id-3",
          }),
        ]),
      /belief 0.7 < 0.8/,
    )
  })

  test("refutation above threshold is refused", () => {
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.evaluated", {
            hypothesisId: "h:id-2",
            verdict: "refuted",
            reasoning: "gut feeling",
            evidenceId: "ev:id-3",
          }),
        ]),
      /belief 0.5 > 0.2/,
    )
  })

  test("refuted passes once belief crosses the floor; dormant needs reasoning", () => {
    const refuted = fold([
      ...backdrop(),
      ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.1, rationale: "hit-rate contradicts LRU", evidenceId: "ev:id-3" }),
      ev(5, "research.hypothesis.evaluated", {
        hypothesisId: "h:id-2",
        verdict: "refuted",
        reasoning: "sim evidence contradicts the statement",
        evidenceId: "ev:id-3",
      }),
    ])
    assert.equal(refuted.research.hypotheses["h:id-2"]?.verdict, "refuted")
    assert.throws(
      () =>
        fold([
          ...backdrop(),
          ev(4, "research.hypothesis.evaluated", { hypothesisId: "h:id-2", verdict: "dormant", reasoning: "", evidenceId: "ev:id-3" }),
        ]),
      /'reasoning' must be a non-empty string/,
    )
  })
})

describe("researchQuery and plan tests declaration", () => {
  test("open questions first; filters by subject and questionId", () => {
    const state = fold([
      ...backdrop(),
      ev(4, "research.question.raised", { question: "second question", subject: "other" }),
      ev(5, "research.hypothesis.proposed", {
        questionId: "q:id-4",
        statement: "h on second",
        prior: 0.4,
        rationale: "r",
        lineage: { mechanism: "de-novo" },
      }),
      ev(6, "research.question.resolved", { questionId: "q:id-4", resolution: "nope" }),
    ])
    const view = researchQuery(state)
    assert.equal(view.questions[0]?.id, "q:id-1", "open question first")
    assert.equal(view.questions.length, 2)
    assert.deepEqual(researchQuery(state, { subject: "other" }).questions.map((q) => q.id), ["q:id-4"])
    assert.deepEqual(researchQuery(state, { questionId: "q:id-4" }).hypotheses.map((h) => h.id), ["h:id-5"])
  })

  test("plan nodes can declare tests against an existing hypothesis", () => {
    const state = fold([
      ...backdrop(),
      created(4, "exp1"),
    ])
    assert.throws(() => fold([created(1, "exp1", { tests: "h:ghost" })]), /unknown tests hypothesis/)
    void state
    const withTests = fold([
      ...backdrop(),
      created(4, "exp1", { tests: "h:id-2" }),
    ])
    assert.equal(withTests.plan.nodes["exp1"]?.tests, "h:id-2")
  })
})

describe("purity and replay determinism", () => {
  test("research events do not mutate inputs", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    const after = reduce(state, raised(1))
    assert.deepEqual(state, frozen)
    assert.notEqual(after, state)
  })

  test("replay rebuilds the epistemic state identically", () => {
    const events = [
      ...backdrop(),
      ev(4, "research.hypothesis.belief.updated", { hypothesisId: "h:id-2", belief: 0.85, rationale: "sim supports", evidenceId: "ev:id-3" }),
      ev(5, "research.hypothesis.evaluated", {
        hypothesisId: "h:id-2",
        verdict: "supported",
        reasoning: "supported",
        evidenceId: "ev:id-3",
      }),
      ev(6, "research.question.resolved", { questionId: "q:id-1", resolution: "LRU" }),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})
