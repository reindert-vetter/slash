package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/jiranotify"
)

// The jira_inbox tracker's reminder/snooze kinds end to end: add a reminder
// ("now" and a later moment), snooze one, lift it, delete one.
func TestJiraInboxRemindersAndSnooze(t *testing.T) {
	jn, err := jiranotify.Open(filepath.Join(t.TempDir(), "jiranotify.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { jn.Close() })
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	m.jiranotify = jn
	ctx := context.Background()
	runID := m.EnsureJiraInbox(ctx)
	if runID == "" {
		t.Fatal("no jira_inbox run")
	}
	bell := func() (visible, snoozed []jiranotify.Item) {
		rem, _ := m.ListReminders(ctx, time.Now())
		return splitBellItems(nil, rem, time.Now())
	}
	send := func(sig JiraNotifySignal) {
		t.Helper()
		sig, ok := validJiraNotifySignal(sig)
		if !ok {
			t.Fatalf("rejected %+v", sig)
		}
		if err := engine.SignalWorkflow(runID, SignalJiraNotify, sig); err != nil {
			t.Fatal(err)
		}
	}
	send(JiraNotifySignal{Kind: "reminder_add", Text: "  deploy checken ", Option: ReminderNow})
	send(JiraNotifySignal{Kind: "reminder_add", Text: "later", Option: SnoozeTomorrow})
	var vis, sn []jiranotify.Item
	waitFor(t, func() bool { vis, sn = bell(); return len(vis) == 1 && len(sn) == 1 })
	if vis[0].Title != "deploy checken" || !vis[0].Unread || vis[0].Kind != "reminder" {
		t.Fatalf("visible reminder = %+v", vis[0])
	}
	send(JiraNotifySignal{Kind: "snooze", ID: vis[0].ID, Option: SnoozeSevenDays})
	waitFor(t, func() bool { vis, sn = bell(); return len(vis) == 0 && len(sn) == 2 })
	send(JiraNotifySignal{Kind: "snooze", ID: sn[0].ID, Option: SnoozeClear})
	waitFor(t, func() bool { vis, sn = bell(); return len(vis) == 1 && len(sn) == 1 })
	send(JiraNotifySignal{Kind: "reminder_delete", ID: vis[0].ID})
	waitFor(t, func() bool { vis, sn = bell(); return len(vis) == 0 && len(sn) == 1 })

	for _, bad := range []JiraNotifySignal{
		{Kind: "reminder_add", Text: " ", Option: ReminderNow},
		{Kind: "reminder_add", Text: "x", Option: SnoozeClear},
		{Kind: "snooze", ID: "n1", Option: ReminderNow},
		{Kind: "snooze", Option: SnoozeTomorrow},
		{Kind: "reminder_delete", ID: "n1"},
	} {
		if _, ok := validJiraNotifySignal(bad); ok {
			t.Errorf("accepted %+v", bad)
		}
	}
}
