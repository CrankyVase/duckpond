# Live button failures and deployment

The owner explicitly requested all working-tree changes deployed to the live site.
Used the repository's guarded `deploy.sh`, retaining local edits and the paused
automatic deploy timer. Frontend, Node service and changed media bridge were updated.
The live application was idle before restart; no model runs were requested.

## Findings and fixes

- Old running backend/new frontend mismatch: production logs showed 404 responses
  for `/api/media/jobs`. After deployment the route is registered and signed-in
  requests succeed. Public health is healthy and the frontend asset hash matches
  the newly built bundle. Git commit alone is not a useful deployment fingerprint
  while changes are uncommitted; source hashes are checkpointed by the deployer.
- Selecting the current Chat/Agent mode from a utility screen previously returned
  early without navigating. It now returns to the conversation, closes transient
  UI, and restores a conversation if none is loaded.
- During an asynchronous mode change the buttons now expose busy/disabled state
  instead of silently discarding clicks on apparently enabled controls.
- Sidebar opening/creation failures now show actionable toasts; navigation closes
  the model picker so its backdrop cannot linger across view changes.
- Media polling and cancellation errors are no longer silently swallowed. Polling
  failures show a Retry job status action; failed Stop requests show an error.

## Live checks

`server/test/liveNavigation.mjs` is explicitly opt-in. It uses an existing owner
session in memory, never logs/persists the cookie, and blocks all non-GET/HEAD
browser API requests. It does not create tasks, load models, generate media,
start downloads, save settings or delete content.

Validated against the public signed-in site: all 15 settings sections, Media Studio
and its four tabs, Model Hub, Files, Stats, Providers, Costs, Chat/Agent return from
Settings, model-picker opening/closing and the project-source setup choices.
No browser exceptions or failed API requests on the completed desktop run.

This is a navigation and interaction check, not proof that generation, downloads,
file mutations or other blocked actions complete. Those remain separate tests.
Dependency installation reported existing security advisories; no broad dependency
upgrades were mixed into this live button repair.
