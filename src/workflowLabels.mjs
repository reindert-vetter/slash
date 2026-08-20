// workflowLabels.mjs — the Dutch label per tembed Workflow Type, shared by
// every place that names a workflow run to the reviewer: the "Taken" card in
// the review tree (RelatedPanel.mjs) and the "Mislukte taken" block on
// /pr-overview (overview.mjs). Extracted here so the overview page doesn't
// have to import RelatedPanel.mjs — that module carries the whole review-tree
// state (comment cursors, url-state bindings, watches) and has no business
// being loaded on the inbox page.
//
// Deliberately labels only: the status badges and the "why is this run in this
// status" sentences (STATUS_BADGES/WORKFLOW_STATUS_NOTE) stay in
// RelatedPanel.mjs — they describe runs that are still in progress, while the
// overview block only ever shows runs that already failed.

// An unknown type falls back to its raw name (see labelForWorkflow).
export const WORKFLOW_LABELS = {
  task_code_comment: 'Comment',
  pr_status: 'PR-status',
  build_relations: 'Relaties',
  resolve_call: 'Call zoeken',
  resolve_test_covers: 'Testdekking',
  explain_code: 'AI-omschrijving',
  summarize_chat: 'Chat-samenvatting',
  comment_titles: 'Comment-titels',
  approve: 'Goedkeuring',
  pr_inbox: 'Inbox',
  code_warning: 'Risicocontrole',
  ingest: 'Review-boom genereren',
  submit_review: 'Review insturen',
  ready_for_review: 'Klaar voor review',
  remove_reviewer: 'Mijzelf als reviewer verwijderen',
  task_inbox: 'Taken-inbox',
  task_snooze: 'Taken uitstellen',
  cleanup: 'Opruimen',
}

// labelForWorkflow names a Workflow Type, falling back to the raw type name
// for anything not in the map (a newly added workflow shows its own name
// rather than nothing at all).
export function labelForWorkflow(workflow) {
  return WORKFLOW_LABELS[workflow] || workflow || 'Taak'
}
