// 追加只写（append-only JSONL）事件存储 —— 运行时的权威事实源。
// 并发模型（Phase 12 多会话收口）：
//   - 单实例：dispatch 串行队列保证顺序；
//   - 多实例（opencode 多会话/多进程）：写入经 <file>.lock 互斥 + 锁内
//     乐观校验（重读磁盘尾部确认缓存未过期），seq 严格连续。
//     锁持有为毫秒级；陈旧锁（>30s，进程崩溃残留）自动打破——追加的
//     原子性由文件语义保证，打破锁最坏重开一个已被校验覆盖的窗口。
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { isRuntimeEventType, type RuntimeEvent, type RuntimeEventInput } from "./types.ts"

const LOCK_TIMEOUT_MS = 5000
const STALE_LOCK_MS = 30_000
const LOCK_RETRY_MS = 25

export class JsonlEventStore {
  private file: string
  private cache: RuntimeEvent[] | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  append(input: RuntimeEventInput): Promise<RuntimeEvent> {
    const next = this.queue.then(() => this.doAppend(input))
    this.queue = next.catch(() => undefined)
    return next
  }

  async readAll(): Promise<RuntimeEvent[]> {
    // 多实例下内存缓存可能落后（他方会话已追加）——读取以磁盘为权威并刷新缓存
    const disk = await this.readFromDisk()
    this.cache = disk
    return [...disk]
  }

  async readSince(seq: number): Promise<RuntimeEvent[]> {
    return (await this.readAll()).filter((event) => event.seq > seq)
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockFile = `${this.file}.lock`
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const handle = await fs.open(lockFile, "wx")
        await handle.close()
        return async () => {
          await fs.rm(lockFile, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error
        }
        // 陈旧锁（持有者崩溃残留）：超过 STALE_LOCK_MS 自动打破
        try {
          const stat = await fs.stat(lockFile)
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.rm(lockFile, { force: true })
            continue
          }
        } catch {
          continue // 锁恰好已被释放
        }
        if (Date.now() > deadline) {
          throw new Error(`ledger lock timeout: ${lockFile} is held by another session`)
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
  }

  // 磁盘为权威：缓存只是加速（多实例下他方实例可能已追加）
  private async readFromDisk(): Promise<RuntimeEvent[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []
      }
      throw error
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(parseEventLine)
  }

  private async doAppend(input: RuntimeEventInput): Promise<RuntimeEvent> {
    if (!isRuntimeEventType(input.type)) {
      throw new Error(`unknown runtime event type: ${String(input.type)}`)
    }
    if (typeof input.source !== "string" || input.source.length === 0) {
      throw new Error("event source must be a non-empty string")
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const release = await this.acquireLock()
    try {
      // 乐观校验（锁内）：磁盘为权威——内存缓存过期则重载
      const disk = await this.readFromDisk()
      if (this.cache && this.cache !== disk && this.cache[this.cache.length - 1]?.seq !== disk[disk.length - 1]?.seq) {
        this.cache = disk
      }
      const events = this.cache ?? disk
      const lastSeq = disk.length > 0 ? disk[disk.length - 1].seq : 0
      const event: RuntimeEvent = {
        id: randomUUID(),
        seq: lastSeq + 1,
        type: input.type,
        source: input.source,
        payload: input.payload ?? {},
        timestamp: new Date().toISOString(),
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.appendFile(this.file, JSON.stringify(event) + "\n", "utf8")
      this.cache = [...disk, event]
      return event
    } finally {
      await release()
    }
  }
}

function parseEventLine(line: string): RuntimeEvent {
  let parsed: Partial<RuntimeEvent>
  try {
    parsed = JSON.parse(line) as Partial<RuntimeEvent>
  } catch (error) {
    throw new Error(`corrupt event log line: ${line.slice(0, 120)} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.seq !== "number" ||
    typeof parsed.type !== "string" ||
    !isRuntimeEventType(parsed.type)
  ) {
    throw new Error(`corrupt event log line: ${line.slice(0, 120)}`)
  }
  return {
    id: parsed.id,
    seq: parsed.seq,
    type: parsed.type,
    source: typeof parsed.source === "string" ? parsed.source : "",
    payload:
      parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : {},
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
  }
}
