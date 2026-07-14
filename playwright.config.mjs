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
  // A handful of specs mount a component by dynamically importing a module inside
  // page.evaluate() against the live app page (they need index.html's Tailwind +
  // Prism styles for computed-colour assertions). The app fires a burst of
  // history.replaceState() during load, and when the box is briefly saturated at
  // startup that can tear down the import context or delay the mount — a pure
  // load-timing artifact. One retry re-runs such a test from a clean page; genuine
  // failures still fail both attempts.
  retries: 1,
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
