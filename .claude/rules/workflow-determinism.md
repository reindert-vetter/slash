# Regel: workflow-code moet deterministisch zijn

tembed draait een Workflow-functie bij elke stap **opnieuw vanaf het begin** tegen
de opgeslagen event-history (replay). Dat werkt alléén als de functie bij dezelfde
history dezelfde beslissingen neemt. Behandel een workflow-body als een pure
functie van (input + history).

## Doen

- Alle **side effects** via een **Activity** (`w.ExecuteActivity`) — netwerk, DB,
  `gh`, bestandsIO, willekeur met gevolgen.
- **Tijd** via `w.Now()`, **wachten** via `w.Sleep(d)` (durable timer).
- **Externe input** via `w.WaitSignal(name, &out)`.
- Niet-deterministische waarden (random, uuid, klok) via `w.SideEffect(&out, fn)`
  zodat de waarde één keer wordt vastgelegd en bij replay wordt hergebruikt.

## Niet doen (breekt replay)

- Directe `time.Now()`, `rand`, `uuid.New()` in de workflow-body.
- Rechtstreeks netwerk/DB/`os/exec` of een module-write buiten een Activity.
- Iteratie over een `map` waarvan de volgorde de control-flow stuurt.
- Goroutines/`select`/kanalen in de workflow-body.
- De volgorde of het aantal `ExecuteActivity`/`WaitSignal`-calls laten afhangen van
  iets dat niet uit input of history komt.

## Waarom het misgaat

Verander je de volgorde van Activities tussen twee replays, dan matcht de
positionele history niet meer en krijg je een verkeerd of vastgelopen resultaat.
De determinisme-eis is precies wat durable replay (en dus herstart-overleving)
mogelijk maakt.

Zie ook `workflows-write-boundary.md` en de skill `add-workflow`.
