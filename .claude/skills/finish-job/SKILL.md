---
name: finish-job
description: Kryten's end-of-job routine for thelenches-site: pre-push checks, commit, PR description, merge, Plan doc Build history entry, Project Plan edits, CLAUDE.md and devtasks.json updates, and the reply to Jon. Use whenever work on this repo is about to be committed, pushed or opened as a PR, even a one-line data change, or when Jon says "finish up", "wrap up", "merge it", "ship it" or "that's it".
---

# Finishing a job

Work through these in order. Small jobs are where steps get forgotten (a Build history entry or a devtasks to-do slips and has to be carried over), so don't skip one because the change is small: say "not needed" for it instead.

## 1. Pre-push checks
- Branch from a fresh `origin/main` (the panel's Edit page commits straight to main): `git fetch origin main && git rebase origin/main` if the branch is old.
- `npm ci` (never edit `package.json`), then an Eleventy build. If a change could touch Harvington, build that site too: `SITE=harvington npx @11ty/eleventy --output=<scratch dir>`.
- Run the offline tests for whatever changed (`scripts/test-*.js`, `worker/test/*.test.mjs`), mocking the Claude API and Google calls. Browser checks (`worker/test/ui-*.check.mjs`) after a build when panel or page markup changed.
- Moved or reorganised files: build before into a scratch folder, build after, then `scripts/compare-build.sh <before> _site`.
- Data shared between the sites (bins, term dates, cartoons, a new `_data` file or page): `node lib/parity.js`; add any intended difference to `KNOWN` with the reason.
- Admin panel, both-sites or newsletter changes: work through the `panel-change`, `both-sites` or `newsletter-change` checklist too.
- Visual or email changes: show Jon a preview (a screenshot or a sample render) before merging.
- Public-facing wording: Jon approves it before it is committed.

## 2. Commit
- Commit subjects say what changed in plain words ("Add carols on the green; fix bin day typo"): Holly and Rimmer read `git log -- src` as evidence of site changes.
- End the message with the attribution lines the session gives. Never put a model name in commits, PRs or code.
- Never commit secrets, Sheet data from /k, or private details (addresses, profiles, notes): the repo and its logs are public.

## 3. Pull request
- One PR. The description is the record of the work, with these sections:
  - **What changed**: files and behaviour. Name every `.github/workflows/` file changed.
  - **Jon to do by hand**: Sheet cells (exact cell and header text; he must unhide and insert columns first), settings, secrets. Say "Nothing" if none.
  - **Testing**: what you ran and the result, including anything not tested.
  - **Next run**: what to check on the next live or shadow run.
- Merge it yourself (GitHub MCP merge tool, squash) once the checks above have passed and any GitHub checks on the PR are green. Tell Jon in your reply that it was merged.
- After merging, if a workflow failed because of the change, fix it now.

## 4. Plan doc (without being asked)
The Plan doc is a Claude Doc: https://claude.ai/artifact/Qo9N1MsFpUonnnQcb6ZX6S. Use the Claude Docs connector, reading the outline and then only the parts you need.
- **Build history** tab: add `### <title> (PR <numbers>, <d Mon yyyy>)` and **one dense bullet** (what changed, files, columns, the first live result if known). New entries go at the top, just above the newest existing `###` entry (currently below "Holly on O…"). Write it as a normal edit, not a suggestion.
- **Project Plan** tab: make targeted edits only if the plan or status changed. Once something is built and tested, cut it there to a line or two and leave the detail in Build history.
- If the connector isn't available, tell Jon and add a `"kryten": true` to-do for the entry.

## 5. CLAUDE.md
- If a working rule, file location or behaviour that a future session needs changed, update CLAUDE.md in the same PR, keeping it dense and dated ("(24 Nov, Jon)").
- A significant visible site change: propose a siteupdates.json entry (use the `website-update` skill). Jon decides.

## 6. devtasks.json (`worker/src/admin/devtasks.json`)
- Remove what this job finished and add what is still outstanding. Never name private individuals.
- Anything Kryten owes later (a check after the next live run, a Build history entry put off) gets `"kryten": true`.
- Edit it with a small script that keeps the file's 2-space layout, so the diff shows only your change.

## 7. Reply to Jon
- Succinct, at most 4 sentences where possible: what went up, that it was merged, and anything he must do. Give him click-by-click steps for that, one step at a time.
- If the work should carry on in a new session, give him a paste-ready starter prompt.
