// Template: een arrow.js component. Kopieer, hernoem naar PascalCase (bv. Block.mjs)
// en verwijder de regels die je niet nodig hebt.
//
// Conventie:
// - Eén component per bestand, default export een functie die reactive state
//   accepteert en een arrow.js template teruggeeft (NIET zelf mounten).
// - De aanroepende module (bv. dashboard.mjs) mount met `template(el)`.
// - Vendored import-pad; pas het aan als jouw vendor-map elders staat.

import { html } from './vendor/arrow.js'

/**
 * @param {object} data - reactive() state vanuit de parent.
 * @returns arrow.js template — roep aan met een mount-target om te renderen.
 */
export default function Component(data) {
  // Reactieve expressies staan ALTIJD in een arrow-function `${() => ...}`,
  // anders is de waarde statisch en updatet de DOM niet.
  return html`
    <div class="rounded-lg border border-slate-200 p-4">
      <h2 class="font-semibold">${() => data.title}</h2>

      <button
        class="mt-2 rounded bg-slate-900 px-3 py-1 text-white"
        @click="${() => data.count++}"
      >
        ${() => data.count} keer geklikt
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
