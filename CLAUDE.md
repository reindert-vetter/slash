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

## Onderwerpen (diepere uitleg in `.claude/rules/`)

Dit bestand wordt altijd volledig in context geladen; de rest van de architectuur
staat daarom in losse referentiebestanden onder `.claude/rules/` die alleen
geladen worden als het onderwerp relevant is. Werk dáár de details bij, niet hier.

- **Blocks & ingest** — een PR wordt omgezet in **blocks** (functie/method-niveau)
  met granulaire reviewer-approval (block/groep/regel/call) en een
  worktree-gebaseerde ingest-pipeline (`gh` → `git diff` → PHP-scanner →
  classificeren → SQLite). Zie `.claude/rules/blocks-and-ingest.md`.
- **Toetsenbord-navigatie** — command-palette (`Enter`), PR-breed menu (`/`),
  list/diff-modes en selectie-granulariteit (`f`/`d`/`s`, groep/regel/call), plus
  de footer-inline-preview. Zie `.claude/rules/keyboard-navigation.md`.
- **Detail-layout & gerelateerd paneel** — de kolom-layout naast de sidebar
  (block-kaart + `RelatedPanel` met onderliggende code en taken/chat-placeholder).
  Zie `.claude/rules/detail-layout.md`.
- **Pagina's, routing & PR-inbox** — de twee statische shells (`/pr/<id>`,
  `/pr-overview`) en de read-only GitHub-inbox die via het `pr_inbox`-workflow
  loopt. Zie `.claude/rules/pages-and-routing.md`.
- **Tembed: durable workflows** — de embeddable workflow-engine (`tembed/`), de
  write-boundary-regel, en de concrete workflows (`task_code_comment`,
  `pr_status`, `pr_inbox`, `build_relations`, `resolve_call` — die resolvt
  methode-aanroepen naar hun definitie, Go-statisch met LLM-fallback —, en
  `approve` die reviewer-goedkeuring durable persisteert). Zie
  `.claude/rules/tembed-workflows.md` en de harde regels
  `.claude/rules/workflow-determinism.md` /
  `.claude/rules/workflows-write-boundary.md`.
- **Conventies** — bestandsnaam-conventies, arrow.js-valkuilen, Prism-vendoring,
  Go-conventies, taalkeuze. Zie `.claude/rules/conventions.md`.

## URL-state (refresh-restore & deep-links)

De navigatie-positie leeft in de **query-string** zodat een refresh of gedeelde
link precies terugkomt waar je was. `src/urlState.mjs` biedt `bindUrlState(state,
fields, { ns })`: het herstelt bij load de opgegeven keys uit de URL naar de
reactive `state` en schrijft daarna elke wijziging terug via
`history.replaceState` (een arrow.js `watch`, dus geen history-spam). `home.mjs`
bindt de hoofd-navigatie (`selected`→`sel`, `mode`, `change`→`chg`,
`gran`→`gran`); de **PR zit in het pad** (`/pr/<id>`, zie
`.claude/rules/pages-and-routing.md`), niet in de query. Een `default`-waarde
wordt uit de URL weggelaten zodat die kort/canoniek blijft (dus `gran` verschijnt
alleen bij `line`/`call`, niet bij de default `group`).
Elk **extra venster/paneel** krijgt een eigen `ns` zodat zijn params náást de
hoofd-navigatie in dezelfde URL staan zonder te botsen. Het `RelatedPanel` gebruikt
dit echt: `bindUrlState(cs, …, { ns: 'rel' })` bindt de **paneel-cursor**
(`focus`→`rel.foc`, `codeSel`→`rel.code`, `sel`→`rel.csel`, `threadPos`→`rel.thr`)
zodat een refresh je terugzet op hetzelfde Onderliggende-code-kind / dezelfde
comment-thread. Herstelde waarden die door async-load buiten bereik vallen worden
geclamped (`loadBlocks` clamp't `selected`, `ensureCode` clamp't `change` en valt
terug naar `mode:'list'` bij een block zonder wijzigingen; de paneel-cursor wordt
ná de data-push één keer opnieuw toegepast, zie `RelatedPanel.applyRelRestore`).
Zie skill `url-state`.

## Klaar met een taak

Ben je klaar met een taak, **vraag dan of je**:

1. de wijzigingen moet **committen**,
2. de branch moet **mergen in `main`**, en
3. de **worktree moet opruimen**.

Voer deze stappen niet ongevraagd uit — vraag het eerst, en pas als hij ja zegt
commit → merge → ruim de worktree op. We werken in een git-worktree (een geïsoleerde
kopie), dus opruimen hoort bij het afronden.

## `.claude/` bijhouden

Deze `.claude/`-map (rules, templates, skills, agents) is onderdeel van het project
en moet **meegroeien**. Komt er een nieuwe regel, conventie, architectuur-uitleg
of terugkerende taak bij: werk het bijbehorende bestand onder `.claude/rules/`
(harde regels én beschrijvende architectuur-referenties leven daar samen) bij, of
maak een nieuw skill/template/agent aan, in dezelfde change. Laat conventies niet
alleen in een chat achter.
