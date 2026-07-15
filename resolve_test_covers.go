package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"slash/modules/claude"
	"slash/modules/testcovers"
)

// This file is the LLM side of test-coverage resolution (package main; it
// reads the head worktree and shells out to the claude CLI, so it runs only
// inside a resolve_test_covers Activity). It is used ONLY for the
// class-level-only case (#[CoversClass]/bare "@covers Class") — a method-level
// annotation always resolves statically in testcovers_analysis.go and never
// reaches here. Haiku picks from the class's own method shortlist
// (context-only); Sonnet searches the worktree agentically if Haiku isn't
// confident. Every claim is verified against the worktree (the method must
// really exist on the named class) before it is trusted.

// testCoverArg is the payload of the resolveTestCoversWithModel Activity: one
// test method, and the classes a class-level-only annotation named (each
// becomes its own "class:<Class>" target_key, mirroring the Go scan).
type testCoverArg struct {
	PR        int      `json:"pr"`
	TestID    string   `json:"testId"`
	TestFile  string   `json:"testFile"`
	TestClass string   `json:"testClass"`
	TestName  string   `json:"testName"`
	Classes   []string `json:"classes"`
	Model     string   `json:"model"` // claude.ModelHaiku | claude.ModelSonnet
}

// testCoverAnswer is the JSON shape we ask the model to emit.
type testCoverAnswer struct {
	Found      bool   `json:"found"`
	Method     string `json:"method"`
	Confidence string `json:"confidence"` // high | low
}

// resolveTestCoversWithModel resolves each of arg.Classes with one model and
// returns one testcovers.Entry per class (found — verified against the
// worktree — or notfound). Never returns an error: a model/CLI failure
// degrades to notfound so the workflow always completes (best-effort, like
// resolveCallsWithModel).
func resolveTestCoversWithModel(ctx context.Context, cl claude.Client, dataDir string, arg testCoverArg) []testcovers.Entry {
	_, headDir := worktreeDirs(dataDir, arg.PR)
	idx := buildSymbolIndex(headDir)
	agentic := arg.Model == claude.ModelSonnet
	shortModel := testcovers.ModelHaiku
	if agentic {
		shortModel = testcovers.ModelSonnet
	}

	testSrc := extractBlockSource(filepath.Join(headDir, arg.TestFile), arg.TestFile, arg.TestClass, arg.TestName)

	out := make([]testcovers.Entry, 0, len(arg.Classes))
	for _, class := range arg.Classes {
		short := shortName(class)
		targetKey := "class:" + short
		entry := testcovers.Entry{
			PR: arg.PR, TestID: arg.TestID, TargetKey: targetKey,
			Status: testcovers.StatusNotfound, Annotation: "CoversClass", CoveredClass: short, Model: shortModel,
		}

		req := claude.RunRequest{
			Model:  arg.Model,
			Prompt: testCoversPrompt(arg, short, idx.byClass[short], testSrc.Text, agentic),
		}
		if agentic {
			req.WorkDir = headDir
			req.Tools = []string{"Read", "Grep", "Glob"}
		}

		if cl != nil {
			if raw, err := cl.Run(ctx, req); err == nil {
				if ans, ok := parseTestCoverAnswer(raw); ok && ans.Found {
					if def := methodOnClass(idx, short, ans.Method); def != nil {
						code := blockSource(headDir, *def)
						entry.Status = testcovers.StatusFound
						entry.Confidence = ans.Confidence
						entry.CoveredFile = def.File
						entry.CoveredClass = def.Class
						entry.CoveredMethod = def.Name
						entry.CoveredLine = def.Line
						entry.CoveredCode = code.Text
					}
				}
			}
		}
		out = append(out, entry)
	}
	return out
}

// testCoversPrompt builds the model prompt: the test to explain, the class the
// coverage annotation named, the candidate methods on that class, and a
// strict JSON contract. For the agentic (Sonnet) variant it invites the model
// to search the checked-out repo.
func testCoversPrompt(arg testCoverArg, class string, cands []Block, testBody string, agentic bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are determining which method of a PHP class a PHPUnit test exercises.\n\n")
	fmt.Fprintf(&b, "Test: %s::%s (file %s) carries a coverage annotation naming the class `%s` but not a specific method.\n\n",
		arg.TestClass, arg.TestName, arg.TestFile, class)
	if testBody != "" {
		fmt.Fprintf(&b, "Test body:\n```php\n%s\n```\n\n", clip(testBody, 4000))
	}
	if len(cands) > 0 {
		b.WriteString("Methods defined on that class (pick the one this test exercises):\n")
		for _, c := range cands {
			fmt.Fprintf(&b, "- %s::%s  (file %s, line %d)\n", c.Class, c.Name, c.File, c.Line)
		}
		b.WriteString("\n")
	}
	if agentic {
		b.WriteString("You may use the Read, Grep and Glob tools to search this checked-out repository for `" + class + "` and confirm which of its methods the test's assertions actually exercise.\n\n")
	} else if len(cands) == 0 {
		b.WriteString("No methods were found statically on that class. If you cannot determine the method from the test body alone, answer found=false.\n\n")
	}
	b.WriteString("Respond with ONLY a JSON object, no prose, no markdown fences:\n")
	b.WriteString(`{"found": true|false, "method": "<method>", "confidence": "high"|"low"}` + "\n")
	b.WriteString("Set found=false (and confidence=\"low\") if you are not sure. Only answer found=true with confidence=\"high\" when you are confident the method exists on that class and is what this test exercises.\n")
	return b.String()
}

// parseTestCoverAnswer extracts the first {...} JSON object from the model
// output (models sometimes wrap it in prose or fences) and unmarshals it.
func parseTestCoverAnswer(raw string) (testCoverAnswer, bool) {
	start := strings.IndexByte(raw, '{')
	end := strings.LastIndexByte(raw, '}')
	if start < 0 || end <= start {
		return testCoverAnswer{}, false
	}
	var ans testCoverAnswer
	if err := json.Unmarshal([]byte(raw[start:end+1]), &ans); err != nil {
		return testCoverAnswer{}, false
	}
	return ans, true
}
