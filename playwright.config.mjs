import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Build the Go binary, seed a deterministic fixture DB (no network/gh/git),
  // then serve it. All in one command so it works regardless of webServer vs
  // globalSetup ordering.
  webServer: {
    command:
      'mkdir -p tests/.tmp && go build -o tests/.tmp/slash . && ' +
      // Wipe every DB plus its WAL/SHM sidecars — a leftover -wal from a
      // killed run makes a fresh open fail with a SQLite disk-I/O error.
      'rm -f tests/.tmp/*.db tests/.tmp/*.db-wal tests/.tmp/*.db-shm && ' +
      'rm -rf tests/.tmp/workflows && ' +
      'tests/.tmp/slash seed -db tests/.tmp/test.db -from tests/fixtures/blocks.json && ' +
      'tests/.tmp/slash seed -db tests/.tmp/test.db -from tests/fixtures/relations-blocks.json -relations tests/fixtures/relations.json && ' +
      `SLASH_GITHUB=off SLASH_INBOX=tests/fixtures/inbox.json tests/.tmp/slash -db tests/.tmp/test.db -addr 127.0.0.1:${PORT} -static .`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
