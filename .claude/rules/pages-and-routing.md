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

Onder beide takken staan ongewijzigd *Open op GitHub* / *Open Jira-ticket*,
gevolgd door **"Kopieer GitHub URL"** (`data-testid=copy-url`,
`navigator.clipboard.writeText(pr.url)` met korte "Gekopieerd!"-feedback via de
efemere `ui.copiedFor`) en de **ignore-sectie** (zie hieronder).
Omdat er nu nooit meer een `<a href="/pr/<id>">` in de rij zit — de navigatie
naar de tree loopt altijd via de menu-keuze "Open review-boom" — is er ook geen
losse hover-only regenerate-knop (`regenerateButton`) of aparte `data-row`-
wrapper meer nodig; die zijn vervallen (was eerder nodig om een interactief
element niet in een `<a>` te nesten, wat nu niet meer speelt).

### Filter-drawer (voor-ingestelde filters, live gh-search)

Naast "Recent gegenereerd" staat een tweede uitklapknop **"Filters"**
(`filterDrawer`, `data-testid=filter-drawer`, mal van `recentDrawer` —
`state.filterOpen` toggelt, keyed-array-slot met eigen key per tak
`filter:closed`/`filter:open`, conform de single↔array-valkuil in
`conventions.md`). Uitgeklapt toont hij een menu met **vier preset-filters** +
**"Toon alle verborgen pull requests"** (`data-testid=show-hidden`). Elke preset
draait een **live gh-search** via `GET /api/prs/filter?preset=<key>`
(`runPreset` → `state.presetResults`/`state.activePreset`, sequence-guard zoals
`runSearch`); de resultaten **vervangen tijdelijk de hoofdsecties**
(`currentView` in `overview.mjs` routeert: query > verborgen > preset > inbox),
met een "← Terug naar inbox"-balk (`data-testid=back-to-inbox`, `clearPresetView`).

De queries zijn **server-side allow-listed** (`filterPresets` in `inbox_api.go`)
— de UI stuurt alleen een vaste `key`, nooit rauwe zoektekst naar gh
(`exec`-input-validatie). De vier keys: `updated-oud`
(`sort:created-asc`, oud eerst), `alle-open`, `alle-draft`, en **`ouder-3-dagen`**
— die laatste laat `handleFilter` de datumgrens **dynamisch** berekenen
(`created:<{vandaag−3d}`, `YYYY-MM-DD`; een read-handler, dus `time.Now()` is hier
toegestaan — de determinisme-regel geldt alleen in workflow-bodies).
`searchPRsExpr`/`runPRSearch` (`inbox.go`) prependen `repo:<slug>` maar
respecteren de eigen `sort:`/`draft:` van de preset (anders dan `searchPRs`, dat
altijd `sort:updated-desc` appendt). De `ouder-3-dagen`-resultaten worden
frontend-side **gegroepeerd per auteur** (`authorGroups`/`authorGroupBlock`,
`data-testid=author-group`); de andere drie zijn een platte lijst. Offline
(`SLASH_GITHUB=off`) honoreert `handleFilter` alleen de `draft:`-qualifier van de
fixture-rijen. Test: `tests/overview-filter-presets.spec.mjs`.

### Ignore / verbergen uit de inbox

Een PR kun je vanuit de per-rij popover **negeren** ("Negeer PR", een divider met
één knop per termijn: **Altijd / Morgen 08:00 / Volgende week maandag 08:00 /
7 dagen / 14 dagen**, `data-testid=ignore-<kind>`). `ignoreUntil(kind)` rekent de
**absolute vervaltimestamp** uit in browser-lokale tijd ("altijd" = `0`) en
`ignorePr` stuurt 'm als `IgnoreSignal{pr, until}` naar de per-repo
`ignore`-tracker (`POST /api/workflows/<ignoreRunId>/signals/ignore`, de sanctioned
write-weg — zie `.claude/rules/tembed-workflows.md`). De UI update `state.ignores`
**optimistisch** (wholesale-reassign, dus de rij verdwijnt meteen) en verzoent op
de volgende `reloadIgnores`. Een reeds-genegeerde PR toont in plaats van de
termijnen één **"Niet meer negeren"**-knop (`unignorePr` → `clear:true` → de
workflow doet `Set(..., -1)`, een DELETE).

Verbergen is **client-side op leestijd** (`isIgnored(n)` = `until === 0 ||
until > Date.now()`): `mainContent` (secties + stacks) filtert genegeerde PR's
weg; presets/zoekresultaten blijven bewust ongefilterd (expliciete views). Het
menu-item **"Toon alle verborgen pull requests"** opent de `hiddenBlock`-view
(`data-testid=hidden-view`): één rij per geldige (niet-verlopen) ignore met de
titel uit de al-geladen inbox-data (of een minimale `#nummer`-rij voor een PR die
uit de inbox-query viel), een **"genegeerd tot \<datum\>"**-noot
(`formatIgnoreUntil`, `until 0` → "altijd") en een un-ignore-knop
(`data-testid=hidden-unignore`). `state.ignores` wordt bij load gevuld door
`loadIgnore` (`POST /api/workflows/ignore` → `runId`, dan `GET /api/ignore`);
`state.ignoreRunId`/`state.ignores`/`state.filterOpen`/`state.activePreset`/
`state.showHidden` leven **buiten** de URL (efemer, mirror van
`ui.openPopover`/`recentOpen`). Test: `tests/overview-ignore.spec.mjs`.

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
| `GET /api/prs/filter?preset=<key>` | Live gh-`search` voor een **vaste, allow-listed** preset-query (`filterPresets` in `inbox_api.go`) — nooit rauwe UI-tekst naar gh (`exec`-input-validatie). Zie "Filter-drawer" hieronder. |
| `POST /api/workflows/ignore` | Ensure de per-repo `ignore`-tracker → `{runId}` (de UI signalt ignore/un-ignore daaraan). Zie `.claude/rules/tembed-workflows.md`. |
| `GET /api/ignore` | Read-only ignore-read-model → `{ok,ignores:[{pr,until}]}`. Verval-check gebeurt client-side op leestijd. |
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

### `?pr=<id>` auto-selecteert de rij waar je vandaan komt

Vanuit `/pr/<id>` linken zowel de **`←`-nav-chain-exit** (stop 1,
`state.showDescription`, zie `.claude/rules/keyboard-navigation.md`) als het
**`/`-menu-item "Naar PR-overzicht"** (`PR_COMMANDS` in `home.mjs`) naar
`/pr-overview?pr=<state.pr>` — niet naar de kale `/pr-overview`. `overview.mjs`
leest die param **eenmalig** bij module-load
(`new URLSearchParams(location.search).get('pr')` → `pendingSelectPr`, mirror
van `home.mjs`'s `prFromPath()` — geen `bindUrlState`, dit is een
eenrichtings-consume-bij-load, geen navigatiepositie die teruggeschreven moet
worden) en past 'm toe zodra de data er is, via **`trySelectPendingPr()`**,
aangeroepen aan het eind van zowel `applyLive` als `applyCached` (mirror van
`applyRelRestore`/`applyBlockRefRestore`'s restore-dan-clear-patroon):

- Staat de PR in `state.sections` (de hoofd-lijst) → zet de module-level
  `selKey` op `'row:' + pr` (dezelfde identiteit als `paintSelection`/
  `reanchorSelection` al gebruiken, zie hierboven) en `pendingSelectPr = null`.
  De bestaande `sections.length`-watch triggert vanzelf de eerstvolgende
  `scheduleRepaint()`, die de ring zet + scrollt.
- Staat de PR daar **niet** in, dan wordt de "Recent gegenereerd"-lade
  gecheckt: `ensureRecentPrs()` (dezelfde `GET /api/prs`-fetch als
  `toggleRecent()` — nu een gedeelde helper, met dezelfde
  `recentLoading`-guard) haalt de lijst op; staat de PR daarin, dan
  `state.recentOpen = true` (de lade klapt vanzelf open) + `selKey =
  'recent:' + pr`. Ook hier trekt de bestaande `recentOpen`/`recentPrs.length`-
  watch de repaint.
- Staat de PR **nergens** (gemerged/uit de inbox-query gevallen, of nooit
  geïngest) → stille no-op, net als een niet-gevonden `sel`-restore op
  `/pr/<id>`. `pendingSelectPr` wordt **hoe dan ook** eenmalig gecleared na de
  recent-check, ongeacht de uitkomst — een latere achtergrond-reload
  (`reloadSnapshot`, elke 60s) mag de selectie niet opnieuw forceren.
- `hoverEnabled = false` wordt meegezet (zoals `move`/`moveTo` al doen) zodat
  een toevallige muis-hover de auto-selectie niet meteen overschrijft.
- De `?pr=`-param wordt bewust **niet** opgeschoond (geen
  `history.replaceState`) — harmless bij een refresh, die selecteert dan
  gewoon dezelfde PR opnieuw.

Test: `tests/overview-pr-select.spec.mjs` (in-sections, alleen-in-de-lade, en
de stille no-op).

### `?sel=` reist mee in dezelfde round-trip: dezelfde block blijft geselecteerd

Naast `?pr=` (welke **rij** in de overview selecteren) draagt dezelfde
round-trip ook `?sel=<file:line>` mee — welk **block** je moet terugkrijgen
zodra je vanuit de overview weer de review-boom instapt. Dit is een pure
extensie van het bestaande `sel`-mechanisme (`bindUrlState`/`state.blockRef`/
`applyBlockRefRestore`, zie de URL-state-sectie in `CLAUDE.md`) — geen nieuw
opslagmechanisme, geen localStorage: `sel` was al de canonieke, deelbare
navigatiepositie voor een refresh/gedeelde link, dit hergebruikt 'm simpelweg
over de heen-en-terug-reis via `/pr-overview`.

- **Uitgaand (`home.mjs`):** `overviewExitUrl()` bouwt de bestemming voor
  **beide** exits naar `/pr-overview` (de `←`-nav-chain-exit op stop 1, en het
  `/`-menu-item "Naar PR-overzicht") — `/pr-overview?pr=<state.pr>`, plus
  `&sel=<encodeURIComponent(state.blockRef)>` zodra er een selectie is
  (`state.blockRef` leeg → geen `sel`-param, bv. vlak na laden).
- **Ingaand (`overview.mjs`):** twee **niet-genulde** module-`let`s,
  `originPr`/`originSel`, lezen `pr`/`sel` **eenmalig** bij load — bewust
  **los** van het bestaande, one-shot `pendingSelectPr` (die wordt binnen
  milliseconden na load al gecleard zodra de rij gevonden/niet-gevonden is;
  `originPr`/`originSel` moeten daarentegen blijven leven tot de reviewer
  minuten later daadwerkelijk terug de boom in klikt). `treeUrl(pr)` — gebruikt
  door **alle drie** de navigatiepunten naar `/pr/<n>` (`generatePage`'s
  redirect na een geslaagde (re)ingest, "Open review-boom", en de
  `→`-forward-nav in `openOrGenerate`) — voegt `?sel=<originSel>` alleen toe
  als `pr.number === originPr`: klik je in de overview op een **andere** PR dan
  waar je vandaan kwam, dan krijgt die nooit een sel van een niet-gerelateerde
  PR mee.
- **Block niet meer gevonden** (verwijderd, of inmiddels volledig goedgekeurd
  en dus verborgen) leunt op de **bestaande** `applyBlockRefRestore`-fallback
  (clamp naar de gewone default) — geen nieuwe edge-case-code nodig, exact
  hetzelfde gedrag als een verlopen/gedeelde `?sel=`-link.
- **`?drill=`/`?dgran=`/`?dchg=` reizen mee naast `?sel=`** — een open gedrilde
  Onderliggende-code-kolom (zie "Drillen" in `.claude/rules/detail-layout.md`)
  is óók een navigatiepositie, dus `overviewExitUrl()` hangt ze aan zodra
  `state.drillRef` niet leeg is (alleen samen met `sel`, nooit los — drillen
  heeft geen betekenis zonder een geselecteerd block). `overview.mjs` leest ze
  in dezelfde stap als `originSel` (`originDrill`/`originDrillGran`/
  `originDrillChange`, drie extra never-nulled module-`let`s) en `treeUrl(pr)`
  voegt ze alleen toe wanneer ook `sel` wordt toegevoegd (`pr.number ===
  originPr`). Terug in `/pr/<n>` lost `applyDrillRefRestore`/
  `applyDrillCursorRestore` (`home.mjs`) ze op naar echte gedrilde kolommen —
  zie `.claude/rules/detail-layout.md`. Niet gevonden (relatie weg, resolver
  opnieuw gedraaid) → dezelfde stille not-found-fallback als `sel` zelf.

Test: `tests/overview-pr-select-block.spec.mjs`.

### Client (`src/overview.mjs`, arrow.js, dark-zinc, Nederlands)

Twee-fasen render via een reactieve `state.statuses` (skeleton → pills, geen
layout-shift). Features: gesecteerde lijst, debounced zoeken (aparte
resultaten-regio, sequence-guard), **stacks** (elke PR wiens `baseRefName` =
een in-view PR's `headRefName` → ingesprongen groep bovenaan), reviewer-avatars,
review/CI-chips, "recent gegenereerd"-lade (lazy `GET /api/prs`), en
toetsenbord-nav (↑/↓/Home/End/Enter/`/`/→, met de hover-vs-keyboard-flag zodat
`scrollIntoView` de selectie niet kaapt). UI-proza is Nederlands; de
GitHub-sectietitels blijven Engels.

**Stacks zijn een BOOM, geen lineaire keten (`computeStacks`,
`src/overview.mjs`, geëxporteerd puur voor testbaarheid).** Eén PR kan de
directe basis zijn voor **meerdere** zuster-PR's tegelijk — b.v. vijf losse
feature-branches die allemaal rechtstreeks op dezelfde, nog niet gemergede
branch zijn getakt (een "fan-out"), niet elk op de vorige. Dat is een net zo
geldige stack-relatie als een lineaire keten (elke zuster-PR's `baseRefName`
wijst tenslotte naar een in-view PR's `headRefName`), maar een eerdere versie
modelleerde dit als een strikte lijst (`childOf: Map<parentNum, PR>`, met een
guard die alleen de eerst-verwerkte kandidaat-child per parent onthield) —
waardoor bij zo'n fan-out alleen de eerste zuster werd gelift en de rest
onopgemerkt in zijn normale sectie bleef staan. `computeStacks` bouwt nu
`childrenOf: Map<parentNum, PR[]>` (alle matches, niet enkel de eerste,
gesorteerd op PR-nummer oplopend) en vlakt elke boom via een depth-first-walk
af tot `[{pr, depth}, …]`: de root op `depth 0`, en **alle zuster-PR's die op
dezelfde parent stapelen delen dezelfde `depth`** (in plaats van elk een
stap dieper dan de vorige, zoals een lineaire keten dat zou suggereren) — pas
een *echte* keten (A→B→C, elke stap één nieuwe branch dieper) levert nog
oplopende dieptes op. `stackGroup`/`listBox`/`connectorMark` (ongewijzigd
generiek op `opts.depth`) renderen zusters op dezelfde diepte dus gewoon
achter elkaar, met identieke inspringing/connector. Alleen bomen met ≥ 2
knopen tellen als een stack. Test: `tests/overview-stack-fanout.spec.mjs`
(fixture `tests/fixtures/inbox-fanout.json`, een letterlijke reproductie van
een echte fan-out — 1 basis-PR + 5 zuster-PR's die er allemaal rechtstreeks
op takken — gevoed als synthetische data rechtstreeks in `computeStacks`,
niet via `SLASH_INBOX`: de `/api/inbox`-snapshot is één gedeeld, worker-breed
read-model waar meerdere andere overview-tests exacte rij-tellingen tegen
aanhouden, dus een tweede inbox-fixture kan daar niet naast bestaan; mirrort
het "importeer een al-geladen paginamodule, roep zijn geëxporteerde pure
functie aan met synthetische data"-patroon van `navigate.spec.mjs`'s
`changeGroups`-test).

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

**De keyboard-selectie volgt identiteit (`selKey`/`data-nav-key`), niet enkel
een array-positie (`selIndex`).** Elke navigeerbare rij (`prRow` én
`recentItem`) draagt naast `data-nav-row`/`data-pr` ook een stabiel
`data-nav-key` (dezelfde string als de arrow.js `.key(...)` van die rij, bv.
`"row:12903"`/`"recent:12903"`). `move`/`moveTo` zetten bij elke stap zowel
`selIndex` als `selKey`; `paintSelection()` roept vóór het schilderen altijd
eerst `reanchorSelection(rows)` aan, die `selIndex` **herleidt uit `selKey`**
tegen de op dat moment aanwezige `currentRows()` — staat die rij er nog, dan
volgt de ring 'm naar zijn (eventueel verschoven) positie; is-ie echt weg, dan
wordt de selectie **losgelaten** (`selIndex = -1`, geen ring) in plaats van op
een willekeurige andere rij te belanden. Dit was nodig omdat de onderliggende
rijenlijst kan veranderen zonder dat de reviewer zelf een pijltje indrukt: een
zoekopdracht typen/wissen (vervangt de hele rijenset door een andere,
mogelijk kortere/anders-geordende), een achtergrond-snapshot-reload
(`reloadSnapshot`, elke 60s), of de "Recent gegenereerd"-lade openen/sluiten
(zie hieronder) — met een kale positionele `selIndex` bleef de ring dan op
"wat er toevallig op die plek staat" hangen, vrijwel altijd een andere PR dan
de reviewer had geselecteerd. Getest in
`tests/overview-selection-identity.spec.mjs` (zoeken naar een korte,
anders-geordende resultatenset laat de ring nooit op de enige overgebleven,
niet-geselecteerde rij landen; de lade dicht-klappen met een selectie erin
laat de selectie los i.p.v. 'm op een pr-row te laten landen).

**`→` en `Enter` betekenen bewust iets anders op de geselecteerde rij.**
`Enter` (`activateSelected`) blijft ongewijzigd: klik op de rij, wat het
popover-menu opent (of, voor een "Recent gegenereerd"-item, direct navigeert —
dat is al een `<a href>`). `→` (`activateSelectedForward`) is de "ga meteen
door"-toets, analoog aan de `→`-conventie op `/pr/<id>` (zie
`keyboard-navigation.md`: `→` stapt een stop verder, `Enter` opent een menu):
op een `hasGraph`-rij navigeert `→` **direct** naar `/pr/<n>` (identiek aan
"Open review-boom", geen popover zichtbaar); op een niet-geïngeste rij opent
`→` (`openOrGenerate`) hetzelfde popover als `Enter` zou doen — nodig om de
bestaande busy-spinner/stage-tekst/foutmelding te tonen tijdens het genereren,
geen nieuwe UI — en vuurt meteen `generatePage(pr)` (default `redirect:true`)
af, zodat de tree bij succes automatisch opent. Faalt het, dan blijft het
popover open met dezelfde inline foutmelding als een muis-gedreven poging.
`findPrByNumber` zoekt het `pr`-object (met `hasGraph`) op via `data-pr` in
`state.sections` (dekt ook gestapelde rijen — dezelfde objectreferenties) en
`state.searchResults`; geen match (defensief) valt terug op het bestaande
`activateSelected()`. `handlePopoverKey` blijft `→` afvangen zolang een
popover al open is, dus een tweede `→`-druk op een net geopend
genereer-popover doet niets extra's.

**De "Recent gegenereerd"-lade doet mee in de `↓`-navigatie zodra hij
openstaat** — bewuste keuze: `currentRows()` blijft simpelweg alle
`[data-nav-row]`-elementen (zowel `pr-row` als `recent-item`), dus zodra de
lade open is stroomt `↓` vanaf de laatste PR-rij gewoon door in de
lade-items, in DOM-volgorde. Dicht is de lade leeg (geen `recent-item`s in de
DOM), dus dan doet hij niet mee — en sluit je 'm terwijl de selectie op een
lade-item stond, dan laat de identiteits-herijking hierboven die selectie los
(geen ring) i.p.v. 'm op een overgebleven pr-row te plakken.

Ook: **`Escape` in de zoekbox blurt het veld** (naast het wissen van
`state.query`) — anders bleef `document.activeElement` op de (nu lege) input
staan en at `kbHandler`'s `typing`-guard (`active.tagName === 'INPUT'`) élke
volgende pijltjestoets op, wat aanvoelde als "de pijltjes doen niks meer" tot
de reviewer handmatig wegklikte/tabte.

En andersom: **`↑` voorbij de eerste rij springt naar de zoekbalk bovenin**
(`kbHandler`'s ArrowUp-tak: bij `selIndex <= 0` roept 'ie `focusSearch()` aan
i.p.v. op rij 0 te klemmen) — die zoekbalk zoekt al over **alle** open PR's van
de repo (`/api/prs/search`), dus vanaf de lijst omhoog naar het zoeken is één
toetsaanslag. `focusSearch` focust het veld en laat de rij-selectie los
(`selKey = null`, geen ring). Test: `tests/overview-ignore.spec.mjs`.

**En de symmetrische weg terug: `↓` in de zoekbox springt weer naar de
rijenlijst** (`onSearchKeydown`'s `ArrowDown`-tak, naast de bestaande
`Escape`-tak in diezelfde functie). Zonder dit was landen in de zoekbox — via
een klik, via de query terugbackspacen tot leeg (geen `Escape`, dus de
bestaande blur-op-Escape-fix triggert niet), of via de `↑`-sprong hierboven
(die al bij `selIndex <= 0` vuurt, dus ook meteen na page-load) — een
**one-way trap**: elke volgende `↓` bleef `kbHandler`'s `typing`-guard raken
en deed niets, wat als "pijltjes-omlaag doet het niet" oogde zonder dat de
reviewer besefte dat de focus stiekem in het zoekveld zat. `onSearchKeydown`
blurt het veld en roept `moveTo(0)` aan — landt op de eerste zichtbare rij
(van welke `currentView()` dan ook actief is), of is een veilige no-op bij nul
rijen (bestaande guard in `moveTo`). Test: `tests/overview-search-arrowdown.spec.mjs`.

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
