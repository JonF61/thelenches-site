# CLAUDE.md — standing instructions for Claude Code

Read this first in every session. The full Project Plan is a Claude Doc you can't open; this file carries what you need. Jon (the owner) also works with Claude in a claude.ai Project chat that reads your pull requests, so **the PR description is how your work reaches that chat**.

## The project
- thelenches.org.uk: community website + weekly newsletter for the Lenches villages (Worcestershire). Eleventy v3 + Nunjucks, GitHub Pages, commits to main rebuild automatically. `pathPrefix` must stay "/".
- Pipeline: GitHub Actions + a Google Sheet ("Lenches Pipeline") as data hub + a Cloudflare Worker (`worker/`, deployed by deploy-worker.yml on push) for signed approval/send links and crons. Claude API for extraction. Newsletter sends via Gmail API from website@.
- Key code: `scripts/ingest` (Gmail + RSS ingestion, extract.js, replies.js = "Holly" submitter replies, rules.md), `scripts/newsletter` (select, render, index, send), `scripts/digest`, `scripts/approve`, `scripts/publish`, `lib/` (lenches.js, anchors.js, whatson.js), `src/items/` (hand-written events and notices, one file each; assembled by `lib/whatson.js` into `src/_data/whatson.js`), `src/_data/` (siteupdates.json, services.json, bins.json, site.json), `.eleventy.js`, `src/_includes/base.njk`.

## Working with Jon
- Names (after Red Dwarf): you, Claude Code, are **Kryten**; the claude.ai Project chat is **Holly** (replies.js is also nicknamed Holly; its emails sign as "Lenches website assistant"). "Report back to Holly" means the PR description.
- British English. Succinct. He is a GitHub novice: give exact click-by-click steps (direct links, which button, what he should see).
- One step at a time: when you need him to do or check something, ask only that, then wait.
- If this session is on Jon's PC without Git/Node, move to a cloud session straight away rather than asking to install anything.
- Ask before finalising anything that is a judgement call about content or wording; show public-facing wording for approval before committing it.

## Hand-written items (`src/items/`)
One small JSON file per item, so adding or removing one never resends a big file. `lib/whatson.js` assembles them at build (site, newsletter, publish, eventimages) and leaves out expired items; the nightly rebuild keeps this current.
- **Event**: `src/items/events/YYYY-MM-DD-slug.json` (the event's start date, then a short slug of the title). Fields: `date`, `title`, `body`, optional `endDate` (YYYY-MM-DD, multi-day events), `link` {text, url}, `image` {url, alt, optional credit and creditUrl: a caption under the image on the site and in the newsletter}, `saveTheDate`, `lenches`, `tile`. Shown until `endDate`, or else `date`, has passed (UK time). Events sort by date, then title.
- **Notice**: `src/items/notices/slug.json`. Fields: `title`, `body`, optional `expires` (YYYY-MM-DD: hidden from that date on; none = shown until the file is deleted), `order` (lower first; none = after numbered ones, by file name), `link`, `image`, `official`, `roads`.
- **Road items** (notices with `roads: true`, shown on /living-here/roads/ and its map) may also carry, all optional: `start` (YYYY-MM-DD, first day of the works; else `date`), `end` (YYYY-MM-DD, last day of the works), `road` (the road's name as on a map, e.g. "Ab Lench Road"; else guessed from the title) and `village`. With no `end` the map shows the works until `expires` (else every day) and says "end date not given". The map's line comes from `src/_data/roadgeo.json` (keyed `road|village` in lower case; filled by the publish run via Nominatim, never at build; a road not in it is pinned at its village). Fix a wrong or missing line by editing its entry (set `"source": "manual"`); delete an entry to have it looked up again.
- **Bin line and Events footnote**: `src/items/bin-and-footnote.json` ({bin, eventsFootnote}).
- **Edit**: change the one file. Editing an item's `title` or `date` makes it a new item (new page anchor; the newsletter may show it again).
- **Remove**: delete the file. Expired files stay harmlessly in place and are never auto-deleted; tidy them up now and then.
- Note: pipeline notices' `expires` (pipeline.json) is the last day shown; hand-written `expires` is the first day hidden.

Minimal event (`src/items/events/2026-11-14-craft-fair-church-lench.json`):
```json
{
  "date": "2026-11-14",
  "endDate": "2026-11-15",
  "title": "Craft fair — Church Lench Village Hall",
  "body": "Local makers' stalls, 10am to 4pm both days."
}
```
Minimal notice (`src/items/notices/hall-car-park-resurfacing.json`):
```json
{
  "title": "Hall car park resurfacing",
  "body": "The car park is closed for resurfacing until the end of November.",
  "expires": "2026-12-01",
  "order": 15
}
```

## Hard rules
- Never edit `.github/workflows/` (Jon pastes workflow files himself) or `package.json` (the lockfile must be regenerated on a runner; `npm ci` everywhere).
- Work on a branch and open one pull request. Kryten merges it (GitHub MCP merge tool) only after asking Jon and getting a yes for that PR each time; approval for one PR never covers another. Jon may also merge himself.
- Before pushing: `npm ci`, Eleventy build, and offline tests/sample renders of anything you changed (mock the Claude API and Google calls). Show Jon previews of visual or email changes.
- Anonymity: nothing public or sent to anyone but Jon may name him or expose jon@. System mail uses from_name "The Lenches Website and Newsletter Team"; Holly signs as "Lenches website assistant".
- Statements from parish councils, councillors and other official bodies are published in their own words: only obvious typos and broken links fixed.
- Newsletter: content is frozen in the build snapshot and covered by a content hash; sends never happen without Jon's tap except holiday mode; extra sends are always manual. Email must be Outlook-safe: 600px table layout, inline CSS, JPEG not WebP.
- Sheet: code reads columns by header name. Never rename or move headers or tabs; add new columns at the END only. The grid ends at the last column and tidyTabs hides technical columns, so tell Jon to unhide and insert columns before typing headers, with exact cells and header text.
- Cloudflare cron day-of-week is 1=Sunday..7=Saturday: always write day names (WED,THU).
- Commits made with GITHUB_TOKEN don't trigger other workflows.
- GitHub Actions concurrency groups keep only one waiting run: a newer queued run cancels the waiting one, even with `cancel-in-progress: false`. Where every dispatch must run (e.g. approval.yml), key the group per item (`approval-${{ github.event.client_payload.id }}`); when proposing workflow text for Jon to paste, never use a shared group for such workflows (22 Oct: rapid Approve/Reject taps were silently dropped).
- When you make a significant visible site change, propose an entry for `src/_data/siteupdates.json` (Jon decides; never reuse a key).

## Finishing a job: the PR description
Write it for the project chat, which will read it from GitHub: what changed (files and behaviour), anything Jon must do by hand (Sheet headers, settings, workflow pastes), how it was tested, and what to check on the next live/shadow run. Keep it factual and complete; Jon shouldn't need to paste anything back.
