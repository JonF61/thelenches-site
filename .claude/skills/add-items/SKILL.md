---
name: add-items
description: Add hand-written events and notices to thelenches.org.uk (shared with harvingtonvillage.org.uk) from any source: the weekly Facebook group screenshots, a news article link (Evesham Journal, BBC, council news), pasted text, a forwarded email, a poster or flyer photo, or Jon just telling you about something. Approval list first, one JSON file per item in sites/lenches/items/, then checks that pages already stating the same facts and this week's newsletter are brought up to date. Use whenever Jon attaches Facebook screenshots (even with no words, or "this week's"), pastes or links an article, says "news item", "put this on the website", "add this", "spotted this", "Facebook items" or "from the group", or sends anything that should become an event or notice on either site.
---

# Adding events and notices

Items reach the site three ways: emailed ones go through the pipeline (Holly writes them up, Jon approves in the panel); everything else is hand-written by Kryten as one small file per item, shown on both sites. This skill is the hand-written route, whatever the source:

- **Facebook screenshots** (weekly): the last 7 days' posts from the Lenches group; usually several candidates.
- **A link** (newspaper, council, club site): read it. Strip tracking junk (`?utm_…`, `fbclid`, `#Echobox…`) before fetching or linking. Some sites refuse automated reading (the Evesham Journal did, 22 Nov 2026): then **ask Jon to paste the text**. Do not rebuild the story from a web search: that time a search found only last year's similar offer, and the details would have been wrong. Prefer the official source (council, organiser) as the item's `link` over a newspaper page; use the newspaper only when there is no official page.
- **Pasted text, a forwarded email, a flyer photo, or Jon's own words**: use only the facts given.

## 1. List candidates on screen (no files yet)
- Read the source. Pick out events (a date) and notices (news, appeals, closures, offers, lost/found, roadworks).
- Before listing, check what is already on the site so nothing is doubled: `ls sites/lenches/items/events sites/lenches/items/notices`, `sites/lenches/items/regulars.json`, and grep titles/venues in `sites/lenches/items/` and `sites/harvington/items/`. Say "already listed" against any match, and note when the source adds details to an existing file (offer to update that file instead).
- Show a short numbered table: type, proposed title, date(s)/expiry, one-line body summary, and any question. Leave out: private sales and personal ads, anything political, other organisations' sponsorship lines, posts naming private people in a way they wouldn't expect published.
- A regular, ongoing class/club/group goes in `regulars.json`, not events: follow the `regular-activity` skill for it (it asks Jon "new activity or newly listed?"). A one-off taster is an event.
- An item for one community only (one parish's council news, a lane only one village uses, members/residents only) gets `"sites": "lenches"` (or `harvington`); everything else is shared with Harvington automatically. Flag these in the table.
- **Pages that already state the facts**: grep `sites/*/_data/` and `sites/*/*.njk` for the subject (e.g. a fare, opening hours, a bus service, a phone number, a closure). If a page says something the new item changes, propose that edit in the same list, on both sites. On 25 Nov the £1 on-demand bus fare notice also needed both Transport pages' "£2.50 a journey" updated; a notice that contradicts our own page looks careless.
- Ask about anything unclear (year, time, venue). For one item, show the full proposed wording (title, body, link) rather than a table. Then **wait for Jon to approve** (he may approve some, edit wording, or drop items).

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
- `added` = today: required, because it drives the New badge and hides the notice 28 days later (so stale news never lingers); the test fails without it.
- `expires` = the first day it should be hidden (e.g. the day after a closure ends). Optional `order`, `pinned`, `link`, `link2`, `image`, `official`, `sites`. Roadworks: `roads: true` plus optional `start`, `end`, `road`, `village`.

## Wording rules
- British English, plain and factual, third person. No "sponsored by…" lines (sponsorship is ours alone). Never name Jon.
- Parish council / official statements: their own words; fix only obvious typos and broken links.
- Don't invent facts, prices, times or links not in the post. A Facebook post link is fine as the link if the post is public.

## Images
Only when Jon says so. News-column images display at 3:2 (lead 4:3, object-fit cover): crop to that ratio first (sharp). Put them in `sites/lenches/images/items/` with a **new file name** each time: frozen newsletters and browser caches keep pointing at the old name, so a reused name shows the wrong picture. Image field: `{"url": "/images/items/<file>.jpg", "alt": "...", "credit": "..."}`. An image showing people needs Jon's OK.

## Editing and removing
- Editing an item's `title` or `date` makes it a new item (new anchor; may reappear in the newsletter); say so if Jon asks for it.
- Remove an item by deleting its one file. Never rewrite or resend other files.

## 3. Check, commit, merge
- `node scripts/test-notice-until.js` and an Eleventy build (`npx @11ty/eleventy --output=/tmp/...` or the usual build); both sites pick up Lenches items.
- Commit with a plain subject naming the items ("Add Facebook items: carols on the green, hall car park closure", "£1 on-demand bus fares notice; Transport fare updated"); Holly reads commit subjects as evidence of site changes.
- Branch, PR, merge (the `finish-job` skill). No siteupdates.json entry for routine items, and no preview screenshots for routine items (the `preview` skill is for layout changes).

## 4. This week's newsletter
New items reach Thursday's issue by themselves **unless that site's issue is already built** (frozen: Rebuild or the Thursday 06:30 build). Check both sites after merging:
```bash
python3 .claude/skills/sheet-access/k.py read "Newsletter draft" --where key=status
python3 .claude/skills/sheet-access/k.py read "Newsletter draft" --where key=status --site harvington
```
`built` or `tested` means frozen: tell Jon to open the panel's **Newsletter draft** for that site, tap **Rebuild**, check the item is there, then **Test send** (Send to all needs a fresh Test send after a Rebuild). A blank status means the issue isn't built yet and will include the item. Without `KRYTEN_TOKEN`, use the Read Sheet tab workflow on "Newsletter draft". Then tell Jon in a line what went up and whether he needs to Rebuild.
