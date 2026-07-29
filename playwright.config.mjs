import { defineConfig, devices } from '@playwright/test'

// The Go binary is built once by globalSetup; each worker then seeds its own DB
// and starts its own server on its own port (see tests/_fixtures.mjs). There is
// no shared `webServer` anymore — that removes the cross-worker write races and
// page-load contention that made the suite flaky, and lets us parallelise freely.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a failure here is a failure. This used to be `retries: 1` as a
  // blanket cover for the cold-start mount race (specs that mount a component via
  // a dynamic import inside page.evaluate() against the live app page, which the
  // app's own history.replaceState() burst during load can tear down). That race
  // now has a targeted fix instead — evaluateSettled in tests/_fixtures.mjs retries
  // just that evaluate, on just those two error messages — so the blanket retry
  // only bought two bad things: a free second attempt for genuine, unrelated
  // failures in the same file, and silence about how often anything actually
  // flakes. Every other flake the suite exhibited has since been traced to its own
  // root cause (two of them real app bugs; see the "Playwright test infra" section
  // in .claude/rules/conventions.md for the full list and the patterns to avoid).
  //
  // So: if a test fails here, do not restore this to 1 — find the race. The suite
  // was verified green four consecutive full runs with retries off at 4 workers.
  retries: 0,
  // 8-core machine. Each worker runs its own Go server + a Chromium; 4 workers
  // keeps the box from saturating (which showed up as flaky assertion timeouts at
  // higher worker counts) while still running everything in parallel.
  workers: 4,
  reporter: 'list',
  globalSetup: './tests/_setup.mjs',
  // Assertions poll for up to 15s. Passing tests still resolve in well under a
  // second; the headroom only matters when 4 parallel workers briefly saturate
  // the box and a render/mount takes a few seconds — that used to trip the default
  // 5s timeout and flake the component-mount specs (approval/highlight/diff).
  expect: { timeout: 15_000 },
  use: {
    // baseURL is overridden per worker in tests/_fixtures.mjs (each worker has its
    // own port); this is just a harmless default.
    baseURL: 'http://127.0.0.1:4200',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
