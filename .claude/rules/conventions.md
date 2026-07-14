# Conventies (ingevuld door dit scaffold — corrigeer waar nodig)

- Frontend-modules zijn `.mjs`, één component per bestand, PascalCase voor
  component-bestanden (`Block.mjs`), lowercase voor pagina-modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) leven in `src/vendor/` en worden met een relatief
  pad geïmporteerd, niet via een CDN-module. Tailwind is de uitzondering (Play CDN).
  arrow.js staat gevendord in `src/vendor/arrow.js`.
- **Lokale patch op arrow.js (`src/vendor/arrow.js`)** — er staat één bewuste
  wijziging in de gevendorde arrow.js, gemarkeerd met een `LOCAL PATCH`-comment in
  de header: de template-expressie-evaluator `rt` skipt een **vrijgegeven slot**
  (`typeof W[t]=="function"`-guard) i.p.v. 'm aan te roepen. Zonder die guard crasht
  een reactief effect dat ná het opruimen van zijn keyed-node nog in de
  microtask-flush vuurt met `W[t] is not a function` (use-after-free) — o.a. bij het
  **drillen** (een Onderliggende-code-kind als eigen kolom openen re-scope't het
  paneel en breekt kaarten af midden in de flush). Bij een arrow.js-upgrade moet
  deze patch **opnieuw** worden aangebracht (zie het comment voor de originele
  regel).
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
- **arrow.js hergebruikt een keyed node zonder z'n function-bindings te
  herdraaien — en verliest soms een `.innerHTML`/attribuut-update bij
  co-subscribers.** Twee samenhangende valkuilen, beide waargenomen in de
  block-kaarten van `DetailPanel` (`home.mjs`):
  1. Wisselt een keyed node van rol maar blijft z'n `.key(...)` gelijk (b.v. een
     block dat van *preview* naar *geselecteerd* gaat bij ↓/↑), dan **verplaatst
     + patcht** arrow.js de bestaande node i.p.v. 'm opnieuw op te bouwen: de
     `${() => …}`-function-bindings binnenin draaien niet opnieuw en een bevroren
     binding (b.v. de `activeGroup`-highlight) vuurt nooit voor de nieuwe staat.
  2. Abonneren **meerdere** reactieve consumers op dezelfde property (b.v. de
     diff-render leest `b.code` én een `watch`-getter leest `curBlock().code`),
     dan laat arrow.js de `null→geladen`-update van de diff-binding er
     **intermitterend** uitvallen — de diff blijft op "loading" hangen terwijl de
     code er al is.
  Oplossing (beide): laat niet-navigatie-transities een **verse** node forceren
  via de key, en herbouw de kaart van buitenaf i.p.v. te vertrouwen op de fragiele
  `b.code`-binding. Concreet in `home.mjs`: de block-kaart-key codeert rol
  (`sel`/`prev`) **én** code-status (`load`/`code`/`err`). De DetailPanel-binding
  abonneert op `state.codeVersion` (gebumpt door `ensureCode` zodra code arriveert)
  — een teller náást `b.code` — zodat hij betrouwbaar herdraait en de key
  omklapt, wat een **verse** diff-binding oplevert die de geladen code leest. De
  `setCommentScope`/`setRelated`-watches blijven wél `curBlock().code` lezen (dat
  moeten ze, om de cursor te volgen); dat maakt ze co-subscribers en is exact
  waarom de diff-binding zélf de update kan missen — vandaar de herbouw-via-key
  i.p.v. wéér een `b.code`-lezer toe te voegen. Zie
  `.claude/rules/detail-layout.md`.
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
