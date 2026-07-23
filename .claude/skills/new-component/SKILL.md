---
name: new-component
description: Scaffold a new arrow.js frontend component (.mjs) in src/ following the vanilla-JS/no-build conventions of this repo. Use when adding a new UI block, page module, or reactive widget to the PR Review Tree dashboard.
---

# New frontend component

Create a new `.mjs` component that fits the stack: vanilla ES modules,
arrow.js for reactivity, Tailwind (Play CDN) for styling. **No** bundler, no
JSX, no framework.

## Steps

1. Determine the type and thus the file name:
   - **Component/block** → PascalCase, e.g. `src/Block.mjs`.
   - **Page module** → lowercase, e.g. `src/home.mjs`.
2. Copy `.claude/templates/Component.mjs` to the right location and rename it.
3. Fill it in and remove unused lines. Stick to:
   - Default export = a function that accepts `reactive()` state and
     **returns** an arrow.js `html`` `` template (doesn't mount itself).
   - Reactive values sit in `${() => ...}`, events as `@click="${...}"`,
     lists with `.map(...).key(id)`.
   - Style with Tailwind classes; no separate CSS files unless needed.
4. Import and mount the component in the parent module with `template(el)`.
5. Add a Playwright test if needed that checks the rendered behavior.

## arrow.js pitfalls (from practice)

- **No HTML comments** (`<!-- ... -->`) in an `html`` `` template — arrow.js
  throws "Invalid HTML position" then. Use JS comments outside the template.
- A reactive **attribute value must be the whole value**:
  `class="${() => ...}"`, not `class="static ${() => ...}"`. Build the full
  string inside the arrow function.
- Test hooks: give rows a `data-testid` so Playwright can select them stably.

## Don't

- Don't add an npm package for something vanilla can do.
- Don't CDN-import a module (except Tailwind Play CDN); import vendored libs
  relatively from `src/vendor/`.
