package main

// Template for a new tembed Workflow (a slash task). Copy into workflows.go (or
// a new file), rename, and wire the Manager in newTasks(). Read the rules first:
//   .claude/rules/workflow-determinism.md
//   .claude/rules/workflows-write-boundary.md

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/reindert-vetter/tembed"
	// import the modules this task drives, e.g.:
	// "slash/modules/comments"
)

// WorkflowExample is the Workflow Type (snake_case) — also the endpoint segment
// POST /api/workflows/example.
const WorkflowExample = "example"

// SignalExample is a Signal Name this workflow waits on.
const SignalExample = "example_signal"

// ExampleInput starts an Execution.
type ExampleInput struct {
	// ... task input fields (JSON) ...
}

// ExampleManager registers the workflow + its Activities on a tembed engine.
type ExampleManager struct {
	engine *tembed.Engine
	// modules this task drives, e.g. comments *comments.Module
}

// NewExampleManager wires the modules as Activities and registers the workflow.
func NewExampleManager(engine *tembed.Engine /*, modules... */) *ExampleManager {
	m := &ExampleManager{engine: engine}

	// An Activity is the ONLY place a module writes or talks to the outside.
	engine.RegisterActivity("doThing", func(ctx context.Context, in []byte) ([]byte, error) {
		// var arg SomeType; json.Unmarshal(in, &arg)
		// return nil, module.Save(ctx, arg)
		return nil, nil
	})

	engine.RegisterWorkflow(WorkflowExample, exampleWorkflow)
	return m
}

// exampleWorkflow is deterministic: all side effects via ExecuteActivity, all
// external input via WaitSignal, time via w.Now/w.Sleep.
func exampleWorkflow(w *tembed.Workflow, input []byte) ([]byte, error) {
	var in ExampleInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, err
	}

	if err := w.ExecuteActivity("doThing", in, nil); err != nil {
		return nil, fmt.Errorf("do thing: %w", err)
	}

	// React to Signals until done.
	for {
		var sig struct{ Done bool }
		w.WaitSignal(SignalExample, &sig)
		// ... store/handle the signal via an Activity ...
		if sig.Done {
			break
		}
	}
	return json.Marshal(map[string]any{"runId": w.RunID()})
}

// Start starts an Execution (write via workflow — allowed).
func (m *ExampleManager) Start(ctx context.Context, in ExampleInput) (string, error) {
	return m.engine.StartWorkflow(WorkflowExample, in)
}

// Signal delivers a Signal to a running Execution (the UI/API write path).
func (m *ExampleManager) Signal(runID string, payload any) error {
	return m.engine.SignalWorkflow(runID, SignalExample, payload)
}
