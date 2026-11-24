---
name: holly-review
description: Kryten's periodic review of how Holly's drafts are faring: reads Reply feedback, Item feedback and Holly lessons on both Sheets, finds corrections Jon keeps making, and proposes lasting changes to scripts/replies/voice.md, templates.md, scripts/ingest/rules.md or the lessons list for Jon's approval. Use when Jon asks how Holly is doing, why her drafts keep needing edits, for a "Holly review", or to tidy her lessons; also when a session has spare time and no review has been done for about a month, or after Jon rejects or rewrites several of her drafts in a row.
---

# Holly review

Holly (the parts that write to the public: replies.js and the listing write-ups in extract.js) already learns week to week: every draft carries the approved **Holly lessons** and the latest 8 corrections, and the Monday `lessons.yml` run proposes up to 5 new lessons. That only adds lessons, though. This review is the slower, human-scale step that CLAUDE.md asks of Kryten: spot what keeps going wrong and **fix it at the source** (her voice, a fixed template, a write-up rule), so the lessons list stays short and every draft improves, not just the ones that happen to match a lesson.

You propose. Jon decides. Never change Holly's public wording without his approval.

## 1. Read the feedback (on screen only)
Everything here is personal data: what senders wrote, Jon's final text, contacts. Read it with /k (`KRYTEN_TOKEN`), keep it on screen, and never copy it into a commit, PR, devtasks.json, log or the Plan doc. In anything that persists, describe patterns in general terms only ("asks for a time the sender already gave").

This prints the decided rows since a date (default: the last 30 days), with what Holly drafted and what Jon did. Reply feedback and Item feedback are per Sheet, so it runs for both. Holly lessons is one list in the Lenches Sheet.
```
SINCE=2026-10-25; for s in lenches harvington; do for t in "Reply feedback" "Item feedback"; do echo "== $s / $t"; curl -sS https://approvals.lenches.workers.dev/k -H "authorization: Bearer $KRYTEN_TOKEN" -H 'content-type: application/json' -d "{\"op\":\"read\",\"tab\":\"$t\",\"range\":\"A1:Z500\",\"max_rows\":500,\"site\":\"$s\"}" | SINCE=$SINCE python3 -c "
import json,sys,csv,io,os,collections
r=list(csv.reader(io.StringIO(json.load(sys.stdin)['csv'])))[1:]; h=r[0]; g=lambda x,c: x[h.index(c)] if c in h else ''
rows=[x for x in r[1:] if g(x,'decided_at')[:10]>=os.environ['SINCE'] and g(x,'outcome') and not g(x,'outcome').startswith('ignored')]
print(collections.Counter((g(x,'type'),g(x,'outcome')) for x in rows).most_common())
for x in rows:
  if g(x,'outcome') in ('approved','auto','window','handled','closed'): continue
  print('---',g(x,'type'),g(x,'class'),g(x,'outcome'),'|',g(x,'reason') or g(x,'changed'))
  print('HOLLY:',g(x,'draft')[:500]); print('FINAL:',(g(x,'final_text') or g(x,'final'))[:500])"; done; done
```
Then read the lessons: `{"op":"read","tab":"Holly lessons","range":"A1:H200"}` (Lenches only). Note their `notes` "Check: …" clashes from the Monday run.

Ignore `ignored:*` rows (Jon's tests and slips), `handled` ("Replied in Gmail") and `closed`. Decisions before 2026-11-02 18:50 UK are cleared down and not counted for Holly, so set `SINCE` after that unless Jon asks for history.

## 2. Find the patterns
Group the edited, redrafted and rejected rows by what Jon changed, not by sender. Look for:
- **Tone and voice**: too long, too formal, gushing, repeated phrases, wrong greeting or sign-off habits. → `scripts/replies/voice.md`.
- **A fixed wording** Jon rewrites the same way each time (ack, holding reply, outreach, live notice, listing check). → `scripts/replies/templates.md`.
- **Listing write-ups**: titles, dates, what gets cut or added (Item feedback `changed` shows "field: Holly's → yours"). → `scripts/ingest/rules.md`.
- **Wrong decisions**: drafting when no reply was needed, asking what was already given, chasing what's done. These are usually code or prompt rules (replies.js `FIXED_RULES`, `ASK_CODES`, Rimmer's `CHECKLIST`). Describe them for Jon as a possible Kryten job; don't fix code in this review.
- **Lessons**: ones that say the same thing, conflict ("Check: …" notes), or are now covered by a voice or template change and can be retired. Holly uses only the newest 20 approved, so a long list quietly drops old ones.

Count each pattern (e.g. "4 of 10 edits"). One-offs aren't patterns: leave them to the weekly lessons.

## 3. Report to Jon (on screen, short)
- One line on the numbers: per type, approved as written / edited / rejected in the period. The panel's Autonomy screen has the same counts.
- Up to 3 patterns, each with its count, a general description (no sender details) and one proposed fix: the exact new or changed wording for voice.md, templates.md or rules.md, or the lessons to merge, edit or retire.
- Anything that needs code, offered as a separate job.
Ask Jon which to apply. Wait.

## 4. Apply what Jon approves
- **voice.md / templates.md / rules.md**: edit the wording he approved. A template's `{placeholders}` and its heading key must stay the same (replies.js reads them by name). Run `node scripts/test-replies.js` (and `node scripts/test-ackfeedback.js` for ack wording), mocking Claude as the tests do. Commit with a plain subject ("Holly's voice: shorter thank-yous"), then PR and merge (`finish-job` skill).
- **Lessons**: Jon edits, retires or deletes them on the panel's **Holly lessons** screen (stale-checked), or asks you to make a /k `set` on the tab (with `expect`; quote the undo id). Never name anyone in a lesson.
- Add a `"kryten": true` devtasks to-do to check the next few drafts show the change.

## Why not just add lessons?
Lessons ride along in every prompt, and Holly's fixed rules come first. A fix in voice.md or a template applies to every draft at no extra length, can't clash with a lesson, and Jon reviews it once. So prefer a source fix for anything that recurs, and keep lessons for narrow, situational advice.
