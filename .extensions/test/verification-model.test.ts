import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { initialState, reduce, replay } from "../src/runtime/reducer.ts"
import type { RuntimeEvent, RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-verify-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function ev(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "agent"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: "2026-09-06T00:00:00.000Z" }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

function observed(seq: number, evidence: Record<string, unknown>, source = "agent"): RuntimeEvent {
  return ev(seq, "fact.observed", { entity: "svc", property: "tests", value: "pass", evidence }, source)
}

// 亲证证据：verify-run 产出的形态（mechanism + 指纹）
const WITNESSED = { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 }

describe("evidence adjudication (declared → downgraded)", () => {
  test("declared test evidence is downgraded to external 0.8 with mechanism marker", () => {
    const state = fold([observed(1, { type: "test" })])
    const evidence = state.evidence["ev:id-1"]!
    assert.equal(evidence.type, "external", "declared test must be adjudicated down")
    assert.equal(evidence.reliability, 0.8)
    assert.equal(evidence.mechanism, "declared-downgraded")
    assert.equal(state.facts["svc::tests"]?.confidence, 0.6, "OBSERVED cap unchanged by adjudication")
  })

  test("declared tool_output is downgraded the same way", () => {
    const state = fold([observed(1, { type: "tool_output", command: "sneaky" })])
    const evidence = state.evidence["ev:id-1"]!
    assert.equal(evidence.type, "external")
    assert.equal(evidence.mechanism, "declared-downgraded")
    assert.equal(evidence.command, undefined, "downgraded fingerprints are untrusted and dropped")
  })

  test("witnessed test evidence keeps its type, reliability and fingerprints", () => {
    const state = fold([observed(1, WITNESSED)])
    const evidence = state.evidence["ev:id-1"]!
    assert.equal(evidence.type, "test")
    assert.equal(evidence.reliability, 0.9)
    assert.equal(evidence.mechanism, "verify-run")
    assert.equal(evidence.command, "npm test")
    assert.equal(evidence.exitCode, 0)
  })

  test("witnessed marker without command fingerprint is rejected", () => {
    assert.throws(() => fold([observed(1, { type: "test", mechanism: "verify-run" })]), /requires a command fingerprint/)
  })

  test("declared human/external/agent_claim pass through untouched", () => {
    for (const type of ["human", "external", "agent_claim"]) {
      const state = fold([observed(1, { type })])
      const evidence = state.evidence["ev:id-1"]!
      assert.equal(evidence.type, type, type)
      assert.equal(evidence.mechanism, "declared", type)
    }
  })

  test("agent_claim still can never verify", () => {
    assert.throws(
      () =>
        fold([
          observed(1, { type: "agent_claim" }),
          ev(2, "fact.verified", {
            entity: "svc",
            property: "tests",
            value: "pass",
            evidence: { type: "agent_claim" },
          }),
        ]),
      /executors cannot prove their own success/,
    )
  })
})

describe("evidence reference (observed → verified share one witness)", () => {
  function observedThenVerified(evidence2: Record<string, unknown>): RuntimeState {
    return fold([
      observed(1, WITNESSED),
      ev(2, "fact.verified", { entity: "svc", property: "tests", value: "pass", evidence: evidence2 }),
    ])
  }

  test("verified by referencing the witnessed evidence keeps one shared entry", () => {
    const state = observedThenVerified({ evidenceId: "ev:id-1" })
    const fact = state.facts["svc::tests"]!
    assert.equal(fact.status, "VERIFIED")
    assert.equal(fact.confidence, 0.9)
    assert.deepEqual(fact.evidenceIds, ["ev:id-1"], "same evidence id, no duplicate entry")
    assert.equal(Object.keys(state.evidence).length, 1)
    assert.equal(state.evidence["ev:id-1"]?.mechanism, "verify-run")
  })

  test("unknown or malformed references are rejected", () => {
    assert.throws(() => observedThenVerified({ evidenceId: "ev:ghost" }), /unknown evidence reference/)
    assert.throws(() => observedThenVerified({ evidenceId: "" }), /must be a non-empty string/)
  })

  test("value mismatch is still enforced through the reference path", () => {
    assert.throws(
      () =>
        fold([
          observed(1, WITNESSED),
          ev(2, "fact.verified", { entity: "svc", property: "tests", value: "fail", evidence: { evidenceId: "ev:id-1" } }),
        ]),
      /does not match observed value/,
    )
  })

  test("observed can cite an existing witnessed evidence", () => {
    const state = fold([
      observed(1, WITNESSED),
      ev(2, "fact.observed", { entity: "other", property: "tests", value: "pass", evidence: { evidenceId: "ev:id-1" } }),
    ])
    assert.deepEqual(state.facts["other::tests"]?.evidenceIds, ["ev:id-1"])
    assert.equal(Object.keys(state.evidence).length, 1, "citing does not duplicate entries")
  })
})

describe("run: verifier gate", () => {
  function nodeWithVerifier(seq: number, verifier: string): RuntimeEvent {
    return ev(seq, "plan.node.created", { nodeId: "t1", type: "task", title: "x", verifier })
  }

  function started(seq: number): RuntimeEvent {
    return ev(seq, "plan.node.started", { nodeId: "t1" }, "worker")
  }

  test("nodes without run: verifier are unaffected (declared external still legal)", () => {
    const state = fold([
      nodeWithVerifier(1, "all tests green and reviewed"),
      started(2),
      ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "external" } }, "worker"),
    ])
    assert.equal(state.plan.nodes["t1"]?.status, "done")
  })

  test("run: node rejects declared evidence and mismatched witnessed commands", () => {
    const base = [nodeWithVerifier(1, "run: npm test"), started(2)]
    assert.throws(
      () => fold([...base, ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "external" } }, "worker")]),
      /requires a verify-run execution of 'npm test'/,
    )
    assert.throws(
      () =>
        fold([
          ...base,
          ev(
            3,
            "plan.node.completed",
            { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm run build" } },
            "worker",
          ),
        ]),
      /requires a verify-run execution of 'npm test'/,
    )
    assert.throws(
      () => fold([nodeWithVerifier(1, "run:   "), started(2), ev(3, "plan.node.completed", { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "x" } }, "worker")]),
      /empty run: verifier command/,
    )
  })

  test("run: node rejects a witnessed run that did not pass (failing run ≠ completion)", () => {
    const events: RuntimeEvent[] = [
      nodeWithVerifier(1, "run: npm test"),
      started(2),
      ev(
        3,
        "plan.node.completed",
        { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 2 } },
        "worker",
      ),
    ]
    assert.throws(() => fold(events), /did not pass \(exit code 2\)/)
  })

  test("run: node completes with the matching witnessed command (also via evidence reference)", () => {
    const direct = fold([
      nodeWithVerifier(1, "run: npm test"),
      started(2),
      ev(
        3,
        "plan.node.completed",
        { nodeId: "t1", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } },
        "worker",
      ),
    ])
    assert.equal(direct.plan.nodes["t1"]?.status, "done")

    const viaReference = fold([
      nodeWithVerifier(1, "run: npm test"),
      started(2),
      ev(3, "fact.observed", { entity: "svc", property: "tests", value: "pass", evidence: WITNESSED }, "worker"),
      ev(4, "plan.node.completed", { nodeId: "t1", evidence: { evidenceId: "ev:id-3" } }, "worker"),
    ])
    assert.equal(viaReference.plan.nodes["t1"]?.status, "done", "referenced witness satisfies the gate")
  })

  test("solver success inherits the same gate from its contract node", () => {
    const base = [
      nodeWithVerifier(1, "run: npm test"),
      ev(2, "solver.spawned", { nodeId: "t1", solverId: "s1", executor: "worker" }, "director"),
    ]
    assert.throws(
      () =>
        fold([
          ...base,
          ev(3, "solver.reported", { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "external" } }),
        ]),
      /requires a verify-run execution of 'npm test'/,
    )
    const state = fold([
      ...base,
      ev(
        3,
        "solver.reported",
        { solverId: "s1", outcome: "success", summary: "done", evidence: { type: "test", mechanism: "verify-run", command: "npm test", exitCode: 0 } },
      ),
    ])
    assert.equal(state.solvers["s1"]?.status, "finished")
    assert.equal(state.plan.nodes["t1"]?.status, "done")
  })
})

describe("replay isomorphism with legacy (unmarked) declared evidence", () => {
  test("fold === replay across adjudicated history", () => {
    const events: RuntimeEvent[] = [
      // Phase 2–6 时代的旧式申报：无 mechanism 字段
      ev(1, "fact.observed", { entity: "svc", property: "tests", value: "pass", evidence: { type: "tool_output" } }, "old-agent"),
      ev(2, "fact.verified", { entity: "svc", property: "tests", value: "pass", evidence: { type: "test" } }, "old-ci"),
      // 新式亲证
      ev(3, "fact.observed", { entity: "new", property: "build", value: "pass", evidence: WITNESSED }, "agent"),
    ]
    const replayed = replay(events)
    assert.deepEqual(replayed, fold(events), "adjudication must be identical on dispatch and replay")
    assert.equal(replayed.evidence["ev:id-1"]?.mechanism, "declared-downgraded")
    assert.equal(replayed.evidence["ev:id-2"]?.type, "external")
    assert.equal(replayed.evidence["ev:id-3"]?.mechanism, "verify-run")
  })

  test("legacy verified facts survive replay via the downgraded external channel", () => {
    const events: RuntimeEvent[] = [
      observed(1, { type: "test" }),
      ev(2, "fact.verified", { entity: "svc", property: "tests", value: "pass", evidence: { type: "test" } }),
    ]
    const state = replay(events)
    assert.equal(state.facts["svc::tests"]?.status, "VERIFIED", "downgraded external canVerify holds")
    assert.equal(state.facts["svc::tests"]?.confidence, 0.8)
  })

  test("evidence fields do not break purity", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    const after = reduce(state, observed(1, WITNESSED))
    assert.deepEqual(state, frozen)
    assert.notEqual(after, state)
  })
})
