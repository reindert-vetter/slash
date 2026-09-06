// plan_prompt.go — the prompt the `plan` tracker sends to Claude, and the
// parsing/normalising of what comes back (see plan_workflow.go).
//
// The model answers with ONE JSON object and nothing else. Everything the page
// needs is in it: the clarifying questions with their answer options, the
// example-code blocks per option (nested as deep as the explanation needs), and
// the "what has to be done" task list with its own blocks. Ids are assigned
// HERE, from the position in the answer, never by the model — a model
// reproduces "the second option of the first question" reliably and a
// "q1o2"-style identifier not at all, and stable ids are what the reviewer's
// stored answers hang off.
package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// planPrompt builds the Dutch prompt. mode "all" asks for questions + tasks
// (the first pass), "tasks" only for the task list (after an answer) — the
// questions themselves must not move while the reviewer is answering them.
func planPrompt(doc planDoc, mode string) string {
	var b strings.Builder
	b.WriteString("Je helpt een ontwikkelaar een Jira-ticket om te zetten in een scherp uitvoerplan.\n\n")
	fmt.Fprintf(&b, "TICKET %s: %s\n\n", doc.Key, doc.Title)
	desc := planTrim(doc.Description, 6000)
	if desc == "" {
		desc = "(geen omschrijving in Jira)"
	}
	b.WriteString("OMSCHRIJVING:\n" + desc + "\n\n")

	// Context from the other side of the parent/subtask relation. A subtask is
	// planned WITH its main task in view (but the plan covers only the
	// subtask); a main task is planned knowing which parts already hang under
	// it as their own tickets, so those are named rather than planned twice.
	if doc.ParentKey != "" {
		fmt.Fprintf(&b, "HOOFDTAAK %s: %s\n", doc.ParentKey, doc.ParentTitle)
		if pd := planTrim(doc.ParentDescription, 3000); pd != "" {
			b.WriteString(pd + "\n")
		}
		b.WriteString("Dit ticket is een SUBTAAK van die hoofdtaak. Gebruik de hoofdtaak als context (waar past dit in), maar maak het plan UITSLUITEND voor de subtaak hierboven — plan niets wat bij de hoofdtaak of een andere subtaak hoort.\n\n")
	}
	if len(doc.Subtasks) > 0 {
		b.WriteString("SUBTAKEN VAN DIT TICKET (elk een eigen ticket, apart opgepakt):\n")
		for _, st := range doc.Subtasks {
			fmt.Fprintf(&b, "- %s: %s", st.Key, st.Title)
			if st.Status != "" {
				fmt.Fprintf(&b, " (%s)", st.Status)
			}
			b.WriteString("\n")
		}
		b.WriteString("Het plan gaat over de hoofdtaak. Noem waar nodig hoe die subtaken erin passen, maar werk hun werk niet opnieuw uit.\n\n")
	}

	// The hotfix answer is a fixed constraint on the plan itself, not just on
	// where plan_execute branches from: a hotfix goes straight to production.
	if base := strings.TrimSpace(doc.BaseBranch); base != "" {
		if doc.Hotfix {
			fmt.Fprintf(&b, "HOTFIX: dit is een bug die als hotfix vanaf `%s` naar productie gaat. Houd het plan zo klein en risicoloos mogelijk: alleen wat de bug verhelpt, geen refactor en geen meeliftende verbeteringen.\n\n", base)
		} else {
			fmt.Fprintf(&b, "BASISBRANCH: dit plan wordt uitgevoerd vanaf `%s`.\n\n", base)
		}
	}
	if len(doc.Answers) > 0 {
		b.WriteString("AL BEANTWOORDE VRAGEN (gebruik deze keuzes als vaststaand):\n")
		for _, a := range doc.Answers {
			q, opt := planLookupAnswer(doc, a)
			fmt.Fprintf(&b, "- %s → %s", q, opt)
			if a.Text != "" {
				fmt.Fprintf(&b, " (toelichting: %s)", a.Text)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	b.WriteString("Antwoord met UITSLUITEND één JSON-object, zonder tekst eromheen en zonder code-fence:\n")
	b.WriteString(`{"questions":[{"question":"…","why":"…","options":[{"label":"…","detail":"…","blocks":[{"title":"app/Foo.php","label":"handle()","lang":"php","note":"…","code":"…","children":[{"title":"app/Support/Bar.php","label":"apply()","lang":"php","note":"…","code":"…","children":[]}]}]}]}],`)
	b.WriteString(`"tasks":[{"title":"…","explanation":"…","blocks":[{"title":"…","lang":"php","note":"…","code":"…","children":[{"title":"…","lang":"php","note":"…","code":"…","children":[]}]}]}]}`)
	b.WriteString("\n\nRegels:\n")
	if mode == "all" {
		fmt.Fprintf(&b, "- \"questions\": maximaal %d vragen die je ECHT nog nodig hebt om het plan te perfectioneren. Geen vraag waarvan het antwoord al in het ticket staat.\n", maxPlanQuestions)
		fmt.Fprintf(&b, "- Elke vraag heeft 2 tot %d concrete keuzes (\"options\"), geen open vraag.\n", maxPlanOptions)
		b.WriteString("- Elke keuze heeft minstens één blok met VOORBEELDCODE die laat zien hoe die keuze eruitziet.\n")
	} else {
		b.WriteString("- Laat \"questions\" leeg ([]): die zijn al gesteld.\n")
	}
	fmt.Fprintf(&b, "- \"tasks\": maximaal %d taken, in uitvoervolgorde: alles wat er moet gebeuren, met per taak een korte uitleg en voorbeeldcode.\n", maxPlanTasks)
	b.WriteString("- NEST je blokken: elk blok dat iets aanroept of aanpast krijgt \"children\" met de onderliggende stukken (de helper die het aanroept, de test die het dekt, de call-site die mee moet). Nest zo diep als het plan duidelijker maakt — twee of drie niveaus is normaal, één plat blok is te weinig.\n")
	b.WriteString("- ELK blok heeft een \"note\": één of twee zinnen uitleg over wat dat blok doet en waarom het nodig is. Dat geldt net zo hard voor ELK onderliggend blok, op ELK nestniveau — bij een kind-blok legt de note uit waarom het onder zijn ouder hangt (welke aanroep, welke dekking, welke call-site). Laat geen enkel blok zonder note.\n")
	b.WriteString("- \"code\" is echte, compileerbare voorbeeldcode, hooguit ~25 regels per blok. \"lang\" is php, typescript, javascript, sql, json, bash of yaml.\n")
	b.WriteString("- Prozateksten in het Nederlands, code en identifiers in het Engels.\n")
	return b.String()
}

// planTrim trims s and caps it at max bytes, marking that it was cut.
func planTrim(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max] + "\n…(afgekapt)"
	}
	return s
}

// planLookupAnswer turns a stored answer back into readable text for the
// prompt ("vraag → gekozen optie"), falling back to the raw ids.
func planLookupAnswer(doc planDoc, a planAnswer) (string, string) {
	q, opt := a.QuestionID, a.OptionID
	for _, pq := range doc.Questions {
		if pq.ID != a.QuestionID {
			continue
		}
		q = pq.Question
		for _, po := range pq.Options {
			if po.ID == a.OptionID {
				opt = po.Label
			}
		}
	}
	return q, opt
}

// planRaw mirrors the model's answer before ids/caps are applied.
type planRaw struct {
	Questions []struct {
		Question string `json:"question"`
		Why      string `json:"why"`
		Options  []struct {
			Label  string      `json:"label"`
			Detail string      `json:"detail"`
			Blocks []planBlock `json:"blocks"`
		} `json:"options"`
	} `json:"questions"`
	Tasks []struct {
		Title       string      `json:"title"`
		Explanation string      `json:"explanation"`
		Blocks      []planBlock `json:"blocks"`
	} `json:"tasks"`
}

// parsePlanAnswer extracts the JSON object out of the model's raw text (a
// stray ```json fence or a sentence around it is tolerated), then numbers and
// caps everything.
func parsePlanAnswer(raw string) ([]planQuestion, []planTask, error) {
	body := planJSONObject(raw)
	if body == "" {
		return nil, nil, fmt.Errorf("plan: no JSON object in the model's answer")
	}
	var pr planRaw
	if err := json.Unmarshal([]byte(body), &pr); err != nil {
		return nil, nil, fmt.Errorf("plan: parse answer: %w", err)
	}
	questions := make([]planQuestion, 0, len(pr.Questions))
	for _, q := range pr.Questions {
		if strings.TrimSpace(q.Question) == "" || len(questions) >= maxPlanQuestions {
			continue
		}
		pq := planQuestion{
			ID:       fmt.Sprintf("q%d", len(questions)+1),
			Question: strings.TrimSpace(q.Question),
			Why:      strings.TrimSpace(q.Why),
			Options:  make([]planOption, 0, len(q.Options)),
		}
		for _, o := range q.Options {
			if strings.TrimSpace(o.Label) == "" || len(pq.Options) >= maxPlanOptions {
				continue
			}
			pq.Options = append(pq.Options, planOption{
				ID:     fmt.Sprintf("%so%d", pq.ID, len(pq.Options)+1),
				Label:  strings.TrimSpace(o.Label),
				Detail: strings.TrimSpace(o.Detail),
				Blocks: normalizePlanBlocks(o.Blocks),
			})
		}
		if len(pq.Options) == 0 {
			continue
		}
		questions = append(questions, pq)
	}
	tasks := make([]planTask, 0, len(pr.Tasks))
	for _, tk := range pr.Tasks {
		if strings.TrimSpace(tk.Title) == "" || len(tasks) >= maxPlanTasks {
			continue
		}
		tasks = append(tasks, planTask{
			ID:          fmt.Sprintf("t%d", len(tasks)+1),
			Title:       strings.TrimSpace(tk.Title),
			Explanation: strings.TrimSpace(tk.Explanation),
			Blocks:      normalizePlanBlocks(tk.Blocks),
		})
	}
	if len(questions) == 0 && len(tasks) == 0 {
		return nil, nil, fmt.Errorf("plan: the answer held no questions and no tasks")
	}
	return questions, tasks, nil
}

// normalizePlanBlocks trims a block tree and drops the empty ones, recursively
// (the nesting itself is kept — it is what makes the plan readable).
func normalizePlanBlocks(list []planBlock) []planBlock {
	out := make([]planBlock, 0, len(list))
	for _, b := range list {
		b.Title = strings.TrimSpace(b.Title)
		b.Label = strings.TrimSpace(b.Label)
		b.Note = strings.TrimSpace(b.Note)
		b.Lang = strings.ToLower(strings.TrimSpace(b.Lang))
		b.Code = strings.TrimRight(b.Code, "\n")
		b.Children = normalizePlanBlocks(b.Children)
		if b.Code == "" && b.Title == "" && len(b.Children) == 0 {
			continue
		}
		if b.Title == "" {
			b.Title = "Voorbeeld"
		}
		out = append(out, b)
	}
	return out
}

// planJSONObject returns the outermost {...} of s, so a stray fence or a
// sentence before/after the JSON does not sink the whole answer.
func planJSONObject(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return ""
	}
	return s[start : end+1]
}
