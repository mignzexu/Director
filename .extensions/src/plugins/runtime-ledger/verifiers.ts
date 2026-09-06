// runtime-ledger 私有模块：验证工具（verify-run）。
//
// Phase 7 核心：证据从申报制到产出制。agent 只能声明「验证什么」，
// 执行与记账由本工具完成——spawn 真实命令、捕获指纹（exit code / 时长 /
// 输出尾部）、自动 dispatch fact.observed（mechanism="verify-run"）。
// 机器可复现的验证（test/tool_output）只能由此产出，申报一律被 Runtime
// 裁定降级为 external。
//
// 风险等级：medium —— 项目首个本地进程执行工具，按 README 约定触发
// Capability Gateway 最小化：本登记 + JsonlAuditLogger 审计 + 宿主权限键
// （private.md `verify-run: allow`）。ToolContext.ask() 审批为 Gateway
// 第二步（待宿主行为验证）。
//
// 威胁模型（README 上线检查清单第 3 条）：
// - 本地进程执行（shell:true，cwd 默认工作区根，env 继承宿主——与原生
//   bash 同级，OS 级隔离已让渡 openchamber）
// - 超时强杀：Windows 下 taskkill /T /F 杀进程树；类 Unix kill SIGKILL；
//   极端情况下仍可能有孙进程残留（已登记，接受）
// - 输出上限：收集上限 64KB，outputTail 仅保留尾部 400 字符
// - 无网络调用、无目录外写入（除审计文件）
import { spawn } from "node:child_process"
import { z } from "zod"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import { JsonlAuditLogger } from "../../state/audit.ts"
import type { AuditEvent } from "../../core/types.ts"

const OUTPUT_COLLECT_LIMIT = 64 * 1024
const OUTPUT_TAIL_LENGTH = 400
const DEFAULT_TIMEOUT_MS = 120_000

const runArgs = {
  entity: z.string().min(1).describe("Fact subject to verify, e.g. 'service/auth'"),
  property: z.string().min(1).describe("Fact property, e.g. 'tests'"),
  command: z.string().min(1).describe("Shell command to execute (its exit code decides pass/fail)"),
  kind: z.enum(["test", "tool_output"]).default("tool_output").describe("Evidence kind the run produces"),
  depth: z
    .enum(["observed", "verified"])
    .default("observed")
    .describe("observed: record OBSERVED fact; verified: also promote it to VERIFIED with the same evidence"),
  cwd: z.string().optional().describe("Working directory (defaults to the workspace root)"),
  timeoutMs: z.number().int().positive().max(600_000).default(DEFAULT_TIMEOUT_MS).describe("Kill the run after this long"),
  note: z.string().optional().describe("Optional note attached to the run"),
}
const runSchema = z.object(runArgs)
type RunArgs = z.infer<typeof runSchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

interface RunOutcome {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  outputTail: string
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32") {
    if (child.pid !== undefined) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
    }
    return
  }
  child.kill("SIGKILL")
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(command, { shell: true, cwd, env: process.env, windowsHide: true })
    const chunks: Buffer[] = []
    let collected = 0
    let timedOut = false
    const collect = (data: Buffer): void => {
      if (collected >= OUTPUT_COLLECT_LIMIT) {
        return
      }
      chunks.push(data)
      collected += data.length
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.on("error", () => {
      clearTimeout(timer)
      // spawn 本身失败（如 shell 缺失）：按 exit 127 语义处理
      resolve({ exitCode: 127, timedOut: false, durationMs: Date.now() - started, outputTail: "" })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const combined = Buffer.concat(chunks).toString("utf8")
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: combined.slice(-OUTPUT_TAIL_LENGTH),
      })
    })
  })
}

export function buildVerifierTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  // 审计文件与 createRuntime 默认 root 一致（<directory>/.extensions/state/runtime/）；
  // directory 在 execute 时才可得，故 lazy 初始化（tools 需在插件对象创建时静态组装）
  let auditLogger: JsonlAuditLogger | undefined
  const ensureAudit = (directory: string): JsonlAuditLogger => {
    if (!auditLogger) {
      auditLogger = new JsonlAuditLogger(`${directory}/.extensions/state/runtime/audit.jsonl`)
    }
    return auditLogger
  }

  return {
    "verify-run": {
      description:
        "Execute a verification command and record its outcome as ledger evidence (machine-witnessed, " +
        "mechanism=verify-run). The exit code decides the fact value ('pass' on 0, 'fail' otherwise). " +
        "This is the only way to produce test/tool_output evidence — declared ones are downgraded to " +
        "external by the runtime. Nodes whose verifier declares 'run: <command>' can only be completed " +
        "with a matching witnessed run.",
      args: runArgs,
      execute: async (rawArgs, port) => {
        const args: RunArgs = runSchema.parse(rawArgs)
        const cwd = args.cwd ?? port.directory
        const outcome = await runCommand(args.command, cwd, args.timeoutMs)
        const value = outcome.exitCode === 0 && !outcome.timedOut ? "pass" : "fail"

        const auditEvent: AuditEvent = {
          timestamp: new Date().toISOString(),
          session_id: port.sessionID,
          agent: port.agent,
          capability: "verify-run",
          command: args.command,
          cwd,
          permissions: { kind: args.kind, depth: args.depth, timeoutMs: args.timeoutMs },
          approved: true,
          exit_code: outcome.exitCode,
          timed_out: outcome.timedOut,
          duration_ms: outcome.durationMs,
        }
        try {
          await ensureAudit(port.directory).record(auditEvent)
        } catch {
          // 审计失败不推翻验证结果（事件将照常落账）
        }

        try {
          const observed = await getRuntime().dispatch({
            type: "fact.observed",
            source: port.agent,
            payload: {
              entity: args.entity,
              property: args.property,
              value,
              note: args.note,
              evidence: {
                type: args.kind,
                mechanism: "verify-run",
                command: args.command,
                exitCode: outcome.exitCode,
                ...(outcome.timedOut ? { timedOut: true } : {}),
                ...(outcome.outputTail.length > 0 ? { outputTail: outcome.outputTail } : {}),
              },
            },
          })
          const evidenceId = `ev:${observed.id}`
          if (args.depth === "verified") {
            await getRuntime().dispatch({
              type: "fact.verified",
              source: port.agent,
              payload: { entity: args.entity, property: args.property, value, evidence: { evidenceId } },
            })
          }
          const fact = getRuntime().getState().facts[`${args.entity}::${args.property}`]
          return jsonResult(`${args.entity}::${args.property} = ${value} (${fact?.status ?? "?"})`, {
            ok: true,
            seq: observed.seq,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            durationMs: outcome.durationMs,
            outputTail: outcome.outputTail,
            evidenceId,
            fact,
          })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
  }
}
