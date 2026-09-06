export interface CapabilityContext {
  sessionId?: string
  agent?: string
  messageId?: string
  directory: string
  worktree?: string
  signal?: AbortSignal
}

export interface Capability {
  id: string
  description: string
  execute(input: unknown, context: CapabilityContext): Promise<unknown>
}

export interface CapabilityRegistry {
  register(capability: Capability): void
  get(id: string): Capability
  list(): Capability[]
}

export interface AuditEvent {
  timestamp: string
  session_id?: string
  agent?: string
  capability: string
  command: string
  cwd: string
  permissions: Record<string, unknown>
  requested_permissions?: Record<string, unknown>
  approved: boolean
  exit_code?: number | null
  timed_out?: boolean
  cancelled?: boolean
  duration_ms?: number
  error?: string
  error_code?: string
  backend?: string
}

export interface AuditLogger {
  record(event: AuditEvent): Promise<void>
  readAll(): Promise<AuditEvent[]>
}

export interface StateStore {
  read<T>(relativePath: string): Promise<T | undefined>
  write<T>(relativePath: string, value: T): Promise<void>
  exists(relativePath: string): Promise<boolean>
}

