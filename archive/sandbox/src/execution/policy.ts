import path from "node:path"
import { DEFAULT_CONFIG } from "../config/sandbox-config.ts"
import type { SandboxConfig } from "../config/sandbox-config.ts"

export interface SandboxPolicy {
  workspace: string
  network: boolean
  readRoots: string[]
  writeRoots: string[]
  protectedRoots: string[]
}

export interface SandboxPolicyOptions {
  workspace: string
  network?: boolean
  readRoots?: string[]
  writeRoots?: string[]
  protectedRoots?: string[]
  config?: SandboxConfig
}

export function defaultSandboxPolicy(options: SandboxPolicyOptions): SandboxPolicy {
  const configProtected = options.config?.filesystem.protected_paths ?? DEFAULT_CONFIG.filesystem.protected_paths
  const protectedRoots = [
    path.join(options.workspace, ".git"),
    ...configProtected.map((item) => path.resolve(options.workspace, item)),
    ...(options.protectedRoots ?? []),
  ]
  return {
    workspace: path.resolve(options.workspace),
    network: options.network ?? false,
    readRoots: [...(options.readRoots ?? [])],
    writeRoots: [...(options.writeRoots ?? [])],
    protectedRoots: [...new Set(protectedRoots.map((item) => path.resolve(item)))],
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root)
  const candidateResolved = path.resolve(candidate)
  const normalizedRoot = rootResolved.replace(/[\\/]+$/g, "")
  const normalizedCandidate = candidateResolved.replace(/[\\/]+$/g, "")
  const comparisonRoot = normalizedRoot.toLowerCase()
  const comparisonCandidate = normalizedCandidate.toLowerCase()
  return (
    comparisonCandidate === comparisonRoot || comparisonCandidate.startsWith(comparisonRoot + path.sep)
  )
}

export function isGitPath(workspace: string, candidate: string): boolean {
  return isPathWithin(path.join(workspace, ".git"), candidate)
}
