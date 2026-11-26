---
name: sheet-access
description: Read and write the pipeline Google Sheets ("Lenches Pipeline" and "Harvington Pipeline") safely with the bundled k.py helper over the Worker's /k endpoint, with rows keyed by header name and writes by column name. Use whenever a job needs anything from either Sheet (Pending, Replies, Contacts, Settings, Rimmer, Issues, feedback or lessons tabs, Subscribers, Sends, Log…), to change a cell or status, to undo a Kryten write, or when Jon asks what a tab says, even if he doesn't mention the Sheet by name.
---

# Sheet access

Both pipeline Sheets are reached through the Worker's `POST /k` (Kryten's own bearer token, `KRYTEN_TOKEN`). Use **`k.py`** in this folder rather than hand-written curl and CSV code. /k's CSV puts the row number first and the column letters on a line of their own, and getting that wrong has twice aimed reads and writes at the wrong columns. k.py keys every row by its header name and real Sheet row number, and writes name the column, never a letter.

```
K=.claude/skills/sheet-access/k.py
python3 $K headers Pending                                  # column letters and names
python3 $K read Rimmer --where status=kryten                # matching rows, values cut to 120 chars
python3 $K read Rimmer --site harvington --count status     # counts instead of rows
python3 $K read "Reply feedback" --since decided_at=2026-11-02 --not outcome=approved,ignored* --cols type,outcome,reason
python3 $K read Pending --has duplicate --last 5 --json     # full values, as JSON
python3 $K get Pending 212                                  # one row, every field in full
python3 $K set Pending 212 status done --expect pending     # stale-checked; prints the undo id
python3 $K set Contacts 57 notes "…" --blank                # only into an empty cell
python3 $K append "Holly lessons" '{"id":"…","lesson":"…","status":"approved"}'
python3 $K undo w20261124101657408e
```
- `--site harvington` for the Harvington Sheet; the default is the Lenches. A few things live in the Lenches Sheet for both sites: Holly lessons, and Photos is the Lenches' alone.
- Reads page through the whole tab (500 rows a call), so big tabs (Sends, Log, Pending) cost a few seconds. Filter with `--where`, `--has`, `--since`, `--last`, `--cols` or `--count` rather than printing everything: fewer tokens, and less personal data on screen.
- A long value for `set` can come from stdin: pass `-` as the VALUE (or as `--expect`).

## Writes
- **Ask Jon first** for any write he hasn't asked for, then say what you changed and give its **undo id** (k.py prints it).
- `set` needs `--expect` with the value you just read (or `--blank`). /k refuses if the cell changed since, so a stale write never lands; re-read and ask, never force it. Take the expect value from `get` (or `--width 0`): `read` cuts long values with "…", and /k compares the cell as the Sheet displays it. `set` writes one cell; for a block, use the raw /k call in CLAUDE.md (at most 50 cells). Each write adds a **Kryten log** row with the old and new values. RAW only (no formulas), never row 1, at most 50 cells. /k never writes the Kryten log tab itself.
- One write at a time, and check each message before the next.
- The Sheet stays editable by Jon and the panel, and code reads columns **by header name**. So never rename, move or insert columns; a new column goes at the **end** (Jon unhides and types the header).
- A change to a Pending row (status, category, text, image cells) reaches the site only on the next publish. Dispatch `publish.yml` straight after (GitHub MCP actions tools); the newsletter draft follows the site build.
- To retire a Holly lesson, set its status to `retired`. Holly uses only `approved` rows.

## Privacy
/k shows everything in full: real addresses, Subscribers, Do Not Send, Sends, Replies, Contacts profiles and notes. That's fine on Kryten's screen, but never copy it into a commit, PR, devtasks.json, workflow input, log or the Plan doc (the repo and its logs are public). Describe patterns in general terms instead. Never print the token.

## When /k isn't available
k.py stops with a clear message when `KRYTEN_TOKEN` is missing or the proxy refuses the host (403). Then use the workflows, dispatched with the GitHub MCP actions tools, and read the job log:
- **Read Sheet tab** (`read-sheet-tab.yml`: `tab`, optional `range`, `max_rows`). Its logs are public, so it refuses the personal tabs, masks addresses and hides Contacts' profiles and notes. Never widen that.
- **Write Sheet cells** (`write-sheet.yml`: `action` set/append/undo, `tab`, `range` as a letter and row, `values`, `expect`, `undo_id`). Run inputs are public, so never pass private data in them. Check the header row first, since its CSV has the same row-number-first layout.
- For the personal tabs without /k, ask Jon.

## Asking Holly for a draft (only when Jon asks)
/k also takes `{"op":"draft","kind":"contactmail"|"nudge","email":"<a Contacts row's address>","brief":"…","site":"harvington"}`. It runs the panel's own Draft email / Draft nudge checks, and the draft waits in Replies for Jon's Approve. Send it with curl as in CLAUDE.md, adding `-A kryten-helper/1.0` (Cloudflare refuses some default clients with error 1010).

## SEO rankings (read-only)
`python3 $K rankings [--site harvington]` prints the panel's SEO → Rankings data (Ahrefs Rank Tracker: phone and computer positions now and a week ago, `checked`, `units` charged); `python3 $K rankings "<phrase>" mobile|desktop` prints that tracked phrase's Google top 10. Same 12-hour (overview) and one-day (top 10) cache as the panel, so repeat calls cost no Ahrefs units.
A Link partners row's link request (or its chaser, when due) is `{"op":"draft","kind":"linkask","id":"<partner id>","site":"harvington"}`: the panel's Draft request checks (email on the row, not already asked), fixed wording, waiting in Replies for Jon's Approve.
