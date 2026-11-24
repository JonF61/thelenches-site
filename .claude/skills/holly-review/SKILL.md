---
name: holly-review
description: Kryten's periodic review of how Holly's drafts are faring: reads Reply feedback, Item feedback and Holly lessons on both Sheets, finds corrections Jon keeps making, and proposes lasting fixes (scripts/replies/voice.md, templates.md, scripts/ingest/rules.md, or lessons to retire or merge) for Jon's approval. Use whenever Jon asks how Holly is doing, says she keeps getting something wrong, asks why her drafts need edits or about her lessons or Autonomy numbers, or asks for a "Holly review"; also offer it when about a month has passed since the last review, or after Jon rejects or rewrites several of her drafts in a row.
---

# Holly review

Holly (the parts that write to the public: replies.js and the listing write-ups in extract.js) already learns week to week: every draft carries the approved **Holly lessons** and the latest 8 corrections, and the Monday `lessons.yml` run proposes up to 5 new lessons. That only adds lessons, though. This review is the slower, human-scale step that CLAUDE.md asks of Kryten: spot what keeps going wrong and **fix it at the source** (her voice, a fixed template, a write-up rule), so the lessons list stays short and every draft improves, not just the ones that happen to match a lesson.

You propose. Jon decides. Never change Holly's public wording without his approval.

## 1. Read the feedback (on screen only)
Everything here is personal data: what senders wrote, Jon's final text, contacts. Read it with /k (`KRYTEN_TOKEN`), keep it on screen, and never copy it into a commit, PR, devtasks.json, log or the Plan doc. In anything that persists, describe patterns in general terms only ("asks for a time the sender already gave").

This prints the decided rows since a date (Reply feedback and Item feedback are per Sheet, so it runs for both), with what Holly drafted and what Jon did, using the `sheet-access` skill's helper:
```
K=.claude/skills/sheet-access/k.py; SINCE=2026-11-25   # the day after the last review
for s in lenches harvington; do
  python3 $K read "Reply feedback" --site $s --since decided_at=$SINCE --count outcome
  python3 $K read "Reply feedback" --site $s --since decided_at=$SINCE --not outcome=approved,handled,closed,ignored* --cols decided_at,type,class,outcome,reason,draft,final_text --width 700
  python3 $K read "Item feedback" --site $s --since decided_at=$SINCE --not outcome=approved,auto,window,ignored* --cols decided_at,type,outcome,changed,draft,final --width 700
done
```
Then read the lessons: `python3 $K read "Holly lessons" --width 0` (Lenches only). Note their `notes` "Check: …" clashes from the Monday run.

Set `SINCE` to the day after the last review: find it by searching the Plan doc's Build history for "Holly review" (the first was 24 Nov 2026). Going back further re-reads corrections already dealt with. Never go before the 2 Nov 2026 18:50 clear-down unless Jon asks for history, since those decisions aren't counted for Holly. The `--not` filters leave out what isn't a correction: `ignored:*` (Jon's tests and slips), `handled` ("Replied in Gmail"), `closed`, and drafts that went out as written.

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
- **Lessons**: Jon edits, retires or deletes them on the panel's **Holly lessons** screen (stale-checked), or asks you to change it with the helper (`python3 $K set "Holly lessons" <row> status retired --expect approved`, or `lesson` with `--expect` the old text; quote the undo id). To retire a lesson, set its status to `retired` (Holly uses only `approved` rows) rather than deleting it, so the record stays. Never name anyone in a lesson.
- Add a `"kryten": true` devtasks to-do to check the next few drafts show the change.

## Why not just add lessons?
Lessons ride along in every prompt, and Holly's fixed rules come first. A fix in voice.md or a template applies to every draft at no extra length, can't clash with a lesson, and Jon reviews it once. So prefer a source fix for anything that recurs, and keep lessons for narrow, situational advice.
