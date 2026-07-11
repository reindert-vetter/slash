---
name: add-workflow
description: Add a new durable task as a tembed Workflow (a Workflow Type) with its Activities and Signals, plus its POST /api/workflows/<type> endpoint. Use when adding a new long-lived, signal-driven task to slash (like task_code_comment). Enforces the workflows-only-write and determinism rules.
---

# Nieuwe workflow (Workflow Type) toevoegen

Een slash-**task** is een tembed **Workflow**. Terminologie volgt Temporal:
**Workflow Type** (de naam), **Workflow Execution** (een lopende instantie, met
**Run ID**), **Activity** (side-effect-werk), **Signal** (externe input).

**Lees eerst** `.claude/rules/workflow-determinism.md` en
`.claude/rules/workflows-write-boundary.md` — die zijn bindend.

## Stappen

1. **Kopieer** `.claude/templates/workflow.go` als startpunt (nieuw bestand of in
   `workflows.go`). Kies een snake_case **Workflow Type**, dat is meteen het
   endpoint-segment: `POST /api/workflows/<type>`.
2. **Definieer input/Signal-payloads** als kleine JSON-structs.
3. **Registreer Activities** op de engine (`engine.RegisterActivity("naam", fn)`).
   Een Activity is de **enige** plek waar een module mag schrijven of naar buiten
   praat. Best-effort side effects (b.v. `gh`) mogen falen zonder de workflow te
   laten sneuvelen — vang de error en geef een sentinel terug.
4. **Schrijf de Workflow-functie** (`func(w *tembed.Workflow, in []byte)
   ([]byte, error)`): deterministisch, alle side effects via `w.ExecuteActivity`,
   externe input via `w.WaitSignal`, tijd via `w.Now`/`w.Sleep`.
5. **Registreer** de workflow (`engine.RegisterWorkflow(type, fn)`), meestal in een
   `NewXxxManager(engine, modules...)` die ook de Activities bedraadt.
6. **Endpoints** (`tasks_api.go`, zie skill `add-api-endpoint` voor de
   server-conventies):
   - `POST /api/workflows/<type>` → `StartWorkflow` → `{ "runId": ... }`.
   - `POST /api/workflows/{runID}/signals/<signal>` → `SignalWorkflow` (UI-write).
   - `GET /api/workflows/{runID}` en read-models zijn read-only.
7. **Bootstrap & recovery**: bouw de engine in `newTasks(...)`, roep
   `engine.Recover()` bij startup, en hervat per-Execution achtergrondwerk
   (pollers) via `Runs()` + `Input()`.
8. **Poller/heartbeat** (optioneel): wil je periodiek iets checken (b.v. GitHub
   elke minuut), doe dat **buiten** de workflow in een goroutine die nieuwe feiten
   als **Signal** binnenbrengt — niet met een bezige loop ín de workflow.
9. **Test** (`*_test.go`): gebruik `tembed.NewMemoryStore()` + een module-fake,
   verklein poll-intervallen, en dek minstens één replay/herstart-pad
   (`engine.Recover()` mag een Activity nooit opnieuw draaien).

## Harde regels

- Workflow-body deterministisch (zie `workflow-determinism.md`).
- Alleen workflows/Activities schrijven (zie `workflows-write-boundary.md`).
- Geen nieuwe dependency zonder overleg; SQLite = `modernc.org/sqlite`.
- Herstart de server na een backend-wijziging (Go heeft geen hot-reload).
