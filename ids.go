package main

import (
	"crypto/rand"
	"encoding/hex"
)

// newUIReactionID returns a random hex ID for a UI-originated reaction.
func newUIReactionID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
