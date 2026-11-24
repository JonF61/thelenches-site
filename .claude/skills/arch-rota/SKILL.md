---
name: arch-rota
description: Type the ARCH Benefice Messenger's church service rota and readings into sites/lenches/_data/services.json (read by both sites' Churches pages and Holly's site facts). Use when Jon attaches or mentions a new ARCH Messenger, or asks to update church service times or readings.
---

# ARCH Messenger rota

The ARCH Benefice Messenger (monthly) lists each Sunday's and feast day's services across the benefice and the readings. Kryten types it into **one file**, `sites/lenches/_data/services.json`; Harvington reads the same file (`sites/harvington/_data/services.js`), so never copy it there.

## 1. Get the Messenger
Jon attaches it (PDF or screenshots). If he says it came by email, find it with the Gmail connector (search recent days only). Ask if any page is unreadable rather than guessing a time or village.

## 2. File format
```json
{
  "source": "ARCH Messenger, December 2026",
  "midweek": "A midweek Eucharist is held every Wednesday at 11am at St James the Great, Harvington.",
  "dates": [
    {
      "date": "2026-12-06",
      "name": "2nd Sunday of Advent",
      "readings": [
        { "ref": "Isaiah 40:1-11" },
        { "ref": "Psalm 85:1-2, 8-end", "q": "Psalm 85:1-2, 8-13" },
        { "ref": "Mark 1:1-8" }
      ],
      "services": [
        { "time": "9.30am", "village": "Norton", "service": "Holy Communion" },
        { "time": "11am", "village": "Church Lench", "service": "Family Service", "note": "followed by bring-and-share lunch" }
      ]
    }
  ]
}
```
- `date` YYYY-MM-DD; `name` the Sunday/feast as the Messenger gives it.
- `village`: one of Church Lench, Rous Lench, Abbots Morton, Harvington, Norton (the place, not the church name). A new place: ask Jon.
- `time` as shown on the site: "9.30am", "11am", "6pm" (dot, not colon; no space).
- `service`: drop any trailing "@" + number ("Church@10" → "Church").
- `note` (optional): short lower-case extra from the Messenger ("at the village hall", "followed by bring-and-share lunch").
- `harvest` (optional): a second readings list for Harvest services, shown as "Or, for Harvest:".
- `midweek`: update only if the Messenger changes it.

## 3. Rules
- **Never** list baptisms, funerals or weddings.
- Readings as "Book ch:v-v" (full book name, as in the file). Where the Messenger says "-end", keep that in `ref` and add `q` with the real last verse (check the chapter's last verse) so the Bible Gateway link works.
- Dates in order. Remove dates that have passed (they no longer show), add the new month's, and keep any later dates already typed unless the new Messenger changes them. Update `source`.
- Copy times and villages exactly; if the Messenger contradicts itself, ask Jon.

## 4. Check, commit, merge
- `python3 -c "import json;json.load(open('sites/lenches/_data/services.json'))"`, then build both sites (`npx @11ty/eleventy` and `SITE=harvington npx @11ty/eleventy --output=<dir>`) and look at each built `churches/index.html` for the new dates; `node scripts/test-sitefacts-sites.js`.
- Show Jon a short on-screen summary (date, name, services) before committing if anything was unclear.
- Commit subject like "Church services: ARCH Messenger December 2026 rota"; branch, PR, merge (per CLAUDE.md).
