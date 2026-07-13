# Conventies (ingevuld door dit scaffold — corrigeer waar nodig)

- Frontend-modules zijn `.mjs`, één component per bestand, PascalCase voor
  component-bestanden (`Block.mjs`), lowercase voor pagina-modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) leven in `src/vendor/` en worden met een relatief
  pad geïmporteerd, niet via een CDN-module. Tailwind is de uitzondering (Play CDN).
  arrow.js staat gevendord in `src/vendor/arrow.js`.
- **arrow.js-valkuilen** (uit de praktijk): géén HTML-comments (`<!-- -->`) in een
  `html`` `` template (gooit "Invalid HTML position"); een reactieve attribuut-waarde
  moet de **hele** waarde zijn (`class="${() => ...}"`, niet `class="x ${...}"`).
  Ruwe HTML injecteer je via de `.innerHTML`-binding
  (`.innerHTML="${() => htmlString}"`) — arrow.js zet dan de property i.p.v. te
  escapen. Zorg dat de string veilig is (bv. Prism.highlight, dat zelf escapet).
- **arrow.js `watch(getter, cb)` — som je reactieve deps _inline_ in de getter op.**
  Verstop je alle reads in een geroepen functie met early-returns/conditionele
  paden (b.v. `watch(() => buildStuff(), …)`), dan varieert de dependency-set per
  run en kan de uitgekristalliseerde run een key laten vallen waar hij eerder wél
  op abonneerde — de watch her-abonneert niet en stopt met vuren. Lijst daarom de
  state die het moet volgen letterlijk op (`() => [state.a, state.b, obj && obj.x]`)
  en doe het echte werk in de _callback_. Zo doen de `setCommentScope`- en
  `setRelated`-watches in `home.mjs` het; een eerdere `setRelated`-watch die dat
  níét deed liet het gerelateerd-paneel op het bij load geselecteerde block
  bevriezen (zie `.claude/rules/detail-layout.md`).
- **Syntax-highlighting:** Prism 1.29.0 staat gevendord als één ES-module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php, met
  `window.Prism={manual:true}` zodat het niet de hele pagina auto-highlightt). De
  code-panes in `Block.mjs` highlighten PHP met `Prism.highlight(...)` en tonen het
  resultaat via de `.innerHTML`-binding. Prism's eigen container-CSS is bewust
  weggelaten; alleen de token-kleuren staan in de `<style>` van `index.html`,
  **gescoped op de `.language-php`-class** die elk code-fragment draagt — dus niet
  alleen de diff-panes maar ook de Onderliggende-code-kaarten + de comment-hint
  (`RelatedPanel.mjs`) en de footer krijgen dezelfde kleuren. (Was eerder gescoped
  op `[data-testid=code-diff]`, waardoor alles buiten de diff-panes kleurloos bleef.)
- Go: `net/http` `ServeMux`, handlers per feature. De `/api/`-bridge shelt uit naar
  `gh`/`claude` via `os/exec` — valideer altijd input voordat je het aan een
  subproces geeft.
- **Code (Go + JS) is Engels** — comments, log-berichten en identifiers. De docs in
  `.claude/` en `CLAUDE.md` blijven Nederlands.
