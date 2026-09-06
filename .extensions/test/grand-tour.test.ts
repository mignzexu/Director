// Grand Tour —— Phase 12 整合测试：一个完整项目生命的单测故事。
// 五幕：立（目标与计划）→ 败与修（Local Repair）→ 认知插曲（研究循环）→
// 收官与学习（Director 判定 + 经验沉淀）→ 时间旅行（重启 / asOf / recall）。
// 全部走工具层（宿主视角的 15 工具），证明系统能力的整体协调性：
// 不是 173 项零件测试的堆叠，而是"USER GOAL → … → 经验沉淀"的一条完整链。
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { composeExtensionHooks, type ComposedExtensionHooks } from "../src/adapters/opencode/index.ts"
import { createRuntimeLedgerExtension } from "../src/plugins/runtime-ledger/index.ts"
import type { ExtensionPluginContext } from "../src/plugins/types.ts"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-grand-tour-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

type ExecutableTool = { execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }

function tool(hooks: ComposedExtensionHooks, id: string): ExecutableTool {
  const t = hooks.tools[id] as ExecutableTool | undefined
  assert.ok(t, `tool '${id}' missing from composed hooks`)
  return t
}

function host(): { directory: string; worktree: string; log: ExtensionPluginContext["log"] } {
  return { directory: dir, worktree: dir, log: () => {} }
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "private",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  }
}

async function out(result: ToolResult): Promise<any> {
  return JSON.parse(typeof result === "string" ? result : result.output)
}

describe("grand tour: one project life through the whole system", () => {
  test("act 1–5: goal → plan → failure → repair → inquiry → verdict → lessons → time travel", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const fact = tool(hooks, "fact-record")
    const plan = tool(hooks, "plan-node")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")
    const verify = tool(hooks, "verify-run")
    const review = tool(hooks, "director-review")
    const tick = tool(hooks, "director-tick")
    const memory = tool(hooks, "memory-record")
    const recallTool = tool(hooks, "memory-recall")
    const question = tool(hooks, "research-question")
    const hypothesis = tool(hooks, "research-hypothesis")
    const planQuery = tool(hooks, "plan-query")
    const c = ctx()

    // ── Act 1：立 —— USER GOAL → Director → Global DPN ──
    await fact.execute({ entity: "project", property: "goal", action: "observed", value: "ship auth service", evidenceType: "human" }, c)
    await plan.execute({ action: "created", nodeId: "o1", type: "outcome", title: "auth service live", intent: "users need login" }, c)
    const director = await out(await spawn.execute({ nodeId: "o1", solverId: "d1", role: "director" }, c))
    assert.equal(director.ok, true)
    await plan.execute({ action: "created", nodeId: "m1", type: "milestone", parent: "o1", title: "core works" }, c)
    await plan.execute(
      { action: "created", nodeId: "tA", type: "task", parent: "m1", title: "build auth", verifier: "run: node auth-test.mjs" },
      c,
    )
    await plan.execute(
      { action: "created", nodeId: "tB", type: "task", parent: "m1", title: "token docs", preconditionFacts: ["auth::token-format"] },
      c,
    )
    const opening = await out(await review.execute({ directorId: "d1", assessment: "on-track", reasoning: "plan declared, gates known" }, c))
    assert.equal(opening.ok, true)

    // ── Act 2：败与修 —— Local Repair + circuit breaker 未触发 ──
    await fs.writeFile(path.join(dir, "auth-test.mjs"), "process.exit(1)", "utf8")
    const failedRun = await out(await verify.execute({ entity: "auth", property: "tests", command: "node auth-test.mjs", kind: "test" }, c))
    assert.equal(failedRun.fact.value, "fail")
    await spawn.execute({ nodeId: "tA", solverId: "s1", executor: "private" }, c)
    const failedA = await out(await plan.execute({ action: "failed", nodeId: "tA", reason: "first attempt broke", failureClass: "tool" }, c))
    assert.equal(failedA.node.failureClass, "tool")
    const reopened = await out(await plan.execute({ action: "reopened", nodeId: "tA", reason: "fix landed" }, c))
    assert.equal(reopened.node.retryCount, 1)
    await spawn.execute({ nodeId: "tA", solverId: "s2", executor: "private" }, c)
    await fs.writeFile(path.join(dir, "auth-test.mjs"), "process.exit(0)", "utf8")
    const passRun = await out(await verify.execute({ entity: "auth", property: "tests", command: "node auth-test.mjs", kind: "test", depth: "verified" }, c))
    assert.equal(passRun.fact.status, "VERIFIED")
    const doneA = await out(await report.execute(
      { solverId: "s2", action: "succeeded", summary: "auth built", evidenceId: passRun.evidenceId },
      c,
    ))
    assert.equal(doneA.ok, true, "solver delivers with the witnessed pass")

    // ── Act 3：认知插曲 —— UNKNOWN → question → hypothesis → 实验 → verdict ──
    await fact.execute({ entity: "auth", property: "token-format", action: "unknown", note: "undecided" }, c)
    const blockedHire = await out(await spawn.execute({ nodeId: "tB" }, c))
    assert.equal(blockedHire.ok, false, "UNKNOWN fact gates tB hiring")
    const q = await out(await question.execute(
      { action: "raised", question: "JWT or opaque token for our sessions?", subject: "auth", motivation: "tB gated" },
      c,
    ))
    const h = await out(await hypothesis.execute(
      {
        action: "proposed",
        questionId: q.question.id,
        statement: "JWT fits: stateless and our scale is small",
        prior: 0.5,
        rationale: "standard choice, needs a load sanity check",
        mechanism: "de-novo",
      },
      c,
    ))
    await plan.execute({ action: "created", nodeId: "exp1", type: "verification", title: "token load sanity", tests: h.hypothesis.id }, c)
    await plan.execute({ action: "started", nodeId: "exp1" }, c)
    await fs.writeFile(path.join(dir, "token-sim.mjs"), "process.exit(0)", "utf8")
    const exp = await out(await verify.execute({ entity: "token-sim", property: "jwt-ok", command: "node token-sim.mjs", kind: "tool_output" }, c))
    assert.equal(exp.fact.value, "pass")
    const moved = await out(await hypothesis.execute(
      { action: "updated", hypothesisId: h.hypothesis.id, belief: 0.9, rationale: "sim clean", evidenceId: exp.evidenceId },
      c,
    ))
    assert.equal(moved.hypothesis.belief, 0.9)
    const verdict = await out(await hypothesis.execute(
      { action: "evaluated", hypothesisId: h.hypothesis.id, verdict: "supported", reasoning: "0.9 with witness", evidenceId: exp.evidenceId },
      c,
    ))
    assert.equal(verdict.hypothesis.verdict, "supported")
    // Resolution 桥：认知结论落成 VERIFIED 世界事实
    await fact.execute({ entity: "auth", property: "token-format", action: "observed", value: "JWT", evidenceType: "external" }, c)
    await fact.execute({ entity: "auth", property: "token-format", action: "verified", value: "JWT", evidenceType: "external" }, c)
    await question.execute({ action: "resolved", questionId: q.question.id, resolution: "JWT confirmed by sim" }, c)
    // 门开：tB 雇佣 → 交卷完成
    await spawn.execute({ nodeId: "tB", solverId: "s3", executor: "private" }, c)
    const doneB = await out(await report.execute(
      { solverId: "s3", action: "succeeded", summary: "docs written", evidenceType: "external" },
      c,
    ))
    assert.equal(doneB.ok, true)
    // 里程碑与实验节点完成
    await plan.execute({ action: "started", nodeId: "m1" }, c)
    await plan.execute({ action: "completed", nodeId: "m1", evidenceType: "external", summary: "core + docs done" }, c)
    await plan.execute({ action: "completed", nodeId: "exp1", evidenceType: "external", summary: "sim clean" }, c)

    // ── Act 4：收官与学习 —— Director 判定 + 经验沉淀 ──
    const closing = await out(await review.execute(
      {
        directorId: "d1",
        assessment: "on-track",
        reasoning: "milestone done, outcome stays open for rollout",
        nextActions: ["rollout", "monitor"],
      },
      c,
    ))
    assert.equal(closing.ok, true)
    const lesson = await out(await memory.execute(
      {
        action: "recorded",
        subject: "auth-project",
        lesson: "run: gated tasks recover well via reopen — failures were tool-class, fixed in one retry",
        anchors: ["tA", failedRun.evidenceId, passRun.evidenceId],
      },
      c,
    ))
    assert.equal(lesson.ok, true)
    assert.equal(lesson.relatedExisting.length, 0)

    const health = await out(await tick.execute({ directorId: "d1" }, c))
    assert.equal(health.health.totalNodes, 5)
    assert.equal(health.health.doneNodes, 4, "tA + tB + m1 + exp1 done, outcome stays open")
    assert.equal(health.health.failedNodes.length, 0, "failure resolved — nothing stuck")
    assert.equal(health.health.churn.created, 5)
    assert.equal(health.recentReviews.length, 2)

    // ── Act 5：时间旅行 —— 重启恢复 + asOf + recall ──
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q2 = await out(await tool(second, "plan-query").execute({ nodeId: "tA" }, c))
    assert.equal(q2.nodes[0].status, "done")
    assert.equal(q2.nodes[0].retryCount, 1)
    const r2 = await out(await tool(second, "research-query").execute({}, c))
    assert.equal(r2.hypotheses[0].verdict, "supported")

    // asOf：回到 Act 2 失败时刻——当时 tA 是 failed、lesson 还不存在
    const eventsRaw = await fs.readFile(path.join(dir, ".extensions", "state", "runtime", "events.jsonl"), "utf8")
    const seqOfFailure = eventsRaw.split("\n").findIndex((l) => l.includes('"plan.node.failed"')) + 1
    const past = await out(await recallTool.execute({ asOf: seqOfFailure, include: "failures" }, c))
    assert.ok(past.failures.nodes.some((n: { id: string }) => n.id === "tA"), "asOf sees the failure that once was")

    const lessons = await out(await recallTool.execute({ subject: "auth-project" }, c))
    assert.equal(lessons.lessons.length, 1)
    assert.equal(lessons.lessons[0].anchorIds.length, 3)
  })
})
