import { promises as fs } from "node:fs"
import path from "node:path"
import type { StateStore } from "../core/types.ts"

export class FileStateStore implements StateStore {
  private rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  private resolve(relativePath: string): string {
    const joined = path.resolve(this.rootDir, relativePath)
    const root = path.resolve(this.rootDir)
    if (joined !== root && !joined.startsWith(root + path.sep)) {
      throw new Error(`state path escapes state root: ${relativePath}`)
    }
    return joined
  }

  private async ensureParent(file: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
  }

  async read<T>(relativePath: string): Promise<T | undefined> {
    const file = this.resolve(relativePath)
    try {
      const raw = await fs.readFile(file, "utf8")
      return JSON.parse(raw) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined
      }
      throw error
    }
  }

  async write<T>(relativePath: string, value: T): Promise<void> {
    const file = this.resolve(relativePath)
    await this.ensureParent(file)
    await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8")
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath))
      return true
    } catch {
      return false
    }
  }
}
