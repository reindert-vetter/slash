# `test_run` — "laat Claude bepaalde tests draaien"

Reviewer request: laat Claude zelf bepalen welke *bestaande* tests relevant
zijn voor een PR en die gericht draaien — nooit de hele suite, en geen vast
per-repo testcommando dat de reviewer configureert. Modelled zo dicht mogelijk
op `comment_batch` (zie "`comment_batch`" in `.claude/docs/workflows-comments.md`
voor het precedent dit bestand kopieert) — hier staan alleen de verschillen en
de eigen afwegingen.

## Wat Claude wel en niet mag

Eén agentic run (`runTestRun`, `test_run.go`), Opus, met
`Read/Grep/Glob/Bash` — **bewust geen `Edit`**. Dit is "laat testen", niet
"verander code": een testrun mag alleen bestaande tests draaien en de
uitkomst rapporteren. `modules/claude/prompts/test_run.md`
(`claude.TestRunSystemPrompt`) legt Claude zelf drie dingen op:

1. **Zoek het testraamwerk zelf uit** — via `composer.json`, CI-configuratie,
   `phpunit.xml`, wat er ook is. Geen aanname hierover in Go: het paste bij de
   beslissing dat Claude zelf bepaalt WAT er getest wordt.
2. **Bepaal welke bestaande tests relevant zijn** voor de wijzigingen van deze
   PR (`git diff` tegen de basisbranch, of de gewijzigde bestanden).
3. **Draai nooit de hele suite** — expliciet verboden in de prompt, ook niet
   "voor de zekerheid". Dit kan niet hard worden afgedwongen in Go: Claude's
   eigen Bash-gebruik valt onder de bestaande write-boundary-uitzondering voor
   een chat-turn (zie ".claude/rules/workflows-write-boundary.md", "Exception:
   the Claude chat turn may act through a shell") en wordt niet geparsed/
   gevalideerd. De enige harde grens is de bestaande `agenticTimeout` (10
   minuten, `modules/claude/claude.go`) die elke Tools-aanroep al bindt.

## Het marker-contract — dubbel parsen, net als `comment_batch`

Vier marker-regels, gefixeerd in het prompt-bestand:

```
[slash:plan] <één regel: welke tests en waarom>
[slash:test-start] <testnaam of testbestand>
[slash:test-pass] <testnaam of testbestand>
[slash:test-fail] <testnaam of testbestand> <korte reden>
```

`parseTestRunMarkers` (`test_run.go`) parsed ze **live**, tijdens het
streamen, voor de volatiele snapshot (zie hieronder) én **nogmaals** uit de
finale tekst voor het Activity-resultaat dat de workflow-history in gaat —
exact dezelfde discipline als `comment_batch.go`'s eigen `[slash:start]/
[slash:done]/[slash:skip]`, zodat het opgeslagen resultaat een pure functie
van die tekst blijft en replay nooit afhangt van of een stream werd
waargenomen (`.claude/rules/workflow-determinism.md`).

**Eén structureel verschil met `comment_batch`:** `comment_batch` krijgt de
reviewer's bevestigde comment-ids vooraf en valideert elke marker tegen die
bekende set. Een testrun heeft geen equivalent — Claude bepaalt zelf, tijdens
de run, zowel het testraamwerk als de set relevante tests. De per-test
progressielijst (`testRunProgress.Items`, `test_run_progress.go`) begint dus
**leeg** en groeit zodra een `[slash:test-start]` binnenkomt, in plaats van
vooraf gevuld en tegen een bekende id-ruimte gevalideerd te worden. Een
testnaam is vrije tekst die het model verzint — begrensd op lengte
(`testRunMaxNameLen`), nooit gebruikt om iets te adresseren/schrijven, alleen
om te tonen.

## Zichtbaarheid: een PR-breed progress-snapshot, naar het `comment_batch`-model

`test_run_progress.go` is het volatiele geheugen-alleen snapshot
(`testRunProgress`: `Running/Plan/Passed/Failed/Current/Phase/Tool/Detail/
Cancelled/Items/Error`), per PR, gepusht via de `testrun.progress` SSE-event
en leesbaar via `GET /api/test-run?pr=N` — dezelfde
`.claude/rules/workflows-write-boundary.md`-uitzondering als
`chat_progress.go`/`comment_batch_progress.go` (geen module, geen read-model,
geen workflow-history-write, leeg na een restart). Net als
`comment_batch_progress.go` blijft de snapshot **staan** na afloop van de run
(niet verwijderd) — een testrun laat zelf geen enkel durabel spoor achter, dus
"2 geslaagd, 1 mislukt" zou anders verdwijnen zodra de run klaar is.

Een item dat nog "busy" was toen de run eindigde (afgebroken, of de CLI
crashte middenin) krijgt de eigen staat `interrupted` — nooit stilzwijgend
verdwijnen of als geslaagd gelezen worden.

**Waar de reviewer het ziet:** `testRunStatusBlock` (`home.mjs`), een kaartje
in `prInfoCard`, onder de gewone GitHub-statuspillen — alleen gerenderd zolang
`hasTestRunActivity()` (`testRun.mjs`) iets te melden heeft. Er is **bewust
geen eigen bottom action-row** in de sidebar (zoals `comment_batch`'s
`batchActionRow`) — reviewer-beslissing: de sidebar is al druk genoeg. De
trigger is een item in het `/`-PR-menu (`PR_COMMANDS`, `home.mjs`): "Tests
laten draaien". `src/testRun.mjs` is de gedeelde reactive module (fetch + SSE,
geen component), qua vorm identiek aan `commentBatch.mjs`.

## Cancel — hergebruik van `chat_cancel.go`, geen nieuwe primitive

`runTestRun` registreert zijn `runCtx`-cancel-func onder een synthetische id
(`testRunCancelID(pr)` = `"testrun-<pr>"`) bij dezelfde
`registerChatCancel`/`cancelChatTurn` als een chat-turn — die map is altijd al
generiek per string-key geweest, niet letterlijk "per conversatie". Een
dunne `POST /api/test-run/cancel {pr}` roept alleen `cancelChatTurn(...)` aan
— net als `handleChatCancel`, puur een in-memory `context.CancelFunc`, nooit
een workflow-Signal (zie `chat_cancel.go`'s eigen doc-comment voor waarom een
Signal hier niet kan). Omdat elke `claude.RunChat`-aanroep al
`killOwnProcessGroup` gebruikt (`modules/claude/claude.go`, `Setpgid` +
group-SIGKILL bij context-cancel), doodt een cancel ook automatisch elk
kindproces dat Claude's Bash-tool startte (phpunit, composer, …), hoe diep ook
— geen extra werk nodig.

## De write-gate: gedeeld met een code-genererende chat-turn, bewuste keuze

Een testrun pakt dezelfde capaciteit-1 slot (`chat_write_gate.go`,
`acquireWriteTurnSlot`) als een chat-turn die naar Edit/Bash escaleert, in
plaats van een eigen slot te krijgen. Overwogen alternatief: een apart slot
zodat een testrun parallel met een code-editerende turn kan lopen. Verworpen:

- De gedeelde lokale checkout is één mutable resource. Een gelijktijdige
  code-turn die `git checkout`/`stash` doet kan de working tree onder een
  lopend testproces wegtrekken (valse fails) of de testrun's eigen resten
  interpreteren als iets om te stashen/weg te gooien.
- Geaccepteerde kost: een testrun en een code-turn wachten nu op elkaar,
  zichtbaar via de bestaande `chatPhaseWaiting`-fase (`advanceTestRunProgress`
  roept die exact zo aan als `runOneClaudeTurn` doet).

**Een tweede testrun-verzoek voor DEZELFDE PR wordt WEL geweigerd (409), niet
in de wachtrij gezet** — mirrort `handleCommentBatchStart`'s eigen precedent
exact, om twee redenen: beide runs zouden in dezelfde gedeelde checkout
verkennen/uitvoeren, en de per-PR progress-snapshot kan maar één run
beschrijven. Anders dan de write-gate hierboven (die twee VERSCHILLENDE
soorten operatie om de beurt laat gaan) is er geen reden een tweede,
identieke run te laten wachten — opnieuw vragen zodra de eerste klaar is kost
niets.

## Resten: laten staan, pas opruimen na 3 dagen — via de cleanup-workflow

Een testcommando kan bestanden achterlaten in de gedeelde checkout (caches,
coverage, logs) zonder dat er ooit een `Edit`-tool bij betrokken was.
Reviewer-beslissing, letterlijk: "laat ze staan, maar ruim wel op wat ouder is
dan 3 dagen".

- `runTestRun` (`test_run.go`) doet na de run een dry-run `git clean -ndx` in
  de checkout (`collectTestRunResidue`) en zet het resultaat — de directory
  plus een begrensde lijst paden (`testRunResidueMax = 200`) — op het
  Activity-resultaat (`testRunResult.ResidueDir`/`ResiduePaths`). Er gebeurt
  hier verder **niets**: geen automatische opruiming, geen landing (een
  testrun heeft nooit iets om te landen — geen Edit-tool).
- **Opruimen zit in de bestaande `cleanup`-workflow**, niet in `test_run`
  zelf — precies zoals gevraagd. `sweepTestRunResidue` (`cleanup.go`) is een
  derde onvoorwaardelijke Activity naast `purgeRetiredWorkflows`/
  `purgeOrphanCommentRuns` in `cleanupWorkflow`: het loopt over elke
  `test_run`-run met `Status == StatusCompleted` waarvan `UpdatedAt` ouder is
  dan `testRunResidueAge` (3 dagen, onafhankelijk van `cleanupMergedAge` en
  van of de PR zelf gemerged is — dit gaat alleen over de leeftijd van de
  resten). Voor elke gevonden run: een **verse** `git clean -ndx` in dezelfde
  directory, en alleen het snijpunt met de opgeslagen paden wordt echt
  verwijderd (`removeConfirmedTestRunResidue`) — een pad dat de reviewer zelf
  inmiddels heeft toegevoegd/verwijderd wordt met rust gelaten, dezelfde "nooit
  gokken"-discipline als `resolveCleanupTargets`/`purgeOrphanCommentRuns`.
  Daarna wordt de run zelf verwijderd (`engine.DeleteRun`) — niets blijft over
  om een tweede keer te overwegen.
- Wat jonger is dan 3 dagen wordt **alleen gemeld** (het statuskaartje in
  `prInfoCard` blijft staan), nooit aangeraakt.

## Tests

`test_run_test.go`: `TestParseTestRunMarkers` (de vier marker-soorten),
`TestTestRunProgressLifecycle` (geen voorgevulde lijst, `busy` → `interrupted`
bij afronden zonder uitkomst-marker), `TestSweepTestRunResidueAgeGate` (een
echte git-checkout met untracked resten; oud genoeg wordt verwijderd + de run
verdwijnt, vers genoeg blijft allebei met rust).
