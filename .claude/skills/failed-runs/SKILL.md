---
name: failed-runs
description: Find, diagnose and fix failed GitHub Actions runs on JonF61/thelenches-site (and the Harvington build repo), then report to Jon. Use for the daily 05:53 failed-runs routine, at session start when failures show up, whenever a run fails after a merge, when GitHub's failure emails or the panel's Activity, Diagnostic or Watchdog show red, or when Jon says something "didn't run", "failed" or "is stuck", even if he doesn't name the workflow.
---

# Failed runs

Jon asked (10 Nov) for failures to be fixed proactively and reported, not left for him to notice. The pipeline runs dozens of workflows a day (ingest, publish, both site builds, newsletter, Rimmer, approvals), and a silent failure can mean an unsent reply, a stale site or a missed newsletter. The goal is to fix the cause and say plainly what happened.

## 1. List the failures
- GitHub MCP actions tools: `actions_list`, method `list_workflow_runs`, owner JonF61, repo thelenches-site, `perPage` 100. The result is too big to read inline: it is saved to a file, so filter it with python (keep `conclusion` in failure, timed_out or startup_failure, created in the last ~26 hours; print id, name, event, head_branch, created_at). Use page 2 if 100 runs don't reach back far enough. Where the `gh` CLI works (some routine sessions), `gh run list --limit 100 --json databaseId,workflowName,event,headBranch,conclusion,createdAt` does the same.
- Leave out runs on closed PR branches, and failures already followed by a later successful run of the same workflow when the cause was clearly transient (a Google 429, a network blip, a GitHub outage). Name these in the report as transient.
- The **Daily diagnostic** (05:17 UK, fired by the Worker) often fails only because it reports another failure or a check such as "Sites not in step" (lib/parity.js). Fix the thing it reports.
- Harvington's site is deployed to `JonF61/harvington-site` by build-harvington.yml in this repo, so its failures show here too.

## 2. Find the cause
- Read only the failed job's log tail (`get_job_logs` with the run id, failed jobs only, last ~60 lines; or `gh run view <id> --log-failed | tail -60`). Whole logs are expensive.
- Common causes here: a test or build broken by a recent merge (check `git log` around the run's head SHA); a Sheet header or column missing; a Google API 429 or 5xx; a secret or setting missing; the Claude API refusing or overloaded; concurrency cancelling (a "cancelled" run is not a failure unless a needed run was dropped); a schedule that GitHub started very late.
- Logs are public and may contain masked values. Never print or repeat secrets, subscriber addresses or the jon@ address in a PR, comment or report.

## 3. Fix it
- **Code or workflow cause**: fix it on a branch from a fresh `origin/main`, run `npm ci`, the build and the relevant offline tests (mock Claude and Google), then PR and merge (`finish-job` skill). Workflow changes follow the `new-workflow-or-column` skill.
- **Re-run** only a read-only workflow, one that sends no email, publishes nothing and writes nothing to a Sheet (e.g. Read Sheet tab, a build that only checks). Otherwise leave it to the next scheduled run, or ask Jon's go-ahead to run it now. Re-running an ingest, approval, newsletter or publish can send or publish twice.
- **Needs Jon** (a secret, a Cloudflare or Google setting, a decision on content): don't guess. Give him exact click-by-click steps with direct links, one step at a time.
- **Transient**: no change; mention it. If the same transient failure recurs over several days, treat it as a real problem (retry/backoff, a later schedule).

## 4. Report
Short, at most 4 sentences where possible: each failure, its cause, what you did (PR number, merged or not, re-run or not) and anything Jon must do. If nothing failed: "No failed runs in the last day." Then stop without changing anything.
When running as the routine, send it as the session's result, plus a push notification only if Jon must act. Record anything to check later in devtasks.json with `"kryten": true`.
