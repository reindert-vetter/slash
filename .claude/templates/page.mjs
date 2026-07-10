// Template: een lowercase page-module (bv. home.mjs). Een pagina haalt data van
// de /api/*-bridge, maakt reactive() state, mount een component en bezit globale
// interactie (bv. keyboard-navigatie). Kopieer, hernoem en verwijder wat je niet
// nodig hebt.
//
// LET OP (arrow.js valkuilen, uit de praktijk):
// - Zet GEEN HTML-comments (`<!-- ... -->`) in een html`` template: arrow.js gooit
//   dan "Invalid HTML position". Gebruik JS-comments buiten de template.
// - Een reactieve attribuut-waarde moet de HELE waarde zijn:
//   `class="${() => ...}"`, niet `class="static ${() => ...}"`. Bouw de volledige
//   string in de arrow-functie.
// - Reactieve waarden staan altijd in `${() => ...}`; events als `@click="${...}"`;
//   lijsten met `.map(...).key(id)`.

import { reactive } from './vendor/arrow.js'
import Component from './Component.mjs'

const state = reactive({
  items: [],
  selected: 0,
})

async function load() {
  const res = await fetch('/api/example')
  if (!res.ok) return
  state.items = await res.json()
}

function onKeydown(e) {
  if (state.items.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    state.selected = Math.min(state.selected + 1, state.items.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    state.selected = Math.max(state.selected - 1, 0)
  }
}

window.addEventListener('keydown', onKeydown)

// Mount: roep de template aan met een mount-target.
Component(state)(document.getElementById('app'))

load()
