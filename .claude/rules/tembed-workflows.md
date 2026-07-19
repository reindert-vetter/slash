# Tembed: durable workflows (`tembed/`)

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
- **Deterministische, idempotente start (`StartWorkflowID`):** `StartWorkflow`
  genereert een willekeurige Run ID; `StartWorkflowID(id, name, input)` neemt de
  Run ID van de **caller** en is **idempotent** — bestaat er al een run met die
  `id` (welke status dan ook), dan is het een **no-op reuse** die `id` teruggeeft
  en de bestaande run (én zijn oorspronkelijke input) ongemoeid laat. De
  existence-check + create staat onder de run-lock, dus twee gelijktijdige starts
  van dezelfde `id` kunnen nooit allebei aanmaken. Zo kan een caller een
  **deterministische** Run ID afleiden uit een externe sleutel (b.v.
  `gh-<commentID>`) zodat een herhaalde start — dezelfde poll die twee keer
  draait, of een herstart die dezelfde GitHub-comment opnieuw ziet — nooit een
  tweede Execution maakt. De Run ID komt van de caller (glue), niet uit de
  workflow-body, dus dit schendt de determinisme-eis van de body niet. Gebruikt
  door de comment-import (zie "Bestaande GitHub-comments importeren").
- **Opslag** via de `Store`-interface: `MemoryStore` (tests), `JSONLStore` (één
  leesbaar bestand per run), `SQLiteStore` (pure-Go `modernc.org/sqlite`, geen
  cgo) en `MultiStore` om te combineren (SQLite voor queries + JSONL als
  audit-trail). Enige runtime-dependency is `modernc.org/sqlite`.
- **Recovery:** `engine.Recover()` bij startup dry-vt elke `running`/`waiting`
  run opnieuw (herplant timers, her-blokkeert op signals).
- **Tests:** `tembed/*_test.go` (activity-replay, signals, buffered signal,
  durable timer, activity-failure, SQLite+JSONL combinatie).

## Harde regel: alleen workflows muteren state

**Workflows zijn de enige schrijvers.** State verandert uitsluitend via een
Workflow Execution; al het andere is **read-only van buitenaf**:

- **Modules** (`modules/*`, b.v. `comments`, `github`, `inbox`) zijn de dingen die "kunnen
  gebeuren in een workflow" — ze worden **alleen** door workflow-Activities
  aangeroepen. Hun schrijf-methodes (`Save`, `AddReaction`, `PostReviewComment`, …)
  hoor je nergens anders aan te roepen; hun **read**-methodes (`List`, …) voeden
  de UI.
- De **HTTP-API** schrijft alleen via workflow-endpoints (een Execution starten
  of een Signal sturen). Alle andere endpoints en de **UI zijn read-only**.
- Waarom: de workflow-event-history is de bron van waarheid (durable, herspeelbaar,
  overleeft herstart). Een module-tabel is een afgeleide read-model. Zie
  `.claude/rules/workflows-write-boundary.md` en `.claude/rules/workflow-determinism.md`.

## De eerste slash-task: `task_code_comment` (`workflows.go` + `modules/`)

De eerste concrete taak draait op tembed: **een comment op een regel code
plaatsen** en de thread levend houden. Termen volgen Temporal — een **Workflow
Type** `task_code_comment`, gestart als **Workflow Execution** (met een **Run ID**,
dat tevens de comment-id is), die **Activities** draait en op **Signals** reageert.

- **Twee modules** die de workflow als Activity aandrijft:
  - `modules/comments` — de comments-module met een **eigen SQLite read-model**
    (`comments`/`reactions`, `data/comments.db`). "Doet zijn eigen ding": telt
    reacties (`reaction_count`) en zet `status` op `resolved` bij `/resolve`.
    Write (`Save`/`AddReaction`) = workflow-only; `List` = read voor de UI. Elke
    comment bewaart ook het **codefragment** waarop hij hangt (`code`/`gran`/
    `label`-kolommen, meegegeven in `CodeCommentInput`) — de exacte navigatie-unit
    op het moment van plaatsen — zodat de thread later dezelfde code toont als de
    composer. `RelatedPanel.mjs` deelt daarvoor één `composeTargetHint`-box (het
    kader met granulariteit + `class::method` + Prism-highlighted fragment): de
    composer voedt 'm uit `commentTarget()` (live navigatie), de geplaatste-comment-
    thread uit de opgeslagen `code`/`gran`/`label`. Een comment zónder `code` (b.v.
    oude of geseede) toont geen kader. Een lichte `migrate` voegt die kolommen toe
    aan een bestaande DB (`ALTER TABLE … ADD COLUMN`, dubbele-kolom-fout genegeerd).
    Naast het fragment bewaart een comment zijn **navigatie-anker** (`row_start`/
    `row_end`/`seg`): de aligned-row-range binnen het block + (voor een `call`) de
    segment-sleutel. Daarmee scope't `RelatedPanel` de comment-index op het
    geselecteerde block én de selectie-unit (call ⊂ line ⊂ group ⊂ block;
    `commentUnder`/`visibleComments`, `home.mjs` duwt de scope via een `watch`+
    `setCommentScope`). Ook krijgt elke comment een **hiërarchisch pad** dat de
    workflow deterministisch bouwt (`commentPath` in `workflows.go`, uit input +
    Run ID) en dat geïndexeerd in de `path`-kolom staat:
    `/pr-<pr>/<file>/<label>/<codeRef>/comment-<id>` (de `file` behoudt z'n
    slashes, dus een directory-prefix matcht ook; `codeRef` = `group-5-9` /
    `line-7` / `call-7-<seg>`). Zo vindt een **prefix-match** alle comments onder
    een scope: `/pr-123` (hele PR), `/pr-123/app/Foo.php` (bestand),
    `…/Foo::bar` (block), `…/group-5-9` (unit) — via `comments.Search(prefix)`
    (read-only) achter `GET /api/comments?path=<prefix>`. Schrijven van het pad
    blijft workflow-only (`saveComment`-Activity). Los daarvan markeert de diff
    elke regel met een comment met een **💬** (`commentRowSet` → `Block`
    `commentedRows` → `paneHTML`, presence-only).
    De **thread** opent bovendien met de comment zélf als **eerste bericht**: de
    body die de comment titelt verschijnt óók als eerste chat-bubble (aan de kant
    van de reviewer), gevolgd door de reacties. `RelatedPanel.mjs` bouwt dat met
    `threadMessages(c)` = de synthetische opening (`{source:'ui', body:c.body}`,
    key `origin:<id>`) + `c.reactions`; de keyboard-nav (`reactionCount`/`threadPos`)
    telt die opening mee, dus `↑` loopt door tot de opening bovenaan. Een **klik**
    op een comment-rij landt er ook echt op (`toComment()` → highlight + thread
    open + reply-veld gefocust), net als de toetsenbord-landing.
  - `modules/github` — de GitHub-communicatie (`gh api`): `PostReviewComment`
    (regel-range + side, zie hieronder), `Reply`, `FetchReplies`, `PRState`
    (`open`/`merged`/`closed`), `PRMeta` (titel/URL/body/author/diff-stats/head-ref),
    `DeleteComment`, `MarkFileViewed` (het Files-changed-"Viewed"-vinkje, via
    `gh api graphql`). Interface `github.Client` + `github.Fake` (met `SetPRState`,
    `IsViewed`/`ViewedFiles`, `LastStartLine`/`LastEndLine`/`LastSide`/
    `LastPostedBody`) voor tests.
  - `modules/jira` — de Jira-communicatie via de lokale `acli`-CLI (zelfde
    bridge-patroon als `modules/github`/`modules/claude`, geen nieuwe
    dependency): `Issue(key)` draait `acli jira workitem view <key> --fields
    summary,description --json` (de `key` wordt eerst tegen
    `^[A-Z][A-Z0-9]+-\d+$` gevalideerd — nooit ongevalideerde input naar
    `exec.CommandContext`) en flatten't de ADF-`description` (Atlassian
    Document Format, een `{type:"doc", content:[...]}`-boom) naar platte tekst
    door de content-boom recursief te doorlopen en alle `text`-leaves te
    concateneren (paragrafen gescheiden door `\n`). Interface `jira.Client` +
    `jira.Fake` (`SetIssue`) voor tests; **`SLASH_JIRA=off`** → `jira.Fake{}`
    (geen netwerk, mirrort `SLASH_GITHUB=off`/`SLASH_CLAUDE=off`), bedraad in
    `newTasks` (`tasks_api.go`).
- **Flow:** `saveComment` (comments) + `postGithubComment` (github, best-effort),
  dan een lus op `reply`-**Signals**. Een reactie komt binnen via de **UI**
  (`POST /api/workflows/{runID}/signals/reply`) én via een **per-thread poller**;
  beide worden als hetzelfde Signal geleverd. Elke reactie wordt opgeslagen
  (comments) en een UI-reactie wordt gespiegeld naar GitHub; `Done`/`/resolve`
  sluit de thread.
- **Regel-range, side en call-context naar GitHub:** `CodeCommentInput` draagt
  naast `Line` ook `StartLine`/`EndLine`/`Side`/`Segment`. `postGithubComment`
  bouwt daaruit de `github.PostReviewComment(ctx, pr, file, start, end, side,
  body)`-call: `Side` is `"RIGHT"` (nieuw/context, default bij leeg) of
  `"LEFT"` (een verwijderde regel); is `StartLine < EndLine` dan post het een
  **multi-line range** (`start_line`..`line`, GitHub-eis), anders single-line op
  `EndLine` (valt terug op `Line` als beide 0 zijn — backward-compat met oudere
  callers die alleen `Line` zetten). Voor `Gran == "call"` met een niet-lege
  `Segment` prefixt de **naar-GitHub-geposte** body met het segment als
  code-span (`` `segment`\n\n`` + body) — de **opgeslagen** comment (`saveComment`,
  het read-model achter de thread) blijft de rauwe `Body`, ongewijzigd door
  `Segment`. Puur input-gedreven, dus deterministisch onder replay.
  **Frontend-kant:** `commentTarget()` (`home.mjs`) berekent deze vier velden uit
  de huidige navigatie-unit i.p.v. altijd `b.line` (de blok-startregel) te sturen.
  `unitLineRange(b, rows, unit)` telt de aligned rows van `blockRows(b)` af vanaf
  `b.code.new.start`/`b.code.old.start` (de bron-startregel uit `GET /api/code`;
  aligned rows dragen zelf geen regelnummers, een filler-rij op de andere kant telt
  niet mee) om `startLine`/`endLine` + `side` te bepalen: `side` is `'RIGHT'` zodra
  één rij in de unit een `right` heeft, anders (een pure verwijdering) `'LEFT'`; is
  de code nog niet geladen dan valt het terug op `{startLine:0, endLine:0,
  side:'RIGHT'}` (de backend valt op zijn beurt terug op `Line`). `unitSegment(rows,
  unit)` levert voor een `'call'`-unit de onderstreepte segmenttekst (dezelfde
  `unit.right`/`unit.left`-Sets als `segKey`/de indigo-underline in `Block.mjs`,
  substring `min..max` inclusief); een group/line-unit heeft geen `char`-vlag en
  geeft `''`. `placeComment` (`RelatedPanel.mjs`) geeft alle vier door aan
  `createComment`, plus `line: t.startLine || b.line` (dezelfde backward-compat-
  fallback als de Go-kant). Er is precies één plek die naar de workflow post
  (`createComment`); elke composer-flow (toetsenbord, klik, de comment-soort-menu's
  "Alleen voor mijzelf") loopt via `placeComment` en krijgt dus dezelfde anchoring.
  **`commentTarget()` volgt `focusedBlock()`, niet altijd het top-level
  `curBlock()`:** staat de keyboard op een gedrilde kolom (`state.focusLevel >
  0`, zie "Drillen"/"Kolom-navigatie" in `.claude/rules/detail-layout.md`), dan
  moet de referentiecode van een net-gestarte comment het block van díe kolom +
  diens eigen `state.drillCursor[focusLevel-1].{gran,change}` zijn — niet het
  top-level block. `placeComment` gebruikt daarom `t.file`/`t.startLine` (uit
  `commentTarget()`) i.p.v. het top-level `b.file`/`b.line`, en `commentsSection`'s
  "Nieuwe comment · `<file>:<line>`"-header idem. De `commentScope`-`watch`
  in `home.mjs` (die `cs.view`, de zichtbare comment-lijst, scope't) moet
  daarnaast ook `state.focusLevel`/`state.drill`/`state.drillCursor` **inline**
  in zijn dependency-array opnemen — anders blijft de comment-index na het
  drillen gescoped op het block van vóór de drill, ook al is de net geplaatste
  comment zelf correct geanchored (zie de watch-inline-deps-regel in
  `.claude/rules/conventions.md`). Getest in `tests/drill-comment-target.spec.mjs`.
- **Privé-notitie (`local`-vlag):** `CodeCommentInput` draagt een
  `Local bool`-vlag. Is die gezet — de UI stuurt 'm bij de keuze **"Alleen voor
  mijzelf"** in het comment-soort-menu (zie `.claude/rules/keyboard-navigation.md`)
  — dan **slaat de workflow `postGithubComment` over** (`if !in.Local`). De comment
  wordt dus wél in het read-model opgeslagen maar nooit naar GitHub gepost. Dat is
  replay-deterministisch: het aantal `ExecuteActivity`-calls hangt van de **input**
  af, niet van live state. Verdere zorg is er niet: `posted` blijft de zero-value
  (`RootID == 0`), dus `StartCodeComment` start geen poller en de bestaande
  `RootID == 0`-guards maken `deleteGithubComment`/`replyGithub` no-op — reageren op
  of verwijderen van een privé-notitie raakt GitHub dus nooit.
- **Poller-cadans (heartbeat-gedreven):** de poller checkt GitHub **snel**
  (`pollInterval = time.Minute`) zolang er in de laatste `heartbeatWindow`
  (10 min) een **heartbeat** binnenkwam — de UI pingt
  `POST /api/workflows/{runID}/heartbeat` voor de **taak die je op dat moment
  bekijkt** (per-actieve-taak, geen state-mutatie: enkel in-memory poll-timing,
  dus buiten de write-boundary). De UI pingt **alleen bij echte activiteit**:
  tabblad zichtbaar **én** gefocust **én** input in de laatste `ACTIVITY_WINDOW`
  (2 min) — een open-maar-verlaten tabblad stopt dus vanzelf met heartbeaten
  (`tabActive`/`beat` in `RelatedPanel.mjs`). Zonder recente heartbeat valt hij terug op een
  **trage** cadans (`idlePollInterval = 10 min`); **alleen** op die trage cadans
  checkt hij ook of de PR gemerged/closed is en **stopt** hij dan. De poller
  waakt op de snelle tick maar gate't de echte GitHub-calls op de gewenste cadans,
  zodat een heartbeat mid-idle meteen naar snel schakelt.
- **`pr_status`-workflow (per PR):** een tweede Workflow Type, één Execution per
  PR, die `state`-**Signals** van de pollers ontvangt en **completet** zodra de PR
  merged/closed is. Dat is de durabele bron-van-waarheid die pollers lezen om te
  stoppen (schrijven blijft dus binnen een workflow). `ensurePRStatus(pr)` start/
  hergebruikt één tracker per PR (ook na herstart, via `Runs()`+`Input()`).
  **Bij start** (synchroon in `StartWorkflow`, vóór de signal-lus) draait hij
  drie Activities **na elkaar**, elk gevolgd door zijn eigen read-model-write —
  zodat de UI **progressief** kan tonen (eerst titel+omschrijving, dan de
  samenvatting, dan de review/CI-status) i.p.v. te wachten tot alles binnen is:
  1. **`fetchPRBasics`** — haalt titel/URL/body/author/diff-stats/head-ref op
     via de github-module (`PRMeta`, best-effort — een gh-hiccup laat de rest
     leeg), leidt een Jira-key af uit de titel (`\b([A-Z][A-Z0-9]+-\d+)\b`,
     dezelfde regex als de frontend) en haalt bij een gevonden key het
     Jira-ticket op (`jira.Issue`, best-effort — geen key of een Jira-hiccup
     laat de jira-velden leeg), dan `prmeta.SaveBasics(...)`.
  2. **`generatePRSummary`** — bouwt uit de zojuist opgeslagen basics (titel,
     body, de distinct gewijzigde bestanden uit de `blocks`-tabel, en het
     Jira-ticket) een prompt en vraagt Haiku (`claude.Client.Run`, context-only)
     om in 2-4 zinnen samen te vatten wat de PR doet, dan
     `prmeta.SaveSummary(pr, summary)`.
  3. **`fetchPRStatuses`** — hergebruikt de bestaande heavy inbox-status-query
     (`statusesFor` uit `inbox.go`: reviewDecision, checks, reviewers) voor
     precies deze ene PR (respecteert `SLASH_GITHUB=off`), dan
     `prmeta.SaveStatuses(...)`. Kanttekening: GitHub's rollup levert alleen een
     **totaal** + een overall state, geen per-check pass-count; `checksPassed`
     is dus `checksTotal` bij een `SUCCESS`-rollup, anders `0` — genoeg voor een
     status-pill, geen exacte teller.

  Elke stage schrijft via zijn **eigen, gerichte** `prmeta`-methode (zie
  hieronder) zodat een latere stage nooit een eerdere overschrijft. De UI
  (`/`-menu, zie `.claude/rules/keyboard-navigation.md`) leest dat via
  `GET /api/pr?pr=N` voor de Jira/GitHub-deep-links; de titel levert de
  `KEY-123`-ticket-key. `EnsurePRStatus` is de geëxporteerde ensure-wrapper die de
  UI via `POST /api/workflows/pr_status {pr}` bij het laden aanroept (een Execution
  starten = sanctioned write-weg) — de UI wacht **niet** op deze POST, maar
  pollt `GET /api/pr` en rendert wat er al is (velden van een nog niet-gedraaide
  stage zijn simpelweg leeg/0).

  **Ingest-refresh (nieuwe commits automatisch binnenhalen):** `pr_status`
  dreef aanvankelijk alleen de merge/closed-detectie; sinds de ingest-refresh
  gebruikt hij dezelfde `state`-Signal-lus ook om **nieuwe commits op de PR**
  incrementeel te verwerken, zodat een reviewer niet handmatig
  `POST /api/ingest` hoeft te draaien na elke push. `PRStateSignal` draagt
  daarvoor naast `State` ook `BaseSHA`/`HeadSHA` (net als `ReactionSignal.Action`
  / `ApprovalSignal.Viewed` rijden beide varianten op **hetzelfde** Signal —
  een workflow kan maar op één Signal-naam tegelijk `WaitSignal`-en): `State`
  gezet = een lifecycle-observatie (merged/closed, ongewijzigd gedrag);
  `State` leeg + `HeadSHA` gezet = een ingest-refresh-verzoek.
  - **`pollIngestRefresh`** (nieuwe, aparte poller-loop, los van elke
    comment-thread — spiegelt `poll`/`pollInbox`, zelfde heartbeat-cadans:
    snel `pollInterval` als binnen `heartbeatWindow` een heartbeat kwam, anders
    traag `idlePollInterval`) checkt op zijn cadans `fetchPRMeta`'s live
    `headRefOid` tegen het opgeslagen `pr_ingest`-record (zie hieronder). Is
    die anders, dan signalt hij `PRStateSignal{BaseSHA, HeadSHA}` naar de
    `pr_status`-tracker. **Belangrijk:** de per-comment-thread-heartbeat
    (`RelatedPanel.mjs`) pingt alleen wanneer er een taak/thread open staat;
    zonder open thread zou deze poller altijd op de trage cadans blijven
    hangen. Daarom pingt `home.mjs` (`startPRStatusHeartbeat`) apart, elke 60s,
    de `pr_status`-Run-ID zolang de PR-pagina zichtbaar+gefocust is — een
    operationele ping zonder state-mutatie, dus buiten de write-boundary,
    zoals de bestaande comment-/inbox-heartbeats.
  - **`refreshIngestDelta`-Activity** (`ingest.go`): diff't de **eerder
    opgeslagen** head-SHA (uit de nieuwe `pr_ingest`-tabel, `db.go`) tegen de
    **nieuw waargenomen** head-SHA (`changedFileNames`, een `git diff
    --name-only` — geen volledige unified diff nodig om alleen de
    bestandsnamen te weten) om **precies** te bepalen welke bestanden sinds de
    vorige ingest wijzigden. Alleen die bestanden worden herscand
    (`diffBetweenSHAs` + `parseFiles`, gescoped) en via **`upsertPRFileBlocks`**
    weggeschreven: een DELETE+INSERT die **alleen** de blocks van die
    bestanden raakt (`DELETE FROM blocks WHERE pr=? AND file IN (...)`) —
    ieder ander bestand z'n eigen blocks (en dus alles wat aan hun block-id hangt:
    comments/approvals/callresolve, in aparte SQLite-bestanden zonder FK)
    blijft volledig ongemoeid. De head-worktree wordt **in place** bijgewerkt
    (`updateWorktree`: `git checkout --detach <sha>` binnen de bestaande
    worktree-map, valt terug op de bestaande hard-rebuild `ensureWorktree` als
    dat faalt) i.p.v. de vorige remove+recreate — die was prima voor een
    handmatige, incidentele ingest maar te zwaar voor een cadans die elke
    minuut kan vuren.
    **Base-SHA gewijzigd** (bv. een rebase op een nieuwere `develop`) maakt een
    incrementele diff tegen de oude base onveilig; dan valt de Activity terug
    op de **volledige** bestaande ingest-pipeline (`prepareIngestWorktrees` +
    `scanAndStoreIngestBlocks`, exact dezelfde full-swap als een handmatige
    `POST /api/ingest`) — `ingestResult.FullFallback` markeert dat in de
    workflow-history.
  - **`pr_ingest`-tabel** (`db.go`, `schemaDDL`): `pr → base_sha, head_sha`,
    bijgewerkt door **zowel** een volledige ingest (`scanAndStoreIngestBlocks`)
    als een delta-refresh, zodat de poller altijd weet waar de volgende
    refresh vandaan moet diffen. Leeg (geen rij) betekent "nog nooit
    geïngest" — de poller/Activity doen dan niets (een refresh vereist een
    voorafgaande volledige ingest).
  - **Relations/callresolve blijven "vol" herberekend, niet delta-scoped:**
    ná een geslaagde (niet-`Skipped`) refresh roept `prStatusWorkflow` gewoon
    de bestaande `buildRelations`-Activity aan (dezelfde Activity die
    `build_relations` ook gebruikt) — over de PR's **volledige huidige**
    blocklijst (`blocksByPR`, een DB-read, geen re-parse). Bewuste keuze: de
    kosten van `buildRelations`/`resolveCalls` schalen al met de PR-grootte
    (niet de repo), en `resolveCalls` bouwt sowieso een hele-worktree
    symbol-index ongeacht hoeveel blocks je 'm voedt — delta-scopen van *welke*
    blocks bespaart dus nauwelijks iets, terwijl een relatie tussen twee
    losse, ongerelateerde bestanden (`event_listener`: dispatcher in bestand A,
    listener-handle in bestand B) een partiële keep-set juist een risico op
    stale/verdwenen relaties geeft. Met de **volledige** blocklijst als
    keep-set kunnen `relations.Replace`/`callresolve.Prune`/`UpsertGo` nooit
    een geldige rij van een ongewijzigd bestand wegpruunen, en `UpsertGo` raakt
    sowieso nooit een `searching`/`found`-rij (LLM-owned) aan.
- **`pr_inbox`-workflow (per repo):** een derde Workflow Type dat de PR-inbox
  bezit — het is de **enige** die GitHub voor het overzicht leest. Een
  `refresh`-Signal (van de UI bij laden én van `pollInbox` op de
  heartbeat-cadans) drijft de `refreshInbox`-Activity, die de inbox fetcht en in
  de **`inbox`-module** (read-model) schrijft. `EnsureInbox` start/hergebruikt één
  Execution per repo en doet een synchrone eerste refresh bij startup. Zie
  `.claude/rules/pages-and-routing.md` (sectie "PR-inbox").
- **Opslag:** de tembed-engine gebruikt `MultiStore(SQLite data/workflows.db,
  JSONL data/workflows/)` — comments leven dus zowel in de workflow-history als in
  **jsonl-bestanden**. Daarnaast houdt de comments-module zijn eigen read-model.
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/task_code_comment` (start),
  `GET` (lijst), `POST /api/workflows/{runID}/signals/reply` (UI-reactie),
  `POST /api/workflows/{runID}/heartbeat` (UI-heartbeat, geen state-write),
  `GET /api/workflows/{runID}` (status), en read-only `GET /api/comments?pr=N`
  (of `?path=<prefix>` voor de hiërarchische prefix-zoek over de comment-paden).
  Read-only `GET /api/workflows?pr=N` (let op: **zonder** trailing slash, dus een
  ander pattern dan `/api/workflows/`) geeft `{ok,runs:[...]}` — élke workflow-run
  van die PR (`RunsForPR` in `tasks_api.go` filtert `engine.Runs()` op het
  `pr`-veld in elke run's opgeslagen input, dus `pr_inbox` — per-repo, geen
  `pr`-veld — valt er vanzelf uit), nieuwste `updatedAt` eerst. Elke
  `task_code_comment`-run draagt daarnaast een genest, optioneel `comment`-veld
  (`WorkflowRunView.Comment`, een `*CommentRef`): `RunsForPR` parseert de run's
  eigen (immutable) `Input` nogmaals als `CodeCommentInput` en vult
  `{file,label,gran,line,rowStart,rowEnd,snippet}` — `snippet` is `Body`
  afgekapt op een woordgrens (`commentSnippet`, ~60 tekens + `…`). `RunID` (==
  de comment's id, zie boven) staat al op de buitenste view. Voedt de
  "Taken"-kolom (`workflows-panel`, onderdeel van `CommentsSidebar` in
  `RelatedPanel.mjs`), zie `.claude/rules/detail-layout.md`: de omschrijving
  per rij en de klik-door-naar-de-comment (`openTask` in `home.mjs`) leunen op
  dit veld.
  Voor de PR-metadata: `POST /api/workflows/pr_status {pr}` (ensure de tracker,
  die synchroon de drie stages draait) + read-only `GET /api/pr?pr=N` (leest
  het `prmeta`-read-model: `{ok,pr,title,url,updatedAt,body,author,additions,
  deletions,changedFiles,headRef,summary,jiraKey,jiraTitle,jiraDesc,jiraUrl,
  reviewDecision,checksTotal,checksPassed,reviewers}`; `{ok:false}` zolang nog
  niets gefetcht is, en een veld van een nog niet-gedraaide stage staat gewoon
  op zijn zero-value). Voor de inbox: `POST /api/workflows/{runID}/signals/refresh` +
  read-only `GET /api/inbox` (leest het `inbox`-read-model).
  Bootstrap + recovery + hervatten van pollers + `EnsureInbox`:
  `newTasks(ctx, db, dataDir, repo)` in `tasks_api.go`, aangeroepen in `runServe`.
- **Nieuwe workflow of module toevoegen:** skills `add-workflow` / `add-module`
  (+ templates `.claude/templates/workflow.go` / `module.go`).
- Tests: `workflows_test.go` (UI-reactie + gh-poll→signal + resolve, een
  restart-durability-test, `pr_status`-stop-bij-merge, heartbeat-houdt-snel,
  `pr_status`-fetcht-PR-meta, plus `pr_inbox`-refresh-vult-read-model);
  `tests/pr-menu.spec.mjs` (Playwright: het `/`-menu en zijn submenu's); modules
  zijn puur en los testbaar.

## Bestaande GitHub-comments importeren (levende threads)

Comments die **buiten de app** op de PR zijn geplaatst (of vóór ingest) staan
niet vanzelf in het `comments`-read-model — de app kende alleen comments die het
zélf via `task_code_comment` plaatste. De import haalt ze binnen en maakt er
**volwaardige, levende threads** van (reageren spiegelt naar GitHub, GitHub-
replies worden binnengepolld), i.p.v. read-only kopieën.

- **Fetch (`modules/github`):** `FetchReviewComments(pr)` geeft de **thread-roots**
  van de diff-review-comments (`in_reply_to_id == 0`, gepagineerd via
  `apiPaginate`); `FetchGeneralComments(pr)` geeft de **PR-brede** comments zonder
  file:line — de issue-conversatie (`issues/{pr}/comments`) én de niet-lege
  bodies van ingediende reviews (`pulls/{pr}/reviews`, `Kind` `issue` resp.
  `review_summary`). Replies op een geïmporteerde root komen daarna via het
  bestaande `FetchReplies`-pad binnen. `github.Fake` heeft
  `SetReviewComments`/`SetGeneralComments` voor tests.
- **Mapping (`comment_import.go`, package main — leest de head/base-worktree, dus
  een read-only side-effect zoals `blockstats.go`/`/api/code`):**
  `mapReviewComment(dataDir, pr, blocks, gc)` mapt een review-comment's
  `file:line(+side)` naar een block + **aligned-row-anker** in **exact dezelfde**
  index-ruimte als approvals/app-comments (`dedent4` → `alignRows` +
  `rowForLine`, dat de source-regel op de gekozen kant naar zijn rij-index telt
  vanaf de block-`Start`). Vindt hij het block + de rij → een gewone
  block-gescopete regel-comment (`Kind ""`); vindt hij het block maar niet de
  exacte rij → `RowStart -1` (overal binnen het block getoond, de bestaande
  "onbekend anker"-conventie); vindt hij géén block → **PR-breed** (`Kind
  "review"`, leeg `Label`). `mapGeneralComment` maakt altijd een ankerloze
  PR-brede input (`Kind` `issue`/`review_summary`). Alle drie dragen
  `ImportedRootID`/`Source "github"`/`Author`/`CreatedAt` (de originele
  GitHub-timestamp) mee. LEFT-side (verwijderde regel) comments matchen het block
  via zijn **oude** source-range (base-worktree), want de opgeslagen
  `Line`/`EndLine` zijn head-coördinaten.
- **Workflow-tak (`taskCodeCommentWorkflow`):** `CodeCommentInput` kreeg
  `ImportedRootID`/`Source`/`Kind`/`CreatedAt`. De posting-keuze is input-gedreven
  (dus replay-deterministisch) in drie gevallen: **geïmporteerd**
  (`ImportedRootID != 0`) → **sla `postGithubComment` over** maar zet
  `posted.RootID = in.ImportedRootID` (de comment bestáát al op GitHub — nooit
  her-posten), zodat de reply-poller draait en UI-replies wél naar de echte
  thread spiegelen; **local** (privé-notitie) → `RootID 0`, alle GitHub-calls
  no-op; **normaal** → posten + `RootID` vastleggen. `saveComment` bewaart
  `Source`/`Kind`/`CreatedAt`.
- **Reply-lus per thread-soort (`isPRWide(kind)` = `issue`/`review_summary`/
  `review`):** echo-preventie ongewijzigd (alleen `Source == "ui"` mirror't naar
  GitHub, `github`-sourced replies niet), maar het **mirror-pad** hangt af van de
  thread:
  - **Review-diff thread** (`Kind ""`): een reply (en een `/resolve`) mirror't als
    **review-reply** (`replyGithub` → `pulls/{pr}/comments/{rootId}/replies`),
    ongewijzigd.
  - **PR-brede thread** (`isPRWide`): PR-brede comments (issue-comments/review-
    summary's) hebben op GitHub **geen reply-thread** — een reply wordt daarom
    gemirror'd als een **nieuwe issue-comment** op de platte PR-conversatie
    (`postGithubIssueComment` → `github.PostIssueComment` →
    `issues/{pr}/comments`). Die Activity retourneert de nieuwe comment-id als
    `postResult` zodat 'ie in de history staat (voor de dedup hieronder). Een
    **resolve** (`Done`) op een PR-brede thread is **alleen lokaal**: GitHub heeft
    er geen concept voor, dus de workflow raakt GitHub niet aan (`if !r.Done`) —
    `saveReaction` zet enkel de read-model-status op `resolved`.
- **Dedup tegen de app z'n eigen comments (`knownGithubIDs`):** `importPRComments`
  haalt álle GitHub-comment-roots op — óók degene die de app zélf plaatste (een
  app-review-comment, of een PR-brede reply die als issue-comment werd gepost).
  Zonder dedup zou dat een duplicaat maken (de app-run heeft géén `gh-<id>` Run
  ID, dus `StartWorkflowID`-idempotentie vangt 'm niet). `knownGithubIDs(pr)`
  scant daarom alle `task_code_comment`-runs van de PR en verzamelt hun bekende
  GitHub-id's — `input.ImportedRootID` + elke `postGithubComment`/
  `postGithubIssueComment`-result uit de history — en `importPRComments` slaat een
  comment met een bekend id over. Alles durable (history/input), dus
  herstart-veilig. O(runs), zelfde schaal als `ResumePolling`.
- **Importer-glue + poller (`workflows.go`, cadans meeliftend op `pr_status`):**
  `importPRComments(ctx, pr)` leest de blocks (DB), fetcht review + general
  comments (reads-in-glue, zoals `poll`/`pollInbox`), mapt ze, en start per
  comment een Execution met `StartWorkflowID("gh-<id>", …)` — de **enige write**,
  idempotent gemaakt door de deterministische Run ID. `pollImportComments(ctx,
  prRunID, pr)` draait één import meteen en daarna op de heartbeat-cadans
  (spiegel van `pollIngestRefresh`: snel binnen `heartbeatWindow`, anders traag),
  en stopt zodra de `pr_status`-tracker klaar is (merged/closed). Gestart naast
  `pollIngestRefresh` in `ensurePRStatus` (nieuwe tracker) en `ResumePRStatusPolling`
  (na herstart). Voor elke geïmporteerde **review-diff** thread (niet PR-breed)
  start het de per-thread reply-`poll`; een in-memory `importPolled`-set (dedup,
  operationeel — reconstrueerd door `ResumePolling` na herstart) voorkomt een
  tweede poller per run bij een volgende import-tick.
- **Herstart (`ResumePolling`):** de root-ID van een geïmporteerde thread leeft in
  de **input** (`ImportedRootID`), niet in een `postGithubComment`-history-event
  (dat is er niet), dus `ResumePolling` leest 'm daaruit en markeert de run in
  `importPolled`.
- **Kanttekening — reply-dedup leunt op de DB, niet op de poller-`seen`-map:**
  de per-poller `seen[replyID]`-map (in `poll`) is een snelheids-cache die bij
  herstart leeg begint; dat is veilig omdat `comments.AddReaction`
  **`INSERT OR IGNORE`** op de reactie-id (`gh-<id>`) doet en de count alleen bij
  een echt nieuwe rij ophoogt ("already recorded — no double count"). Herstart
  → poller her-signalt alle replies → geen dubbeltelling. Ditzelfde contract
  maakt de `StartWorkflowID`-dedup en de `seen`-reset samen herstart-veilig; hou
  het intact.
- **Read-model & frontend:** `comments.Comment` kreeg `Source` (`ui`/`github`) +
  `Kind` kolommen (lichte `migrate`, `ALTER TABLE … ADD COLUMN`). `GET
  /api/comments?pr=N` serveert de geïmporteerde comments automatisch — geen nieuw
  endpoint. De frontend badge't `source: github` en toont de PR-brede comments
  (`Kind != ""`) in een eigen blok onder de PR-info-kolom (zie
  `.claude/rules/detail-layout.md`), los van de block-gescopete comments-sidebar.
- Tests: `comment_import_test.go` (mapping-anker + PR-wide-degradatie + general;
  `importPRComments` vult read-model met `source github`, **her-post nooit**, en
  is idempotent bij her-import; een geïmporteerde thread spiegelt een UI-reply en
  echoot een GitHub-reply niet; herstart hervat de poller via de input-root-ID),
  `modules/comments/comments_test.go` (`Source`/`Kind` round-trip),
  `tembed/engine_test.go` (`StartWorkflowID`-idempotentie).

## Relaties tussen blokken (`build_relations` + `modules/relations`)

Een vierde Workflow Type, **`build_relations`** (één Execution per PR), leidt
**many-to-many relaties** tussen blokken af — de call-graph-edges, maar
betekenis-gedreven i.p.v. tekstueel. De eerste relatie-`kind`:
**`event_listener`** — een gewijzigd blok dat een event dispatcht wordt de
**parent** van de `Listener::handle` voor dat event, **mits die handle óók in
deze PR gewijzigd is** (beide kanten moeten wijzigen om te koppelen).

- **`modules/relations`** (`data/relations.db`): het read-model,
  `relations(pr, parent_id, child_id, kind, line)` (block-id =
  `<pr>:<file>:<symbol>`). `line` is de **absolute broncoderegel, binnen de
  parent's eigen tekst**, waar de detector de trigger van deze relatie vond
  (een dispatch-call, een route-actie, een type-hinted param, …) — de
  frontend gebruikt 'm om het Onderliggende-code-paneel te herordenen op de
  door de reviewer geselecteerde `group`-unit (zie `groupLineRange`/
  `relatedChildren` in `home.mjs`, en de "Onderliggende code"-sectie in
  `.claude/rules/detail-layout.md`); `0` voor een rij van vóór dit veld (een
  oude rij die pas bij de volgende rebuild een echte waarde krijgt). Write
  `Replace(pr, rels)` (workflow-only, full-swap per PR → replay-safe), read
  `List(pr)`. `kind` houdt de tabel open voor latere relatietypes. Een lichte
  `migrate` voegt `line` toe aan een bestaande DB (`ALTER TABLE … ADD COLUMN`,
  dubbele-kolom-fout genegeerd — hetzelfde patroon als de comments-module).
- **Analyse-service `relations.go`** (package main, géén module — leest de
  head-worktree = side-effect): `buildRelations(dataDir, pr, blocks)` draait een
  lijst **detectors** (nu `eventListenerDetector` + de vijf Laravel-detectors
  hieronder). De event→listener-map komt
  robuust uit drie bronnen (union): de `handle(EventType $e)`-type-hint, het
  `$listen`-array in een `*ServiceProvider.php`, en `Event::listen(...)`-calls;
  dispatch-sites worden per blok-body gescand (`event(new X`, `X::dispatch(`, …).
  Herbruikt `extractBlockSource` (code.go) om block-bodies te lezen.
  `blockText(headDir, b)` geeft niet meer alleen tekst terug maar de volledige
  `codeSide` (tekst + de absolute startregel `Start` van een **verse** scan —
  niet b's eigen, mogelijk verouderde `Line`-veld): elke detector converteert
  de byte-offset van zijn regex-match binnen die tekst naar een absolute
  bestandsregel via **`matchLine(text, match, fromLine)`** (telt de `\n`'s tot
  de eerste occurrence van de matched tekst) en geeft die mee aan `emit`/de
  relation zelf. Puur additief — geen detector-gedrag gewijzigd, alleen een
  extra regel-anker vastgelegd; `TestBuildRelationsLaravelChainCapturesLine`
  (`relations_test.go`) verifieert 'm tegen een onafhankelijke scan van de
  fixture-broncode.
- **Laravel request-keten** — vijf extra **`kind`s**, allemaal **both-changed**
  (net als `event_listener`: een edge verschijnt alléén als beide blokken in deze
  PR wijzigen; ongewijzigde bestanden worden nooit als node geïnjecteerd, en het
  hoogste níveau dát wél wijzigt wordt vanzelf de tree-root omdat `recomputeLeftList`
  elke child uit de linkerlijst haalt). De head-worktree mag wél vrij gelezen
  worden voor de mapping (zoals `providerEventMap` ongewijzigde ServiceProviders
  leest). Middleware is **bewust buiten scope**. De detectors delen `blockIndex`
  (changed new-side blocks per short class name), `blockText` (leest een blok-body;
  voor de whole-file `ROUTE`-fallback het hele bestand) en `edgeEmitter` (dedup):
  - **`route_controller`** (`routeControllerDetector`) — een gewijzigd route-bestand
    (whole-file `ROUTE`-blok) → de gewijzigde controller-methodes die het aanroept:
    array-callable `[X::class, 'm']`, string-callable `'Ns\X@m'` (namespace-prefix
    genegeerd via `shortName`), en resource-routes `Route::(api)resource('p',
    X::class|'X')` (ook de oude string-controller-vorm) → élke gewijzigde
    CONTROLLER-methode van die class.
  - **`controller_request`** (`controllerRequestDetector`) — een gewijzigde
    controller-methode → het gewijzigde `XRequest`-blok uit een type-hinted
    parameter (`\w+Request \$`) → alle gewijzigde REQUEST-methodes van die class.
  - **`controller_resource`** (`controllerResourceDetector`) — controller-methode →
    de gewijzigde API-Resource die hij bouwt/teruggeeft: `new XResource(`,
    `XResource::make|collection(`, of het return-type `): XResource`.
  - **`controller_model`** (`controllerModelDetector`) — controller-methode → het
    gewijzigde route-model-bound `Model`-blok uit een type-hinted parameter
    (`ProductGroup $productGroup`), gefilterd op MODEL-categorie zodat
    Request/Resource/interfaces afvallen → **alle** gewijzigde methodes van die
    model-class (afgesproken granulariteit: een model-param noemt een class, geen
    method).
  - **`request_policy`** (`requestPolicyDetector`) — een gewijzigde
    `FormRequest::authorize` → de gewijzigde Policy-methode die hij checkt:
    `->can('ability', XPolicy::class)` (en de array-vorm `[XPolicy::class, …]`),
    waarbij de **ability** de policy-methode is (`can('show', …)` → `XPolicy::show`).
    Een `Model::class`-ref resolvt naar zijn Policy via de `$policies`-map in een
    `*ServiceProvider` (`policiesMap`), met de `{Model}Policy`-conventie als
    fallback. `POLICY` is een nieuwe categorie (`classify.go`, `app/Policies/`);
    `isPolicyBlock` valt terug op pad/`Policy`-suffix zodat een nog niet
    her-geïngest blok ook matcht.
- **Workflow** (`workflows.go`): `buildRelationsWorkflow` draait de
  `buildRelations`-Activity één keer bij start (synchroon in `StartWorkflow`) en
  opnieuw op elk **`rebuild`**-Signal. `EnsureRelations(ctx, pr)` (spiegelt
  `ensurePRStatus`) start/hergebruikt één Execution per PR; **na een geslaagde
  ingest** roept `handleIngest` (`api.go`) 'm aan.
- **Endpoints:** read-only `GET /api/relations?pr=N` (leest het read-model);
  `POST /api/workflows/{runID}/signals/rebuild`. Block-JSON draagt nu een
  computed **`id`** (`model.go` `MarshalJSON`) zodat de frontend `parentId`/
  `childId` aan blokken matcht.
- **Frontend:** `home.mjs` laadt de relaties in `loadBlocks`, splitst
  `state.blocks` (top-level = `allBlocks` minus children) van `state.allBlocks`;
  de sidebar + navigatie draaien op `state.blocks`, children renderen in de
  **Onderliggende code**-kaart (zie `.claude/rules/detail-layout.md`). `childrenOf`
  draagt de relatie-`kind` per child mee (`{ block, kind }`, niet meer hardcoded
  `event_listener`) zodat `relatedChildren` 'm doorgeeft en `KIND_LABEL`
  (`RelatedPanel.mjs`) het juiste badge toont — het badge benoemt de **rol van de
  child** gezien vanaf zijn parent (`route_controller`→"controller",
  `controller_request`→"request", `controller_resource`→"resource",
  `controller_model`→"model", `request_policy`→"policy"). De keten nest gratis via
  drill (een child die zelf een PR-blok is krijgt zijn eigen Onderliggende-code-
  paneel): route → controller → request/resource/model, en request → policy.
- Tests: `relations_test.go` (event: detector met beide mapping-bronnen, de
  beide-kanten-eis, module round-trip, en de workflow-end-to-end; Laravel:
  `TestBuildRelationsLaravelChain` (alle vijf edges + de array-/string-/resource-
  route-vormen), `TestBuildRelationsLaravelBothSidesRequired` (geen policy-blok →
  geen `request_policy`; geen route-blok → geen `route_controller`, maar de
  controller-downstream-edges vuren wél), en `TestBuildRelationsLaravelWorkflow`);
  `tests/relations.spec.mjs` (Playwright: child weg uit de lijst, wél in het
  paneel — geseed via `slash seed -relations`).

## Aangeroepen (ook ongewijzigde) methodes resolven (`resolve_call` + `modules/callresolve` + `modules/claude`)

Naast de betekenis-relaties koppelt de **Onderliggende code**-kaart ook de
**methode-aanroepen** die een gewijzigd blok doet aan hun **definitie** — ook als
die methode in een bestand staat dat de PR **niet** wijzigde (bv. `joinAddress`
uit `->joinAddress('contract')`). Twee lagen: een Go-resolver eerst, een LLM als
fallback.

- **Waarom een apart read-model, niet de `relations`-tabel:** deze children
  wijzen naar ongewijzigde bestanden (hun block-id is dus géén PR-blok dat de
  frontend kent), én `relations.Replace` doet een full-swap per PR — een dure
  LLM-resolutie zou bij een rebuild verdwijnen. Daarom een eigen module.
- **`modules/callresolve`** (`data/callresolve.db`): het read-model
  `call_resolutions(pr, caller_id, call_key, status, child_*, model, confidence,
  updated_at)`, PK `(pr, caller_id, call_key)`. `status`: `resolved` (Go),
  `unresolved` (Go faalde → automatische LLM-search), `searching`/`found`/`notfound` (LLM).
  De rij draagt de **volledige child-descriptor + de codetekst** (`child_code`),
  dus de frontend rendert zonder losse code-fetch. Writes (workflow-only):
  `UpsertGo` (schrijft Go-rijen, maar **overschrijft geen** `searching`/`found`
  rij → LLM wint van een rebuild), `SaveSearching`, `Save`, en `Prune(pr, keep)`
  (verwijdert elke rij waarvan het `(caller_id, call_key)`-pair niet in de
  huidige Go-scan zit — de caller is uit de PR gevallen óf de call-site staat
  niet meer op een gewijzigde regel; dit ruimt óók LLM-rijen op, want de
  call-site is weg). Read: `List(pr)`. De `buildRelations`-Activity roept na
  `UpsertGo` `Prune` aan met de zojuist gescande entries als keep-set.
- **Analyse-service `callresolve_analysis.go`** (package main, géén module —
  leest de head-worktree): `resolveCalls(dataDir, pr, blocks)` bouwt via
  `buildSymbolIndex` één worktree-brede index (class→methods, method→blocks,
  Eloquent scope-alias `scopeX→x`, enums) en scant elk gewijzigd new-side blok
  met regexes (patroon van `dispatchedEvents`). **`idxSkipDirs` slaat alleen
  echt vendored/gegenereerde mappen over** (`vendor`, `node_modules`, `.git`,
  `storage`, `public`) — bewust **niet** `tests/`: een custom test-basisklasse
  (`tests/TestCase.php`, `tests/HttpTestCase.php`) of een gedeelde trait is
  net zo goed app-code, en stond eerder onterecht buiten de index. Zonder die
  kandidaat kon de Go-resolver een aanroep van zo'n geërfde test-helper nooit
  zelf pinnen (rule 1's `$this->m()`-check zoekt alleen op de eigen class, niet
  door overerving heen) en escaleerde elke zo'n call onnodig helemaal naar de
  dure agentische Sonnet-pass, die 'm via `Grep` alsnog vond. Puur additief:
  een uniek match kan nooit méér ambigu worden dan voorheen. Zie
  `TestResolveCallsTestHelperClassIndexed`. **Alleen de gewijzigde regels**
  van het blok worden gescand: `changedNewLines` dieft base↔head per bestand
  (`git diff --no-index --unified=0`, geparsed met de ingest-`parseUnifiedDiff`,
  new-side sets ge-union'd omdat `--no-index` twee absolute paden oplevert;
  ontbrekende base-file → alles telt als gewijzigd). Een call op een ongewijzigde
  regel levert dus nooit een child op — dat gaf ongerelateerde "Onderliggende
  code", b.v. een builder-`->join(` op een oude regel die uniek naar een
  toevallige app-method (`MerchantController::join`) matchte. Resolvt
  `$this->`/`self::`/`static::` (eigen class), `Foo::m(`/`(new Foo)->m(` (class
  in de call), **`$var->m(` via de receiver-variabelenaam** (regel 3b:
  `$order->billingAddress()` → `Order::billingAddress`, ook als die method op
  meerdere classes bestaat; incl. scope-vorm — dezelfde heuristiek die
  `resolvePrompt` de LLM leert; kanttekening: de call-key is de kale
  methodenaam, dus twee receivers die in één blok dezelfde method aanroepen
  vallen samen op de eerste match), en `->m(` op een **unieke** globale- of
  scope-match. Ambigu (>1 kandidaat) → `unresolved`; methodes die nergens in de app-worktree bestaan
  (vendor is geskipt — framework-calls als `->where(`) worden **óók
  `unresolved`**: ze staan per definitie op een gewijzigde regel, dus de
  automatische LLM-search pikt ze op i.p.v. niks te tonen.
  **Enum-cases** (regel 6, `reStaticRef`): een `Foo::NAAM` **zonder haakjes** —
  `AddressType::BILLING` — resolvt naar de **enum-declaratie** als `Foo` een
  geïndexeerde enum is die die case/const definieert (`scanEnums` maakt van elke
  enum een synthetisch blok, à la macros; code via `blockSource`-line-slicing;
  `child_method` = de case-naam, dus het label wordt `AddressType::BILLING`).
  `Foo::class` en constanten op niet-enum-classes worden genegeerd; dezelfde
  case op meerdere enums → `unresolved`. De frontend-`findCallSites` matcht
  daarvoor naast `naam(` en `->naam` ook `::naam`.
  **Eloquent magic properties** (regel 5, `reArrowProp`): een `->naam` **zonder
  haakjes** — `$order->billingAddress` — is Laravel-syntax voor de
  relatie-**methode** `billingAddress()`. We behandelen 'm als call als `naam` een
  methode matcht wiens body een **relatie** is (`return $this->morphOne/hasMany/
  belongsTo(...)`, `reRelationCall` + `relationshipCandidates`) — zodat kale
  attribuut-toegang (`->id`, `->total`) genegeerd blijft: eerst probeert regel
  5a de **receiver-variabelenaam** (`$order->billingAddress` →
  `Order::billingAddress`, ook bij meerdere modellen met die relatie), daarna
  regel 5 generiek: uniek → `resolved`, meerdere modellen → `unresolved` (LLM
  kiest het juiste model). Draait ná regel 4, dus een echte `->naam()`-call wint
  de key. De frontend koppelt zo'n property-
  segment aan het child via `findCallSites`, dat naast `naam(` ook `->naam`
  (property) matcht. De LLM-prompt (`resolvePrompt`) legt Haiku/Sonnet uit dat
  `->naam` en `naam()` hetzelfde target zijn en dat de receiver-variabelenaam
  (`$order` → `Order`) het juiste model verraadt.
  **Laravel-macros** worden óók geïndexeerd (`scanMacros`, aangeroepen in
  `buildSymbolIndex`): een `Receiver::macro('naam', function (…) {…})` — b.v.
  `Builder::macro('joinAddress', …)` in een `*ServiceProvider` — is een anonieme
  closure **binnen** een boot-method en dus onzichtbaar voor `ScanBlocks`
  (`skipBody` slokt de hele method-body op, inclusief de macro-registratie). We
  detecteren de registratie met een regex (`reMacroDef`) en maken er een
  synthetisch block van (`Class` = de receiver, `Name` = de macro-naam), zodat een
  `->joinAddress(`-call via regel 4 als een gewone unieke method resolvt. De code
  van zo'n macro komt via `blockSource` (code.go): de symbool-lookup faalt (het
  block is genest, niet top-level), dus die valt terug op line-slicing op de
  opgeslagen `Line`/`EndLine`.
  **Artisan-commando's** (regel 3c, `reCommandCall`): een geschedulede
  `$schedule->command('accounting:import --provider=…')`-call resolvt naar de
  **`handle`-method van de commando-class**. `buildSymbolIndex` bouwt daarvoor
  een `commands`-map: `scanCommands` leest elke `protected $signature = 'naam …'`
  (alleen `$signature`, commando-specifiek), neemt het **eerste token** als
  commando-naam en koppelt die aan de `handle`-block van dezelfde file. De
  **call-key is de commando-naam** (`accounting:import`), niet `command`, zodat
  verschillende geschedulede commando's aparte children blijven; de generieke
  `->command(`-arrow-call wordt onderdrukt (`seen["command"]`). Een commando
  zonder app-class (framework, b.v. `queue:work`) wordt `unresolved`. De
  frontend-`findCallSites` matcht een commando-key (bevat `:`/`-`, dus nooit een
  method-identifier) via de **string-literal** `command('naam…')` i.p.v. de
  identifier-vormen.
  **Laravel-facades** (regel 3, fallback op `reStaticCall`): een facade forwardt
  z'n static calls naar zijn accessor-class, dus `AccountingClient::providers()`
  draait feitelijk op `AccountingDriver::providers()`. `buildSymbolIndex` bouwt
  een `facades`-map (facade-shortname → accessor-shortname) met `scanFacades`: die
  detecteert `class X extends …Facade` (`reFacadeClass`) plus de
  `getFacadeAccessor() { return Y::class; }` (`reFacadeAccessor`) en koppelt X→Y
  (positioneel gepaird — een facade-file bevat één facade + één accessor). In
  regel 3 valt een `Foo::m(` die niet op `Foo` zélf resolvt terug op
  `methodOnClass(accessor, m)` als `Foo` een geïndexeerde facade is. Een method
  die óók op de accessor niet bestaat (b.v. de framework-`Manager::forgetDrivers()`
  ná `providers()`, vendor is niet geïndexeerd) blijft `unresolved` → automatische LLM-search.
  **Eloquent-model als geheel** (regel 2c, `new Model()`/`Model::…`): gebruikt een
  controller/service een Eloquent-model (`new ProductGroup()`, `ProductGroup::query()`
  — bv. gevolgd door `->fill()`/`->save()`), dan wil de reviewer **het model zelf**
  als Onderliggende code zien, niet zijn constructor of een losse geërfde
  Eloquent-methode (`fill`/`save`/`query` zijn nooit in de app gedefinieerd en
  blijven dus gewoon `unresolved`, ongewijzigd). `buildSymbolIndex` indexeert elk
  bestand onder `app/Models/` (`hasSeg(rel, "app/Models/")`) met `scanModels` —
  een **whole-class synthetisch blok** per class-declaratie (`Class` = de
  modelnaam, `Name` leeg, spant de hele class-body — mirror van `scanEnums`,
  `blockSource` valt voor de lege `Name` terug op line-slicing) — in een aparte
  `idx.models`-map (modelnaam → blok). Rule 2c scant `new Foo(`
  (`reNewObj`) én `Foo::m(` (`reStaticCall`) op een receiver die in `idx.models`
  zit en emit **één** child per model (call-key = modelnaam, `seen`-gededupt —
  instantiatie + een latere statische call op hetzelfde model in één blok geven
  dus nooit twee children), met `ChildClass` = de modelnaam en **`ChildMethod`
  leeg** — de frontend-`blockLabel`-conventie toont dan de kale modelnaam
  (`ProductGroup`), geen `::method`. Rule 2b (`new Foo()` → constructor) **sluit
  een model-class expliciet uit** (`idx.models[class]`-check) — ook als het model
  wél een expliciete `__construct` heeft, wijst dit nooit naar de constructor: de
  reviewer wil het model, niet zijn constructor-body. Diffstat/`Ongewijzigd`-badge
  komen gratis mee (hetzelfde mechanisme als elk ander `method_call`-child, op
  basis van of `ChildFile` in de PR wijzigt). Andere resoluties op dezelfde regel
  (bv. `ProductGroupResource::make($productGroup)` → de resource-class) blijven
  ongemoeid — dit is een aanvullende child, geen vervanging.
- **`modules/claude`** (`modules/claude/claude.go`): de CLI-bridge naar `claude`
  (`Client`-interface + `Fake`, patroon van `modules/github`). `Run` shelt uit
  naar `claude -p <prompt> --model <id>` met context-timeout; agentisch (Sonnet)
  krijgt `cwd`=head-worktree + read-only tools (`Read,Grep,Glob`). Model-ID's:
  `claude-haiku-4-5`, `claude-sonnet-5`. **`SLASH_CLAUDE=off`** → `claude.Fake`
  (geen netwerk; leeg = resolvt niets), voor offline/tests.
  - **Context-only Haiku-calls draaien vanuit een neutrale scratch-cwd, niet de
    slash-repo.** `claude` laadt bij elke `-p`-aanroep automatisch de volledige
    project-`CLAUDE.md` + `.claude/rules` van zijn cwd als systeemcontext —
    voor een context-only call (geen tools, `RunRequest.WorkDir == ""`: de
    Haiku-pass van `resolve_call`, `explain_code`, `pr_status`'s samenvatting)
    is dat **pure overhead**, want die prompts gaan over PHP-code in de PR, niet
    over hoe dit project gebouwd wordt. Gemeten: ~110k `cache_creation`-tokens
    (~$0,22 op een triviale test-call) met cwd = slash-repo, tegen ~7k
    (~$0,016) met een lege cwd buiten elke repo — een daling van ~94%. `Module`
    (`claude.go`) draagt daarom een `scratchDir`-veld: `Run` zet `cmd.Dir` op
    `req.WorkDir` als die gezet is (agentisch, ongewijzigd — Sonnet blijft in de
    checked-out PR-worktree draaien voor `Read`/`Grep`/`Glob`), anders op
    `m.scratchDir`. `tasks_api.go` geeft `claude.New(...)` daarvoor een pad
    **onder `os.TempDir()`** mee (`slash-llm-cwd`), expliciet **niet** onder
    `dataDir`: `claude` zoekt een `CLAUDE.md` door **omhoog** de directory-boom
    te lopen (zoals git naar `.git` zoekt), dus een lege submap van de
    slash-repo (bv. `data/llm-cwd`) laadt via die ouder-keten alsnog de
    repo-`CLAUDE.md` — empirisch bevestigd (bleef ~112k tokens) vóórdat de
    locatie naar `os.TempDir()` verplaatst werd. Voor de agentische
    Sonnet-escalatie verandert er niets: die worktree draagt **plug-and-pay's
    eigen** `CLAUDE.md`/`.claude/rules` (~150k+ tokens overhead, groter dan
    slash's eigen ~110k) en dat is een apart, groter vraagstuk (alleen `--bare`
    + een losse `ANTHROPIC_API_KEY` i.p.v. de huidige OAuth/abonnement-auth zet
    die auto-discovery echt uit — een auth/billing-besluit, hier bewust
    ongemoeid gelaten).
  - **De statische instructietekst per actie staat los van de wisselende
    call-inhoud, via `--append-system-prompt`.** `RunRequest.SystemPrompt`
    draagt het call-onafhankelijke deel van elke prompt (taakomschrijving +
    JSON-contract voor `resolve_call`, de Nederlandse if-uitleg-instructie voor
    `explain_code`, de "Vat samen…"-instructie voor `pr_status`'s
    samenvatting) — **byte-voor-byte** dezelfde tekst die voorheen inline in de
    `-p`-prompt stond, nu verplaatst naar `modules/claude/prompts/
    {resolve_call,explain_code,pr_summary}.md` en met `//go:embed` ingebed
    (stdlib, geen dependency, geen build-stap) als `claude.ResolveCallSystemPrompt`/
    `ExplainCodeSystemPrompt`/`PRSummarySystemPrompt`. Bewust **niet** onder
    `.claude/` (dat zou zelf weer auto-discovery-gevoelig zijn in een
    interactieve `claude`-sessie in déze repo) maar onder `modules/claude/
    prompts/` — prompt-inhoud voor een subprocess-aanroep, geen documentatie
    voor dit project. `resolvePrompt`/`explainPrompt`/`prSummaryPrompt` bouwen
    nog altijd de wisselende inhoud (call-naam, caller-body, kandidatenlijst,
    geselecteerde code, PR-metadata) — alleen het altijd-gelijke stuk is eruit
    getild. Puur een verplaatsing: de uiteindelijke instructietekst die het
    model ziet is ongewijzigd (geverifieerd met een byte-gelijkheids-test tegen
    de embedded content), dus resolutie-kwaliteit verandert niet. Bijkomend
    voordeel: omdat dit systeemprompt-deel nu identiek is over herhaalde calls
    van dezelfde actie binnen één PR (bv. 32× `resolve_call`), kan `claude`'s
    eigen prompt-cache het hergebruiken — dat kon niet toen het inline in de
    steeds wisselende `-p`-string stond.
  - **Determinisme:** beide wijzigingen zitten volledig binnen `Module.Run`
    (cwd-keuze) en de `RunRequest`-payload (`SystemPrompt`) — het aantal/de
    volgorde van `cl.Run`-aanroepen per workflow-body is ongewijzigd, dus dit
    raakt de replay-determinisme-eis (`.claude/rules/workflow-determinism.md`)
    niet.
- **Workflow `resolve_call`** (`workflows.go` + `resolve_call.go`): één Execution
  per zoekactie. Body (deterministisch — escalatie op basis van de **opgeslagen**
  Haiku-uitkomst, niet live output): `markCallsSearching` → `resolveWithModel`
  (Haiku, context-only shortlist uit de Go-index) → voor de calls die Haiku niet
  zeker vond **automatisch** `resolveWithModel` (Sonnet, agentisch) → merge →
  `saveResolutions`. **Puur automatisch, géén signal.** Elke LLM-claim wordt
  tegen de worktree geverifieerd (`verifyDefinition` + path-containment) vóór hij
  `found` wordt.
- **Endpoints:** `POST /api/workflows/resolve_call` (start; body `{pr, callerId,
  callerFile, callerClass, callerName, calls}`) en read-only
  `GET /api/callresolve?pr=N`. De `buildRelations`-Activity schrijft de Go-rijen
  mee (naast de relaties). Voortgang: de UI herlaadt het read-model op een
  interval (zoals `syncComments`), geen run-poll. De headless twin
  **`slash relations <pr>`** (`main.go`) draait naast `buildRelations` óók
  `resolveCalls` + `UpsertGo`/`Prune`, zodat een re-run zónder volledige
  re-ingest het Onderliggende-code-read-model ververst (handig na een
  resolver-wijziging).
- **Frontend:** `home.mjs` laadt `state.callResolve` (`loadCallResolve`), voegt
  `resolved`/`found`-rijen als `method_call`-children toe (`relatedChildren`), en
  start de LLM-search voor `unresolved` calls **automatisch** — geen knop:
  `startCallSearch(focusedBlock())` draait in de `setRelated`-watch zodra het
  paneel een blok met onopgeloste calls toont (gededupt per caller+callKey in
  `searchRequested`, lost de héle unresolved-set van het blok op i.p.v. gescoped
  op de selectie). Het paneel toont alleen nog de "zoeken…"-indicator
  (`related-searching`). De kaart
  **volgt de cursor**: `findCallSites` mapt elke call-methode naar het diff-segment
  waar hij staat, `callScopeMethods` scope't in diff-mode op de geselecteerde unit
  (op `gran==='call'` de ene actieve call; op line/group de calls op de regels
  binnen `[unit.start, unit.end]`), en alleen in list-mode toont hij alle calls van
  het block, geordend (gewijzigd child-blok → call op gewijzigde regel → rest). De lijst wordt in een `watch` berekend en via
  `setRelated` het paneel in geduwd (niet in de render-binding — dat racet met de
  diff over `b.code`). Een LLM-gevonden child toont een **`bron: haiku/sonnet`**-badge
  (de `source` uit de rij; Go-resolved toont geen bron). Zie
  `.claude/rules/detail-layout.md`.
- Tests: `callresolve_analysis_test.go` (resolver op fixture-PHP, incl. een
  macro-call → `Builder::joinAddress`, de gewijzigde-regels-restrictie met een
  echte base+head-diff, een enum-case → `AddressType::BILLING`, een
  geschedulede `->command('accounting:import …')` → `AccountingImport::handle`,
  een facade-call `AccountingClient::providers()` → `AccountingDriver::providers`,
  en `TestResolveCallsModelUsage`/`TestResolveCallsModelWithoutConstructor`
  (`new Model()`/`Model::…` → één gededupte whole-class model-child, nooit de
  constructor ondanks dat die soms bestaat, `fill`/`save` blijven `unresolved`,
  een resource-resolutie op dezelfde regel blijft ongemoeid)),
  `resolve_call_test.go` (Haiku-confident → found; escalatie naar Sonnet;
  notfound; verificatie weigert een verzonnen definitie), en
  `modules/callresolve/callresolve_test.go` (round-trip + UpsertGo bewaart LLM +
  `Prune` ruimt wees-callers én stale call-keys op).
  De frontend-kant heeft een **seed-pad**: `slash seed … -callresolve
  <callresolve.json>` (mirror van `-relations`) laadt resolved rijen in
  `callresolve.db` zodat Playwright de `method_call`-children rendert zonder
  resolver-run (`tests/fixtures/callresolve.json`, PR 91 in `relations.spec.mjs` —
  bewijst o.a. dat het Onderliggende-code-paneel de blok-selectie volgt).
- **`kind`-kolom (`call_resolutions.kind`, default `method_call`):** onderscheidt
  een gewone call-resolutie van een **class-niveau** child (`ChildMethod` leeg —
  het hele model, geen method). `Entry.Kind` in Go: leeg → genormaliseerd naar
  `KindMethodCall` bij het schrijven (`UpsertGo`/`Save` in
  `modules/callresolve`), dus geen van de bestaande call-emittende regels (1
  t/m 6) hoefde aangepast — alleen `emitKind` (de nieuwe onderliggende
  implementatie van `emit`, met een expliciete `kind`-parameter) wordt door
  rule 2c (`KindModelUsage`) en `resolveMigrationModels` (`KindMigrationModel`,
  zie hieronder) aangeroepen. Een bestaande `callresolve.db` migreert via een
  lichte `ALTER TABLE … ADD COLUMN` (dubbele-kolom-fout genegeerd — het
  standaardpatroon uit `relations`/`comments`). Frontend: `resolvedCallChildren`
  (`home.mjs`) neemt `r.kind` **over** i.p.v. altijd `'method_call'` te
  hardcoden, en het **label** vertakt op `r.childMethod` (leeg → kale
  `r.childClass`, gevuld → het bestaande `Class::method`-template) — dit gold al
  vóór deze kolom bestond voor rule 2c's model-usage-children (die toonden
  ooit een `"ProductGroup::"` met een lege, lelijke `::`-staart) en geldt nu
  ook voor `migration_model`. `KIND_LABEL` (`RelatedPanel.mjs`) koppelt zowel
  `model_usage` als `migration_model` aan het badge-woord **"model"**; de
  `diffStatBadge`/`unchanged`-helpers herkennen beide kinds naast
  `method_call`/`covers` (gedeelde `DIFFSTAT_KINDS`-set) zodat ze óók een
  `+A −R`/`Ongewijzigd`-badge en grijze "ongewijzigd"-ringstijl krijgen, exact
  als een gewone call-child.
- **Migratie → model (`resolveMigrationModels`, `callresolve_analysis.go`):**
  een gewijzigde migratie hoort meestal bij een **al bestaand, ongewijzigd**
  model — het hoofdgeval is "kolom toevoegen aan een bestaande tabel", niet
  "nieuw model + nieuwe migratie tegelijk". Dat maakt dit een **callresolve**-
  regel (mag naar een ongewijzigd bestand wijzen), geen `relations`-detector
  (die zijn allemaal both-changed, zie de Laravel-keten hierboven) — en zonder
  LLM-fallback: de mapping is regelgebaseerd en deterministisch, dus een
  migratie die niet te mappen valt levert **stil niets** op (geen
  `unresolved`-rij, geen "Zoek"-knop). Scope: elk gewijzigd
  `Category == "MIGRATION" && Name == "up"`-blok (een migratie is altijd de
  anonieme `return new class extends Migration {...}`, dus `Class == ""` — zie
  `classify.go`'s `database/migrations/`-regel en `phpscan.go`'s
  anonieme-class-afhandeling; alleen `up` telt, `down` nooit). Per
  `Schema::create('tabel', ...)`/`Schema::table('tabel', ...)`-match
  (`reSchemaTable`, beide tellen — een kolom-migratie hoort net zo goed bij
  zijn model als een create-migratie) in de `up`-body: tabel → model via (1)
  een expliciete `protected $table = '...'`-override
  (`idx.modelTables`, gevuld tijdens dezelfde `buildSymbolIndex`-worktree-walk
  als `idx.models`/`scanModels` — geen tweede walk) of (2) de Eloquent-conventie
  (`singularizeTable` — een bewust **pragmatische**, niet-volledige
  inflector: `-ies`→`-y`, trailing `-s` weg — gevolgd door `studly`). Eén
  gededupte child per distinct tabel (`seenTable` binnen de migratie — twee
  `Schema::table`-calls op dezelfde tabel geven dus nooit twee children), child
  = het `idx.models`-whole-class-blok (hetzelfde synthetische blok als rule
  2c hierboven — `ChildMethod` leeg, kale modelnaam-label). `CallKey` =
  `"migration_model:" + tabel` (nooit botsend met een echte method-call-key,
  die bevat geen `:`). De entries van deze functie worden in de
  `build_relations`-Activity (`workflows.go`) **samengevoegd** met
  `resolveCalls`'s entries vóór de ene `UpsertGo`/`Prune`-aanroep — dus geen
  aparte prune-scope nodig, migratie-rijen zitten vanzelf in de keep-set zolang
  hun migratie in de PR blijft wijzigen.
- Tests: `TestResolveMigrationModelsConvention`/`ExplicitTable`/
  `MultipleTablesDeduped` (`callresolve_analysis_test.go`, fixture-PHP: een
  `Schema::create`-migratie die via de conventie naar zijn model resolvt, een
  `$table`-override die de conventie overstemt, en een migratie met twee
  `Schema::table`-calls op dezelfde tabel + een niet-mapbare tabel — gededupt
  resp. stil overgeslagen); `TestKindRoundTrip`/`TestMigrateAddsKindColumn`
  (`modules/callresolve/callresolve_test.go`: lege Kind normaliseert naar
  `method_call` via zowel `UpsertGo` als `Save`, een expliciete Kind
  round-trippt, en een DB zonder de kolom migreert bij `Open`).
  Playwright: `tests/migration-model.spec.mjs` (PR 101, `migrationmodel-*.json`
  — bewijst dat zowel een `model_usage`- als een `migration_model`-child een
  kale modelnaam + "model"-badge tonen, nooit de `Class::`-vorm).

## Testdekking koppelen (`resolve_test_covers` + `modules/testcovers`)

Een PHPUnit-testmethode koppelt aan de methode die hij test — in **beide
richtingen** van de "Onderliggende code"-kaart: een test toont de geteste
methode als kind, én een geteste productiemethode toont "gedekt door
TestX::testY" als kind (mits de test zelf ook door de PR wijzigt, want alleen
dán bestaat er een test-PR-blok om aan te hangen). Twee lagen, net als bij
call-resolve: een Go-detector eerst, een **beperkte** AI-fallback alleen voor
één specifiek geval.

- **Waarom een eigen module, geen `relations`-rij:** de geteste methode kan in
  een bestand staan dat de PR **niet** wijzigt (het normale geval — een
  bestaande test op bestaande productiecode), dus is zijn block-id vaak geen
  PR-blok dat de frontend kent. Net als `callresolve` draagt een rij daarom de
  **volledige child-descriptor + codetekst**, niet alleen een block-id-paar.
- **`modules/testcovers`** (`data/testcovers.db`): het read-model
  `test_covers(pr, test_id, target_key, status, covered_*, annotation, model,
  confidence, updated_at, line)`, PK `(pr, test_id, target_key)`. `target_key`
  mirrort callresolve's `call_key`: `"method:Class::method"` voor een statisch
  opgeloste annotatie, `"class:Class"` voor een class-niveau-annotatie
  (AI-territorium), `"none"` voor "geen annotatie". `line` (distinct van
  `covered_line`, de declaratieregel van de **geteste** methode) is de
  absolute broncoderegel **binnen het testbestand zelf** waar de
  coverage-annotatie staat — vastgelegd door de Go-scan (`coverTarget.line` in
  `testcovers_analysis.go`, via dezelfde `matchLine`-aanpak als de
  relations-detectors) en gebruikt door de frontend om het
  Onderliggende-code-paneel te herordenen op de geselecteerde `group`-unit
  (zie `groupLineRange`/`resolvedTestCoverChildren` in `home.mjs`, en de
  "Onderliggende code"-sectie in `.claude/rules/detail-layout.md`). Alleen
  gezet op een `resolved`/`unresolved` rij (de annotatie leeft in de tekst die
  de Go-scan doorzoekt); een `found`-rij die van een `unresolved`
  class-only-annotatie escaleerde (zie hieronder) draagt 'm bewust **niet**
  door — te veel extra plumbing (API/workflow/Activity-payload) voor dit
  smalle AI-pad, dus zo'n rij degradeert naar dezelfde "niet in de group"-tier
  als `covered_by` (zie `detail-layout.md`). Zes statussen — de vijf van
  `callresolve` plus één nieuwe terminale:
  - **`resolved`** — een **method-niveau** annotatie (`#[CoversMethod(Class::class,
    'method')]`, `@covers Class::method`, of `@coversDefaultClass` +
    `@covers ::method`) noemt **altijd** zowel class als methode, dus dit
    resolvt **statisch, zonder AI**, geverifieerd tegen de worktree.
  - **`unannotated`** — geen enkele annotatie gevonden → **permanente warning,
    nooit AI**.
  - **`unresolved`** — een **class-niveau-only** annotatie (`#[CoversClass(Class::class)]`,
    kale `@covers Class`) noemt alleen een class, geen methode → precies de
    betekenis van callresolve's `unresolved`: "Go kon 'm niet pinnen, bied de
    AI-zoektocht aan" — triggert automatisch `resolve_test_covers`.
  - **`searching`/`found`/`notfound`** — LLM-owned, identiek aan callresolve.
  - Write `UpsertGo` (schrijft `resolved`/`unannotated`/`unresolved`-rijen,
    overschrijft nooit een `searching`/`found`/`notfound`-rij — een Go-rebuild
    mag een dure AI-resolutie niet wegvegen) en `Prune` (ruimt weesrijen op wier
    `(test_id, target_key)` niet meer in de huidige scan zit), `SaveSearching`/
    `Save` voor de AI-tak, `List` read-only.
- **Statische detector `testcovers_analysis.go`** (package main, leest de
  head-worktree): `scanTestCovers(dataDir, pr, blocks)` scant, per **gewijzigd
  testbestand** (TEST-categorie PR-blokken — geen whole-worktree-scan van
  tests), de ruwe tekst rond elke testmethode (`methodZone`, begrensd door het
  vorige blok in hetzelfde bestand) én rond de class-declaratie (`classZone`,
  alles vóór het eerste `class`-keyword — voor een class-brede
  `@coversDefaultClass`/`#[CoversClass]`/kale `@covers Class`) op de vier
  annotatievormen, puur regex, geen parser. Een method-niveau-annotatie wint
  altijd van een class-niveau-annotatie voor dezelfde class (geen dubbele
  AI-zoektocht als de methode al precies bekend is). Een testmethode wordt
  herkend via de `test`-naamprefix of een `#[Test]`/`@test`-marker
  (`isTestMethod`) — zo blijven `setUp`/helper-methodes buiten beschouwing.
  `buildTestCovers` wordt aangeroepen **in de bestaande `buildRelations`-Activity**
  (naast de bestaande `resolveCalls`/`UpsertGo`/`Prune`-aanroep voor
  callresolve) — geen apart Workflow Type voor dit statische deel, exact
  hetzelfde precedent als callresolve's Go-rijen.
- **AI-tak `resolve_test_covers.go` + workflow `resolveTestCoversWorkflow`**
  (mirror van `resolve_call.go`/`resolveCallWorkflow`): draait **uitsluitend**
  voor `unresolved`-targets (een class-niveau-only annotatie) — **nooit** voor
  `unannotated`. Haiku krijgt als context de **kandidaat-methoden van de
  genoemde class** (`idx.byClass[class]`, dezelfde beperkte, goed te verifiëren
  scope als de coordinator vroeg) + de testmethode-body, en kiest **welke
  methode** de test uitoefent; bij lage confidence escaleert automatisch naar
  Sonnet (agentisch, `Read/Grep/Glob` in de worktree). Elke claim wordt
  geverifieerd: de methode moet **echt bestaan op de genoemde class**
  (`methodOnClass`) — strenger dan `verifyDefinition` omdat de class al vastligt
  door de annotatie, alleen de methode is onzeker. Resultaat `found`
  (met `model`/`confidence`) of `notfound`.
- **Endpoints:** `POST /api/workflows/resolve_test_covers` (start; body `{pr,
  testId, testFile, testClass, testName, classes}`) en read-only
  `GET /api/testcovers?pr=N`.
- **Frontend** (`home.mjs`): `state.testCovers` (`loadTestCovers`).
  **Richting 1** (test → geteste methode): `resolvedTestCoverChildren(b)` voor
  een TEST-blok `b` — kind `covers`, dezelfde diffstat/`Ongewijzigd`-badge en
  `bron: haiku/sonnet`-badge als een `method_call`-child. **Richting 2**
  (geteste productiemethode → dekkende test): `coveredByChildren(b)` — kind
  `covered_by`, hergebruikt het bestaande test-PR-blok (geen los codesnapshot
  nodig). Beide zijn **block-level** (zoals `event_listener`): ze vallen weg op
  `gran==='call'`, net als de listener-children — dekking is geen
  regel/call-gebonden begrip. `directChildBlocks`/`nestedPrBlocks` (de
  combinatie-goedkeuringspil) nemen **alleen richting 1** mee (test → geteste
  methode); richting 2 bewust **niet**, om een method↔test-cyclus in die
  recursieve rollup te vermijden. **Testdekking verbergt géén enkel blok uit de
  linkerlijst** — noch de test, noch de geteste methode. Anders dan een
  call-target of een listener (vaak echt ongewijzigde referentiecode die
  `resolvedCallTargetIds`/de relatie-children wél uit de lijst halen) is een
  geteste methode die een PR-blok is **altijd** gewijzigde, primair te-reviewen
  code (bv. een nieuw toegevoegde controller die de PR introduceert). Een test
  mag zo'n blok dus nooit uit de tree laten verdwijnen: `recomputeLeftList`
  voegt `testCoverTargetIds()` **niet** aan de hidden-set toe (de functie
  bestaat nog, maar wordt niet meer gebruikt om te verbergen). Beide kanten
  blijven in de lijst én verschijnen daarnaast als elkaars Onderliggende-code-
  kind: de test toont de geteste methode als `covers`-kind, de methode toont de
  test als `covered_by`-kind — volledig symmetrisch.
  **Warning** (`data-testid=related-covers-warning`, custom inline SVG,
  in de kaart-header naast `related-approval-total`): getoond zodra het
  gefocuste TEST-blok een `unannotated`- of (na een mislukte AI-zoektocht)
  `notfound`-rij heeft, met per geval andere tekst. **"zoeken…"**-indicator
  (`related-searching`) hergebruikt dezelfde `searching()`/`pending()`-helpers
  als callresolve — `unresolvedTestCovers(b)` wordt gewoon meegeconcateneerd in
  hetzelfde `unresolved`-argument van `setRelated`. De AI-search start
  **automatisch** (`startTestCoverSearch`, dezelfde `setRelated`-watch als
  `startCallSearch`), gededupt per test+class in `testCoverSearchRequested`.
- Tests: `testcovers_analysis_test.go` (alle annotatievormen, class-niveau →
  `unresolved`, een onverifieerbare claim → effectief `unannotated`, een
  niet-TEST-blok wordt geskipt, en een `build_relations`-end-to-end-test die
  bevestigt dat de Activity ook `testcovers.db` vult), `resolve_test_covers_test.go`
  (mirror van `resolve_call_test.go`: Haiku-confident → found, escalatie naar
  Sonnet, notfound, verificatie weigert een methode die niet op de genoemde
  class bestaat), `modules/testcovers/testcovers_test.go` (round-trip,
  `UpsertGo` beschermt een `found`-rij, `Prune` ruimt weesrijen op).
  Playwright: `tests/testcovers.spec.mjs` (beide richtingen + drill-recursie,
  beide warning-varianten, het `bron: sonnet`-badge), geseed via
  `slash seed … -testcovers <testcovers.json>` (mirror van `-callresolve`,
  `tests/fixtures/testcovers.json` + `testcovers-blocks.json`, PR 92/93/94).

## AI-omschrijving van een if-unit (`explain_code` + `modules/explanations`)

Een klein Workflow Type, **`explain_code`**, genereert de **footer-omschrijving**:
een korte Nederlandse Haiku-uitleg van het if-statement in de gefocuste
`line`/`group`-navigatie-unit (zie de Footer-sectie in
`.claude/rules/keyboard-navigation.md` voor de frontend-kant). Eén Execution
per **unit + code-hash**, geen Signals — hij completet meteen.

- **`modules/explanations`** (`data/explanations.db`): het read-model
  `explanations(pr, block_id, unit_key, code_hash, status, text, model,
  updated_at)`, PK `(pr, block_id, unit_key)` — maximaal één levende rij per
  unit; een nieuwe hash (nieuwe commit) overschrijft de oude rij.
  `status`: `searching`/`done`/`failed` (`failed` is terminaal — offline/
  Claude-hiccup, de footer toont dan niets en vraagt niet opnieuw). Writes
  (`SaveSearching`/`Save`) workflow-only; `List(pr)` read-only. Een rij met
  **lege `code_hash`** matcht frontend-side elke hash (seed-fixtures).
- **Input-gedreven, geen worktree-reads:** `ExplainCodeInput` draagt álles wat
  de LLM ziet — de unit-code (new-side tekst van de aligned rows), de
  omringende blokcode als context (frontend-truncated,
  `EXPLAIN_CONTEXT_LINES`), bestand/label/gran, de `unitKey`
  (`group-<start>-<end>`/`line-<row>`, dezelfde codeRef-vorm als
  `commentPath`) en de `codeHash` (frontend-`fnv1a` over code+context; de
  backend slaat 'm alleen op). De workflow-body is dus een pure functie van
  zijn input.
- **Workflow** (`workflows.go` + `explain.go`): `markExplainSearching` →
  `generateExplanation` (Haiku via `modules/claude`, **context-only** — geen
  tools, geen Sonnet-escalatie; lege output → `failed`) → `saveExplanation`.
  De done/failed-beslissing leest het **opgeslagen** Activity-resultaat
  (history), dus replay-deterministisch.
- **Idempotente start:** `StartExplainCode` gebruikt `StartWorkflowID` met een
  **deterministische Run ID** (`explainRunID`: `expl-` + sha256 over
  pr|blockId|unitKey|codeHash, gehasht omdat block-id's paden/dubbele punten
  bevatten en Run ID's als JSONL-bestandsnaam dienen) — een herhaalde selectie
  of dubbele POST hergebruikt de bestaande run i.p.v. een tweede LLM-call.
- **Endpoints:** `POST /api/workflows/explain_code` (start; body
  `{pr, blockId, file, label, gran, unitKey, codeHash, code, context}`) en
  read-only `GET /api/explanations?pr=N`.
- **Frontend** (`home.mjs`): de footer-`watch` detecteert een if in de
  gefocuste unit (`reIfStatement`), toont "genereren…" en start de workflow
  automatisch met een 600ms-debounce, client-side gededupt
  (`explainRequested`) en pas nadat het read-model minstens één keer geladen
  is (`explanationsLoaded` — anders zou een verse run een al bestaande/geseede
  rij overschrijven vóór de eerste GET binnen was). `SLASH_CLAUDE=off` →
  `claude.Fake` → `failed`-rij → footer stil.
- Tests: `explain_test.go` (Fake-Haiku → done-rij + Nederlandse prompt-check,
  idempotente herstart, offline → failed),
  `modules/explanations/explanations_test.go` (round-trip + hash-supersede),
  `tests/footer-explanation.spec.mjs` (geseede weergave, if vs. geen if,
  gedrilde kolom; PR 97, geseed via `slash seed … -explanations
  <explanations.json>` + de in `tests/_setup.mjs` gematerialiseerde
  `pr-97`-worktrees).

## Reviewer-goedkeuring persisteren (`approve` + `modules/approvals`)

Een vijfde Workflow Type, **`approve`** (één Execution per PR), maakt reviewer-
goedkeuring **durable** zodat een browser-refresh onthoudt wat is afgevinkt.
Patroon van `build_relations`/`pr_status`.

- **`modules/approvals`** (`data/approvals.db`): het read-model
  `approvals(pr, block_id, rows, calls, PRIMARY KEY(pr, block_id))`, met `rows`/
  `calls` als JSON-arrays (de goedgekeurde rij-indices resp. de
  `${row}:${segStart}`-call-segment-keys — de client-side `b.approvedRows`/
  `b.approvedCalls`). Write `Replace(pr, blockID, rows, calls)` (workflow-only):
  full-swap per block, een **leeg** stel verwijdert de rij → replay-safe. Read
  `List(pr)`.
- **Workflow** (`workflows.go`): `approveWorkflow` is een lus op een **`set`**-
  Signal (`ApprovalSignal{blockId, rows, calls}`); elke `set` draait één
  `saveApproval`-Activity die `approvals.Replace` aanroept. Deterministisch: het
  aantal Activities is exact het aantal `set`-Signals in de history (geen live
  state, geen klok/random). Nooit-completend — een lange-levende per-PR tracker.
  `EnsureApprovals(pr)` (spiegelt `EnsurePRStatus`) start/hergebruikt één Execution
  per PR, ook na herstart (`engine.Recover()` her-blokkeert de waiting Execution op
  `set`; `findApproveLocked` vindt 'm terug).
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/approve {pr}` →
  `EnsureApprovals`, geeft `runId`; de generieke `POST
  /api/workflows/{runID}/signals/set {blockId, rows, calls}` levert het Signal;
  read-only `GET /api/approvals?pr=N` → `approvals.List(pr)`.
- **Frontend** (`home.mjs`): `loadApprovals` ensuret de tracker (runId in
  `state.approveRunId`) en herstelt per block-id `b.approvedRows`/`b.approvedCalls`.
  Elke mutatie (`toggleApprove`/`toggleCallApprove`, plus de top-checkbox via de
  `onApprove`-callback die `Block.mjs` uitvoert) stuurt ná de lokale hertoewijzing
  `persistApproval(b)` → het `set`-Signal met het volledige stel voor dat block. De
  UI schrijft nooit direct — alleen dit Signal (write-boundary).
- **GitHub "Viewed"-vinkje in sync houden:** een viewed-verzoek lift mee op
  hetzelfde `set`-Signal — mirror van `ReactionSignal.Action`. `ApprovalSignal`
  draagt daarvoor `File string` + `Viewed *bool`: `nil` = gewone block-approval-
  set (bestaand gedrag), niet-`nil` = "markeer/ontmarkeer dit bestand" en
  `BlockID`/`Rows`/`Calls` worden genegeerd. `approveWorkflow` vertakt op
  `sig.Viewed != nil` naar de Activity **`setFileViewed`** (i.p.v.
  `saveApproval`), die `github.Client.MarkFileViewed(ctx, pr, file, viewed)`
  aanroept — de enige plek die GitHub's Files-changed-"Viewed"-checkbox zet
  (`gh api graphql`: eerst het PR-node-ID ophalen, dan `markFileAsViewed`/
  `unmarkFileAsViewed` als mutatie). De UI detecteert de transitie zelf:
  `syncViewedFiles` in `home.mjs` groepeert `state.blocks` per bestand en
  vergelijkt "alle blokken van dit bestand volledig approved + code geladen"
  tegen `state.viewedFiles`; alleen bij een overgang (net compleet / niet meer
  compleet) stuurt het het signal. Het draait aan het eind van
  `persistApproval` (elke approve-toggle) én in `ensureCode` zodra een block se
  code alsnog arriveert (voor het geval een bestand pas ná een refresh z'n
  laatste code-fetch binnenkrijgt).

## Ingest-pipeline als workflow (`ingest` + `.claude/rules/blocks-and-ingest.md`)

Een zesde Workflow Type, **`ingest`**, tilt de PR→blocks-pipeline binnen de
write-boundary: vóór deze workflow schreef `ingestPR` de `blocks`-tabel en de
git-worktrees rechtstreeks vanuit `handleIngest` (HTTP) en de CLI — de enige
echte doorbraak van de "alleen workflows muteren state"-regel. Eén Execution
per ingest-verzoek, **geen Signal** — de workflow-body draait zijn twee
Activities sequentieel en completet meteen (`StartWorkflow` drijft 'm
synchroon tot completion omdat er geen `WaitSignal` in zit).

- **`prepareWorktrees`-Activity:** `gh pr view` (via `fetchPRMeta`) +
  `ensureCommits` + de twee `ensureWorktree`-calls (`ingest.go`,
  `prepareIngestWorktrees`). Retourneert alleen de kleine `worktreeSHAs`-summary
  (base-SHA, head-SHA, gewijzigde bestandspaden) — niet de worktree-inhoud, die
  op schijf blijft op zijn deterministische pad (`worktreeDirs`).
- **`scanAndStoreBlocks`-Activity:** `git diff` + de PHP-scanner/classificatie +
  `replacePRBlocks` (`ingest.go`, `scanAndStoreIngestBlocks`) — de enige plek die
  de `blocks`-tabel nog schrijft. Retourneert alleen de kleine
  `ingestResult`-summary (`{pr, stored, byStatus, warnings}`), niet de blocks
  zelf, zodat de event-history compact blijft (zelfde patroon als
  `build_relations`/`pr_inbox`).
- **`TaskManager.StartIngest(ctx, pr) (*ingestResult, error)`** start de
  Execution en leest het resultaat terug (`engine.Result`) — de sanctioned
  write-weg. `handleIngest` (`api.go`) roept 'm aan i.p.v. rechtstreeks
  `ingestPR`, en roept daarna zoals voorheen `EnsureRelations` aan.
- **CLI (`slash ingest <pr>`, `main.go`):** bouwt zelf een losse engine +
  modules via `newTasks(ctx, db, dataDir, repo, resumeRuntime=false)` — de
  `resumeRuntime`-vlag slaat `ResumePolling`/`EnsureInbox` over (server-only
  runtime: geen poller-hervatting, geen inbox-fetch voor een one-shot
  headless-ingest) — en roept dan `StartIngest` + `EnsureRelations` aan, zoals
  de HTTP-flow.
- **Determinisme:** beide Activities zijn de enige non-determinisme/IO
  (netwerk, git, DB); de workflow-body zelf voegt niets non-deterministisch toe
  en draait de twee stappen altijd in dezelfde volgorde. `ingestMu` (een
  package-level mutex, ongewijzigd) serialiseert gelijktijdige ingests van
  dezelfde PR op worktree-niveau — nu binnen elke Activity apart in plaats van
  rond de oude, ongesplitste `ingestPR`.
- Zie `.claude/rules/blocks-and-ingest.md` voor de volledige pipeline-uitleg en
  `ingest_test.go` (`TestIngestWorkflowEndToEnd`, een echte gh/git-afhankelijke
  end-to-end-test die zichzelf skipt als gh onbereikbaar is).
- Tests: `approvals_test.go` (module round-trip incl. full-swap/clear, de workflow
  end-to-end: `set`-Signal → read-model, `EnsureApprovals`-idempotentie, en een
  viewed-request die `setFileViewed`/`github.Client.MarkFileViewed` drijft i.p.v.
  het approvals-read-model aan te raken).
