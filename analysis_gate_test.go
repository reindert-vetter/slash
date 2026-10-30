package main

import (
	"context"
	"testing"
)

func TestAcquireAnalysisSlotBlocksAtCap(t *testing.T) {
	old := analysisRunSlots
	analysisRunSlots = make(chan struct{}, 1)
	defer func() { analysisRunSlots = old }()

	rel, err := acquireAnalysisSlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := acquireAnalysisSlot(ctx); err == nil {
		t.Fatal("expected blocked acquire to fail on cancelled ctx")
	}
	rel()
	rel2, err := acquireAnalysisSlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rel2()
}
