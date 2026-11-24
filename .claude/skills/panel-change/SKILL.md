---
name: panel-change
description: Checklist for changing the admin panel (approvals.lenches.workers.dev/admin, the Cloudflare Worker in worker/): adding or changing a screen, button, badge, card, filter or API route, a new decision type, or a stale-checked Sheet edit, for either site. Use whenever a job touches worker/src/admin/ (index.js, ui/client.js, ui/css.js, any admin module) or Jon asks for something "in the panel", "on the Summary", "a button to…", "a new screen", even if he doesn't say "panel".
---

# Changing the admin panel

The panel is Jon's control room: every decision about what goes public happens there, so its rules exist to keep one approval path, never lose or overwrite his work, and show him how each screen works. Read the CLAUDE.md "Admin panel" and "Summary" bullets first for the current state.

## Where things are
- `worker/src/admin/index.js`: routes (`/admin/api/...`, with a comment list at the top: add yours there), `state()` and `summary()` data, site handling.
- `worker/src/admin/ui/client.js`: the whole page script. `VIEWS` (menu), `INTROS` (one line per screen), `HELP` (folded "How this works" per screen), and each screen's view function. `ui/css.js` holds the styles.
- One module per feature in `worker/src/admin/` (contacts.js, rimmer.js, autonomy.js…); `sheet.js` has `editCell` for stale-checked writes; `core.js` has `decide()`.
- Tests are in `worker/test/`: `*.test.mjs` (run with `node --test worker/test/<file>`) and browser checks `ui-*.check.mjs` (run with `node worker/test/<file>`, using Playwright's preinstalled Chromium).

## Rules, and why
1. **Decisions go through `decide()` in `worker/src/core.js`** (the same path as the signed email links), dispatching approval.yml or the job's workflow. Never add a second approval path: one path means one place to check, log and test what goes public.
   A new action needs:
   - an entry in `PANEL_ONLY` unless it is also meant for emailed links (/a refuses panel-only actions);
   - its handler in `scripts/approve` or its own workflow, with **per-item concurrency** (`group: x-${{ github.event.client_payload.id }}`), because a shared group silently drops waiting runs;
   - typed text (reasons, edited bodies) passed in the dispatch **body**, read from `GITHUB_EVENT_PATH`, never as env, since step env is printed in the public log.
2. **Writes to the Sheet are stale-checked**: send the value the page loaded (`expected`) and refuse with 409 if the cell changed (`sheet.js` `editCell`; spec with `onlyStatus`/`guard`/`alsoIf` where needed). Jon and the pipeline edit the same Sheet, so a blind write can undo his change.
3. **Both sites**: every `/admin/api` call carries `x-site`, and handleAdmin uses `siteEnv(env, site)`. Read and write the shown site's Sheet. Things that are one list for both sites (Holly lessons, Health) use `lenv` (the Lenches). Lenches-only screens (Photos) are hidden on other sites' menus. `dispatch` adds `client_payload.site` for non-Lenches sites; keep Lenches payloads unchanged, since they must match the email links.
4. **Every screen explains itself** (Jon, 4 Nov): a new screen gets an `INTROS` line and a `HELP` entry; a new button or badge gets a line in its screen's `HELP`. `worker/test/help.test.mjs` fails without them. Write help in plain words for a non-technical reader.
5. **Summary**: if the feature has something waiting for Jon, add a short code-written line to Summary (never Claude-written). When nothing is waiting it folds into "No action needed on: …".
6. **Cloudflare Access covers `/admin` only**: never put a public route (`/a`, `/u`, `/f`, `/s`, `/c`, `/o`, `/k`, `/r`, `/sg`) under it, and never put an admin feature outside it.
7. **Privacy**: the panel may show personal data to Jon, but Worker `console.log` lines and dispatch payloads are logged, so keep them to ids and counts.
8. Something Holly drafts after a tap: reuse the "Holly is drafting…" bar pattern (it polls state for the new awaiting draft). Something that builds: reuse the Building → Live ✓ pattern (`runs.js`, `showsText`).
9. A new workflow the panel starts: add its plain name to `runs.js` `WORKFLOW_NAMES` so Activity names it.
10. Data files the Worker bundles (site.json, trades.json, eat.json, contacts.json…) need their path in `deploy-worker.yml`'s `paths`, or the panel keeps the old copy.

## Mock it first
Visible changes need Jon's OK before building. Show a small mock-up (a screenshot of a quick HTML mock, or a browser check run against the change) and agree the wording of buttons, badges and help text.

## Test
- `node --test worker/test/help.test.mjs worker/test/admin.test.mjs` plus the feature's own `*.test.mjs` (add one for new logic, mocking Google and GitHub as the others do).
- The screen's browser check (`node worker/test/ui-<screen>.check.mjs`; extend it or copy the nearest one for a new screen), and `ui-sites.check.mjs` if site switching is involved. Take screenshots at phone and desktop sizes (`SHOTS=<dir>`) and show Jon the visible change.
- Run the decision's script path offline if one was added (e.g. `scripts/approve` with a fake event file).

## Ship
- PR and merge (`finish-job` skill). Merging deploys the Worker via `deploy-worker.yml`: check that run succeeded.
- Ask Jon to try it once in the panel (exact clicks), and note anything to watch in devtasks.json with `"kryten": true`.
- Update CLAUDE.md's panel bullet for the feature (what it does, files, tests), keeping it dense.
