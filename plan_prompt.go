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

	// The comments are often where a ticket is really decided: one of them
	// walks the description back, narrows the scope, or names the constraint
	// nobody wrote down. Reviewer request: plan with the comments of the main
	// task and the subtasks in view, not just their descriptions.
	writePlanComments(&b, "OPMERKINGEN OP DIT TICKET (nieuwste onderaan):", doc.Comments)
	writePlanComments(&b, "OPMERKINGEN OP DE HOOFDTAAK EN DE SUBTAKEN:", doc.RelatedComments)
	if len(doc.Comments)+len(doc.RelatedComments) > 0 {
		b.WriteString("Een opmerking die iets terugdraait, inperkt of aanscherpt weegt ZWAARDER dan de oorspronkelijke omschrijving: de laatste stand van zaken is wat telt.\n\n")
	}
	// What already merged around this ticket family — the three most relevant
	// pull requests, with the files they touched (see plan_context.go).
	if len(doc.RelatedPRs) > 0 {
		b.WriteString("AL GEMERGED WERK DAT HIERBIJ HOORT (de meest relevante, nieuwste eerst):\n")
		for _, pr := range doc.RelatedPRs {
			fmt.Fprintf(&b, "- PR #%d: %s", pr.Number, pr.Title)
			if pr.Key != "" {
				fmt.Fprintf(&b, " [gevonden via %s]", pr.Key)
			}
			if pr.MergedAt != "" {
				fmt.Fprintf(&b, " (gemerged %s)", pr.MergedAt)
			}
			b.WriteString("\n")
			if len(pr.Files) > 0 {
				b.WriteString("  bestanden: " + strings.Join(pr.Files, ", ") + "\n")
			}
		}
		b.WriteString("Bouw hierop VOORT: hergebruik de patronen, bestanden en keuzes die hierboven al gemerged zijn in plaats van ze opnieuw te bedenken, en plan niets wat daar al gedaan is.\n\n")
	}
	// The base-branch answer is a fixed constraint on the plan itself, not just
	// on where plan_execute branches from: a hotfix goes straight to production.
	if base := strings.TrimSpace(doc.BaseBranch); base != "" {
		if doc.Hotfix {
			fmt.Fprintf(&b, "HOTFIX: dit gaat als hotfix vanaf `%s` rechtstreeks naar productie. Houd het plan zo klein en risicoloos mogelijk: alleen wat dit ticket nodig heeft, geen refactor en geen meeliftende verbeteringen.\n\n", base)
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

	// A follow-up round must not ask the same thing twice, so it sees every
	// question already on the document (answered or not) — appendPlanQuestions
	// drops a literal repeat, but the model should not spend a slot on one.
	if mode == "followup" && len(doc.Questions) > 0 {
		b.WriteString("VRAGEN DIE AL GESTELD ZIJN (stel deze NIET opnieuw):\n")
		for _, q := range doc.Questions {
			fmt.Fprintf(&b, "- %s\n", q.Question)
		}
		b.WriteString("\n")
	}
	b.WriteString("Antwoord met UITSLUITEND één JSON-object, zonder tekst eromheen en zonder code-fence:\n")
	b.WriteString(`{"questions":[{"question":"…","why":"…","options":[{"label":"…","detail":"…","blocks":[{"title":"app/Foo.php","label":"handle()","lang":"php","note":"…","code":"…","children":[{"title":"app/Support/Bar.php","label":"apply()","lang":"php","note":"…","code":"…","children":[]}]}]}]}],`)
	b.WriteString(`"tasks":[{"title":"…","explanation":"…","location":"…","conditions":["…"],"config":["…"],"migration":"…","endpoints":["…"],"errors":"…","rollout":"…","edgeCases":["…"],"outOfScope":["…"],"blocks":[{"title":"…","lang":"php","note":"…","code":"…","children":[{"title":"…","lang":"php","note":"…","code":"…","children":[]}]}]}]}`)
	b.WriteString("\n\nRegels:\n")
	switch mode {
	case "all":
		fmt.Fprintf(&b, "- \"questions\": maximaal %d vragen die je ECHT nog nodig hebt om het plan te perfectioneren. Geen vraag waarvan het antwoord al in het ticket staat.\n", maxPlanQuestions)
		fmt.Fprintf(&b, "- Elke vraag heeft 2 tot %d concrete keuzes (\"options\"), geen open vraag.\n", maxPlanOptions)
		b.WriteString("- Elke keuze heeft minstens één blok met VOORBEELDCODE die laat zien hoe die keuze eruitziet.\n")
	case "followup":
		// The reviewer asked for MORE questions to sharpen the plan further.
		// The existing questions are listed above as fixed choices; these are
		// the ones that come NEXT, and they are appended on our side.
		fmt.Fprintf(&b, "- VERVOLGVRAGEN: de vragen hierboven zijn al gesteld. Stel maximaal %d NIEUWE vragen die het plan nu nog scherper maken — dieper en concreter dan de vorige ronde, en nooit een herhaling daarvan.\n", maxPlanQuestions)
		fmt.Fprintf(&b, "- Elke vraag heeft 2 tot %d concrete keuzes (\"options\") met voorbeeldcode, precies als de vorige ronde.\n", maxPlanOptions)
		b.WriteString("- Laat \"tasks\" leeg ([]): de takenlijst wordt daarna apart opnieuw opgesteld.\n")
	default:
		b.WriteString("- Laat \"questions\" leeg ([]): die zijn al gesteld.\n")
	}
	b.WriteString("- Stel GEEN vragen over tests en laat de reviewer daar niets over kiezen.\n")
	fmt.Fprintf(&b, "- \"tasks\": maximaal %d taken, in uitvoervolgorde: alles wat er moet gebeuren, met per taak een korte uitleg en voorbeeldcode.\n", maxPlanTasks)
	// Reviewer request, verbatim: "elke if statement moet in de plan, elke
	// config ook", plus the checklist agreed with it. These fields are what
	// makes a task executable instead of a heading.
	b.WriteString("- Elke taak is CONCREET. Vul per taak in wat van toepassing is (laat een veld weg als het echt niet speelt, verzin niets):\n")
	b.WriteString("  - \"location\": in welke module of /app-map dit terechtkomt (het echte pad).\n")
	b.WriteString("  - \"conditions\": ELKE if/voorwaarde/branch die je toevoegt of aanpast, in woorden — welke conditie, wat gebeurt er als hij waar is en wat als hij niet waar is. Laat er geen weg.\n")
	b.WriteString("  - \"config\": ELKE config, env-variabele of instelling die erbij komt of verandert, met naam, waarde en standaardwaarde.\n")
	b.WriteString("  - \"migration\": datamigratie of schemawijziging (welke tabel/kolom, en hoe bestaande rijen meegaan).\n")
	b.WriteString("  - \"endpoints\": nieuwe of gewijzigde endpoints/routes, met methode en pad.\n")
	b.WriteString("  - \"errors\": foutafhandeling van deze stap — wat er misgaat en wat er dan gebeurt.\n")
	b.WriteString("  - \"rollout\": feature flag/uitrol en hoe je dit terugdraait als het misgaat.\n")
	b.WriteString("  - \"edgeCases\": randgevallen van de data — leeg, nul, heel groot, meerdere tegelijk.\n")
	b.WriteString("  - \"outOfScope\": wat expliciet NIET bij deze taak hoort.\n")
	b.WriteString("- Noem GEEN tests: welke test bij welke taak hoort bepaalt de uitvoerder zelf.\n")
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
		Location    string      `json:"location"`
		Conditions  []string    `json:"conditions"`
		Config      []string    `json:"config"`
		Migration   string      `json:"migration"`
		Endpoints   []string    `json:"endpoints"`
		Errors      string      `json:"errors"`
		Rollout     string      `json:"rollout"`
		EdgeCases   []string    `json:"edgeCases"`
		OutOfScope  []string    `json:"outOfScope"`
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
			Location:    planTrim(tk.Location, maxPlanDetailLen),
			Conditions:  normalizePlanDetails(tk.Conditions),
			Config:      normalizePlanDetails(tk.Config),
			Migration:   planTrim(tk.Migration, maxPlanDetailLen),
			Endpoints:   normalizePlanDetails(tk.Endpoints),
			Errors:      planTrim(tk.Errors, maxPlanDetailLen),
			Rollout:     planTrim(tk.Rollout, maxPlanDetailLen),
			EdgeCases:   normalizePlanDetails(tk.EdgeCases),
			OutOfScope:  normalizePlanDetails(tk.OutOfScope),
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

// maxPlanDetailItems/maxPlanDetailLen bound one task's concrete fields (see
// planTask): the model is asked for EVERY if and EVERY config, and a bounded
// list is what keeps that from turning one task into an essay.
const (
	maxPlanDetailItems = 8
	maxPlanDetailLen   = 300
)

// normalizePlanDetails trims one of a task's detail lists and bounds it.
func normalizePlanDetails(list []string) []string {
	if len(list) == 0 {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		item = planTrim(item, maxPlanDetailLen)
		if item == "" || len(out) >= maxPlanDetailItems {
			continue
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// appendPlanQuestions adds a follow-up round's questions AFTER the ones already
// on the document, renumbering only the new ones (q6, q6o1, …) so every stored
// answer keeps pointing at the question it was given for. A question the model
// simply repeats is dropped, and the total is bounded by
// maxPlanQuestionsTotal. Pure, so the numbering is testable.
func appendPlanQuestions(existing, fresh []planQuestion) []planQuestion {
	seen := make(map[string]bool, len(existing))
	for _, q := range existing {
		seen[strings.ToLower(strings.TrimSpace(q.Question))] = true
	}
	out := append([]planQuestion{}, existing...)
	for _, q := range fresh {
		text := strings.ToLower(strings.TrimSpace(q.Question))
		if text == "" || seen[text] || len(out) >= maxPlanQuestionsTotal {
			continue
		}
		seen[text] = true
		q.ID = fmt.Sprintf("q%d", len(out)+1)
		for i := range q.Options {
			q.Options[i].ID = fmt.Sprintf("%so%d", q.ID, i+1)
		}
		out = append(out, q)
	}
	return out
}

// writePlanComments renders one group of Jira comments into the prompt, oldest
// first, each bounded. An empty group writes nothing at all — a header with
// "geen opmerkingen" underneath only invites the model to reason about it.
func writePlanComments(b *strings.Builder, header string, list []planComment) {
	if len(list) == 0 {
		return
	}
	b.WriteString(header + "\n")
	for _, c := range list {
		b.WriteString("- ")
		if c.Key != "" {
			b.WriteString(c.Key + " · ")
		}
		if c.Author != "" {
			b.WriteString(c.Author)
		} else {
			b.WriteString("onbekend")
		}
		if c.Created != "" {
			b.WriteString(" (" + c.Created + ")")
		}
		b.WriteString(": " + planTrim(c.Body, maxPlanCommentLen) + "\n")
	}
	b.WriteString("\n")
}

// maxPlanCommentLen bounds ONE comment in the prompt: a pasted stack trace must
// not push the ticket itself out of the context window.
const maxPlanCommentLen = 1200
