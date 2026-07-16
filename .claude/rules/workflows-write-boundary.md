# Regel: alleen workflows muteren state

**Workflows zijn de enige schrijvers.** Elke state-verandering loopt via een
tembed **Workflow Execution**. Alles daarbuiten is **read-only van buitenaf**.

Dit is een harde architectuur-regel voor slash, geen suggestie.

## Wat mag wél schrijven

- **Workflow-definities** (`workflows.go`, Workflow Type `task_code_comment`, …).
- **Activities** die door zo'n workflow gedreven worden — dít is de enige plek
  waar een **module** zijn schrijf-methodes uitvoert.

## Wat is read-only

- **Modules** (`modules/*`): hun write-methodes (`Save`, `AddReaction`,
  `PostLineComment`, …) worden **uitsluitend** vanuit een workflow-Activity
  aangeroepen — nooit rechtstreeks vanuit een HTTP-handler, CLI of de UI. Hun
  **read**-methodes (`List`, …) mogen overal.
- **HTTP-API**: schrijven kan alléén via workflow-endpoints — een Execution
  **starten** (`POST /api/workflows/<type>`) of een **Signal** sturen
  (`POST /api/workflows/{runID}/signals/<signal>`). Elk ander endpoint is `GET`
  en read-only.
- **UI**: leest read-models (`GET /api/comments`, `GET /api/workflows/...`) en kan
  state alleen veranderen door een workflow te starten of te signalen. De UI
  schrijft nooit direct naar een tabel of module.

## Uitzondering: operationele pings zonder state

Een endpoint dat **géén state muteert** valt buiten deze regel, ook al is het een
`POST`. Concreet: `POST /api/workflows/{runID}/heartbeat` zet alléén een
in-memory tijdstip in de `TaskManager` (poll-cadans), schrijft niets naar de
event-history, een module of een tabel, en overleeft een herstart niet (het is
puur operationeel). Zo'n ping mag dus rechtstreeks vanuit de UI. **Twijfel je?**
Raakt het iets durabels (history/read-model/DB) → dan moet het via een
workflow (start/signal); raakt het niks → dan mag het.

Tweede voorbeeld: `GET /api/ingest/progress?pr=N` (`ingest_progress.go`) leest
een puur in-memory `map[int]string` (pr → huidige ingest-stage: `worktrees`/
`scan`/`relations`) die de `prepareWorktrees`/`scanAndStoreBlocks`/
`buildRelations`-Activities (`workflows.go`) bijwerken terwijl ze draaien. Geen
module, geen read-model, geen workflow-history-write — puur cosmetische
voortgang voor de "Genereer review-boom"/"Opnieuw genereren"-knop
(`src/overview.mjs`, gepollt terwijl `POST /api/ingest` in flight is) en gaat
verloren bij een herstart, net als de heartbeat-timing.

## Waarom

De workflow-event-history is de **bron van waarheid**: durable, herspeelbaar,
overleeft een herstart, en legt de volgorde van beslissingen vast. Een
module-tabel (b.v. `comments.db`) is een **afgeleid read-model** dat een Activity
bijwerkt. Door schrijven te bundelen in workflows houd je één auditbare bron en
kun je gedrag deterministisch herspelen.

## Checklist bij review

- Roept een HTTP-handler een module-write aan? → **fout**, laat het via een
  workflow (start/signal) lopen.
- Schrijft de UI/JS ergens direct naartoe (anders dan een start/signal-POST, of
  een state-loze operationele ping zoals `heartbeat`)? → **fout**.
- Zit er nieuwe mutatie-logica buiten een workflow/Activity? → verplaats 'm.

Zie ook `workflow-determinism.md`.
