import { promises as fs } from "node:fs"
import path from "node:path"
import type { AuditEvent, AuditLogger } from "../core/types.ts"

export class JsonlAuditLogger implements AuditLogger {
  private file: string

  constructor(file: string) {
    this.file = file
  }

  private async ensureParent(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
  }

  async record(event: AuditEvent): Promise<void> {
    await this.ensureParent()
    await fs.appendFile(this.file, JSON.stringify(event) + "\n", "utf8")
  }

  async readAll(): Promise<AuditEvent[]> {
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
      .map((line) => JSON.parse(line) as AuditEvent)
  }
}
