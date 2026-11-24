---
name: regular-activity
description: Add, update, pause or remove a regular activity (weekly class, club or group) in sites/lenches/items/regulars.json, shown on both sites' Regular activities pages and in the newsletter. Use whenever something meets on a repeating pattern (every Tuesday, monthly, term time): a Holly note saying "Regular activity: add it…by hand", a village hall or club listing its groups, a Facebook post or email about a weekly class, or Jon asking to add, change, pause or remove a regular, club, class or group, on either site.
---

# Regular activities

All regulars live in one file, `sites/lenches/items/regulars.json` (`regulars` array), and show on both sites (lib/whatson.js `loadWhatson`). A one-off taster session is an **event**, not a regular. For an event or notice, follow the hand-written item rules in CLAUDE.md or the `facebook-items` skill.

## 1. Before writing: check, then ask Jon
- Check it isn't already listed: `grep -i "<what or venue>" sites/lenches/items/regulars.json sites/harvington/items -r`. If it is, offer to update that entry instead.
- Show Jon the proposed entry (fields below) on screen, and **always ask** (Jon, 11 Nov), however it reached us, because only he knows the history and the newsletter labels the two differently:
  - **New activity** (the activity itself has just started) → `"newActivity": true`, shown first as "New activity:" in the newsletter; or
  - **Newly listed** (it has run for a while, it's just new to our list) → no flag, shown as "Newly listed:".
- Organisers' names and contact details are published only with that organiser's consent (Jon, 30 Oct). If you're not sure there's consent, leave them out and ask.
- Use only facts from the source. Never guess times, costs or contacts. Leave a field out rather than leaving it blank (Jon, 30 Oct).
- Wait for Jon's approval of the wording.

## 2. The entry
```json
{
  "day": "Wednesday",
  "time": "7.30-9pm",
  "what": "Rangers",
  "where": "Harvington Village Hall",
  "frequency": "Term time",
  "forWho": "Young women aged 14 to 18",
  "about": "Volunteer-led Girlguiding activities, trips and adventures.",
  "runBy": "Harvington Guides (Girlguiding)",
  "email": "hello@harvingtonguides.org.uk",
  "website": { "text": "Harvington Guides", "url": "http://harvingtonguides.org.uk/" },
  "booking": "Sign up through the Girlguiding website, or email",
  "checked": "2026-11",
  "added": "2026-11-22"
}
```
- **Core** (one line in the newsletter and the snapshot): `day` (Monday..Sunday; blank = "Day to be confirmed", listed last), `time` (as shown: "9.45am", "7-8pm"; may be blank), `what`, `where`, optional `note`, `link` {text, url; a site path like `/churches/` is fine}, `until` (YYYY-MM-DD, the last day shown, e.g. a block's final session).
- **Page only**: `frequency` (blank = every week; e.g. "1st Tuesday of the month", "Term time"), `about`, `runBy`, `phone`, `email`, `website` {text, url}, `forWho`, `cost`, `booking`, `bring`, `image` {url, alt}, `tile`, `checked` (YYYY-MM, this month), `pausedUntil` (YYYY-MM-DD), `detailsElsewhere: true` (hides the detail rows).
- **Always**: `added` = today (YYYY-MM-DD). It gives the "Newly listed / New activity" line in the newsletter for 14 days. Add `newActivity: true` only if Jon says it's a new activity.
- **One site only** (members or residents of one community only): `"sites": "lenches"` or `"harvington"`. Otherwise leave it out, so it shows on both.
- **Picture**: a flyer goes in `sites/lenches/images/items/` with a new file name, as `image` {url `/images/items/<file>`, alt}. Without one, a drawn tile is picked from `what`/`about`. Set `tile` to force one of: yoga, taichi, fitness, quiz, coffee, church, music, fete, sport, walk, theatre, meeting, children, village.
- Order in the file doesn't matter: whatson.js sorts Monday first, then by time. Add new entries at the end. Keep the file's 2-space JSON layout.

## 3. Changes
- **Update**: edit the one entry and set `checked` to this month.
- **Pause**: `pausedUntil` = the date it restarts.
- **Block ending**: `until` = the last session's date.
- **Remove**: delete the entry (only when it has stopped, or the organiser asks).

## 4. Finish
- `node scripts/test-regulars.js && node scripts/test-regular.js`, plus an Eleventy build of both sites.
- Commit with a plain subject ("Add Rangers (Harvington Guides) to regular activities"), then PR and merge (`finish-job` skill).
- If it came in as an email submission, tell Jon to tap **Done already** on that submission in the panel.
- If it came from Holly's village hall email or a devtasks to-do, remove that to-do.
