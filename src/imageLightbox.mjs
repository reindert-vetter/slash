// imageLightbox — click-to-fullscreen for a Markdown image, with →/← to walk
// every other image in the SAME rendered Markdown body (reviewer request: "ik
// wil screenshots uit readme kunnen inzien... als ik erop klik moet het
// volledig scherm en moet ik door alle afbeeldingen kunnen gaan met pijltjes
// naar rechts"). "Overal waar markdown staat" (explicit follow-up answer) —
// so this is ONE mechanism reused everywhere `renderMarkdown` (markdown.mjs)
// renders: the PR description, comment bodies, Claude-chat bubbles, and the
// /inbox task description. It needed no per-call-site wiring because every
// one of those already sits inside a `.markdown-body`-classed container (see
// `.claude/rules/conventions.md`) — that shared class is this module's only
// scoping hook.
//
// Deliberately a plain DOM delegated listener, not an arrow.js `@click`
// binding: renderMarkdown's output is raw HTML set via the `.innerHTML`
// binding (a plain string, escaped/sanitized in markdown.mjs, never an
// arrow.js template — see markdown.mjs's own header comment), so there is no
// template node to bind a reactive handler to. Mirrors how
// RelatedPanel.mjs's `recomputeCodePreviews` already reads data straight off
// that same kind of raw-HTML DOM instead of re-parsing the source text.
import { reactive, html } from './vendor/arrow.js'

const lb = reactive({ open: false, images: [], index: 0 })

// initImageLightbox wires the one document-level click listener. Idempotent
// — safe to call once per page from each entry module (home.mjs, inbox.mjs)
// without double-binding, since a page only ever loads its own module graph
// once.
let initialized = false
export function initImageLightbox() {
  if (initialized) return
  initialized = true
  document.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-md-image]')
    if (!img) return
    const container = img.closest('.markdown-body')
    if (!container) return
    const images = Array.from(container.querySelectorAll('img[data-md-image]'))
    const index = images.indexOf(img)
    if (index < 0) return
    lb.images = images.map((el) => ({ src: el.currentSrc || el.src, alt: el.alt || '' }))
    lb.index = index
    lb.open = true
  })
}

// isLightboxOpen/handleLightboxKeydown are the two hooks a page's own global
// keydown handler calls FIRST — mirroring how home.mjs's onKeydown checks
// `menu.open` before anything else (see menuOverlay/MenuHost in home.mjs):
// while the lightbox is open it owns the keyboard completely, so the rest of
// the app's own extensive navigation must never see these keys.
export function isLightboxOpen() {
  return lb.open
}

export function handleLightboxKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeLightbox()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    stepLightbox(1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    stepLightbox(-1)
  }
}

function closeLightbox() {
  lb.open = false
}

// stepLightbox wraps around (last → first, first → last) — a natural "keep
// pressing → to cycle through the screenshots" loop, rather than clamping and
// forcing the reviewer to switch to ← at the end.
function stepLightbox(delta) {
  const n = lb.images.length
  if (n <= 1) return
  lb.index = (lb.index + delta + n) % n
}

// imageLightboxOverlay — the fullscreen overlay itself. A click on the
// backdrop closes it; a click on the image/nav buttons must not (handled via
// stopPropagation, per the nested-@click rule in arrowjs-pitfalls.md — the
// state mutation there never removes an ancestor's own listener mid-dispatch,
// so plain stopPropagation is enough here, unlike that rule's own edge case).
export function imageLightboxOverlay() {
  return html`
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      data-testid="image-lightbox"
      @click="${() => closeLightbox()}"
    >
      <button
        type="button"
        class="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        data-testid="image-lightbox-close"
        title="Sluiten"
        aria-label="Sluiten"
        @click="${(e) => {
          e.stopPropagation()
          closeLightbox()
        }}"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="contents">
        ${() =>
          lb.images.length > 1
            ? html`<button
                type="button"
                class="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                data-testid="image-lightbox-prev"
                title="Vorige afbeelding"
                aria-label="Vorige afbeelding"
                @click="${(e) => {
                  e.stopPropagation()
                  stepLightbox(-1)
                }}"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><path d="M15 6l-6 6 6 6"/></svg>
              </button>`.key('lightbox-prev')
            : ''}
      </div>
      <img
        class="max-h-[90vh] max-w-[90vw] object-contain"
        data-testid="image-lightbox-image"
        src="${() => (lb.images[lb.index] ? lb.images[lb.index].src : '')}"
        alt="${() => (lb.images[lb.index] ? lb.images[lb.index].alt : '')}"
        @click="${(e) => e.stopPropagation()}"
      />
      <div class="contents">
        ${() =>
          lb.images.length > 1
            ? html`<button
                type="button"
                class="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                data-testid="image-lightbox-next"
                title="Volgende afbeelding"
                aria-label="Volgende afbeelding"
                @click="${(e) => {
                  e.stopPropagation()
                  stepLightbox(1)
                }}"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5"><path d="M9 6l6 6-6 6"/></svg>
              </button>`.key('lightbox-next')
            : ''}
      </div>
      <div class="contents">
        ${() =>
          lb.images.length > 1
            ? html`<p
                class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white"
                data-testid="image-lightbox-counter"
              >
                ${() => lb.index + 1} / ${() => lb.images.length}
              </p>`.key('lightbox-counter')
            : ''}
      </div>
    </div>
  `
}

// ImageLightboxHost — the top-level mount, sibling of MenuHost (home.mjs) /
// an equivalent top-level mount in inbox.mjs. Same "static chunk-reuse"
// reasoning as MenuHost's own doc comment: mounted once, toggled via its own
// nested `${() => ...}` binding with a stable `<div>` root, per the "bare
// toggling expression" pitfall in arrowjs-pitfalls.md.
export default function ImageLightboxHost() {
  return html` <div>${() => (lb.open ? imageLightboxOverlay().key('image-lightbox') : '')}</div> `
}
