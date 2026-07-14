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
  aangeroepen. Hun schrijf-methodes (`Save`, `AddReaction`, `PostLineComment`, …)
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
  - `modules/github` — de GitHub-communicatie (`gh api`): `PostLineComment`,
    `Reply`, `FetchReplies`, `PRState` (`open`/`merged`/`closed`). Interface
    `github.Client` + `github.Fake` (met `SetPRState`) voor tests.
- **Flow:** `saveComment` (comments) + `postGithubComment` (github, best-effort),
  dan een lus op `reply`-**Signals**. Een reactie komt binnen via de **UI**
  (`POST /api/workflows/{runID}/signals/reply`) én via een **per-thread poller**;
  beide worden als hetzelfde Signal geleverd. Elke reactie wordt opgeslagen
  (comments) en een UI-reactie wordt gespiegeld naar GitHub; `Done`/`/resolve`
  sluit de thread.
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
  **Bij start** (synchroon in `StartWorkflow`, vóór de signal-lus) draait hij één
  keer de **`fetchPRMeta`-Activity**: die haalt de **PR-titel + URL** op via de
  github-module (`PRMeta`, best-effort — geen gh = leeg) en schrijft ze in de
  **`prmeta`-module** (`modules/prmeta`, `data/prmeta.db`, read-model met
  `Save`/`Get`). De UI (`/`-menu, zie `.claude/rules/keyboard-navigation.md`) leest dat via
  `GET /api/pr?pr=N` voor de Jira/GitHub-deep-links; de titel levert de
  `KEY-123`-ticket-key. `EnsurePRStatus` is de geëxporteerde ensure-wrapper die de
  UI via `POST /api/workflows/pr_status {pr}` bij het laden aanroept (een Execution
  starten = sanctioned write-weg).
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
  Voor de PR-metadata: `POST /api/workflows/pr_status {pr}` (ensure de tracker,
  die synchroon de titel fetcht) + read-only `GET /api/pr?pr=N` (leest het
  `prmeta`-read-model: `{ok,pr,title,url,updatedAt}`; `{ok:false}` zolang nog niet
  gefetcht). Voor de inbox: `POST /api/workflows/{runID}/signals/refresh` +
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

## Relaties tussen blokken (`build_relations` + `modules/relations`)

Een vierde Workflow Type, **`build_relations`** (één Execution per PR), leidt
**many-to-many relaties** tussen blokken af — de call-graph-edges, maar
betekenis-gedreven i.p.v. tekstueel. De eerste relatie-`kind`:
**`event_listener`** — een gewijzigd blok dat een event dispatcht wordt de
**parent** van de `Listener::handle` voor dat event, **mits die handle óók in
deze PR gewijzigd is** (beide kanten moeten wijzigen om te koppelen).

- **`modules/relations`** (`data/relations.db`): het read-model,
  `relations(pr, parent_id, child_id, kind)` (block-id = `<pr>:<file>:<symbol>`).
  Write `Replace(pr, rels)` (workflow-only, full-swap per PR → replay-safe), read
  `List(pr)`. `kind` houdt de tabel open voor latere relatietypes.
- **Analyse-service `relations.go`** (package main, géén module — leest de
  head-worktree = side-effect): `buildRelations(dataDir, pr, blocks)` draait een
  lijst **detectors** (nu `eventListenerDetector`). De event→listener-map komt
  robuust uit drie bronnen (union): de `handle(EventType $e)`-type-hint, het
  `$listen`-array in een `*ServiceProvider.php`, en `Event::listen(...)`-calls;
  dispatch-sites worden per blok-body gescand (`event(new X`, `X::dispatch(`, …).
  Herbruikt `extractBlockSource` (code.go) om block-bodies te lezen.
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
  **Onderliggende code**-kaart (zie `.claude/rules/detail-layout.md`).
- Tests: `relations_test.go` (detector met beide mapping-bronnen, de
  beide-kanten-eis, module round-trip, en de workflow-end-to-end);
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
  met regexes (patroon van `dispatchedEvents`). **Alleen de gewijzigde regels**
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
- **`modules/claude`** (`modules/claude/claude.go`): de CLI-bridge naar `claude`
  (`Client`-interface + `Fake`, patroon van `modules/github`). `Run` shelt uit
  naar `claude -p <prompt> --model <id>` met context-timeout; agentisch (Sonnet)
  krijgt `cwd`=head-worktree + read-only tools (`Read,Grep,Glob`). Model-ID's:
  `claude-haiku-4-5`, `claude-sonnet-5`. **`SLASH_CLAUDE=off`** → `claude.Fake`
  (geen netwerk; leeg = resolvt niets), voor offline/tests.
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
  en een facade-call `AccountingClient::providers()` → `AccountingDriver::providers`),
  `resolve_call_test.go` (Haiku-confident → found; escalatie naar Sonnet;
  notfound; verificatie weigert een verzonnen definitie), en
  `modules/callresolve/callresolve_test.go` (round-trip + UpsertGo bewaart LLM +
  `Prune` ruimt wees-callers én stale call-keys op).
  De frontend-kant heeft een **seed-pad**: `slash seed … -callresolve
  <callresolve.json>` (mirror van `-relations`) laadt resolved rijen in
  `callresolve.db` zodat Playwright de `method_call`-children rendert zonder
  resolver-run (`tests/fixtures/callresolve.json`, PR 91 in `relations.spec.mjs` —
  bewijst o.a. dat het Onderliggende-code-paneel de blok-selectie volgt).

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
- Tests: `approvals_test.go` (module round-trip incl. full-swap/clear + de workflow
  end-to-end: `set`-Signal → read-model, en `EnsureApprovals`-idempotentie).
