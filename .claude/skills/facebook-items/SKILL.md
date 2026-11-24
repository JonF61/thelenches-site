---
name: facebook-items
description: Weekly Facebook group round-up for thelenches.org.uk. Use when Jon attaches screenshots of the Lenches Facebook group's recent posts (or says "Facebook items", "this week's Facebook posts") to turn them into hand-written event and notice files in sites/lenches/items/.
---

# Weekly Facebook items

Jon attaches screenshots of the last 7 days' posts from the Lenches Facebook group. Turn them into hand-written items, with his approval first.

## 1. List candidates on screen (no files yet)
- Read every screenshot. Pick out events (a date) and notices (news, appeals, closures, lost/found, roadworks).
- Before listing, check what is already on the site so nothing is doubled: `ls sites/lenches/items/events sites/lenches/items/notices`, `sites/lenches/items/regulars.json`, and grep titles/venues in `sites/lenches/items/` and `sites/harvington/items/`. Say "already listed" against any match, and note when the Facebook post adds details to an existing file (offer to update that file instead).
- Show a short numbered table: type, proposed title, date(s)/expiry, one-line body summary, and any question. Leave out: private sales and personal ads, anything political, other organisations' sponsorship lines, posts naming private people in a way they wouldn't expect published.
- A regular, ongoing class/club/group goes in `regulars.json`, not events: ask Jon whether it is a **new activity** (`newActivity: true`) or just **newly listed** (no flag); give it `added` (today). A one-off taster is an event.
- An item for one community only (one parish's council news, a lane only one village uses, members/residents only) gets `"sites": "lenches"` (or `harvington`); everything else is shared with Harvington automatically. Flag these in the table.
- Ask about anything unclear (year, time, venue). Then **wait for Jon to approve** (he may approve some, edit wording, or drop items).

## 2. Write one file per approved item
**Event**: `sites/lenches/items/events/YYYY-MM-DD-short-slug.json` (start date, then a slug of the title).
```json
{
  "date": "2026-12-19",
  "endDate": "2026-12-20",
  "title": "Christmas coffee morning — St Egwin's, Norton",
  "body": "Coffee, cake and a raffle, 10am to noon. All welcome.",
  "link": { "text": "Details on Facebook", "url": "https://..." }
}
```
- Title as "What — Where" (em dash with spaces). Write the time clearly in the body ("from 7.30pm", "10am to noon"): the calendar links and Google event data read it from there.
- `endDate` only for multi-day events. Optional: `link`, `link2` {text, url}, `image`, `sites`.

**Notice**: `sites/lenches/items/notices/short-slug.json`.
```json
{
  "title": "Hall car park resurfacing",
  "body": "The car park is closed for resurfacing until the end of November.",
  "added": "2026-11-24",
  "expires": "2026-12-01"
}
```
- `added` = today: **required** (the New badge, and hides it 28 days later; the test fails without it).
- `expires` = the first day it should be hidden (e.g. the day after a closure ends). Optional `order`, `pinned`, `link`, `link2`, `image`, `official`, `sites`. Roadworks: `roads: true` plus optional `start`, `end`, `road`, `village`.

## Wording rules
- British English, plain and factual, third person. No "sponsored by…" lines (sponsorship is ours alone). Never name Jon.
- Parish council / official statements: their own words; fix only obvious typos and broken links.
- Don't invent facts, prices, times or links not in the post. A Facebook post link is fine as the link if the post is public.

## Images
Only when Jon says so. News-column images display at 3:2 (lead 4:3, object-fit cover): crop to that ratio first (sharp). Put them in `sites/lenches/images/items/` with a **new file name** each time (never reuse a name). Image field: `{"url": "/images/items/<file>.jpg", "alt": "...", "credit": "..."}`. An image showing people needs Jon's OK.

## Editing and removing
- Editing an item's `title` or `date` makes it a new item (new anchor; may reappear in the newsletter); say so if Jon asks for it.
- Remove an item by deleting its one file. Never rewrite or resend other files.

## 3. Check, commit, merge
- `node scripts/test-notice-until.js` and an Eleventy build (`npx @11ty/eleventy --output=/tmp/...` or the usual build); both sites pick up Lenches items.
- Commit with a plain subject naming the items ("Add Facebook items: carols on the green, hall car park closure"); Holly reads commit subjects as evidence of site changes.
- Branch, PR, merge (per CLAUDE.md), then tell Jon in a line what went up. No siteupdates.json entry for routine items.
