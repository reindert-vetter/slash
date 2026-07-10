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
  regelhoogte, dus ze lijnen vanzelf verticaal uit.

## Toetsenbord-navigatie (twee modes)

De keyboard-flow zit in `home.mjs` (`onKeydown`) en heeft twee modes via
`state.mode`:

- **`'list'`** (start): `↑`/`↓` kiezen een block in de sidebar, `→` stapt de diff
  van het geselecteerde block in.
- **`'diff'`**: `↑`/`↓` lopen door de **wijzigingen** van dat block, `←` stapt
  terug naar de lijst.

Bij het instappen (`→`) springt de selectie naar de **eerste gewijzigde regel**
(toegevoegd, verwijderd of gewijzigd) — `state.change` is de index. De
navigatie-eenheden komen uit `changeGroups(rows)` in `Block.mjs`: opeenvolgende
gewijzigde rijen (del/ins) tellen als **één** groep, maar een run langer dan 5
rijen wordt in stukken van 5 opgeknipt (`MAX_GROUP`). `blockRows(b)` levert exact
dezelfde aligned rijen als de render, zodat navigatie en highlight nooit
uiteenlopen. Het geselecteerde block krijgt de actieve groep als een reactieve
`activeGroup`-functie mee (leest `state.mode/selected/change`), zodat de pane
her-highlight zonder dat de hele `DetailPanel` opnieuw rendert. De actieve rijen
krijgen een fellere tint + een inset-linkerbalk (`shadow-[inset_3px_0_0_…]`, geen
layout-shift) en de eerste rij een `data-change-active`-anchor; `home.mjs`
scrollt die met `scrollIntoView({block:'center'})` naar het midden van de
diff-viewport.

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
