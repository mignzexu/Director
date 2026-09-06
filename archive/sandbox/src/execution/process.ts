import { spawn } from "node:child_process"
import { platform } from "node:os"

export interface ProcessResult {
  exit_code: number | null
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  cancelled: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}

export interface RunProcessOptions {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputChars?: number
}

const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false }
  }
  return {
    text: text.slice(0, max) + `\n...[output truncated at ${max} chars]`,
    truncated: true,
  }
}

function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) {
    return Promise.resolve()
  }
  if (platform() === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
      killer.once("close", () => resolve())
      killer.once("error", () => resolve())
    })
  }
  child.kill("SIGTERM")
  const fallback = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL")
    }
  }, 500)
  fallback.unref()
  return Promise.resolve()
}

export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now()
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  let stdout = ""
  let stderr = ""
  let stdoutTruncated = false
  let stderrTruncated = false
  let timedOut = false
  let cancelled = false
  let killed = false
  let killPromise: Promise<void> | undefined

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
  })

  const finish = (kind: "timeout" | "abort"): void => {
    if (child.pid !== undefined && !killed) {
      killed = true
      if (kind === "timeout") {
        timedOut = true
      } else {
        cancelled = true
      }
      killPromise = killTree(child)
    }
  }

  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => finish("timeout"), options.timeoutMs)
      : undefined

  const abortHandler = options.signal
    ? (): void => finish("abort")
    : undefined

  if (options.signal && abortHandler) {
    if (options.signal.aborted) {
      finish("abort")
    } else {
      options.signal.addEventListener("abort", abortHandler, { once: true })
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutTruncated) {
      return
    }
    const next = stdout + chunk.toString()
    const { text, truncated } = truncate(next, maxChars)
    stdout = text
    stdoutTruncated = truncated
  })

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrTruncated) {
      return
    }
    const next = stderr + chunk.toString()
    const { text, truncated } = truncate(next, maxChars)
    stderr = text
    stderrTruncated = truncated
  })

  const exitCode = await new Promise<number | null>((resolve) => {
    let resolved = false
    child.on("close", (code) => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler)
      }
      if (!resolved) {
        resolved = true
        resolve(code)
      }
    })
    child.on("error", (error) => {
      stderr = stderr + (stderrTruncated ? "" : `\nfailed to start process: ${error.message}`)
      if (!resolved) {
        resolved = true
        resolve(null)
      }
    })
  })

  await killPromise

  return {
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: Date.now() - started,
    timed_out: timedOut,
    cancelled: cancelled,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
  }
}
