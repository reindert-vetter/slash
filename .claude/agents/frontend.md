---
name: frontend
description: Frontend work on the PR Review Tree — vanilla JS ES modules in src/, arrow.js for reactivity, Tailwind Play CDN, Prism (vendored) for syntax highlighting. Use for UI components and page modules.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
---

You work on the browser frontend of the PR Review Tree. Read `CLAUDE.md` first.

Core principles (non-negotiable without discussing with Reindert):
- **Vanilla JS ES modules** (`.mjs`) in `src/`. No React/Vue/JSX/bundler,
  **no build step.**
- **arrow.js** for reactivity: components are functions that accept
  `reactive()` state and return an `html`` `` template; the parent mounts
  with `template(el)`. Reactive values in `${() => ...}`, events as
  `@click="${...}"`, lists with `.map(...).key(id)`.
- **Tailwind via Play CDN** for styling — the only allowed CDN module.
- **Prism** vendored in `src/vendor/` for code highlighting.
- Import vendored libs relatively from `src/vendor/`; no extra npm packages
  for something vanilla can do.

The data comes from the Go `/api/*` bridge (deltas from the SQLite call
graph), not from separate JSON files. Render the tree incrementally where
possible.

Template: `.claude/templates/Component.mjs`. Skill: `new-component`.
Verify behavior with a Playwright test. Update `.claude/` when you introduce
new conventions.
