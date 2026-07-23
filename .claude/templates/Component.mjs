// Template: an arrow.js component. Copy, rename to PascalCase (e.g. Block.mjs)
// and remove the lines you don't need.
//
// Convention:
// - One component per file, default export a function that accepts reactive
//   state and returns an arrow.js template (does NOT mount itself).
// - The calling module (e.g. dashboard.mjs) mounts it with `template(el)`.
// - Vendored import path; adjust it if your vendor folder lives elsewhere.

import { html } from './vendor/arrow.js'

/**
 * @param {object} data - reactive() state from the parent.
 * @returns arrow.js template — call with a mount target to render.
 */
export default function Component(data) {
  // Reactive expressions ALWAYS sit in an arrow function `${() => ...}`,
  // otherwise the value is static and the DOM won't update.
  return html`
    <div class="rounded-lg border border-slate-200 p-4">
      <h2 class="font-semibold">${() => data.title}</h2>

      <button
        class="mt-2 rounded bg-slate-900 px-3 py-1 text-white"
        @click="${() => data.count++}"
      >
        ${() => data.count} times clicked
      </button>

      <ul>
        ${() =>
          data.items.map((item) =>
            html`<li>${item.label}</li>`.key(item.id),
          )}
      </ul>
    </div>
  `
}
