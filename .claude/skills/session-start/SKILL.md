---
name: session-start
description: Kryten's start-of-session checks for thelenches.org.uk / harvingtonvillage.org.uk: carried-over to-dos in devtasks.json, Rimmer findings sent to Kryten, answered Chrome jobs, and recent failed workflow runs, then one short summary. Use at the start of every working session on this repo (before or alongside Jon's first request, even if he doesn't ask), or when Jon says "session checks", "start-up checks", "what's outstanding" or "anything for me?".
---

# Session-start checks

Run these quickly and cheaply, then give Jon **one short summary** (what was found, what you'll do, anything needing him). Don't let them hold up Jon's actual request: if he has asked for something urgent, do that first and the checks after. If nothing is found, say so in one line.

## 1. Kryten's to-dos
- `python3 -c "import json;[print('-',t['task']) for t in json.load(open('worker/src/admin/devtasks.json'))['tasks'] if t.get('kryten')]"`
- For each: do it now if it is due and needs no decision from Jon; otherwise ask Jon, or leave it if it is dated for later (e.g. "after the 3 Dec issue"). Remove each one you finish from devtasks.json in that job's PR.

## 2. Rimmer findings sent to Kryten
- With `KRYTEN_TOKEN` set (check with `[ -n "$KRYTEN_TOKEN" ]`, never print it), this lists the rows whose `status` (column K) is `kryten` on both Sheets; `fix_note` (M) is Jon's note. /k's CSV starts with a line of column letters, so the real headers are the second line:
  ```
  for s in lenches harvington; do echo "== $s"; curl -sS https://approvals.lenches.workers.dev/k -H "authorization: Bearer $KRYTEN_TOKEN" -H 'content-type: application/json' -d "{\"op\":\"read\",\"tab\":\"Rimmer\",\"range\":\"A1:U300\",\"max_rows\":300,\"site\":\"$s\"}" | python3 -c "
  import json,sys,csv,io
  r=list(csv.reader(io.StringIO(json.load(sys.stdin)['csv'])))[1:]; h=r[0]
  k=[x for x in r[1:] if x[h.index('status')]=='kryten']; print(len(r)-1,'rows; kryten:',len(k))
  for x in k: print(dict(zip(h,x)))"; done
  ```
- Without the token (or a 403 from the proxy), use the Read Sheet tab workflow (`read-sheet-tab.yml`, tab Rimmer, range A1:M300).
- Deal with each (fix in a PR, or explain), then ask Jon before setting its status to `fixed` or `dismissed` (a /k `set` with `expect` = `kryten`; quote the undo id).

## 3. Chrome jobs
- Read the Plan doc's **Kryten and Holly** tab (https://claude.ai/artifact/Qo9N1MsFpUonnnQcb6ZX6S) with the Claude Docs connector: outline first, then only that tab. To keep it cheap, search the tab's body (node `be3e8150-7f47`) for "Chrome job" and view only the matching rows, rather than reading the whole tab. Look for Chrome job rows that Jon has answered (an answer in the row, Status not Done); act on them and set their Status to Done. If the connector isn't available, tell Jon.

## 4. Failed runs
- List recent runs with the GitHub MCP actions tools (`actions_list`, method `list_workflow_runs`, repo JonF61/thelenches-site). There is no failure filter and 100 runs is too big to read inline: the tool saves the result to a file, so filter that with python (keep runs whose `conclusion` is not success, skipped or cancelled, created in the last ~26 hours). The daily routine "Kryten: daily failed-runs check" (05:53 UK) usually covers these, so check only those since its last report or that it couldn't fix.
- Read a failed job's log (`get_job_logs`), fix code or workflow causes in a PR and merge it, re-run only read-only workflows, and give Jon click-by-click steps for anything only he can do.

## Cost
Each /k read is cheap; reading the Plan doc and job logs is the expensive part, so read only the tab or job you need. If the checks are turning token-heavy, tell Jon and offer to defer.
