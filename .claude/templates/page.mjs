// Template: a lowercase page module (e.g. home.mjs). A page fetches data from
// the /api/*-bridge, creates reactive() state, mounts a component, and owns
// global interaction (e.g. keyboard navigation). Copy, rename, and remove
// what you don't need.
//
// NOTE (arrow.js pitfalls, from practice):
// - Do NOT put HTML comments (`<!-- ... -->`) inside an html`` template:
//   arrow.js throws "Invalid HTML position" then. Use JS comments outside
//   the template.
// - A reactive attribute value must be the WHOLE value:
//   `class="${() => ...}"`, not `class="static ${() => ...}"`. Build the
//   full string inside the arrow function.
// - Reactive values always sit in `${() => ...}`; events as
//   `@click="${...}"`; lists with `.map(...).key(id)`.

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

// Mount: call the template with a mount target.
Component(state)(document.getElementById('app'))

load()
