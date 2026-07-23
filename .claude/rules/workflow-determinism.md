# Rule: workflow code must be deterministic

tembed re-runs a Workflow function **from the beginning** at every step against
the stored event history (replay). That only works if the function makes the
same decisions given the same history. Treat a workflow body as a pure
function of (input + history).

## Do

- All **side effects** via an **Activity** (`w.ExecuteActivity`) — network, DB,
  `gh`, file IO, randomness with consequences.
- **Time** via `w.Now()`, **waiting** via `w.Sleep(d)` (durable timer).
- **External input** via `w.WaitSignal(name, &out)`.
- Non-deterministic values (random, uuid, clock) via `w.SideEffect(&out, fn)`
  so the value is recorded once and reused on replay.

## Don't (breaks replay)

- Direct `time.Now()`, `rand`, `uuid.New()` in the workflow body.
- Direct network/DB/`os/exec` or a module write outside an Activity.
- Iterating over a `map` whose order drives control flow.
- Goroutines/`select`/channels in the workflow body.
- Letting the order or number of `ExecuteActivity`/`WaitSignal` calls depend
  on something that doesn't come from input or history.

## Why it breaks

If you change the order of Activities between two replays, the positional
history no longer matches and you get a wrong or stuck result. The
determinism requirement is exactly what makes durable replay (and thus
restart survival) possible.

See also `workflows-write-boundary.md` and the skill `add-workflow`.
