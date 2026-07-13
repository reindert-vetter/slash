# Blocks & ingest

De eerste feature: een PR omzetten in een lijst **blocks** (een block = één
PHP-functie/method, of het hele bestand als parsen faalt) en die links als
navigeerbare lijst tonen.

- **Opslag:** de `blocks`-tabel (dit ís de `nodes`/functie-tabel uit de graph,
  hernoemd + uitgebreid met `class/category/end_line/status/side/pr`). De kolom
  `approved` (0/1) markeert of de reviewer een block heeft goedgekeurd. Goedkeuring
  is echter **granulair** (voorlopig client-side): niet één blok-vlag maar een set
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
  count telt goedgekeurde changed-rows uit `blockRows`, dus **`total` is 0 tot de
  code van dat block geladen is** (lazy — de counts vullen zich terwijl je
  navigeert; het geselecteerde block + z'n children laden altijd). De pill is
  groen met een ✓ zodra `done === total`, anders neutraal; verborgen alleen bij
  `total === 0`. Dezelfde `{done,total}` hangt per child in de **Onderliggende
  code**-kaart (`data-testid=related-approval` + een header-rollup
  `related-approval-total`) — zie `.claude/rules/detail-layout.md`. Kanttekening:
  child-blokken zijn (nog) niet los goedkeurbaar (ze staan niet in de
  navigeerbare `state.blocks`), dus hun `done` is voorlopig 0 tot dat er is; de
  `total` maakt de review-omvang van de hele call-boom wél zichtbaar.
  Schema: `.claude/templates/schema.sql` (in sync met de `schemaDDL`-constante in
  `db.go`).
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
