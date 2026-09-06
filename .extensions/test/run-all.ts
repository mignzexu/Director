export {}

const files = [
  "audit",
  "extensions-routing",
  "registration",
  "runtime-events",
  "world-state",
  "plan-model",
  "solver-model",
  "director-model",
  "verification-model",
  "memory-model",
  "recovery-model",
  "research-model",
  "grand-tour",
  "boundary",
  "concurrent-write",
  "flight-recorder",
  "completion-gate",
  "runtime-ledger",
]

for (const file of files) {
  console.log(`\n===== ${file}.test.ts =====`)
  await import(`./${file}.test.ts`)
}
