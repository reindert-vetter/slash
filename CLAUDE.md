# PR Review Tree

Een dashboard dat uit een GitHub-PR (voor nu `plug-and-pay/plug-and-pay`) een
**functie-call-graph** bouwt die je in de browser als boom bekijkt. De boom helpt
bij het reviewen: je ziet welke functies door de PR geraakt worden en hoe ze elkaar
aanroepen.

## De stack is bewust minimalistisch en zonder build-step

Dit is een harde ontwerpkeuze, geen toevalligheid. Voeg **niets** toe dat een
bundler, transpiler of build-stap vereist. Bij twijfel: kies de saaiere, kleinere
oplossing.

### Runtime & server (Go)

- **Golang, geen framework.** Eigen kleine HTTP-server.
- De server serveert de repo **statisch** + een dunne **`/api/*`-bridge** naar
  lokale CLI's:
  - `gh` — voor PR-comments (lezen/plaatsen).
  - `claude` — voor consult en om code te laten aanpassen.
- **Vrijwel geen dependencies in productie — alleen Go built-ins** (`net/http`,
  `os/exec`, `encoding/json`, `database/sql`, …). Wil je een nieuwe dependency
  toevoegen? **Vraag het eerst aan Reindert.**
- **Goedgekeurde uitzondering:** `modernc.org/sqlite` — de pure-Go SQLite-driver
  (geen cgo, dus geen build-step). Dit is de enige toegestane runtime-dependency.
  (Wil je liever de cgo-driver `mattn/go-sqlite3`? Overleg dat eerst.)

### Frontend

- **Vanilla JS ES-modules** in `src/` (`.mjs`). Geen React/Vue/bundler.
- **[arrow.js](https://www.arrow-js.com/)** voor reactiviteit — componenten als
  `dashboard.mjs`, `home.mjs`, `Block.mjs`, etc.
- **Tailwind via Play CDN** (in-browser, geen build-stap).
- **Prism** vendored onder `src/vendor/` voor syntax-highlighting van code.

### Data

- **SQLite** als opslag voor de call-graph (nodes + edges), via `database/sql` +
  `modernc.org/sqlite`. Eén DB-bestand onder `data/` (bv. `data/graph.db`).
- Voordeel boven losse JSON: een update van één klein stukje is een simpele
  row-`UPDATE`/`INSERT` — je hoeft niet een heel bestand te herschrijven of alles
  te herladen. Serveer deltas via de `/api/*`-bridge, niet door de hele graph te
  dumpen.
- Schema-template: `.claude/templates/schema.sql`.

### Test

- **Playwright** (`@playwright/test`) — de enige echte npm-dependency, staat in
  `devDependencies`. Alleen voor tests, nooit in productie.

## Blocks & ingest

De eerste feature: een PR omzetten in een lijst **blocks** (een block = één
PHP-functie/method, of het hele bestand als parsen faalt) en die links als
navigeerbare lijst tonen.

- **Opslag:** de `blocks`-tabel (dit ís de `nodes`/functie-tabel uit de graph,
  hernoemd + uitgebreid met `class/category/end_line/status/side/pr`). De kolom
  `approved` (0/1) markeert of de reviewer een block heeft goedgekeurd. `edges`
  blijft voor de latere call-graph. Schema: `.claude/templates/schema.sql` (in sync
  met de `schemaDDL`-constante in `db.go`).
- **Pipeline:** `gh pr view` → `git fetch` (pull-ref + develop, fallback by-sha) →
  twee detached worktrees onder `data/worktrees/pr-<pr>-{base,head}` (**absolute
  paden**!) → `git diff --unified=0` → PHP-scanner (`phpscan.go`, brace-lexer, geen
  externe parser) → classificeren (`classify.go`) → opslaan. Zie skill `ingest-pr`.
- **Draaien:** `go run . ingest <pr> [-db data/graph.db]` (headless) of
  `POST /api/ingest {"pr":N}`. Server: `go run . [-db path] [-addr host:port]
  [-static dir]`. DB-pad ook via `SLASH_DB`. Serve: `GET /api/blocks?pr=N`
  (delta) en `GET /api/code?pr=N&file=..&class=..&name=..` (de oude + nieuwe
  source van één block, uit de base/head worktrees — voor de side-by-side diff
  onder de block-info; `file` moet een opgeslagen block van die PR zijn). De
  front-end (`Block.mjs`) lijnt die oud/nieuw-source **regel-voor-regel** uit met
  een eigen LCS-line-diff (`alignRows`/`diffLines`, puur JS — géén AI): gelijke
  regels delen een rij, een verwijderde regel laat rechts een lege filler-rij, een
  toegevoegde regel laat links een lege filler-rij, en gewijzigde regels krijgen
  rood (oud) / groen (nieuw). Beide panes renderen evenveel rijen op dezelfde
  regelhoogte, dus ze lijnen vanzelf verticaal uit. De line-diff matcht regels
  **whitespace-ongevoelig** (`diffLines` vergelijkt op `s.replace(/\s+/g,'')`, à la
  `git diff -w`): een regel die alléén her-ingesprongen is (bv. een array die een
  niveau dieper in `array_merge(…)` belandt) paart nog met zijn tegenhanger en
  toont als whitespace-only re-alignment (`wsOnly`) — enkel de verschoven
  whitespace krijgt een zachte tint, het woord zelf wordt nooit char-gemarkeerd —
  i.p.v. door de positionele del/ins-pairing te schuiven en ongewijzigde woorden
  als "gewijzigd" te markeren.

## Toetsenbord-navigatie (twee modes)

De keyboard-flow zit in `home.mjs` (`onKeydown`) en heeft twee modes via
`state.mode`. Los daarvan springt **`Enter`** naar de **chat**: het selecteert de
**bovenste taak** in het `RelatedPanel` (`ui.task = 0`) zodat die thread opent.
`ui` is een gedeelde `reactive({ task: 0 })` in `home.mjs` die aan `RelatedPanel`
wordt doorgegeven, zodat de navigatie de taakselectie kan sturen.

- **`'list'`** (start): `↑`/`↓` kiezen een block in de sidebar, `→` stapt de diff
  van het geselecteerde block in.
- **`'diff'`**: `↑`/`↓` lopen door de **wijzigingen** van dat block, `←` stapt
  terug naar de lijst. Loop je voorbij de **laatste** wijziging (`↓`) of de
  **eerste** (`↑`) — je kunt niet verder binnen dit block — dan stap je door
  naar het **volgende** resp. **vorige** block, **mits dat block uit hetzelfde
  bestand komt** (dezelfde blokken die met het gestippelde connector-lijntje aan
  elkaar hangen); land je op een bestandsgrens dan stopt de navigatie daar. Bij
  het overstappen land je op de eerste resp. laatste wijziging (`stepBlock`, dat
  via `sameFileNeighbour(delta)` de bestands-check doet), zodat je zonder terug
  te gaan naar de lijst door alle diffs van één bestand loopt. Als het buurblock
  zijn code nog laadt onthoudt `pendingLast` dat je op de laatste wijziging wilt
  landen; `ensureCode` lost dat op zodra de rijen bekend zijn. Sta je op de
  **laatste** (resp. **eerste**) wijziging én is er een volgend (resp. vorig)
  **same-file** block, dan verschijnt een **grijs step-chevron _buiten_ de
  block-kaart** — onder de kaart (bij `↓`) net boven het gestippelde
  connector-lijntje, of erboven (bij `↑`) — als hint dat de pijl je naar het
  buurblock brengt (`stepChevron`/`canStep(delta)` in `home.mjs`, in de
  block-kolom náást de kaarten gerenderd). Dit staat los van het **groene
  scroll-chevron _binnen_ de kaart** (`scrollHint`/`updateHints` in `Block.mjs`),
  dat enkel nog "er zijn wijzigingen buiten beeld — scroll verder in dít block"
  betekent. Grijs + buiten = je verlaat het block; groen + binnen = blijf scrollen.
  Op een bestandsgrens (geen same-file buur) blijft het grijze step-chevron uit.

Bij het instappen (`→`) springt de selectie naar de **eerste gewijzigde regel**
(toegevoegd, verwijderd of gewijzigd) — `state.change` is de index. De
navigatie-eenheden komen uit `changeGroups(rows)` in `Block.mjs`: opeenvolgende
gewijzigde rijen (del/ins) tellen als **één** groep, maar een run langer dan 5
rijen wordt in stukken van 5 opgeknipt (`MAX_GROUP`). Die knip gebeurt alleen op
een rij die een **letter (A-z)** bevat: een gewijzigde rij die enkel uit
haakjes/leestekens bestaat (bv. `}` of `{`) wordt bij de huidige groep
getrokken i.p.v. een nieuwe te starten (`hasLetter`), zodat een groep nooit
vlak vóór — of op — een kale haakjes-regel eindigt. `blockRows(b)` levert exact
dezelfde aligned rijen als de render, zodat navigatie en highlight nooit
uiteenlopen. Het geselecteerde block krijgt de actieve groep als een reactieve
`activeGroup`-functie mee (leest `state.mode/selected/change`), zodat de pane
her-highlight zonder dat de hele `DetailPanel` opnieuw rendert. De actieve rijen
krijgen een fellere tint + een inset-linkerbalk (`shadow-[inset_3px_0_0_…]`, geen
layout-shift) en de eerste rij een `data-change-active`-anchor; `home.mjs`
scrollt die met `scrollIntoView({block:'center'})` naar het midden van de
diff-viewport.

### Selectie-granulariteit (`f` inzoomen / `s` uitzoomen / `d` terug)

Binnen een block zoom je met **`f`** (inzoomen) en **`s`** (uitzoomen) langs drie
niveaus (`home.mjs`, `GRANS`). **`d`** is de "terug"-toets die op het fijnste
niveau als vorige-call fungeert (zie onder):

- **`'group'`** (start bij instappen): een hele run gewijzigde regels
  (`changeGroups`) — meerdere regels tegelijk.
- **`'line'`**: één gewijzigde regel per keer (`changeLines`).
- **`'call'`**: één **aanroep-segment binnen** die regel (`changeCalls`). Anders
  dan de grovere niveaus knipt dit niet op *wat* er gewijzigd is maar op de
  **structuur** — de aanroepen die de regel doet — zodat je later elk segment aan
  de functie die het aanroept kunt koppelen (een edge in de call-graph). Een regel
  wordt gesplitst op `->`, `.` en `;` (`segmentCalls`; de `;` blijft aan zijn
  aanroep vast): `$order->customer()->name();` wordt `$order` / `->customer()` /
  `->name();`. De `.`-grens is er vooral voor
  Vue/JS property-access (`order.customer.name`), naast PHP-concatenatie. De gekozen
  segment-tekens krijgen een **smalle underline** in dezelfde indigo (`#6366f1`,
  `UNDERLINE_CLS`) als de inset-linkerbalk van de actieve rij.

**Alleen nieuwe/aangepaste regels zijn selecteerbaar op de fijnere niveaus, maar
op `'call'` loop je door de héle regel.** `'line'` navigeert enkel langs de
**nieuwe kant** (het rechter/`ins`-paneel) en slaat een pure verwijdering over.
`'call'` splitst de **hele** nieuwe regel in segmenten — **élk** segment is
landbaar, gewijzigd of niet (later hangt daar een relatie aan), niet alleen het
diff-stuk. Eén uitzondering: een **verwijderde** regel zonder vervanging blijft
óók landbaar — als één leeg nieuw-segment (niets rechts) met de hele oude regel
onderstreept op de oude kant, zodat je erop kunt landen als een lege rechter-regel
die markeert wat weg is. (`'group'` blijft een hele run inclusief verwijderde
regels, zodat het instappen en de connector-flow onveranderd blijven.)

Alle diff-navigatie loopt via `unitsFor(rows, gran)` (nu geëxporteerd uit
`Block.mjs`, gedeeld met de footer) → `unitsOf(b)`; `state.change`
indexeert de units van het **huidige** niveau. Bij een niveauwissel her-ankert
`setGran` de selectie op de unit die de huidige rij dekt (`unitAtRow`): `f` vanaf
een groep landt op zijn eerste regel, `f` vanaf een regel op zijn eerste
call-segment, en `s`/`d` lopen langs dezelfde rijen terug omhoog.

De drie navigatietoetsen (`fKey`/`dKey`/`sKey` in `home.mjs`):

- **`f`** — inzoomen. Vanuit `'list'` stapt hij eerst de diff in (`enterDiff`, dat
  `gran` naar `'group'` reset). In de diff verfijnt hij één niveau
  (`group → line → call`); staat hij al op **`'call'`**, dan stapt hij i.p.v.
  verder in te zoomen naar de **volgende call** (`nextChange` — dezelfde flow als
  `↓`, dus doorstromend naar de eerste call van het volgende **same-file** block).
- **`d`** — terug. Op **`'call'`** stapt hij naar de **vorige call** (`prevChange`,
  doorstromend naar het vorige same-file block, net als `↑`); sta je op de
  **allereerste** call zónder vorige om naartoe te stromen, dan zoomt hij terug uit
  naar `'line'`. Op de grovere niveaus zoomt `d` gewoon één stap uit.
- **`s`** — altijd één niveau uitzoomen (`call → line → group`), geklemd op
  `'group'`. Anders dan `d` gaat `s` op `'call'` nooit langs vorige calls maar
  direct terug naar `'line'`, zodat je betrouwbaar uit de call-selectie ontsnapt.

`d`/`s` doen niets in `'list'`-mode (er is dan niets om uit te zoomen); alleen `f`
stapt van daaruit in. `nextChange`/`prevChange` worden gedeeld met `↑`/`↓`, zodat
pijlen en `f`/`d` de diff identiek doorlopen. Verfijn je een groep die precies
**één regel** beslaat (`cur.end === cur.start`), dan slaat `f` het `'line'`-niveau
over en springt direct naar `'call'` (er is dan geen zinvolle line-stap: de regel
ís de groep); `s`/`d` lopen wél stap-voor-stap terug (`call → line → group`). De
call-underline
rijdt mee op de bestaande char-diff: `paneHTML` geeft de underline-set van het
actieve segment door aan `highlightChanges`, dat samen met de bestaande
achtergrond-markering via `markChars` (per-teken class-functie, opvolger van
`wrapChangedChars`) in één pass gerenderd wordt. Een lege toegevoegde regel heeft
geen tekens en dus geen underline (correct: niets te markeren).

### Footer: inline preview van de geselecteerde regel

Onder de panels zit een vaste footer (`src/Footer.mjs`, `data-testid=footer`, de
panels reserveren er 100px voor). Zodra de **geselecteerde unit precies één regel**
beslaat toont hij die regel als inline diff (`- oud` / `+ nieuw`,
Prism-highlighted). De footer volgt het **huidige granulariteitsniveau** via
dezelfde `unitsFor(rows, state.gran)` als de navigatie (in `'list'`-mode de eerste
groep, in `'diff'`-mode `state.change`): omdat een `'line'`- of `'call'`-unit
altijd één rij is, verschijnt de regel dus **altijd** in de footer zodra je met
`f` tot één regel (of één edit) verfijnt. Meer-regelige selecties (b.v. een brede
groep) geven `null` → geen inline diff. Lange regels (>`WIDE_AT` tekens) laten de
`max-w` los zodat de footer de volle breedte gebruikt. Op `'call'`-niveau
onderstreept de footer het **actieve segment** in dezelfde indigo als de panes:
`activeUnit` geeft de `left`/`right`-underline-sets van de unit mee aan `line()`,
dat via het geëxporteerde `markChars` + `UNDERLINE_CLS` (uit `Block.mjs`) precies
die tekens onderstreept (op `'group'`/`'line'` hebben de units geen set → geen
underline).

## Detail-layout & gerelateerd paneel (placeholder)

Rechts van de sidebar staat de `DetailPanel` (`home.mjs`): een `<main>` als
**flex-row** met twee kolommen. Links de **block-kolom** (`data-testid=
block-column`, `flex-1`) met de kaart van het geselecteerde block plus de
look-ahead-preview van het volgende block (dashed connector als ze uit hetzelfde
bestand komen). Rechts, náást het geselecteerde block, een vaste kolom van 384px
(`w-96`): `RelatedPanel` (`src/RelatedPanel.mjs`, `data-testid=related-panel`).

`RelatedPanel` is **puur placeholder met dummy data** — nog geen `/api`-koppeling.
Twee gestapelde kaarten:

- **Gerelateerde code** (boven, `data-testid=related-code`): de onderliggende
  functies die het block aanroept, elk als kleine Prism-highlighted PHP-excerpt
  (`data-testid=related-item`). Voedt later uit de `edges`-tabel (de call-graph).
- **Taken + chat** (onder, `data-testid=tasks`): een **flex-row**. Links een
  takenlijst (`data-testid=task-list`, rijen met `data-testid=task-row`). Elke
  rij is twee-regelig: een status-dot + **titel** en daaronder een **note-label**
  (`data-testid=task-note`) met wat er als laatst gebeurde of wat er nu van de
  reviewer verwacht wordt (b.v. "Claude wacht op je antwoord"); later afgeleid uit
  de thread. Het note-label mag tot **3 regels** beslaan (`line-clamp-3`) en de
  rij groeit met zijn tekst mee, daarna wordt de omschrijving afgekapt. Boven de
  takenlijst staat als **eerste item** een gestippelde **"+ Nieuwe taak"**-knop
  (`data-testid=new-task`) om een nieuwe review-taak te starten — placeholder, nog
  niet gekoppeld. De geselecteerde rij is gehighlight (indigo ring). Rechts de
  **chat** van de gekozen taak (`data-testid=chat`): de taaktitel als kop, dummy
  bubbles (`data-testid=chat-bubble`, rechts = reviewer, links = claude) en een
  **uitgeschakelde** composer onderaan. De chat hoort dus bij een taak — klik een
  andere taak en de thread wisselt. De selectie leeft in een gedeelde `reactive`
  (`ui.task`), niet in de URL; `home.mjs` bezit die en geeft 'm aan `RelatedPanel`
  door zodat **`Enter`** (zie Toetsenbord-navigatie) de bovenste taak kan
  selecteren. Koppelt later aan echte work-items + de `/api/claude`-bridge (één
  thread per taak).

De block-kaart heeft `max-w-full` dus hij krimpt om ruimte te maken voor het
paneel; in `'diff'`-mode (`left-6`) vult de block-kolom de resterende breedte
i.p.v. de vaste 76rem.

## URL-state (refresh-restore & deep-links)

De navigatie-positie leeft in de **query-string** zodat een refresh of gedeelde
link precies terugkomt waar je was. `src/urlState.mjs` biedt `bindUrlState(state,
fields, { ns })`: het herstelt bij load de opgegeven keys uit de URL naar de
reactive `state` en schrijft daarna elke wijziging terug via
`history.replaceState` (een arrow.js `watch`, dus geen history-spam). `home.mjs`
bindt de hoofd-navigatie (`pr`→`pr`, `selected`→`sel`, `mode`, `change`→`chg`,
`gran`→`gran`); een `default`-waarde wordt uit de URL weggelaten zodat die
kort/canoniek blijft (dus `gran` verschijnt alleen bij `line`/`call`, niet bij de
default `group`).
Elk **extra venster/paneel** krijgt een eigen `ns` (b.v. `{ ns: 'diff' }` →
`?..&diff.file=..`) zodat zijn params náást de hoofd-navigatie in dezelfde URL
staan zonder te botsen. Herstelde waarden die door async-load buiten bereik
vallen worden geclamped (`loadBlocks` clamp't `selected`, `ensureCode` clamp't
`change` en valt terug naar `mode:'list'` bij een block zonder wijzigingen). Zie
skill `url-state`.

## Tembed: durable workflows (`tembed/`)

`tembed/` is een **embeddable durable-workflow engine** — "Temporal, maar een Go-
package". Het staat als **git subtree** (prefix `tembed/`) in deze repo en is
tegelijk zijn eigen module (`github.com/reindert-vetter/tembed`), zodat andere
projecten het los kunnen inladen. **`tembed/` is bewust abstract** — het weet
niets van PR's, blocks of gh; hou het zo.

- **Subtree-flow:** binnenhalen met `git subtree add --prefix=tembed
  https://github.com/reindert-vetter/tembed main --squash`; wijzigingen
  terugduwen naar de tembed-repo met `git subtree push --prefix=tembed <url>
  main`, updates ophalen met `git subtree pull`. slash importeert het via een
  `replace github.com/reindert-vetter/tembed => ./tembed` in `go.mod`.
- **Kern (event-sourcing + replay):** elke run heeft een append-only
  event-history; de engine draait de workflow-functie telkens **vanaf het begin**
  opnieuw tegen die history. Een `ExecuteActivity` waarvan het resultaat al in de
  history staat geeft de opgeslagen waarde terug (activity draait dus **één keer**),
  anders draait de activity nú en wordt het resultaat weggeschreven. Een
  `WaitSignal` die zijn signaal nog niet heeft **yield't** (interne panic-
  sentinel), wordt als `waiting` gepersisteerd en opnieuw gedreven zodra het
  signaal/timer binnenkomt. **Workflow-code moet deterministisch zijn** — alle
  non-determinisme via het `*Workflow`-handle (`ExecuteActivity`, `WaitSignal`,
  `Sleep`, `SideEffect`, `Now`).
- **Signals** zijn gebufferd: een signaal dat vóór de `WaitSignal` aankomt wacht
  tot de workflow erom vraagt. **Timers** (`Sleep`) zijn durable (absolute
  fire-time in de history, herpland bij `Recover`).
- **Opslag** via de `Store`-interface: `MemoryStore` (tests), `JSONLStore` (één
  leesbaar bestand per run), `SQLiteStore` (pure-Go `modernc.org/sqlite`, geen
  cgo) en `MultiStore` om te combineren (SQLite voor queries + JSONL als
  audit-trail). Enige runtime-dependency is `modernc.org/sqlite`.
- **Recovery:** `engine.Recover()` bij startup dry-vt elke `running`/`waiting`
  run opnieuw (herplant timers, her-blokkeert op signals).
- **Tests:** `tembed/*_test.go` (activity-replay, signals, buffered signal,
  durable timer, activity-failure, SQLite+JSONL combinatie).

### De eerste slash-task: review-comment workflow (`review.go`)

De eerste concrete taak draait op tembed: **commentaar geven op een regel code**,
dan de thread levend houden. `review.go` (package main) registreert de
`reviewComment`-workflow + activities `postLineComment`/`replyComment` op een
engine en draait een **poller** die GitHub op replies pollt en elke nieuwe reply
als `reply`-**signaal** aan de workflow levert; de workflow antwoordt met een
extra comment tot de reviewer de thread sluit (`Done`/`/resolve`). Omdat het op
tembed loopt overleeft het gesprek een herstart: de root-comment wordt nooit
opnieuw geplaatst.

- `GitHubReviewer`-interface abstraheert gh (`PostLineComment`/`Reply`/
  `FetchReplies`); `ghReviewer` shelt uit naar `gh api`, de test gebruikt een
  fake. `NewReviewManager(engine, gh, interval)` bedraadt alles;
  `StartReview(ctx, in)` plaatst de comment (synchroon in `StartWorkflow`) en
  start de poller. `newReviewEngine(dataDir)` bouwt een engine op een
  `MultiStore(SQLite data/tembed.db, JSONL data/tembed/)`.
- Tests: `review_test.go` (volledige poll→signal→reply-lus met fake gh, plus een
  restart-durability-test).

## Conventies (ingevuld door dit scaffold — corrigeer waar nodig)

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
- **Syntax-highlighting:** Prism 1.29.0 staat gevendord als één ES-module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php, met
  `window.Prism={manual:true}` zodat het niet de hele pagina auto-highlightt). De
  code-panes in `Block.mjs` highlighten PHP met `Prism.highlight(...)` en tonen het
  resultaat via de `.innerHTML`-binding. Prism's eigen container-CSS is bewust
  weggelaten; alleen de token-kleuren staan (scoped onder `[data-testid=code-diff]`)
  in de `<style>` van `index.html`.
- Go: `net/http` `ServeMux`, handlers per feature. De `/api/`-bridge shelt uit naar
  `gh`/`claude` via `os/exec` — valideer altijd input voordat je het aan een
  subproces geeft.
- **Code (Go + JS) is Engels** — comments, log-berichten en identifiers. De docs in
  `.claude/` en `CLAUDE.md` blijven Nederlands.

## `.claude/` bijhouden

Deze `.claude/`-map (rules, templates, skills, agents) is onderdeel van het project
en moet **meegroeien**. Komt er een nieuwe regel, conventie of terugkerende taak bij:
werk het bijbehorende bestand bij (of maak een nieuw skill/template/agent aan) in
dezelfde change. Laat conventies niet alleen in een chat achter.
