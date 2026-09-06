import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deriveConfidence, initialState, reduce, replay } from "../src/runtime/reducer.ts"
import { createRuntime } from "../src/runtime/index.ts"
import { StateSnapshot } from "../src/runtime/snapshot.ts"
import { FileStateStore } from "../src/state/state-store.ts"
import { SCHEMA_VERSION, type RuntimeEvent, type RuntimeState } from "../src/runtime/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-world-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function factEvent(seq: number, type: RuntimeEvent["type"], payload: Record<string, unknown>, source = "tester"): RuntimeEvent {
  return { id: `id-${seq}`, seq, type, source, payload, timestamp: "2026-09-05T00:00:00.000Z" }
}

function fold(events: RuntimeEvent[]): RuntimeState {
  let state = initialState()
  for (const event of events) {
    state = reduce(state, event)
  }
  return state
}

function observed(seq: number, value: unknown, type: string, source = "tester"): RuntimeEvent {
  // test/tool_output 在 Phase 7 后只能亲证（否则被裁定降级为 external）
  const witnessed = type === "test" || type === "tool_output"
  return factEvent(
    seq,
    "fact.observed",
    {
      entity: "svc",
      property: "build",
      value,
      evidence: witnessed ? { type, mechanism: "verify-run", command: "npm test" } : { type },
    },
    source,
  )
}

describe("fact lifecycle", () => {
  test("unknown → observed → verified → staled → observed → invalidated with derived confidence", () => {
    const state = fold([
      factEvent(1, "fact.unknown", { entity: "service/auth", property: "build" }, "director"),
      factEvent(2, "fact.observed", {
        entity: "service/auth",
        property: "build",
        value: "passing",
        evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" },
      }),
      factEvent(3, "fact.verified", {
        entity: "service/auth",
        property: "build",
        value: "passing",
        evidence: { type: "test", mechanism: "verify-run", command: "npm test" },
      }),
      factEvent(4, "fact.staled", { entity: "service/auth", property: "build", note: "deps bumped" }, "watcher"),
      factEvent(5, "fact.observed", {
        entity: "service/auth",
        property: "build",
        value: "passing",
        evidence: { type: "human" },
      }, "alice"),
      factEvent(6, "fact.invalidated", {
        entity: "service/auth",
        property: "build",
        evidence: { type: "external" },
        note: "downstream incident report",
      }, "monitor"),
    ])
    const key = "service/auth::build"
    assert.equal(state.revision, 6)

    assert.deepEqual(
      { status: state.facts[key]?.status, value: state.facts[key]?.value, confidence: state.facts[key]?.confidence },
      { status: "INVALID", value: "passing", confidence: 0 },
    )
    assert.equal(state.facts[key]?.note, "downstream incident report")

    // 每次状态变更都换上支撑本次结论的证据
    assert.deepEqual(state.facts[key]?.evidenceIds, ["ev:id-6"])
    // 证据登记表累积全部历史，且可靠度来自代码查表
    assert.deepEqual(
      Object.fromEntries(
        ["ev:id-2", "ev:id-3", "ev:id-5", "ev:id-6"].map((id) => [id, state.evidence[id]?.reliability]),
      ),
      { "ev:id-2": 0.7, "ev:id-3": 0.9, "ev:id-5": 1.0, "ev:id-6": 0.8 },
    )
    assert.equal(state.evidence["ev:id-5"]?.source, "alice")
  })

  test("confidence is always derivable from status + evidence", () => {
    const state = fold([
      observed(1, "up", "tool_output"),
      factEvent(2, "fact.verified", { entity: "svc", property: "build", value: "up", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
      factEvent(3, "fact.staled", { entity: "svc", property: "build" }),
    ])
    for (const fact of Object.values(state.facts)) {
      const best = Math.max(0, ...fact.evidenceIds.map((id) => state.evidence[id]?.reliability ?? 0))
      assert.equal(fact.confidence, deriveConfidence(fact.status, best), `fact ${fact.key}`)
    }
  })

  test("STALE halves the reliability of current supporting evidence", () => {
    const state = fold([
      factEvent(1, "fact.observed", { entity: "e", property: "p", value: "x", evidence: { type: "agent_claim" } }, "bot"),
      factEvent(2, "fact.staled", { entity: "e", property: "p" }),
    ])
    assert.equal(state.facts["e::p"]?.confidence, 0.15) // 0.3 × 0.5
  })
})

describe("verification iron rule", () => {
  test("agent_claim may observe but can never verify", () => {
    const state = fold([observed(1, "done", "agent_claim", "solver-a")])
    assert.equal(state.facts["svc::build"]?.status, "OBSERVED")
    assert.equal(state.facts["svc::build"]?.confidence, 0.3)

    assert.throws(
      () =>
        fold([
          observed(1, "done", "agent_claim", "solver-a"),
          factEvent(2, "fact.verified", {
            entity: "svc",
            property: "build",
            value: "done",
            evidence: { type: "agent_claim" },
          }, "solver-a"),
        ]),
      /executors cannot prove their own success/,
    )
  })

  test("real tools can verify", () => {
    const state = fold([
      observed(1, "done", "tool_output"),
      factEvent(2, "fact.verified", { entity: "svc", property: "build", value: "done", evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } }),
    ])
    assert.equal(state.facts["svc::build"]?.status, "VERIFIED")
    assert.equal(state.facts["svc::build"]?.confidence, 0.7)
  })
})

describe("illegal transitions (fail-loud matrix)", () => {
  const key = { entity: "svc", property: "build" }

  test("verify requires an existing OBSERVED/VERIFIED fact", () => {
    assert.throws(
      () => fold([factEvent(1, "fact.verified", { ...key, value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } })]),
      /cannot verify unknown fact/,
    )
    assert.throws(
      () =>
        fold([
          factEvent(1, "fact.unknown", key),
          factEvent(2, "fact.verified", { ...key, value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
        ]),
      /cannot verify fact in status UNKNOWN/,
    )
    assert.throws(
      () =>
        fold([
          observed(1, "x", "test"),
          factEvent(2, "fact.invalidated", { ...key, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
          factEvent(3, "fact.verified", { ...key, value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
        ]),
      /cannot verify fact in status INVALID/,
    )
    assert.throws(
      () =>
        fold([
          observed(1, "x", "test"),
          factEvent(2, "fact.staled", key),
          factEvent(3, "fact.verified", { ...key, value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
        ]),
      /cannot verify fact in status STALE/,
    )
  })

  test("verified value must match the observed value", () => {
    assert.throws(
      () =>
        fold([
          observed(1, "passing", "tool_output"),
          factEvent(2, "fact.verified", { ...key, value: "failing", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
        ]),
      /does not match observed value/,
    )
  })

  test("observed values must be primitives; null/undefined means use fact.unknown", () => {
    assert.throws(() => fold([observed(1, null, "tool_output")]), /use fact\.unknown/)
    assert.throws(() => fold([observed(1, { complex: true }, "tool_output")]), /string, number or boolean/)
  })

  test("invalidate requires an existing non-UNKNOWN fact and evidence", () => {
    assert.throws(() => fold([factEvent(1, "fact.invalidated", { ...key, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } })]), /cannot invalidate unknown fact/)
    assert.throws(
      () => fold([factEvent(1, "fact.unknown", key), factEvent(2, "fact.invalidated", { ...key, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } })]),
      /cannot invalidate fact in status UNKNOWN/,
    )
    assert.throws(() => fold([observed(1, "x", "test"), factEvent(2, "fact.invalidated", key)]), /'evidence' must be an object/)
  })

  test("stale requires an existing OBSERVED/VERIFIED/STALE fact", () => {
    assert.throws(() => fold([factEvent(1, "fact.staled", key)]), /cannot stale unknown fact/)
    assert.throws(
      () => fold([factEvent(1, "fact.unknown", key), factEvent(2, "fact.staled", key)]),
      /cannot stale fact in status UNKNOWN/,
    )
    assert.throws(
      () =>
        fold([
          observed(1, "x", "test"),
          factEvent(2, "fact.invalidated", { ...key, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
          factEvent(3, "fact.staled", key),
        ]),
      /cannot stale fact in status INVALID/,
    )
  })

  test("payload shape is enforced", () => {
    assert.throws(() => fold([observed(1, "x", "mind_read")]), /evidence type must be one of/)
    assert.throws(() => fold([observed(1, "x", "toString")]), /evidence type must be one of/)
    assert.throws(() => fold([factEvent(1, "fact.observed", { property: "p", value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } })]), /'entity' must be a non-empty string/)
    assert.throws(() => fold([factEvent(1, "fact.unknown", { entity: "e", note: "" })]), /'property' must be a non-empty string/)
  })
})

describe("reducer purity and replay", () => {
  test("fact events do not mutate inputs", () => {
    const state = initialState()
    const frozen = JSON.parse(JSON.stringify(state))
    reduce(state, observed(1, "x", "test"))
    assert.deepEqual(state, frozen)
  })

  test("replay(facts) equals sequential reduce", () => {
    const events = [
      observed(1, "x", "tool_output"),
      factEvent(2, "fact.verified", { entity: "svc", property: "build", value: "x", evidence: { type: "test", mechanism: "verify-run", command: "npm test" } }),
      factEvent(3, "fact.staled", { entity: "svc", property: "build" }),
      observed(4, "y", "human"),
    ]
    assert.deepEqual(replay(events), fold(events))
  })
})

describe("world state through the runtime facade", () => {
  test("fact lifecycle survives restart and keeps seq continuous after rejections", async () => {
    const root = path.join(dir, "rt")
    const first = await createRuntime({ directory: dir, root })
    await first.dispatch({
      type: "fact.observed",
      source: "solver-a",
      payload: { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } },
    })

    // 铁律在 probe 阶段生效：agent_claim 验证被拒，账本零污染
    await assert.rejects(
      () =>
        first.dispatch({
          type: "fact.verified",
          source: "solver-a",
          payload: { entity: "db", property: "deployed", value: true, evidence: { type: "agent_claim" } },
        }),
      /executors cannot prove their own success/,
    )
    assert.equal((await first.events.readAll()).length, 1, "rejected event must not reach the log")
    assert.equal(first.getState().revision, 1, "state unchanged after rejection")

    // 合法重试拿到下一个 seq（无断号）
    await first.dispatch({
      type: "fact.verified",
      source: "ci",
      payload: { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } },
    })
    assert.equal(first.getState().facts["db::deployed"]?.confidence, 0.9)

    const second = await createRuntime({ directory: dir, root })
    assert.deepEqual(second.getState().facts["db::deployed"], first.getState().facts["db::deployed"])
    assert.equal(second.getState().revision, 2)
  })

  test("illegal transitions are rejected before reaching the log", async () => {
    const runtime = await createRuntime({ directory: dir, root: path.join(dir, "rt2") })
    await assert.rejects(
      () =>
        runtime.dispatch({
          type: "fact.verified",
          source: "solver",
          payload: { entity: "db", property: "deployed", value: true, evidence: { type: "test", mechanism: "verify-run", command: "npm test" } },
        }),
      /cannot verify unknown fact/,
    )
    assert.equal(await runtime.events.readAll().then((events) => events.length), 0)
  })
})

describe("snapshot schema migration", () => {
  test("v1 snapshot (no schemaVersion) is ignored, state fully replayed from the log", async () => {
    const root = path.join(dir, "rt-mig")
    const first = await createRuntime({ directory: dir, root })
    await first.dispatch({ type: "goal.set", source: "director", payload: { goal: "g" } })
    await first.dispatch({
      type: "fact.observed",
      source: "solver",
      payload: { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } },
    })

    // 伪造 Phase 1 时代的旧快照：没有 schemaVersion / facts / evidence
    const store = new FileStateStore(root)
    await store.write("state.json", {
      revision: 2,
      goals: [],
      tasks: {},
      observations: [],
      actions: [],
      notes: [],
    })

    const second = await createRuntime({ directory: dir, root })
    assert.equal(second.getState().schemaVersion, SCHEMA_VERSION)
    assert.equal(second.getState().revision, 2)
    assert.equal(second.getState().facts["db::deployed"]?.value, true, "fact must come from log replay, not the stale cache")
  })

  test("v2 snapshot roundtrip preserves facts and evidence", async () => {
    const root = path.join(dir, "rt-snap")
    const first = await createRuntime({ directory: dir, root })
    await first.dispatch({
      type: "fact.observed",
      source: "solver",
      payload: { entity: "db", property: "deployed", value: true, evidence: { type: "tool_output", mechanism: "verify-run", command: "node build.js" } },
    })
    const snapshot = new StateSnapshot(new FileStateStore(root))
    const loaded = await snapshot.load()
    assert.ok(loaded, "v2 snapshot must load")
    assert.deepEqual(loaded, first.getState())
    assert.equal(Object.keys(loaded?.evidence ?? {}).length, 1)
  })
})
