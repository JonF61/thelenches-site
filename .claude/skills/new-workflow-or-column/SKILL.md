---
name: new-workflow-or-column
description: Checklist for adding or changing a GitHub Actions workflow (.github/workflows/*.yml) or adding a column or tab to the pipeline Google Sheets (Pending, Replies, Contacts, Settings or any tab code reads or writes). Use whenever a job creates or edits a workflow file, adds a schedule, dispatch or Run workflow input, or makes code read or write a new Sheet column or tab, even as a small part of a bigger change.
---

# New workflows and Sheet columns

Two kinds of change have each caused silent failures here: a workflow that ran for the wrong site, leaked typed text into a public log or dropped queued runs; and Sheet columns that code never actually read (until 15 Nov, everything past column AZ was invisible, so two features never worked). This checklist exists so neither happens again.

## A. A workflow
Start from the nearest similar workflow (e.g. `lessons.yml` for a scheduled Sheet job, `approval.yml` for a per-item dispatch) and keep its shape.
1. **Site**: any workflow touching a Sheet sets, at the top,
   `SITE: ${{ github.event.client_payload.site || github.event.inputs.site || 'lenches' }}`,
   and its Run workflow form gets a `site` input if it can be run by hand. `scripts/test-sheetsetup.js` checks every workflow with `GOOGLE_SA_KEY` for this. Schedules and `workflow_run` default to the Lenches. If both sites need the scheduled job, the Worker's crons fire it per site, or use a matrix like newsletter-draft.yml.
2. **Concurrency**: GitHub keeps only one *waiting* run per group, and a newer one cancels it, even with `cancel-in-progress: false`. If every dispatch must run (decisions, per-item jobs), key the group per item: `group: x-${{ github.event.client_payload.id }}`. Shared groups end in the site.
3. **Public logs**: a step's `env:` and run inputs are printed in the public Actions log. Pass secrets as `${{ secrets.X }}` (the team inbox is `secrets.GMAIL_USER`, never typed), and read typed or private text (reasons, edited bodies, briefs, addresses) from the event file (`GITHUB_EVENT_PATH`), never from env or inputs. Log lines print ids and counts. Build any line from someone's email with `lib/logsafe.js`.
4. **Claude spend**: every step with `ANTHROPIC_API_KEY` also sets `NODE_OPTIONS: --require ./lib/claudeusage.js`, so the Claude usage tab and the panel's spend card count it.
5. **Triggers between workflows**: commits made with `GITHUB_TOKEN` don't trigger other workflows. Dispatch what must follow (build.yml, build-harvington.yml, publish.yml) explicitly, as approval.yml does.
6. **Names**: add the file's plain name to `worker/src/admin/runs.js` `WORKFLOW_NAMES` so the panel's Activity screen names it, and note it in CLAUDE.md.
7. **Schedules**: GitHub's cron can start hours late. If timing matters, have the Worker's cron dispatch it (index.js SLOTS), as Rimmer does. Cloudflare cron days are 1=Sunday..7=Saturday, so always write day names (`WED`).
8. **Housekeeping**: `npm ci` (never edit package.json), `actions/checkout`/`setup-node` at the versions the others use, a `timeout-minutes`, least `permissions`.
9. **Test**: `node scripts/test-sheetsetup.js` (workflow checks) and the job's own offline test. After merging, dispatch it yourself with the GitHub MCP actions tools if it is read-only, and read the log. If it sends email, publishes or writes to the Sheet, ask Jon first. Name every workflow file changed in the PR description.

## B. A Sheet column or tab
1. **Never rename, move or insert** headers or tabs: code reads columns **by header name**, and the panel and scripts cache headers. A new column goes at the **end** of the tab.
2. **Who adds it**:
   - Code that writes it can add it itself with `scripts/ingest/google.js` `ensureColumn(tab, name)` (adds at the end, widening the grid if needed), as `auto_at` and the `sites` column do. A tab code creates gets its full header row on first use, as the Kryten log and Claude usage tabs do.
   - Otherwise Jon adds it by hand. The grid ends at the last column and technical columns may be hidden, so give him exact steps: which tab, unhide the last columns, insert one column after the last, type the exact header text in row 1 of that column (name the cell, e.g. "BC1: live_notified_at").
3. **Width**: scripts read A to ZZ (`readTable`), the panel A to BZ (`worker/src/admin/sheet.js` `TABLE_RANGE`), /k and k.py A to ZZ. A tab growing past BZ needs the panel range widened too. `scripts/test-widetable.js` covers this.
4. **Both Sheets**: each site has its own Sheet with the same tabs, so a new column must work on both. Either let code add it (`ensureColumn` runs per Sheet) or give Jon the steps for each Sheet. `scripts/sheetsetup` copies the Lenches tabs' header rows to a new site's Sheet, so a new tab made in the Lenches Sheet reaches future sites, but existing ones need it added.
5. **Private data**: if the column holds personal data, add the tab or column to what Read Sheet tab and Write Sheet cells refuse or mask (`scripts/sheettab`, `scripts/sheetwrite`; their logs are public). /k may show it to Kryten.
6. **Check a real run fills it**: after merging, wait for the next real run that should write the column, then read it (`sheet-access` skill: `python3 .claude/skills/sheet-access/k.py read <tab> --has <column> --last 3`). Until a real value appears, keep a `"kryten": true` devtasks to-do for it. This is the step that would have caught the AZ bug.

## Ship
PR and merge (`finish-job` skill), naming every workflow file changed and any column Jon must add (exact cells). Update CLAUDE.md where the workflow or column is described.
