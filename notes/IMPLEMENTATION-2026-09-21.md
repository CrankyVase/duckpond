# Workspace implementation — first slice

Implemented in the working tree, not deployed. Preserves the previous agent's work.

## Delivered

- Chat/Agent restore their selected conversations independently. Async navigation cannot
  let a late response replace a newer selection. New conversations retain their requested mode.
- Composer text persists by account and conversation, including mode switching and reload.
  Storage handles merge current state before writes; attachments are not stored in browser drafts.
- Default sidebar shows Models/Media plus Settings; untouched legacy defaults migrate,
  custom pins remain. Utility views stay available through More.
- Quieter welcome and stable hover/focus motion. Existing theme choices remain intact.
- Project setup explicitly separates existing source folders from new sandbox projects.
- Atomic text-file replacement preserves permission bits, rejects binary/symlink writes,
  and checks expected content for targeted edits. Missing replacement text is an error,
  never an implicit deletion. This is not a lock against arbitrary external editors.
- Durable per-run tool dispatch receipts prevent replay of the same ambiguous invocation.
  Orphan recovery records unknown tool outcomes; completed duplicate calls reuse their result.
- Media outputs now use the requested task type instead of an undefined wrapper property.
  Images no longer get a WAV extension; writes publish by rename; empty responses fail.
- Media queue pause is persistent and owner-controlled. It prevents new Studio queue
  dispatch, not active-job execution, direct chat image tools, or every GPU consumer.
- Stop requests and bridge correlation tags persist. Interrupted jobs are explicitly
  marked as needing reconciliation rather than falsely reported cancelled.
- Media retries preserve server-side reference images/audio and require confirmation
  when the previous result is unknown. The redacted polling row is no longer reused as input.

## Verification performed

- `server/npm run test:workspace`: atomic writes, stale content, permission preservation,
  binary/symlink boundaries, durable receipt replay/unknown outcomes, project search,
  persistent media pause, restart uncertainty and private reference preservation.
- `web/npm run test:workspace`: account/conversation draft isolation and stale storage handles.
- Frontend production build succeeds; existing accessibility/large-chunk warnings remain.
- Mocked browser workbench checks pass at desktop, tablet and phone widths, including
  switching modes, retaining drafts across reload, setup dialog, source/preview panes,
  and tool evidence. All API responses mocked; no inference calls.
- Syntax checks pass for edited server routes and media runner.

No local models loaded, no media generated, no stress tests, no production service restart,
and no deployment. The temporary static preview was only for mocked browser checks.

## Not yet implemented — do not mistake this slice for the full outline

- Worker leases/fencing, canonical-project mutation locks, and resumable checkpointed turns.
- Full edit snapshots/conflict-aware undo and transactional project-wide changes.
- Automatic upstream media result recovery: the bridge currently returns output on a
  synchronous request, so persisting a tag alone cannot recover a lost response.
- Full-stack preview origin/proxy and process reconciliation redesign.
- Shared GPU pause covering every inference entry point.
- Complete mode-specific generation profiles, Changes pane, and model-library redesign.
- Model-backed end-to-end and stress/fault-injection campaign, deferred by the owner.

The next backend slice should implement bridge result lookup and canonical project
ownership before claiming restart-safe autonomous execution. MiniMax source remains
a pinned design reference; no upstream code has been vendored in this slice.
