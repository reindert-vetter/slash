// globalSetup: build the Go binary ONCE for the whole run. Each worker then
// seeds its own DB and starts its own server against this binary (see
// _fixtures.mjs) — so we never rebuild per test and workers don't share write
// state. The per-worker DBs/servers live under tests/.tmp/w<n>/.
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

export default function globalSetup() {
  rmSync('tests/.tmp', { recursive: true, force: true })
  mkdirSync('tests/.tmp', { recursive: true })
  execSync('go build -o tests/.tmp/slash .', { stdio: 'inherit' })
}
