// runtime-ledger 端到端集成测试：真实插件走 composeExtensionHooks 全链路，
// 验证 opencode → L1 → L2 → DPN Runtime 的完整闭环（记账落盘 → 查询读回 →
// 铁律拦截 → 重启恢复）。工具直接调用 execute()，跳过宿主的 zod 输入装配，
// 但插件内的 zod parse 依然生效。
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { composeExtensionHooks, extensionRegistry, type ComposedExtensionHooks } from "../src/adapters/opencode/index.ts"
import { createRuntimeLedgerExtension } from "../src/plugins/runtime-ledger/index.ts"
import { createFlightRecorderExtension } from "../src/plugins/flight-recorder/index.ts"

// 模拟宿主事件流：工具执行完成后宿主发出的 part.updated
function hostToolEvent(tool: string, output = "done"): { type: string; properties: Record<string, unknown> } {
  return { type: "message.part.updated", properties: { part: { type: "tool", tool, state: { status: "completed", output } } } }
}
import type { ExtensionPluginContext } from "../src/plugins/types.ts"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-ledger-"))
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

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
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

async function output(result: ToolResult): Promise<any> {
  return JSON.parse(typeof result === "string" ? result : result.output)
}

async function eventsFile(): Promise<string> {
  return fs.readFile(path.join(dir, ".extensions", "state", "runtime", "events.jsonl"), "utf8")
}

describe("runtime-ledger through the L2 aggregator", () => {
  test("default registry exposes exactly the ledger tools", async () => {
    const hooks = await composeExtensionHooks(host())
    assert.deepEqual(hooks.ids, ["runtime-ledger", "flight-recorder"])
    assert.deepEqual(Object.keys(hooks.tools).sort(), [
      "director-review",
      "director-tick",
      "fact-query",
      "fact-record",
      "memory-recall",
      "memory-record",
      "plan-node",
      "plan-query",
      "research-hypothesis",
      "research-query",
      "research-question",
      "solver-query",
      "solver-report",
      "solver-spawn",
      "verify-run",
    ])
  })

  test("record → disk → query end to end", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const record = tool(hooks, "fact-record")

    const result = await output(
      await record.execute(
        { entity: "db", property: "deployed", action: "observed", value: true, evidenceType: "external" },
        toolContext(),
      ),
    )
    assert.equal(result.ok, true)
    assert.equal(result.fact.status, "OBSERVED")
    assert.equal(result.fact.confidence, 0.6)
    assert.equal(result.fact.key, "db::deployed")

    // 事件带着调用方 agent 身份落账
    const raw = await eventsFile()
    const lines = raw.trim().split("\n")
    assert.equal(lines.length, 1)
    const event = JSON.parse(lines[0]!)
    assert.equal(event.type, "fact.observed")
    assert.equal(event.source, "private")

    // source 取自工具上下文（换 agent 记账可区分）
    const query = await output(await tool(hooks, "fact-query").execute({}, toolContext()))
    assert.equal(query.ok, true)
    assert.equal(query.facts.length, 1)
    assert.equal(query.facts[0].status, "OBSERVED")
    assert.equal(query.facts[0].evidence[0].reliability, 0.8)
  })

  test("iron rule: agent_claim verification is rejected and the log stays clean", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const record = tool(hooks, "fact-record")

    await output(
      await record.execute(
        { entity: "db", property: "deployed", action: "observed", value: true, evidenceType: "external" },
        toolContext(),
      ),
    )
    const rejected = await output(
      await record.execute(
        { entity: "db", property: "deployed", action: "verified", value: true, evidenceType: "agent_claim" },
        toolContext(),
      ),
    )
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /executors cannot prove their own success/)

    const lines = (await eventsFile()).trim().split("\n")
    assert.equal(lines.length, 1, "rejected call must not reach the ledger")

    const query = await output(await tool(hooks, "fact-query").execute({}, toolContext()))
    assert.equal(query.facts[0].status, "OBSERVED")
  })

  test("semantic requirements are reported in-band (no event written)", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const record = tool(hooks, "fact-record")

    const missingValue = await output(
      await record.execute({ entity: "db", property: "deployed", action: "observed", evidenceType: "external" }, toolContext()),
    )
    assert.equal(missingValue.ok, false)
    assert.match(missingValue.error, /requires a value/)

    const missingEvidence = await output(
      await record.execute({ entity: "db", property: "deployed", action: "observed", value: true }, toolContext()),
    )
    assert.equal(missingEvidence.ok, false)
    assert.match(missingEvidence.error, /requires an evidenceType/)

    await assert.rejects(() => fs.access(path.join(dir, ".extensions", "state", "runtime", "events.jsonl")))
  })

  test("malformed args are rejected by the plugin's zod schema", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    await assert.rejects(
      () => tool(hooks, "fact-record").execute({ entity: "", property: "p", action: "unknown" }, toolContext()),
      /entity/,
    )
    await assert.rejects(
      () => tool(hooks, "fact-record").execute({ entity: "e", property: "p", action: "teleport" }, toolContext()),
      /invalid/i,
    )
  })

  test("fresh composition replays history from the ledger (restart semantics)", async () => {
    const first = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    await tool(first, "fact-record").execute(
      { entity: "db", property: "deployed", action: "observed", value: true, evidenceType: "external" },
      toolContext(),
    )
    await tool(first, "fact-record").execute(
      { entity: "db", property: "deployed", action: "verified", value: true, evidenceType: "external" },
      toolContext(),
    )

    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const query = await output(await tool(second, "fact-query").execute({}, toolContext()))
    assert.equal(query.revision, 2)
    assert.equal(query.facts[0].status, "VERIFIED")
    assert.equal(query.facts[0].confidence, 0.8)
    assert.equal(query.facts[0].evidence[0].type, "external")
  })

  test("extension registry member matches a fresh factory instance", () => {
    const singleton = extensionRegistry[0]!
    assert.equal(singleton.id, "runtime-ledger")
    assert.deepEqual(Object.keys(singleton.tools ?? {}).sort(), [
      "director-review",
      "director-tick",
      "fact-query",
      "fact-record",
      "memory-recall",
      "memory-record",
      "plan-node",
      "plan-query",
      "research-hypothesis",
      "research-query",
      "research-question",
      "solver-query",
      "solver-report",
      "solver-spawn",
      "verify-run",
    ])
  })
})

describe("director loop through the plugin", () => {
  test("full direction round: spawn → tick → build → dispatch → tick → review → restart keeps the archive", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const plan = tool(hooks, "plan-node")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")
    const tick = tool(hooks, "director-tick")
    const review = tool(hooks, "director-review")
    const ctx = toolContext()

    // Director 自雇：认领 outcome
    await plan.execute({ action: "created", nodeId: "o1", type: "outcome", title: "ship it" }, ctx)
    const hired = await output(await spawn.execute({ nodeId: "o1", solverId: "d1", role: "director" }, ctx))
    assert.equal(hired.ok, true)

    // tick：纯观察（图里已有 o1），完成度 0，零事件落账
    const t0 = await output(await tick.execute({ directorId: "d1" }, ctx))
    assert.equal(t0.ok, true)
    assert.equal(t0.health.totalNodes, 1)
    assert.equal(t0.health.doneNodes, 0)
    assert.equal(t0.health.churn.created, 1)
    const before = (await eventsFile()).trim().split("\n").length

    // 依据观察行动：建子计划、派工、交卷
    await plan.execute(
      { action: "created", nodeId: "t1", type: "task", title: "build core", parent: "o1" },
      ctx,
    )
    await spawn.execute({ nodeId: "t1", solverId: "s1" }, ctx)
    await report.execute({ solverId: "s1", action: "succeeded", summary: "core done", evidenceType: "external" }, ctx)

    // tick 纯观察：账本事件数不变，完成度上升
    const t1 = await output(await tick.execute({ directorId: "d1" }, ctx))
    assert.equal((await eventsFile()).trim().split("\n").length, before + 3, "tick writes zero events")
    assert.equal(t1.health.totalNodes, 2)
    assert.equal(t1.health.doneNodes, 1)
    assert.equal(t1.health.completionRatio, 0.5)
    assert.equal(t1.health.churn.created, 2)

    // 结论落账（失败路径：needs-replan 的校验在 reducer 测试里钉死）
    const verdict = await output(
      await review.execute({ directorId: "d1", assessment: "on-track", reasoning: "core done, no churn", nextActions: ["next milestone"] }, ctx),
    )
    assert.equal(verdict.ok, true)
    const badDirector = await output(
      await review.execute({ directorId: "ghost", assessment: "on-track", reasoning: "x" }, ctx),
    )
    assert.equal(badDirector.ok, false)
    assert.match(badDirector.error, /unknown director/)

    // 重启：决策档案、churn 与健康推导完整恢复
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const t2 = await output(await tool(second, "director-tick").execute({ directorId: "d1" }, ctx))
    assert.equal(t2.ok, true)
    assert.equal(t2.health.totalNodes, 2)
    assert.equal(t2.health.doneNodes, 1)
    assert.equal(t2.health.churn.created, 2)
    assert.equal(t2.recentReviews.length, 1)
    assert.equal(t2.recentReviews[0].assessment, "on-track")
  })

  test("director-tick rejects inactive or unknown directors", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const noDirector = await output(await tool(hooks, "director-tick").execute({ directorId: "ghost" }, toolContext()))
    assert.equal(noDirector.ok, false)
    assert.match(noDirector.error, /unknown or inactive director/)
  })
})

describe("solver tools through the plugin", () => {
  test("hire → progress → blocked → resumed → succeed → node done → survives restart", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const plan = tool(hooks, "plan-node")
    const fact = tool(hooks, "fact-record")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")
    const query = tool(hooks, "solver-query")

    await plan.execute(
      { action: "created", nodeId: "t1", type: "task", title: "build core", preconditionFacts: ["db::deployed"] },
      toolContext(),
    )

    // 未就绪：雇佣被拒并列出缺口
    const tooEarly = await output(await spawn.execute({ nodeId: "t1" }, toolContext()))
    assert.equal(tooEarly.ok, false)
    assert.match(tooEarly.error, /unmet facts/)

    await fact.execute(
      { entity: "db", property: "deployed", action: "observed", value: true, evidenceType: "external" },
      toolContext(),
    )
    await fact.execute(
      { entity: "db", property: "deployed", action: "verified", value: true, evidenceType: "external" },
      toolContext({ agent: "ci" }),
    )

    // 自动编号在工具层：不传 solverId → s1；executor 默认调用方
    const hired = await output(await spawn.execute({ nodeId: "t1", role: "builder" }, toolContext()))
    assert.equal(hired.ok, true)
    assert.equal(hired.solver.id, "s1")
    assert.equal(hired.solver.executor, "private")

    await report.execute({ solverId: "s1", action: "progress", summary: "scaffold done", detail: "3 files" }, toolContext())
    await report.execute({ solverId: "s1", action: "blocked", reason: "waiting on api keys" }, toolContext())
    const stuck = await output(await query.execute({ status: "blocked" }, toolContext()))
    assert.equal(stuck.solvers.length, 1, "stuck work must be queryable")
    const progressWhileBlocked = await output(
      await report.execute({ solverId: "s1", action: "progress", summary: "still here" }, toolContext()),
    )
    assert.equal(progressWhileBlocked.ok, false)
    await report.execute({ solverId: "s1", action: "resumed", reason: "keys arrived" }, toolContext())

    // 交卷：无证据 / agent_claim 拒绝；test 证据成功并联动节点完成
    const noEvidence = await output(await report.execute({ solverId: "s1", action: "succeeded", summary: "done" }, toolContext()))
    assert.equal(noEvidence.ok, false)
    assert.match(noEvidence.error, /requires an evidenceType/)
    const cheated = await output(
      await report.execute({ solverId: "s1", action: "succeeded", summary: "done", evidenceType: "agent_claim" }, toolContext()),
    )
    assert.equal(cheated.ok, false)
    assert.match(cheated.error, /executors cannot prove their own success/)
    const done = await output(
      await report.execute({ solverId: "s1", action: "succeeded", summary: "core built", evidenceType: "external" }, toolContext()),
    )
    assert.equal(done.ok, true)
    assert.equal(done.solver.status, "finished")

    const planQ = await output(await tool(hooks, "plan-query").execute({ nodeId: "t1" }, toolContext()))
    assert.equal(planQ.nodes[0].status, "done")

    // 重启：名册、履历与合同完整恢复
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q = await output(await tool(second, "solver-query").execute({}, toolContext()))
    assert.equal(q.solvers.length, 1)
    assert.equal(q.solvers[0].status, "finished")
    assert.equal(q.solvers[0].progress.length, 1)
    assert.equal(q.solvers[0].contract.node.status, "done")
    assert.deepEqual(q.solvers[0].contract.gateFacts.map((f: { key: string }) => f.key), ["db::deployed"])
  })

  test("stop releases the node for a fresh hire; failed solver fails the node", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const plan = tool(hooks, "plan-node")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")

    await plan.execute({ action: "created", nodeId: "t1", type: "task", title: "x" }, toolContext())
    await spawn.execute({ nodeId: "t1", solverId: "s1" }, toolContext())
    await report.execute({ solverId: "s1", action: "blocked", reason: "stuck" }, toolContext())
    const stopped = await output(await report.execute({ solverId: "s1", action: "stopped", reason: "swap specialist" }, toolContext()))
    assert.equal(stopped.ok, true)
    assert.equal(stopped.solver.status, "stopped")

    const planQ = await output(await tool(hooks, "plan-query").execute({ nodeId: "t1" }, toolContext()))
    assert.equal(planQ.nodes[0].status, "pending")

    const rehired = await output(await spawn.execute({ nodeId: "t1", solverId: "s2" }, toolContext()))
    assert.equal(rehired.ok, true)
    assert.equal(rehired.solver.id, "s2")

    // 失败交卷：solver 与节点一起 failed
    await report.execute({ solverId: "s2", action: "failed", reason: "approach dead end" }, toolContext())
    const finalPlan = await output(await tool(hooks, "plan-query").execute({ nodeId: "t1" }, toolContext()))
    assert.equal(finalPlan.nodes[0].status, "failed")
  })
})

describe("verify-run through the plugin", () => {
  test("real execution: pass/fail values, depth=verified, audit trail", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const verify = tool(hooks, "verify-run")
    const ctx = toolContext()

    // exit 0 → pass + OBSERVED（mechanism=verify-run 指纹在案）
    const pass = await output(
      await verify.execute({ entity: "svc", property: "tests", command: `node -e "process.exit(0)"`, kind: "test" }, ctx),
    )
    assert.equal(pass.ok, true)
    assert.equal(pass.exitCode, 0)
    assert.equal(pass.fact.status, "OBSERVED")
    assert.equal(pass.fact.value, "pass")

    // depth=verified → 亲证直接升格 VERIFIED 0.9
    const verified = await output(
      await verify.execute(
        { entity: "svc2", property: "build", command: `node -e "process.exit(0)"`, kind: "test", depth: "verified" },
        ctx,
      ),
    )
    assert.equal(verified.fact.status, "VERIFIED")
    assert.equal(verified.fact.confidence, 0.9)
    assert.equal(verified.fact.evidenceIds.length, 1, "observed and verified share one witness")

    // exit 3 → fail（确证失败也是知识）
    const fail = await output(
      await verify.execute({ entity: "svc3", property: "tests", command: `node -e "process.exit(3)"` }, ctx),
    )
    assert.equal(fail.exitCode, 3)
    assert.equal(fail.fact.value, "fail")

    // 审计 JSONL 落盘（审计设施首次真实启用）
    const auditRaw = await fs.readFile(path.join(dir, ".extensions", "state", "runtime", "audit.jsonl"), "utf8")
    const auditLines = auditRaw.trim().split("\n")
    assert.equal(auditLines.length, 3)
    const first = JSON.parse(auditLines[0]!)
    assert.equal(first.capability, "verify-run")
    assert.equal(first.agent, "private")
    assert.equal(first.approved, true)
  })

  test("timeout kills the run and records fail", { timeout: 15000 }, async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const result = await output(
      await tool(hooks, "verify-run").execute(
        { entity: "slow", property: "job", command: `node -e "setTimeout(() => {}, 10000)"`, timeoutMs: 300 },
        toolContext(),
      ),
    )
    assert.equal(result.ok, true)
    assert.equal(result.timedOut, true)
    assert.equal(result.fact.value, "fail")
  })

  test("run: gate end to end: mismatched/declared evidence rejected, matching witness completes", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const verify = tool(hooks, "verify-run")
    const plan = tool(hooks, "plan-node")
    const ctx = toolContext()

    // 真实脚本落盘，命令与 verifier 声明严格一致
    await fs.writeFile(path.join(dir, "smoke.mjs"), "process.exit(0)", "utf8")

    await plan.execute(
      { action: "created", nodeId: "t1", type: "task", title: "gated task", verifier: "run: node smoke.mjs" },
      ctx,
    )
    await plan.execute({ action: "started", nodeId: "t1" }, ctx)

    // 声明 external → 门禁拒绝
    const declared = await output(
      await plan.execute({ action: "completed", nodeId: "t1", evidenceType: "external" }, ctx),
    )
    assert.equal(declared.ok, false)
    assert.match(declared.error, /requires a verify-run execution of 'node smoke\.mjs'/)

    // 亲证但命令不匹配 → 拒绝
    const mismatch = await output(
      await verify.execute({ entity: "gate", property: "other", command: `node -e "process.exit(0)"`, kind: "test" }, ctx),
    )
    assert.equal(mismatch.ok, true)
    const wrongCmd = await output(
      await plan.execute({ action: "completed", nodeId: "t1", evidenceId: mismatch.evidenceId }, ctx),
    )
    assert.equal(wrongCmd.ok, false)

    // 匹配的亲证 → 引用完成
    const witness = await output(
      await verify.execute({ entity: "gate", property: "smoke", command: "node smoke.mjs", kind: "test" }, ctx),
    )
    assert.equal(witness.ok, true)
    const done = await output(
      await plan.execute({ action: "completed", nodeId: "t1", evidenceId: witness.evidenceId, summary: "gate passed" }, ctx),
    )
    assert.equal(done.ok, true)
    assert.equal(done.node.status, "done")

    // 重启后事实与审计均在
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q = await output(await tool(second, "fact-query").execute({ entity: "gate" }, toolContext()))
    assert.equal(q.facts[0].status, "OBSERVED")
  })
})

describe("plan tools through the plugin", () => {
  test("declare plan → fact gate opens → start → complete → survives restart", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const node = tool(hooks, "plan-node")
    const fact = tool(hooks, "fact-record")
    const planQuery = tool(hooks, "plan-query")

    // 自顶向下声明：outcome ← milestone ← task（task 用世界状态事实门控）
    await node.execute({ action: "created", nodeId: "o1", type: "outcome", title: "ship it" }, toolContext())
    await node.execute(
      { action: "created", nodeId: "m1", type: "milestone", parent: "o1", title: "core works" },
      toolContext(),
    )
    const created = await output(
      await node.execute(
        {
          action: "created",
          nodeId: "t1",
          type: "task",
          title: "build core",
          parent: "m1",
          preconditionFacts: ["db::deployed"],
          verifier: "npm test",
        },
        toolContext(),
      ),
    )
    assert.equal(created.ok, true)
    assert.equal(created.node.status, "pending")

    // 门控未开：启动被拒，缺什么被明确列出
    const blocked = await output(await node.execute({ action: "started", nodeId: "t1" }, toolContext()))
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /unmet facts: db::deployed/)
    const q1 = await output(await planQuery.execute({ nodeId: "t1" }, toolContext()))
    assert.equal(q1.nodes[0].readiness.ready, false)
    assert.deepEqual(q1.nodes[0].readiness.unmetFacts, ["db::deployed"])

    // 事实补齐：observed（agent 说）→ verified（test 证）→ 门开
    await fact.execute(
      { entity: "db", property: "deployed", action: "observed", value: true, evidenceType: "external" },
      toolContext(),
    )
    await fact.execute(
      { entity: "db", property: "deployed", action: "verified", value: true, evidenceType: "external" },
      toolContext({ agent: "ci" }),
    )
    const q2 = await output(await planQuery.execute({ nodeId: "t1" }, toolContext()))
    assert.equal(q2.nodes[0].readiness.ready, true)

    // 完成必须有证据
    const noEvidence = await output(await node.execute({ action: "completed", nodeId: "t1" }, toolContext()))
    assert.equal(noEvidence.ok, false)
    assert.match(noEvidence.error, /requires an evidenceType/)

    // 开工（owner 默认取调用方 agent）
    const started = await output(await node.execute({ action: "started", nodeId: "t1" }, toolContext()))
    assert.equal(started.ok, true)
    assert.equal(started.node.owner, "private", "owner defaults to the calling agent")

    // active 状态下尝试 agent_claim 完成 → 铁律拒绝
    const cheated = await output(
      await node.execute({ action: "completed", nodeId: "t1", evidenceType: "agent_claim" }, toolContext()),
    )
    assert.equal(cheated.ok, false)
    assert.match(cheated.error, /executors cannot prove their own success/)

    const done = await output(
      await node.execute({ action: "completed", nodeId: "t1", evidenceType: "external", summary: "green" }, toolContext()),
    )
    assert.equal(done.ok, true)
    assert.equal(done.node.status, "done")

    // 重启语义：重新组合后计划完整恢复
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q3 = await output(await tool(second, "plan-query").execute({}, toolContext()))
    assert.equal(q3.nodes.length, 3)
    const t1 = q3.nodes.find((n: { id: string }) => n.id === "t1")
    assert.equal(t1.status, "done")
    assert.equal(t1.readiness.ready, true)
    assert.equal(t1.readiness.unmetFacts.length, 0)
  })

  test("plan-node zod schema rejects malformed args", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    await assert.rejects(
      () => tool(hooks, "plan-node").execute({ action: "teleport", nodeId: "t1" }, toolContext()),
      /invalid/i,
    )
  })
})

describe("memory tools through the plugin", () => {
  test("failure → anchored lesson → recall → retire → asOf → restart", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const plan = tool(hooks, "plan-node")
    const verify = tool(hooks, "verify-run")
    const record = tool(hooks, "memory-record")
    const recall = tool(hooks, "memory-recall")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")
    const ctx = toolContext()

    // 真实失败链：亲证 fail → 认领 → 失败交卷（节点 failed）
    await plan.execute(
      { action: "created", nodeId: "t1", type: "task", title: "risky task", verifier: "run: node flaky.mjs" },
      ctx,
    )
    await fs.writeFile(path.join(dir, "flaky.mjs"), "process.exit(2)", "utf8")
    const witness = await output(
      await verify.execute({ entity: "flaky", property: "tests", command: "node flaky.mjs", kind: "test" }, ctx),
    )
    assert.equal(witness.fact.value, "fail")
    await spawn.execute({ nodeId: "t1", solverId: "s1" }, ctx)
    const delivered = await output(
      await report.execute(
        { solverId: "s1", action: "succeeded", summary: "somehow done", evidenceId: witness.evidenceId },
        ctx,
      ),
    )
    assert.equal(delivered.ok, false, "run: gate blocks completion with a failing witness")

    await report.execute({ solverId: "s1", action: "failed", reason: "flaky tests unrecoverable" }, ctx)

    // 记 lesson：锚定失败节点；relatedExisting 应为空（首条）
    const recorded = await output(
      await record.execute(
        {
          action: "recorded",
          subject: "flaky-tests",
          lesson: "flaky integration suites need retry logic before planning dependent tasks",
          anchors: ["t1", witness.evidenceId],
        },
        ctx,
      ),
    )
    assert.equal(recorded.ok, true)
    assert.equal(recorded.relatedExisting.length, 0)

    // 第二条同主题 lesson → relatedExisting 提示已有经验
    const second = await output(
      await record.execute(
        {
          action: "recorded",
          subject: "flaky-tests",
          lesson: "run the suite twice before declaring flakiness",
          anchors: ["seq:4"],
        },
        ctx,
      ),
    )
    assert.equal(second.ok, true)
    assert.equal(second.relatedExisting.length, 1, "prior lesson surfaced for explicit dedupe decision")

    // recall 全景：failures 聚合 + lessons
    const all = await output(await recall.execute({}, ctx))
    assert.equal(all.lessons.length, 2)
    assert.ok(all.failures.nodes.some((n: { id: string }) => n.id === "t1"))
    assert.equal(all.revision > 0, true)

    // 退休第一条 → 默认隐藏
    const retired = await output(await record.execute({ action: "retired", lessonId: recorded.lesson.id, reason: "superseded" }, ctx))
    assert.equal(retired.ok, true)
    const after = await output(await recall.execute({ subject: "flaky-tests" }, ctx))
    assert.equal(after.lessons.length, 1)
    const withRetired = await output(await recall.execute({ subject: "flaky-tests", showRetired: true }, ctx))
    assert.equal(withRetired.lessons.length, 2)

    // asOf：重放到退休前，两条都在（点时间查询）
    const asOfThen = await output(await recall.execute({ subject: "flaky-tests", asOf: retired.seq - 1, showRetired: true }, ctx))
    assert.equal(asOfThen.lessons.filter((l: { retired?: boolean }) => l.retired).length, 0)

    // 重启：lessons 与退休标记完整恢复
    const secondHooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q2 = await output(await tool(secondHooks, "memory-recall").execute({ showRetired: true }, ctx))
    assert.equal(q2.lessons.length, 2)
    assert.equal(q2.lessons.filter((l: { retired?: boolean }) => l.retired).length, 1)
  })

  test("recovery flows: tool-failure retry succeeds vs logic-failure exhausts into a replacement", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const plan = tool(hooks, "plan-node")
    const verify = tool(hooks, "verify-run")
    const ctx = toolContext()
    await fs.writeFile(path.join(dir, "flaky.mjs"), "process.exit(1)", "utf8")
    await fs.writeFile(path.join(dir, "flaky-fixed.mjs"), "process.exit(0)", "utf8")

    // ── 流 A：tool failure → reopen → 修复后重试成功 ──
    await plan.execute(
      { action: "created", nodeId: "tA", type: "task", title: "retryable", verifier: "run: node flaky-fixed.mjs" },
      ctx,
    )
    await plan.execute({ action: "started", nodeId: "tA" }, ctx)
    // 一次失败的尝试（exit 1）作为状态记录
    const badRun = await output(await verify.execute({ entity: "flaky", property: "last-run", command: "node flaky.mjs" }, ctx))
    assert.equal(badRun.fact.value, "fail")
    const failA = await output(
      await plan.execute({ action: "failed", nodeId: "tA", reason: "exit 1", failureClass: "tool" }, ctx),
    )
    assert.equal(failA.ok, true)
    assert.equal(failA.node.failureClass, "tool")

    const reopenA = await output(await plan.execute({ action: "reopened", nodeId: "tA", reason: "fix landed" }, ctx))
    assert.equal(reopenA.ok, true)
    assert.equal(reopenA.node.status, "pending")
    assert.equal(reopenA.node.retryCount, 1)

    await plan.execute({ action: "started", nodeId: "tA" }, ctx)
    const witnessA = await output(
      await verify.execute({ entity: "flaky", property: "tests", command: "node flaky-fixed.mjs", kind: "test", depth: "verified" }, ctx),
    )
    assert.equal(witnessA.fact.value, "pass")
    const doneA = await output(await plan.execute({ action: "completed", nodeId: "tA", evidenceId: witnessA.evidenceId }, ctx))
    assert.equal(doneA.ok, true, "retry succeeded and the run: gate accepted the passing witness")
    assert.equal(doneA.node.status, "done")

    // ── 流 B：logic failure → 三次重试耗尽（circuit breaker）→ supersedes 替代 ──
    await plan.execute({ action: "created", nodeId: "tB", type: "task", title: "doomed approach" }, ctx)
    await plan.execute({ action: "started", nodeId: "tB" }, ctx)
    await plan.execute({ action: "failed", nodeId: "tB", reason: "logic hole", failureClass: "logic" }, ctx)
    for (let i = 0; i < 3; i++) {
      const reopen = await output(await plan.execute({ action: "reopened", nodeId: "tB", reason: `attempt ${i + 2}` }, ctx))
      assert.equal(reopen.ok, true)
      await plan.execute({ action: "started", nodeId: "tB" }, ctx)
      await plan.execute({ action: "failed", nodeId: "tB", reason: `still broken ${i + 2}`, failureClass: "logic" }, ctx)
    }
    const breaker = await output(await plan.execute({ action: "reopened", nodeId: "tB", reason: "one more" }, ctx))
    assert.equal(breaker.ok, false)
    assert.match(breaker.error, /circuit breaker open/)

    // Director 走 Subgraph Replan：替代节点声明 supersedes
    const replacement = await output(
      await plan.execute({ action: "created", nodeId: "tC", type: "task", title: "different approach", supersedes: "tB" }, ctx),
    )
    assert.equal(replacement.ok, true)
    assert.equal(replacement.node.supersedes, "tB")
    await plan.execute({ action: "started", nodeId: "tC" }, ctx)
    const doneC = await output(
      await plan.execute({ action: "completed", nodeId: "tC", evidenceType: "external", summary: "worked around" }, ctx),
    )
    assert.equal(doneC.ok, true)

    // 终态核对：tB 耗尽失败、tC 替代完成
    const q = await output(await tool(hooks, "plan-query").execute({ nodeId: "tB" }, ctx))
    assert.equal(q.nodes[0].status, "failed")
    assert.equal(q.nodes[0].retryCount, 3)
    assert.equal(q.nodes[0].failureClass, "logic")

    // 重启：恢复语义完整
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q2 = await output(await tool(second, "plan-query").execute({ nodeId: "tC" }, ctx))
    assert.equal(q2.nodes[0].supersedes, "tB")
    assert.equal(q2.nodes[0].status, "done")
  })
  test("full epistemic loop: unknown → question → hypothesis → experiment → belief → verdict → fact → gate opens", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const fact = tool(hooks, "fact-record")
    const plan = tool(hooks, "plan-node")
    const verify = tool(hooks, "verify-run")
    const question = tool(hooks, "research-question")
    const hypothesis = tool(hooks, "research-hypothesis")
    const rquery = tool(hooks, "research-query")
    const ctx = toolContext()
    await fs.writeFile(path.join(dir, "simulate.mjs"), "process.exit(0)", "utf8")

    // 显式声明未知 + 被未知门控的任务
    await fact.execute({ entity: "cache", property: "eviction-policy", action: "unknown", note: "no trace data yet" }, ctx)
    await plan.execute(
      {
        action: "created",
        nodeId: "t1",
        type: "task",
        title: "tune cache",
        preconditionFacts: ["cache::eviction-policy"],
        verifier: "npm test",
      },
      ctx,
    )
    const blockedHire = await output(await tool(hooks, "solver-spawn").execute({ nodeId: "t1" }, ctx))
    assert.equal(blockedHire.ok, false)
    assert.match(blockedHire.error, /unmet facts/)

    // 认知展开：raise question → propose hypothesis（prior 带 rationale）
    const q = await output(await question.execute(
      { action: "raised", question: "which eviction policy fits the read-heavy trace?", subject: "caching", motivation: "gate blocks t1" },
      ctx,
    ))
    assert.equal(q.ok, true)
    const h = await output(await hypothesis.execute(
      {
        action: "proposed",
        questionId: q.question.id,
        statement: "LRU maximizes hit-rate for our read-heavy trace",
        prior: 0.5,
        rationale: "common default, needs trace confirmation",
        mechanism: "de-novo",
      },
      ctx,
    ))
    assert.equal(h.ok, true)

    // 实验：计划节点声明 tests → verify-run 亲证
    await plan.execute({ action: "created", nodeId: "exp1", type: "verification", title: "trace sim", tests: h.hypothesis.id }, ctx)
    await plan.execute({ action: "started", nodeId: "exp1" }, ctx)
    const sim = await output(await verify.execute(
      { entity: "trace-sim", property: "hit-rate-lru", command: "node simulate.mjs", kind: "tool_output" },
      ctx,
    ))
    assert.equal(sim.fact.value, "pass")

    // 信念移动（validation gate：必须引用亲证证据）
    const noEvidence = await output(await hypothesis.execute(
      { action: "updated", hypothesisId: h.hypothesis.id, belief: 0.9, rationale: "vibes", evidenceId: "ev:ghost" },
      ctx,
    ))
    assert.equal(noEvidence.ok, false)
    const moved = await output(await hypothesis.execute(
      { action: "updated", hypothesisId: h.hypothesis.id, belief: 0.85, rationale: "sim hit-rate supports LRU", evidenceId: sim.evidenceId },
      ctx,
    ))
    assert.equal(moved.ok, true)
    assert.equal(moved.hypothesis.belief, 0.85)

    // verdict 是阈值转换：0.85 ≥ 0.8 → supported 通过
    const verdict = await output(await hypothesis.execute(
      { action: "evaluated", hypothesisId: h.hypothesis.id, verdict: "supported", reasoning: "0.85 with sim witness", evidenceId: sim.evidenceId },
      ctx,
    ))
    assert.equal(verdict.ok, true)
    assert.equal(verdict.hypothesis.verdict, "supported")
    // 终态后信念冻结
    const frozen = await output(await hypothesis.execute(
      { action: "updated", hypothesisId: h.hypothesis.id, belief: 0.99, rationale: "more", evidenceId: sim.evidenceId },
      ctx,
    ))
    assert.equal(frozen.ok, false)
    assert.match(frozen.error, /frozen at verdict/)

    // Resolution 桥：结论落成 VERIFIED 世界事实（external 转述实验结论）
    await fact.execute(
      { entity: "cache", property: "eviction-policy", action: "observed", value: "LRU", evidenceType: "external" },
      ctx,
    )
    await fact.execute(
      { entity: "cache", property: "eviction-policy", action: "verified", value: "LRU", evidenceType: "external" },
      ctx,
    )
    // 问题解决 + 任务门控打开 → 完成闭环
    await question.execute({ action: "resolved", questionId: q.question.id, resolution: "LRU confirmed by trace sim" }, ctx)
    await plan.execute({ action: "started", nodeId: "t1" }, ctx)
    const done = await output(await plan.execute({ action: "completed", nodeId: "t1", evidenceType: "external" }, ctx))
    assert.equal(done.ok, true)

    // 认知全景
    const view = await output(await rquery.execute({}, ctx))
    assert.equal(view.questions.length, 1)
    assert.equal(view.questions[0].resolved, true)
    assert.equal(view.hypotheses.length, 1)
    assert.equal(view.hypotheses[0].verdict, "supported")

    // 重启恢复
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const q2 = await output(await tool(second, "research-query").execute({}, ctx))
    assert.equal(q2.hypotheses[0].belief, 0.85)
    assert.equal(q2.questions[0].resolved, true)
  })

})

describe("completion gate through the plugin", () => {
  test("completion gate: witnessed shine vs zero-action attested exposed on the dashboard", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension(), createFlightRecorderExtension()])
    const plan = tool(hooks, "plan-node")
    const verify = tool(hooks, "verify-run")
    const spawn = tool(hooks, "solver-spawn")
    const report = tool(hooks, "solver-report")
    const tick = tool(hooks, "director-tick")
    const ctx = toolContext()

    // ── witnessed 流：亲证完成，档案有执行定格 ──
    await plan.execute({ action: "created", nodeId: "tW", type: "task", title: "witnessed work" }, ctx)
    await spawn.execute({ nodeId: "tW", solverId: "s1" }, ctx)
    await fs.writeFile(path.join(dir, "w.mjs"), "process.exit(0)", "utf8")
    const witness = await output(await verify.execute({ entity: "w", property: "tests", command: "node w.mjs", kind: "test" }, ctx))
    await hooks.onEvent!(hostToolEvent("verify-run", "witnessed run")) // 宿主事件流：黑匣子采集
    const doneW = await output(await report.execute(
      { solverId: "s1", action: "succeeded", summary: "verified work", evidenceId: witness.evidenceId },
      ctx,
    ))
    assert.equal(doneW.ok, true)
    const wq = await output(await tool(hooks, "plan-query").execute({ nodeId: "tW" }, ctx))
    assert.equal(wq.nodes[0].completionKind, "witnessed")
    assert.ok((wq.nodes[0].executionTrail?.count ?? 0) >= 1, "black-box freeze shows the work")

    // ── attested 流：无任何宿主动作的交卷（合法，但在仪表盘显形）──
    await plan.execute({ action: "created", nodeId: "tZ", type: "task", title: "claimed only" }, ctx)
    await spawn.execute({ nodeId: "tZ", solverId: "s2" }, ctx)
    const doneZ = await output(await report.execute(
      { solverId: "s2", action: "succeeded", summary: "trust me", evidenceType: "external" },
      ctx,
    ))
    assert.equal(doneZ.ok, true, "attested completion stays legal — no lock added")
    const zq = await output(await tool(hooks, "plan-query").execute({ nodeId: "tZ" }, ctx))
    assert.equal(zq.nodes[0].completionKind, "attested")
    assert.equal(zq.nodes[0].executionTrail?.count, 0, "zero-action hand-in is self-evident")

    // Director 仪表盘：attested 清单 + 零动作显形 + witnessed 计数
    await plan.execute({ action: "created", nodeId: "o1", type: "outcome", title: "root" }, ctx)
    const d = await output(await spawn.execute({ nodeId: "o1", solverId: "d1", role: "director" }, ctx))
    assert.equal(d.ok, true)
    const health = await output(await tick.execute({ directorId: "d1" }, ctx))
    assert.equal(health.health.witnessedDoneCount, 1)
    assert.deepEqual(
      health.health.attestedDone.filter((a: { id: string }) => a.id === "tZ").map((a: { trailCount: number }) => a.trailCount),
      [0],
      "zero-action hand-in glows on the dashboard",
    )

    // 重启：分级与档案完整恢复
    const second = await composeExtensionHooks(host(), [createRuntimeLedgerExtension(), createFlightRecorderExtension()])
    const q = await output(await tool(second, "plan-query").execute({ nodeId: "tW" }, ctx))
    assert.equal(q.nodes[0].completionKind, "witnessed")
    assert.ok((q.nodes[0].executionTrail?.count ?? 0) >= 1)
  })

  test("memory-record anchoring validation surfaces in-band", async () => {
    const hooks = await composeExtensionHooks(host(), [createRuntimeLedgerExtension()])
    const bad = await output(
      await tool(hooks, "memory-record").execute(
        { action: "recorded", subject: "s", lesson: "l", anchors: ["ev:ghost"] },
        toolContext(),
      ),
    )
    assert.equal(bad.ok, false)
    assert.match(bad.error, /unknown evidence anchor/)
    const noAnchor = await output(
      await tool(hooks, "memory-record").execute({ action: "recorded", subject: "s", lesson: "l", anchors: [] }, toolContext()),
    )
    assert.equal(noAnchor.ok, false)
    assert.match(noAnchor.error, /non-empty array/)
  })
})
