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
- With the `sheet-access` skill's helper (needs `KRYTEN_TOKEN`), list the rows whose `status` is `kryten` on both Sheets (`fix_note` is Jon's note):
  ```
  K=.claude/skills/sheet-access/k.py; for s in lenches harvington; do python3 $K read Rimmer --site $s --where status=kryten; done
  ```
- Without the token (or a 403 from the proxy), use the Read Sheet tab workflow (`read-sheet-tab.yml`, tab Rimmer, range A1:M300).
- Deal with each (fix in a PR, or explain), then ask Jon before setting its status to `fixed` or `dismissed` (`python3 $K set Rimmer <row> status fixed --expect kryten`; quote the undo id).

## 3. Chrome jobs
- Read the Plan doc's **Kryten and Holly** tab (https://claude.ai/artifact/Qo9N1MsFpUonnnQcb6ZX6S) with the Claude Docs connector: outline first, then only that tab. To keep it cheap, search the tab's body (node `be3e8150-7f47`) for "Chrome job" and view only the matching rows, rather than reading the whole tab. Look for Chrome job rows that Jon has answered (an answer in the row, Status not Done); act on them and set their Status to Done. If the connector isn't available, tell Jon.

## 4. Failed runs
- Follow the `failed-runs` skill for the last ~26 hours. The daily routine "Kryten: daily failed-runs check" (05:53 UK) usually covers these, so check only those since its last report or that it couldn't fix.

## Cost
Each /k read is cheap; reading the Plan doc and job logs is the expensive part, so read only the tab or job you need. If the checks are turning token-heavy, tell Jon and offer to defer.
