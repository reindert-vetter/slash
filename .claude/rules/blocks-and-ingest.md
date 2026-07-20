# Blocks & ingest

De eerste feature: een PR omzetten in een lijst **blocks** (een block = één
PHP-functie/method, of het hele bestand als parsen faalt) en die links als
navigeerbare lijst tonen.

- **Opslag:** de `blocks`-tabel (dit ís de `nodes`/functie-tabel uit de graph,
  hernoemd + uitgebreid met `class/category/end_line/status/side/pr`). De kolom
  `approved` (0/1) markeert of de reviewer een block heeft goedgekeurd. Goedkeuring
  is echter **granulair**: niet één blok-vlag maar een set
  goedgekeurde **gewijzigde regels** — `b.approvedRows`, een array van rij-indices
  in `blockRows(b)`. Elke granulariteit reduceert daartoe (een groep keurt al zijn
  regels goed, een `line`/`call` de ene rij waarop hij staat), zodat "is het hele
  block goedgekeurd?" simpelweg "zijn álle gewijzigde regels goedgekeurd?" is
  (`blockApproved`/`blockPartlyApproved`/`changedRows`/`approvedRowSet` in
  `Block.mjs`). De top-checkbox op de block-kaart is dus **afgeleid**: aangevinkt bij
  `blockApproved`, indeterminate bij deels, met een `approve <done>/<total>`-teller;
  klikken keurt alles goed of wist alles. Een volledig goedgekeurde rij toont een
  klein emerald **vinkje** in de linker-marge (de actieve indigo-balk wint zolang de
  cursor erop staat). Op `call`-niveau kan één rij **meerdere** call-segmenten
  bevatten (`segmentCalls`); goedkeuring is daar dus fijnmaziger dan de rij:
  `b.approvedCalls`, een array van `${row}:${segStart}`-keys (`callKey`/
  `approvedCallSet`/`rowCallSegments` in `Block.mjs`) naast `b.approvedRows`. Zijn
  alle segmenten van een rij goedgekeurd, dan **gradueert** die rij in
  `b.approvedRows` (en verdwijnen zijn keys uit `approvedCalls`) zodat de grovere
  group/line-goedkeuring en de blok-checkbox het gewoon zien; het omgekeerde
  (één segment van een volledig goedgekeurde rij intrekken) splitst 'm weer terug
  in expliciete keys (`toggleCallApprove` in `home.mjs`). Zolang een rij *deels*
  goedgekeurd is (niet 0, niet alles) toont hij per segment een bolletje op een
  tweede, compacte rij eronder — uitgelijnd onder de segment-kolom via
  letterlijke spaties (werkt zonder JS-meting omdat de code monospace is): een
  reeds goedgekeurd segment krijgt een **vol groen** bolletje, een nog wachtend
  segment een **open** bolletje, zodat de rij in één oogopslag als
  voortgangsstrip leest. Is niks goedgekeurd, dan tonen we niks; is alles
  goedgekeurd, dan verdwijnen de bolletjes en komt het vinkje terug
  (`partialCallApproval`/`circleRowHTML` in `Block.mjs`). Beide panes berekenen
  die bolletjes-rij met exact dezelfde (deterministische) input, dus ze voegen
  'm op dezelfde rij-index
  toe en blijven regel-voor-regel uitgelijnd. `b.approvedRows`/`b.approvedCalls`
  worden altijd **hertoegewezen** (nooit in-place gemuteerd) zodat arrow.js de
  checkbox en de indicators her-rendert. `edges` blijft voor de latere call-graph.
- **Durable persistentie (`approve`-workflow + `modules/approvals`):** goedkeuring
  overleeft een refresh. `b.approvedRows`/`b.approvedCalls` leven per block durabel
  in het `approvals`-read-model (`data/approvals.db`), gevoed door de `approve`-
  workflow — **niet** in de URL (te groot/veranderlijk). `home.mjs` (`loadApprovals`)
  ensuret bij het laden de tracker (`POST /api/workflows/approve {pr}` → runId
  onthouden in `state.approveRunId`) en herstelt daarna elke block-goedkeuring uit
  `GET /api/approvals?pr=N` (per block-id → `b.approvedRows`/`b.approvedCalls`
  hertoegewezen). Élke goedkeurings-mutatie (`toggleApprove`/`toggleCallApprove` in
  `home.mjs`, plus de top-checkbox via de `onApprove`-callback van `Block.mjs`) stuurt
  ná de lokale hertoewijzing het **volledige** stel voor dát block als Signal
  (`POST /api/workflows/{runId}/signals/set {blockId, rows, calls}`,
  `persistApproval`). De UI schrijft dus **nooit** direct — alleen dit signal, binnen
  de write-boundary. Zie `.claude/rules/tembed-workflows.md` (sectie "Reviewer-
  goedkeuring persisteren").
- **Gecombineerde goedkeuring per boom (sidebar + Onderliggende code):** de
  linker-sidebar toont per top-level block een pill (`data-testid=block-approval`)
  met `done/total` van dat block **plus alle onderliggende blokken samen** — z'n
  relatie-children én de PR-block-definities van z'n resolved/found method-calls,
  transitief. `home.mjs` rolt dit op (`blockApproveCount` per block →
  `subtreeApproveCount` over `[b, ...nestedPrBlocks(b)]`) en duwt het via een
  `watch` in `state.approvalSummaries` (id→`{done,total}`) — **bewust ontkoppeld
  van de render** (net als `setRelated`/`setCommentScope`): de sidebar leest een
  platte snapshot i.p.v. elke block-`b.code`, want dat zou de sidebar een
  co-subscriber op de `b.code` van het geselecteerde block maken en de diff
  "stuck on loading"-race hertriggeren (zie `.claude/rules/conventions.md`). De
  count telt goedgekeurde changed-rows. De `done`-kant komt uit de
  goedgekeurde rij-indices; de **`total`** (aantal goed te keuren changed-rows per
  block) komt **server-side** uit `GET /api/blockstats?pr=N` — zie hieronder — met
  een client-side fallback op `changedRows(blockRows(b))` zolang de stats nog niet
  binnen zijn. De pill is groen met een ✓ zodra `done === total`, anders neutraal;
  verborgen alleen bij `total === 0`. Dezelfde `{done,total}` hangt per child in de
  **Onderliggende code**-kaart (`data-testid=related-approval` + een header-rollup
  `related-approval-total`) — zie `.claude/rules/detail-layout.md`. Kanttekening:
  child-blokken zijn (nog) niet los goedkeurbaar (ze staan niet in de
  navigeerbare `state.blocks`), dus hun `done` is voorlopig 0 tot dat er is; de
  `total` maakt de review-omvang van de hele call-boom wél zichtbaar.
  Schema: `.claude/templates/schema.sql` (in sync met de `schemaDDL`-constante in
  `db.go`).
- **Server-side `total` (`blockstats.go` + `GET /api/blockstats`):** het aantal
  goed te keuren changed-rows per block wordt **in de backend** berekend zodat het
  meteen bekend is — óók vóór een block z'n code lazy geladen heeft — en in exact
  dezelfde aligned-row-indexruimte leeft als de goedgekeurde rijen in
  `approvals.db`, zodat `done/total` altijd klopt. `blockstats.go` is een **exacte
  Go-port** van de frontend-`changedRows(blockRows(b))` (`Block.mjs`): het leest de
  oud/nieuw-broncode uit de base/head-worktrees (zoals `/api/code`), past dezelfde
  `dedent4` + LCS-line-alignment (`alignRows`/`diffLines`, whitespace-ongevoelig)
  toe en telt de gewijzigde, niet-ws-only rijen (een pure verwijdering telt als 1
  filler-rij; een ws-only re-indent telt niet). `GET /api/blockstats?pr=N` geeft
  `{pr, totals}` (block-id → count) en is **read-only** — het leest alleen
  worktree-bestanden, dus vrij vanuit een read-handler (write-boundary). De
  parity met de JS wordt door `TestChangedRowCount` (`blockstats_test.go`) op
  gedeelde fixtures bewezen (incl. pure deletion + ws-only). Frontend:
  `home.mjs` (`loadBlockStats` → `state.blockTotals`); `blockApproveCount` prefereert
  dit backend-`total`.
- **Sorteervolgorde van de linkerlijst (`categoryRank` in `recomputeLeftList`,
  `home.mjs`):** de linkerlijst is niet zomaar ingest-/bronvolgorde — hij
  sorteert op categorie-prioriteit: **ROUTE** eerst (de wortel van de
  route→controller→request/resource/model-hiërarchie, zie Taak 7), dan
  **CONTROLLER**, dan de rest ongewijzigd. De sort gebeurt **na** de bestaande
  filters (children/resolved-call-targets/zoekterm) en is een **stabiele**
  sort (`Array.prototype.sort`, gegarandeerd stabiel in moderne JS-engines) —
  binnen elke rank blijft de oorspronkelijke volgorde dus intact. Dit is
  veilig voor `sameFileNeighbour`/`stepBlock` (de same-file-connector +
  `↑`/`↓`-doorstroom naar een buurblock, zie `keyboard-navigation.md`): die
  kijken alleen naar de **directe index-buur** in `state.blocks`, maar omdat
  `classify.go` de categorie uit het bestandspad afleidt, delen alle blokken
  van hetzelfde bestand altijd dezelfde categorie en dus dezelfde rank — de
  stabiele sort houdt ze daardoor gegarandeerd aan elkaar. `sel`/refresh-
  restore blijven ongemoeid: die zoeken op block-**id**/`file:line`, niet op
  index (zie de URL-state-sectie in `CLAUDE.md`), dus een andere volgorde
  verandert niets aan waar een herstelde selectie landt.
- **Verbergen van goedgekeurde blokken (`BlockList.mjs`):** volledig goedgekeurde
  **top-level** blokken (de pill `done === total`, subtree) worden standaard
  **verborgen** uit de "Start"-lijst; een knop onderin (`data-testid=toggle-approved`,
  "Toon N goedgekeurde blocks" / "Verberg …") klapt ze uit
  (`state.showApproved`, efemeer — niet in de URL). Partial + ongoedgekeurd blijven
  altijd zichtbaar. Omdat `total` server-side bekend is, werkt dit betrouwbaar vóór
  de code geladen is. De "Start"-kop toont daarnaast een **PR-brede** teller
  (`data-testid=approval-summary`, "X/Y goedgekeurd · N nog te reviewen") uit
  `state.approvalTotal` — gesommeerd over de subtree-counts in dezelfde ontkoppelde
  `watch` die `approvalSummaries` vult (een platte snapshot, dus de kop wordt nooit
  co-subscriber op een block-`b.code`). `renderList` geeft **altijd** een keyed
  array terug (lege staat als array-van-één) om de arrow.js single↔array
  slot-valkuil te vermijden (zie `.claude/rules/conventions.md`).
- **Pipeline:** `gh pr view` → `git fetch` (pull-ref + develop, fallback by-sha) →
  twee detached worktrees onder `data/worktrees/pr-<pr>-{base,head}` (**absolute
  paden**!) → `git diff --unified=0` → PHP-scanner (`phpscan.go`, brace-lexer, geen
  externe parser) → classificeren (`classify.go`) → opslaan. Zie skill `ingest-pr`.
- **Leidende attributen (`#[...]`) horen bij het blok van de functie eronder
  (`phpscan.go`).** Een PHP-attribuut vlak boven een method/functie —
  `#[DataProvider('providerMethod')]`, `#[Route('/x')]`, stacked attributen, of
  een attribuut waarvan de argumenten over meerdere regels lopen — telt als
  onderdeel van **dát blok**, niet als losstaande tekst ertussenin:
  `Block.Line` begint bij de **eerste** attribuut-regel in een aaneengesloten
  run, i.p.v. bij de `function`-regel zelf. `scanPHP` houdt daarvoor een
  `pendingAttrLine` bij: elke `#[` (nu via een expliciete `skipAttribute`-lexer
  gescand — respecteert nested `[`/strings, dus een attribuut-argument als
  `#[Attr(['a', 'b'])]` of een quote met een `]` erin breekt de scan niet
  voortijdig af) zet 'm, als hij nog leeg is; modifier-keywords
  (`public`/`protected`/`private`/`static`/`abstract`/`final`/`readonly`/`var`)
  laten 'm intact zolang ze tussen het attribuut en `function` in staan; **elk
  ander token** (een type-hint, een variabelenaam, `;`, een
  `class`/`trait`/`interface`/`enum`-keyword) reset 'm naar 0 — zodat een
  attribuut op een property (`#[Deprecated] private string $x;`) nooit lekt
  naar een verderop volgende, ongerelateerde methode. De class-header-sentinel
  (`classHeaderSentinel`) en de body-scan zelf blijven ongewijzigd: alleen het
  moment waarop `Block.Line` wordt vastgelegd verschuift (`scanFunction` kreeg
  daarvoor een `declLineOverride`-parameter). **Gevolg voor `classify.go`:**
  omdat `classifyFile`'s "is dit blok gewijzigd?"-check simpelweg
  `intersects(nb.Line, nb.EndLine)` op de gewijzigde regels doet, telt een
  wijziging die **uitsluitend** de attribuut-regel raakt (bv. een nieuw
  toegevoegd `#[DataProvider(...)]` boven een verder ongewijzigde testmethode)
  nu ook als "modified" — vóór deze wijziging viel zo'n attribuut-only diff
  buiten elk blok en het blok verscheen dus helemaal niet in de reviewboom.
  **Gevolg voor consumers die "de tekst boven de declaratie" scannen** (zoals
  `testcovers_analysis.go`'s `methodZone`, dat annotaties als `#[CoversMethod]`/
  `#[Test]`/`@covers` leest): een deel van die tekst zit nu, voor een blok mét
  leidende attributen, al **binnen** het blok zelf i.p.v. erboven.
  `testcovers_analysis.go`'s `funcDeclLine` (zoekt het echte `function`-keyword
  binnen het blok, want annotatie-attributen bevatten dat woord nooit) lost dit
  op: `methodZone` gebruikt die regel — niet langer `b.Line` — als bovengrens
  van de gescande zone, zodat de al-gefolde attributen gewoon meetellen. Elke
  nieuwe detector die "de zone boven een method" leest (zie bv. `data_provider`
  in `tembed-workflows.md`) moet dezelfde `methodZone`/`funcDeclLine`-aanpak
  hergebruiken, niet zelf op `b.Line` varen. Tests: `phpscan_test.go`
  (`TestLeadingAttributeIncludedInBlock`,
  `TestMultilineLeadingAttributeIncludedInBlock`,
  `TestStackedAttributesUseFirstLine`,
  `TestPropertyAttributeNotLeakedToNextMethod`), `classify_test.go`
  (`TestAttributeOnlyChangeClassifiesAsModified`).
- **PHPDoc-omschrijving als block-description (`phpscan.go`, deterministisch,
  géén AI).** Staat er direct boven een method/functie een `/** ... */`-PHPDoc
  (twee sterretjes bij open — een kaal `/* ... */` telt niet mee), dan
  extraheert `scanPHP` de **vrije-tekstregels** (elke regel die, na het strippen
  van de omkadering en een leidende `*`, niet met `@` begint — dus geen
  `@param`/`@return`/`@var`/etc.) en zet ze, samengevoegd tot één paragraaf
  (spatie-gescheiden), in het nieuwe veld **`Block.Description`**
  (`model.go`). Puur tekstuele extractie uit de brontekst — geen LLM-call, dus
  geen kosten/latency en volledig deterministisch bij re-ingest.
  Mechanisme, analoog aan `pendingAttrLine` hierboven maar losstaand ervan:
  `scanPHP` houdt een eigen `pendingDocText` bij, gezet zodra een
  `/**`-commentaar wordt gescand (`phpDocDescription`, alleen overschreven door
  een latere niet-lege PHPDoc — "laatste vóór de declaratie wint"), en
  overleeft — anders dan `pendingAttrLine` — de aanwezigheid van tussenliggende
  attributen/modifiers: een PHPDoc kan namelijk gewoon **boven** een leidend
  `#[...]`-attribuut staan (`/** ... */` dan `#[Test]` dan `function`), en moet
  dan nog steeds aan die method toegekend worden ook al pakt het attribuut zelf
  `Block.Line` naar zich toe (zie hierboven) — de PHPDoc beïnvloedt `Block.Line`/
  `EndLine` zelf **niet**. `pendingDocText` reset naar `""` op precies dezelfde
  triggers als `pendingAttrLine` (een `;`, een
  `class`/`trait`/`interface`/`enum`-keyword, of elk ander, niet-gerelateerd
  identifier) zodat een PHPDoc boven een property (`/** ... */ private
  $legacy;`) nooit lekt naar een verderop volgende, ongerelateerde methode.
  Class-level PHPDoc (boven `class X {` zelf) en de synthetische blocks
  (class-header-sentinel, enums/models/macros/commands in
  `callresolve_analysis.go`) krijgen bewust **geen** description — alleen een
  echte `function`-declaratie in `scanPHP` doet dat.
  **Opslag:** kolom `description` (TEXT, default `''`) op `blocks` (lichte
  migrate in `openDB`: `ALTER TABLE … ADD COLUMN`, dubbele-kolom-fout genegeerd —
  zelfde patroon als `file_deleted`; `schemaDDL` + `schema.sql` in sync),
  meegeschreven door zowel `replacePRBlocks` als `upsertPRFileBlocks` en
  gelezen door `blocksByPR` → automatisch in `/api/blocks` via het gewone
  struct-tag (`json:"description"`, geen `MarshalJSON`-special-case nodig).
  **Weergave:** geen nieuwe UI nodig — `src/Block.mjs` had al een "**Doel:**"-
  sectie op de block-kaart die `b.description` toont (met een cursieve
  "nog geen omschrijving"-fallback wanneer leeg); die stond er al vóór deze
  wijziging, alleen werd het veld nooit gevuld. Test: `phpscan_test.go`
  (`TestPHPDocDescriptionCapturedForMethod`,
  `TestPHPDocDescriptionSurvivesLeadingAttribute`,
  `TestPHPDocDescriptionNotLeakedAcrossProperty`,
  `TestPlainBlockCommentIsNotADescription`, `TestNoPHPDocMeansNoDescription`).
- **Uitzondering: een kale `#[Test]`-only wijziging telt bewust NIET als
  "modified" (`classify.go`).** Een toegevoegd/verwijderd/aangepast `#[Test]`
  (PHPUnit's argumentloze test-marker) heeft geen reviewbare betekenis — anders
  dan `#[DataProvider(...)]` hierboven, dat wél als een echte wijziging moet
  blijven tellen. `classifyFile` roept daarom, ná de bestaande
  `intersects`-check, `isBareTestAttributeOnlyChange(fd, oldLines, newLines,
  ob, nb)` aan: die is alleen waar als **elke** gewijzigde regel binnen het
  blok (a) in de leidende-attributen-prefix ligt (vóór de echte
  `function`-regel, via hetzelfde `funcDeclLine` dat `testcovers_analysis.go`
  al gebruikt) én (b) getrimd letterlijk `#[Test]` is — geen argumenten, geen
  andere attributen op diezelfde regel. Is dat zo, dan wordt `modified` weer
  op `false` gezet en verschijnt het blok helemaal niet (net als een echt
  ongewijzigd blok) i.p.v. de hele, verder onaangeroerde testmethode te tonen.
  Een `#[Test]`-toevoeging **samen met** een echte body-wijziging blijft
  gewoon "modified" — de carve-out geldt alleen als `#[Test]` de énige reden
  is. Tests: `classify_test.go`
  (`TestBareTestAttributeOnlyChangeIsIgnored`,
  `TestBareTestAttributeChangeStillModifiedWithRealEdit`).
- **Echt verwijderd bestand (`file_deleted`):** "alle blocks van dit bestand zijn
  `removed`" is géén betrouwbaar bestand-verwijderd-signaal (de blocks-tabel bevat
  alleen *getroffen* blocks — een bestand met één verwijderde methode blijft
  gewoon bestaan). Het echte signaal komt uit de scan: `parseOneFile`
  (`parse_pool.go`) leest beide worktrees en een bestand dat **afwezig is in de
  head-worktree** (equivalent aan git's `+++ /dev/null`) is echt verwijderd;
  `classifyFile` stamped dat als `FileDeleted` op elk removed block van dat
  bestand. Gepersisteerd als kolom `file_deleted` (0/1) op `blocks` (lichte
  migrate in `openDB`: `ALTER TABLE … ADD COLUMN`, dubbele-kolom-fout genegeerd —
  zelfde patroon als de comments/relations-modules; `schemaDDL` + `schema.sql` in
  sync), meegeschreven door zowel `replacePRBlocks` als `upsertPRFileBlocks` en
  gelezen door `blocksByPR` → `fileDeleted` in `/api/blocks` (via het gewone
  struct-tag, geen `MarshalJSON`-special-case). De frontend markeert het op
  **drie** plekken, allemaal rose/bold en Nederlands, via de gedeelde helper
  `removedLabel(b)` (`Block.mjs`): "Verwijderd bestand" bij `fileDeleted`,
  "Verwijderd" voor een losse removed-methode — (1) de **kaart-kop-badge**
  (`data-testid=block-status-badge`, vervangt het kale statuswoord; één stabiele
  span met hele-waarde class/tekst-function-bindings), (2) de **sidebar-pil**
  (`data-testid=block-row-removed`, `removedPill` in `BlockList.mjs`, genest slot
  naast `approvalPill` — `statusInfo`/`STATUS_STYLE` ongewijzigd), en (3) de
  **diff-banner** (`data-testid=removed-banner`) boven de old-only pane in
  `codeDiff`'s `effectiveOnly==='left'`-tak (alleen die tak is geherstructureerd:
  buitenste `flex-col` houdt `data-testid=code-diff`/`data-hints`, een geneste
  `relative` flex-row draagt pane + scroll-hints zodat `updateHints`/`syncScroll`
  blijven werken). Tests: `classify_test.go` (detectie, DB-round-trip via beide
  write-paden, migrate) en `tests/removed-file.spec.mjs` (PR 98-fixture
  `tests/fixtures/filedeleted-blocks.json`).
- **Draait als de `ingest`-workflow (write-boundary):** de blocks-tabel-write +
  de git-worktree-mutaties gebeuren niet meer rechtstreeks vanuit een
  HTTP-handler of de CLI, maar binnen een tembed **Workflow Execution** (Workflow
  Type `ingest`, `workflows.go`), gesplitst in twee Activities:
  `prepareWorktrees` (gh-fetch + `ensureCommits` + de twee `ensureWorktree`-calls,
  retourneert alleen de kleine `worktreeSHAs`-summary — base/head-SHA + de
  gewijzigde bestandspaden, niet de worktree-inhoud) en `scanAndStoreBlocks`
  (`git diff` + PHP-scan/classificatie + `replacePRBlocks`, retourneert alleen de
  kleine `ingestResult`-summary, niet de blocks zelf — zo blijft de event-history
  compact, net als bij `build_relations`/`pr_inbox`). Beide Activity-bodies
  (`prepareIngestWorktrees`/`scanAndStoreIngestBlocks` in `ingest.go`) blijven
  wél gewone, direct-testbare functies; alleen worden ze nu **uitsluitend** vanuit
  deze Activities aangeroepen. `TaskManager.StartIngest(ctx, pr)` start de
  Execution (die zonder Signal synchroon doorloopt tot completion) en geeft de
  `ingestResult`-summary terug.
- **Incrementele refresh (nieuwe commits, geen volledige re-ingest):** naast
  deze handmatige, volledige pipeline draait `pr_status` op zijn poll-cadans
  automatisch een **delta-refresh** zodra een PR's live head-SHA verder staat
  dan wat het laatst is geïngest (`pollIngestRefresh` → `PRStateSignal` →
  `refreshIngestDelta`-Activity, `ingest.go`). Die diff't alleen het **eerder
  opgeslagen** head-SHA (nieuwe `pr_ingest`-tabel, `db.go`) tegen het nieuwe,
  herscant **alleen de sindsdien gewijzigde bestanden**, en schrijft ze via
  **`upsertPRFileBlocks`** (een DELETE+INSERT gescoped op precies die
  bestanden — `DELETE FROM blocks WHERE pr=? AND file IN (...)`) i.p.v.
  `replacePRBlocks`'s volledige per-PR swap. Elk ander bestand z'n eigen blocks —
  en dus alles wat aan hun **stabiele** block-id hangt in de aparte
  comments-/approvals-/callresolve-read-models (geen FK, dus sowieso
  onaangeroerd) — blijft volledig met rust. Zie de sectie "Ingest-refresh" bij
  `pr_status` in `.claude/rules/tembed-workflows.md` voor het volledige
  mechanisme (de heartbeat-cadans, de base-SHA-gewijzigd-fallback naar de
  volledige pipeline, en waarom relations/callresolve bewust "vol" — over de
  PR's volledige huidige blocklijst, niet delta-scoped — blijven
  herberekenen).
- **Draaien:** `go run . ingest <pr> [-db data/graph.db]` start de
  `ingest`-workflow headless (bouwt een losse engine zonder server-runtime — geen
  poller-resume, geen inbox-fetch, zie `newTasks(..., resumeRuntime)` in
  `tasks_api.go`) en meteen daarna `EnsureRelations`, net als de HTTP-flow. De
  server-kant is `POST /api/ingest {"pr":N}` (`handleIngest` → `StartIngest` →
  `EnsureRelations`). Server: `go run . [-db path] [-addr host:port]
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
- **`blockRows(b)` is gememoïseerd (`blockRowsCache`, een module-level
  `WeakMap` in `Block.mjs`), buiten reactive state — anders wordt `diffLines`'s
  O(n·m)-DP-tabel bij elke aanroep opnieuw gevuld.** `blockRows` heeft 20+
  call-sites (elke diff-render, elke navigatie-eenheid, en — het duurste geval —
  `home.mjs`'s `approvalSummaries`-watch, die bij **elke** `state.codeVersion`-bump
  (dus bij elke code-load, ook een look-ahead-preview tijdens gewoon
  ↑/↓-navigeren in de sidebar) `subtreeApproveCount`/`blockRows` voor **alle**
  top-level blocks herberekent). Voor een normaal PHP-block (tientallen regels)
  is dat onmerkbaar; voor een niet-PHP whole-file-fallback-block (bv. een
  meerduizend-regelige locale-JSON, zie "Pipeline" hierboven — de scanner valt
  terug op het hele bestand als parsen faalt) is die DP-tabel `(n+1)×(m+1)`
  cellen groot en zonder cache een herhaalde belasting: eenmaal gemeten op een
  9000-regelig JSON-bestand kostte navigeren door de sidebar **na** het
  aanraken van dat block 400-4900ms per stap (i.p.v. de normale tientallen ms)
  zolang er nog nieuwe blocks werden aangeraakt, met een 6-15s piek op het
  eerste contact. De cache-sleutel is de **referentie-identiteit** van
  `b.code`, niet van `b` zelf: `ensureCode` (`home.mjs`) zet `b.code` altijd
  **wholesale** (nooit in-place gemuteerd), dus een gewijzigde referentie is
  een exacte, correcte invalidatie-check — geen staleness-risico. De cache leeft
  bewust in een module-level `WeakMap`, niet als veld op `b`, om geen
  arrow.js-reactive-proxy-notify te triggeren op iets dat toch nergens reactief
  gelezen wordt (hetzelfde patroon als `codeRequested` in `home.mjs`).
- **Char-diff: alleen regel-achtergrond, geen woord-achtergrond.** Een echt
  gewijzigde regel (paired del/ins, geen `wsOnly`) krijgt zijn rood/groene
  regel-achtergrond (pane-tint), maar de **individuele gewijzigde tekens/woorden
  binnen die regel krijgen geen eigen achtergrond meer** — dat zou een dubbele,
  donkerdere "pill" bovenop de regel-tint geven. `highlightChanges` in
  `Block.mjs` rendert zo'n regel dus zonder woord-achtergrond; de
  token-granulaire `charDiffSides`/`tokenize`/`diffChars`-pas (LCS op
  `[A-Za-z0-9]`-runs, à la git-woorddiff) draait nu **alleen nog** voor een
  `wsOnly`-rij, om de verschoven whitespace zelf te markeren (de zachte
  `bg-rose-200`/`bg-emerald-200`-tint hierboven) — niet voor een echte
  content-wijziging. De **call-underline** (`UNDERLINE_CLS`, indigo, het actieve
  segment op `gran==='call'`) is een aparte laag boven op dezelfde
  `markChars`-pass en blijft ongewijzigd werken, ook op een regel zonder
  woord-achtergrond.
