package main

import (
	"fmt"
	"reflect"
	"testing"
)

// diffLinesRef is the old untrimmed full-table implementation, kept as the oracle.
func diffLinesRef(a, b []string) []diffOp {
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if wsKey(a[i]) == wsKey(b[j]) {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	var ops []diffOp
	i, j := 0, 0
	for i < n && j < m {
		if wsKey(a[i]) == wsKey(b[j]) {
			ops = append(ops, diffOp{op: "eq", left: a[i], right: b[j]})
			i++
			j++
		} else if dp[i+1][j] >= dp[i][j+1] {
			ops = append(ops, diffOp{op: "del", left: a[i]})
			i++
		} else {
			ops = append(ops, diffOp{op: "ins", right: b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, diffOp{op: "del", left: a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, diffOp{op: "ins", right: b[j]})
	}
	return ops
}

func TestDiffLinesTrimMatchesFullTable(t *testing.T) {
	a := []string{"x", "  a", "b", "c", "d", "tail1", "tail2"}
	b := []string{"x", "a", "B", "c", "d", "e", "tail1", "tail2"}
	if got, want := diffLines(a, b), diffLinesRef(a, b); !reflect.DeepEqual(got, want) {
		t.Fatalf("trimmed diff differs:\n got %v\nwant %v", got, want)
	}
}

func TestDiffLinesHugeFileFewChanges(t *testing.T) {
	var a, b []string
	for i := 0; i < 120000; i++ {
		a = append(a, fmt.Sprintf("line %d", i))
		b = append(b, fmt.Sprintf("line %d", i))
	}
	b[60000] = "changed"
	ops := diffLines(a, b)
	changed := 0
	for _, o := range ops {
		if o.op != "eq" {
			changed++
		}
	}
	if changed != 2 {
		t.Fatalf("want 2 changed ops, got %d", changed)
	}
}

func TestDiffLinesOverCapFallsBack(t *testing.T) {
	var a, b []string
	for i := 0; i < 3000; i++ {
		a = append(a, fmt.Sprintf("a%d", i))
		b = append(b, fmt.Sprintf("b%d", i))
	}
	ops := diffLines(a, b)
	if len(ops) != 6000 || ops[0].op != "del" || ops[5999].op != "ins" {
		t.Fatalf("unexpected fallback ops: %d", len(ops))
	}
}
