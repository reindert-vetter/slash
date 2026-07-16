# Pagina's & routing

De app heeft twee pagina's, beide statische HTML-shells zonder build-stap; de
Go-server (`api.go`, `routes`) bepaalt welke shell een route krijgt:

- **`/pr/<id>`** — de review-pagina van één PR (`index.html` → `home.mjs`). De
  PR-id komt uit het **pad**, niet uit de query-string: `home.mjs` leest 'm met
  `prFromPath()` (regex `^/pr/(\d+)`) en zet 'm in `state.pr`. Zonder geldige
  id in het pad doet `home.mjs` een `location.replace('/pr-overview')`.
- **`/pr-overview`** — de **PR-inbox**: een live GitHub-dashboard van PR's die je
  aandacht nodig hebben (`overview.html` → `src/overview.mjs`). Zie de sectie
  **PR-inbox** hieronder. Elke rij opent bij een klik hetzelfde popover-menu; een
  geïngeste PR (`hasGraph`) bereikt `/pr/<id>` via de menu-keuze "Open
  review-boom". De read-only "recent gegenereerd"-lade voedt nog steeds uit
  **`GET /api/prs`** (`handlePRs` → `listPRs`, block/file-counts per PR uit
  `PRSummary`).
- **`/`** redirect (302) naar `/pr-overview`; alle overige paden
  (`/src/*`, `/overview.html`, …) worden statisch geserveerd door de
  `http.FileServer`. De `/pr/`- en `/pr-overview`-routes serveren hun shell via
  `serveFile(staticDir, name)`.

## PR-inbox (`/pr-overview`)

De startpagina is een **GitHub-inbox**, nagebouwd op GitHub's eigen
`github.com/pulls`-dashboard: dezelfde secties en taal ("Ready to merge", "Needs
your review", …), met per rij review-status, CI-checks, reviewers en diff-stats.
Hij is **volledig read-only** in de zin dat hij nooit direct een module/tabel
schrijft (conform `workflows-write-boundary.md`). **Elke rij** — geïngest of
niet — opent bij een klik hetzelfde popover-menu (`prRow`/`popover(pr)` in
`src/overview.mjs`, `@click="${() => togglePopover(pr.number)}"` op de hele
rij, een `role="button"`-`<div>`, geen `<a>`); alleen de **inhoud** van dat menu
verschilt op `pr.hasGraph`:

- **`pr.hasGraph === false`** (nog niet geïngest, `generateAction(pr)`):
  als **eerste** keuze **"Genereer review-boom"** (`data-testid=generate-page`)
  — die start het bestaande **`POST /api/ingest {"pr":N}`**-endpoint (zie
  `.claude/rules/blocks-and-ingest.md`), de sanctioned write-weg (een Workflow
  Execution starten), niet een directe module-write. De knop toont tijdens het
  genereren een spinner + de **echte pipeline-fase** i.p.v. een statische
  tekst — "Werktrees voorbereiden…" / "Blocks scannen…" / "Relaties opbouwen…"
  (`INGEST_STAGE_LABELS`, fallback "Bezig met genereren…" zolang er nog geen
  fase bekend is) — en is dan `disabled` (`ui.ingesting`, tegen een dubbele
  ingest). `generatePage` pollt daarvoor elke 800ms
  **`GET /api/ingest/progress?pr=N`** (`ingest_progress.go`, een puur
  in-memory, ephemere teller die de `prepareWorktrees`/`scanAndStoreBlocks`/
  `buildRelations`-Activities in `workflows.go` bijwerken — geen module/
  read-model, dus binnen de write-boundary-uitzondering voor state-loze pings,
  zie `.claude/rules/workflows-write-boundary.md`) in `ui.ingestStage`.
  Zowel de busy-tekst/-icoon als de `disabled`/`class`-styling hangen aan hun
  **eigen** geneste `${() => …}`-bindings (`ingestBusy`/`ingestLabel`/
  `ingestIcon`) i.p.v. een plain-JS-ternary op een ooit-gecapturede `busy`-
  variabele — anders update de knop niet terwijl de popover al openstaat (zie
  de arrow.js-valkuil in `conventions.md`). `handleIngest` (`api.go`)
  antwoordt pas 200 zodra de ingest-pipeline **en** `EnsureRelations`
  synchroon zijn afgerond, dus `generatePage` doet op succes een simpele volle
  `location.href = '/pr/<n>'`-redirect — de verse paginalaad heeft dan alles al
  nodig. Mislukt het genereren, dan blijft de popover open met de foutmelding
  (`ui.ingestError`, `data-testid=generate-error`) en verandert de rij zelf
  niet (nog steeds `hasGraph:false`).
- **`pr.hasGraph === true`** (al geïngest, `ingestedActions(pr)`): twee
  keuzes — **"Open review-boom"** (`data-testid=open-tree`, navigeert direct
  naar `location.href = '/pr/' + pr.number`) en **"Opnieuw genereren"**
  (`data-testid=regenerate-page`) die dezelfde `generatePage`/`ui.ingesting`/
  `ui.ingestStage`-flow hergebruikt als de niet-geïngeste tak, maar met
  `{ redirect: false }` (`generatePage(pr, { redirect })` — default `true`
  voor de "Genereer"-tak; "Opnieuw genereren" moet **niet** navigeren, de
  reviewer blijft op de overview en wil alleen de achterliggende data
  verversen; `ui.ingesting` gaat zelf terug op `null` op succes). Een
  mislukte regeneratie toont de foutmelding onder de knop, binnen dezelfde
  popover (`data-testid=regenerate-error`).

Onder beide takken staan ongewijzigd *Open op GitHub* / *Open Jira-ticket*.
Omdat er nu nooit meer een `<a href="/pr/<id>">` in de rij zit — de navigatie
naar de tree loopt altijd via de menu-keuze "Open review-boom" — is er ook geen
losse hover-only regenerate-knop (`regenerateButton`) of aparte `data-row`-
wrapper meer nodig; die zijn vervallen (was eerder nodig om een interactief
element niet in een `<a>` te nesten, wat nu niet meer speelt).

### GitHub-toegang loopt via een workflow (niet rechtstreeks)

**De pagina roept GitHub nooit zelf aan.** De PR-lijst wordt gefetcht en beheerd
door het **`pr_inbox`-Workflow** (één Execution per repo, zie
`.claude/rules/tembed-workflows.md`); dat
schrijft de laatste staat in de **`inbox`-module** (een read-model), en de
HTTP-handlers lezen **alleen** dat read-model. Dit is de kanonieke
write-boundary-vorm: alleen een workflow praat met GitHub en muteert state.

- **`pr_inbox`-workflow** (`workflows.go`): een `for`-lus op een `refresh`-**Signal**
  → één `refreshInbox`-**Activity**. De Activity draait `buildInboxSnapshot`
  (fetch + `statusesFor`), slaat het op in de `inbox`-module, en geeft alléén een
  klein `{updatedAt, prs}`-summary terug — de data zelf staat in de module, dus de
  event-history blijft compact ook al refresht de workflow eindeloos.
- **Poller-cadans (heartbeat-gedreven, net als de comment-poller):** `pollInbox`
  stuurt een `refresh`-Signal op de **snelle** cadans (`pollInterval`, 1 min)
  zolang er binnen `heartbeatWindow` een heartbeat kwam, anders op de **trage**
  cadans (`idlePollInterval`, 10 min). Bij startup stuurt `EnsureInbox` één
  **synchrone** refresh, zodat het read-model gevuld is vóór de server serveert;
  na herstart hergebruikt `EnsureInbox` de bestaande Execution (`findInboxRun`).
- **De UI drijft de cadans:** bij laden stuurt `overview.mjs` een `refresh`-Signal
  (`POST /api/workflows/{runID}/signals/refresh`) zodat de workflow meteen opnieuw
  checkt, plus een **heartbeat** (`POST …/heartbeat`) — maar **alleen als het
  tabblad zichtbaar én gefocust is** (`activeTab()`), zodat een geparkeerd tabblad
  vanzelf naar de trage cadans zakt. Daarna pollt de UI het read-model periodiek
  (`reloadSnapshot`) om de nieuwste snapshot te tonen. De heartbeat mutert geen
  durable state (alleen in-memory poll-timing) en valt dus buiten de
  write-boundary — precies zoals bij de comments.

De GitHub-fetch zelf (`inbox.go`): `gh api graphql`-`search`-calls (géén nieuwe
dependency). `lightFields` tekent de rij, `heavyFields` (`mergeable
reviewDecision`, `reviewRequests`, `latestReviews`, `statusCheckRollup`) vult de
pills. `hasGraph` wordt overlayd uit de `blocks`-tabel (`ingestedSet`).
`inboxSections` spiegelen `/pulls` (qualifiers 1-op-1 uit dash' `INBOX_SECTIONS`,
incl. `archived:false`, de copilot-query en de **COMMENTED-catch** `keep`-filter);
queries draaien parallel en worden deterministisch hersamengesteld.
`mergeReviewers` en `statusesFor` (één aliased call) zoals voorheen.

**Endpoints:**

| Endpoint | Doet |
|---|---|
| `GET /api/inbox` | Leest het read-model → `{ok,live,repo,generatedFor,updatedAt,runId,sections}`. `runId` = het `pr_inbox`-Run ID (voor refresh/heartbeat). Nog geen snapshot → `{ok:false}`. |
| `GET /api/inbox/status?prs=12,13` | De pills, óók uit het read-model-snapshot (géén GitHub-call). |
| `POST /api/workflows/{runID}/signals/refresh` | Refresh-Signal (UI bij laden). Start alleen de fetch-Activity. |
| `POST /api/workflows/{runID}/heartbeat` | Operationele ping (poll-cadans), geen state-write. |
| `GET /api/prs/search?q=…` | **Nog wél een directe** live gh-`search` (`inbox_api.go`) — een ephemere, geparametriseerde read, geen persistente lijst. Kaal getal → `<n> in:title`. |
| `GET /api/prs` | (bestaand) geïngeste PR's + counts, voor de recent-lade. |

### Offline / test-modus

Onder **`SLASH_GITHUB=off`** raakt niets het netwerk: `buildInboxSnapshot` (de
Activity) serveert de **fixture** uit `SLASH_INBOX` (`tests/fixtures/inbox.json`,
shape `{repo,generatedFor,sections,statuses}`). Bij startup vult de synchrone
refresh het read-model, dus `GET /api/inbox` heeft meteen data (geen race in
tests). `hasGraph` komt uit de DB, dus de geseedde PR (12903) toont in zijn
popover "Open review-boom" naar `/pr/12903`. Faalt de eerste fetch (geen
fixture, geen snapshot) → `/api/inbox` `{ok:false}` → client valt terug op
`GET /data/inbox.json` (label "cached").

### Client (`src/overview.mjs`, arrow.js, dark-zinc, Nederlands)

Twee-fasen render via een reactieve `state.statuses` (skeleton → pills, geen
layout-shift). Features: gesecteerde lijst, debounced zoeken (aparte
resultaten-regio, sequence-guard), **stacks** (PR wiens `baseRefName` = een
in-view PR's `headRefName` → ingesprongen groep bovenaan), reviewer-avatars,
review/CI-chips, "recent gegenereerd"-lade (lazy `GET /api/prs`), en
toetsenbord-nav (↑/↓/Home/End/Enter/`/`/→, met de hover-vs-keyboard-flag zodat
`scrollIntoView` de selectie niet kaapt). UI-proza is Nederlands; de
GitHub-sectietitels blijven Engels.

**De hover-vs-keyboard-flag (`hoverEnabled`) gate't op een échte
cursor-positieverandering, niet op het `mousemove`-event zelf.** Elke
toetsenbordstap (`move`/`moveTo` in `overview.mjs`) zet `hoverEnabled = false`
vóór `paintSelection()` — die roept altijd `scrollIntoView` aan — juist om te
voorkomen dat de daaropvolgende scroll een `mouseenter` triggert die de
keyboard-selectie kaapt. Browsers (Chromium met naam) synthetiseren echter een
`mousemove`-DOM-event op de **ongewijzigde** cursor-positie om `:hover` na
zo'n scroll/layout-verandering te resyncen — een kale
`addEventListener('mousemove', () => hoverEnabled = true)` kan dat niet van een
echte muisbeweging onderscheiden en zette de flag dus meteen weer aan,
waarna de rij die toevallig onder de stilstaande cursor lag de selectie
terugtrok (het gerapporteerde "de PR-items schuiven mee" tijdens
pijltjestoets-navigatie). De listener bewaart daarom de laatst gezien
`clientX`/`clientY` en zet `hoverEnabled` alleen aan bij een echte delta.
Getest in `tests/overview-hover-gate.spec.mjs`: dat dispatcht zelf
`mousemove`/`mouseenter`-DOM-events (het browser-native scroll-getriggerde
geval bleek niet deterministisch op te wekken onder Playwright, zie ook de
`selectRowByKeyboard`-notitie in `overview.spec.mjs`) om de gate zelf te
bewijzen: zelfde coördinaten kapen de selectie nooit, een echte
positie-delta doet dat weer normaal.

**Zodra een popover open is, bezit hij het toetsenbord — de lijst-navigatie
hierboven is opgeschort.** `togglePopover` focust bij het openen (via
`requestAnimationFrame`, na de arrow.js-paint) het **eerste** item in de menu
(`focusPopoverItem(0)`); `kbHandler` vertakt als **allereerste** check op
`ui.openPopover != null` naar `handlePopoverKey(e)` — vóór zelfs de
`/`-zoekbox-shortcut — zodat geen enkele toets nog bij `move`/`moveTo`/
`activateSelected` terechtkomt zolang het menu open is. In die vertakking: `↑`/`↓`
cyclen (met wrap-around aan beide uiteinden) door de menu's eigen
`<button>`/`<a href>`-items (`movePopover`, focus-gebaseerd — geen aparte
selectie-state, de browser's eigen `:focus` is de bron van waarheid), `Enter`/
`Space` laat de **native** knop-/link-activatie op het gefocuste element lopen
(bewust géén `preventDefault` — precies hetzelfde gedrag als een muisklik op
dat item), `Escape` sluit het menu (`closePopover`, ook hergebruikt door de
bestaande klik-buiten-de-popover-sluit-listener), en `←`/`→`/`Home`/`End`/`/`
worden geslikt (`preventDefault`, geen actie) zodat ze niet doorlekken naar de
rij-lijst; elke andere toets (met name `Tab`) blijft ongemoeid.
