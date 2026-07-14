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
- **arrow.js — een `${() => …}`-slot dat wisselt tussen een enkel element en een
  keyed array (`.map()`) bevriest na een lege render.** Waargenomen in de
  comment-lijst van `RelatedPanel.mjs`: de slot gaf óf `visibleComments().map(...)`
  (keyed rijen) óf een enkel `<p>Nog geen comments</p>`. Navigeer je naar een block
  zónder comments (de slot rendert het enkele `<p>`) en dan terug naar een block
  mét een comment, dan draaide de slot-binding wel opnieuw en gaf een niet-lege
  array terug, maar arrow.js rende de rijen niet meer — de lijst bleef leeg terwijl
  `cs.view` wél gevuld was (de comment stond nog wel in de thread-header, die een
  string teruggeeft). **Oplossing:** geef **altijd hetzelfde soort** uit die slot —
  wikkel de lege-staat in een **array van één** (`[html\`<p …>…</p>\`.key('no-comments')]`)
  zodat de slot-vorm stabiel een keyed array blijft. Re-keyen van het paneel of een
  scalar-versieteller hielpen niet; alleen de stabiele array-vorm.
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
- **Een `state.x`-lezing die je synchroon binnen een outer array-bouwende
  `${() => {...}}`-closure aanroept (i.p.v. in een eigen geneste reactieve slot),
  maakt de HELE closure afhankelijk van `state.x`** — ook als de uitkomst zelf
  slechts één klein element betreft. Gezien in `home.mjs`'s `DetailPanel`: de
  block-kolom-closure die alle `Block(...)`-kaarten bouwt riep `canStep(-1)`/
  `canStep(1)` (voor het grijze step-chevron) **direct** aan; `canStep` leest
  `state.change`/`mode`/`focusLevel`. Daardoor draaide de hele closure — en dus
  elke `Block()`-aanroep met **verse** `activeGroup`/`hintsEnabled`/`diffActive`/
  etc.-closures — opnieuw bij **elke** ↑/↓-stap. De `.key(...)` voorkwam een
  volledige DOM-node-vervanging (arrow matcht 'm en hergebruikt de node via
  `move+patch`), maar elke functie-gebonden attribute-slot (`class`, checkbox
  `.indeterminate`, category-badge, enz.) werd daarbij toch **opnieuw gezet**
  (`setAttribute` vergelijkt niet met de oude waarde) — een meetbare
  `MutationObserver`-cascade over de HELE kaart bij iedere stap, wat als
  zichtbare flikkering oogde (niet alleen de highlight verschoof, de hele kaart
  "ademde" mee). **Oplossing:** verplaats de `state.change`-lezing naar een eigen
  geneste `${() => canStep(...) ? … : ''}`-binding (dezelfde vorm als de bestaande
  `${() => menu.open ? menuOverlay() : ''}`-toggle) zodat alléén dat kleine slot
  op de navigatie-state reageert; de outer closure blijft beperkt tot de deps die
  hij expliciet noemt (`selected`/`codeVersion`/`focusLevel`). Zie
  `stepChevronSlot` in `home.mjs` en `.claude/rules/detail-layout.md`.
- **arrow.js ruimt een weggevallen (conditioneel gerenderde) subtree niet volledig
  op — z'n reactieve expressions blijven geabonneerd (use-after-free).** Gezien bij
  het **command-menu** (`home.mjs` + `CommandMenu.mjs`): het overlay hangt aan een
  `${() => menu.open ? menuOverlay() : ''}`-binding. Bij sluiten geeft die `''`
  terug en verdwijnt de overlay uit de DOM, **maar** de list/row-bindings van die
  `CommandMenu`-instantie blijven geabonneerd op het state-object waartegen ze
  gebouwd zijn. Muteert een **latere** open dat object (een andere `mode`, of het
  betreden van een submenu dat `sub` zet), dan vuren die **wees-bindings** tegen
  inmiddels vrijgegeven expression-slots → arrow gooit `W[t] is not a function`
  (een teller-index in arrow's slot-pool wijst naar een gerecyclede slot). Same-mode
  heropenen crasht niet (geen dep verandert), cross-mode of submenu wél. Het is een
  **latente** bug: de oude flow opende nooit een tweede menu (Enter/`/` werden
  opgeslokt zolang de composer open was), dus hij werd pas zichtbaar toen de
  comment-soort-`compose`-mode een menu **over** de composer opende.
  **Oplossing:** splits de menu-state in een **stabiele** `menu` (alleen `open`,
  waar de top-level binding aan hangt) en een **wegwerp** `let ms = reactive({query,
  sel, sub, mode})` die `openMenu` bij **elke** open **vervangt** door een vers
  object. Wees-bindings van een vorige open wijzen dan naar het **oude** `ms` dat we
  nooit meer aanraken, dus ze vuren nooit; alleen de live-bindings (tegen de huidige
  `ms`) draaien. `closeMenu` zet enkel `menu.open=false` — het laat `ms` bewust met
  rust. (Altijd-gemount-met-CSS-verbergen werkt níét: dan rendert `CommandMenu` al
  bij page-load — vóór er een block geselecteerd is — en gooien de label-functies
  die `curBlock()` lezen alsnog, wat de slot-pool corrumpeert.) Zie
  `.claude/rules/keyboard-navigation.md`.
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
- **Git worktrees mogen** — Claude/agents mogen gerust een git-worktree opzetten om
  geïsoleerd of parallel aan een taak te werken (b.v. de Agent-tool met
  `isolation: worktree`). Een eerdere afspraak verbood dit; die is hierbij
  ingetrokken. (Niet te verwarren met de **app-eigen** base/head-worktrees onder
  `data/worktrees/` uit de ingest-pipeline — die blijven zoals beschreven in
  `.claude/rules/blocks-and-ingest.md`.)

## Playwright-test-infra (per-worker geïsoleerde server)

- De Go-binary wordt **één keer** gebouwd in `globalSetup` (`tests/_setup.mjs` →
  `go build -o tests/.tmp/slash .`), nooit per test.
- Er is **geen gedeelde `webServer`** meer. Elke Playwright-worker krijgt via de
  worker-scoped fixture in **`tests/_fixtures.mjs`** zijn **eigen** geseede
  SQLite-DB én **eigen** server op **poort `4200 + workerIndex`**. Omdat `newTasks`
  álle module-DB's (comments/workflows/relations/callresolve/inbox/prmeta) **naast**
  het `-db`-pad zet (`filepath.Dir`), isoleert één `-db tests/.tmp/w<n>/test.db`
  meteen **alle write-state** per worker. De read-only base/head-worktrees onder
  `data/` blijven gedeeld (server-`dataDir` is hardcoded `"data"`). Dit haalt de
  cross-worker **write-races** weg (comment/workflow-SQLite-contention gaf eerder
  een lege `runId`) én de page-load-contentie die de suite flaky maakte.
- **Spec-imports:** elke spec importeert `{ test, expect }` uit **`./_fixtures.mjs`**
  (niet `@playwright/test`), zodat `page.goto('/pr/…')` de eigen worker-server raakt
  (de fixture overschrijft `baseURL`).
- **Workers = 4** op deze 8-core-box: elke worker draait een Go-server **plus** een
  Chromium, dus hoger (6+) verzadigt de machine en gaf flaky assertion-timeouts.
  `expect`-timeout staat op **15s** (ruimte voor een trage render tijdens een
  startup-piek; geslaagde tests blijven <1s) en `retries: 1` vangt de resterende
  cold-start **mount-race** op (een paar specs mounten een component via een
  dynamische `import()` in `page.evaluate()` tegen de live app-pagina — nodig voor
  de Tailwind/Prism-CSS van `index.html` — en de `history.replaceState`-burst van de
  app tijdens load kan die mount kort verstoren). Een echte fout faalt beide pogingen.
- **Data-kanttekening:** de diff-inhoud (`/api/code`) komt uit de **gitignored**
  `data/worktrees/pr-<n>-{base,head}` — géén gecommitte fixture. Zijn die lokaal naar
  een andere commit gedreven (b.v. base+head op twee náást elkaar liggende commits
  i.p.v. base=merge-base), dan tonen de meeste blokken **geen** wijzigingen en falen
  diff-inhoud-afhankelijke tests. Anker diff-navigatie-tests daarom op een blok dat
  betrouwbaar een wijziging draagt (blok 0 van PR 12903).
