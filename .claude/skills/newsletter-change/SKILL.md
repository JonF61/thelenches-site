---
name: newsletter-change
description: Checklist for changing how the weekly newsletter is chosen, laid out or sent (scripts/newsletter/: select.js, render.js, draft.js, index.js, send.js, shared.js, track.js) for either site: new or changed sections, wording, subject line, layout, images, links, limits or send steps. Use whenever a job touches scripts/newsletter/ or lib/anchors.js / lib/ics.js, or Jon asks to change what the newsletter shows or how it looks ("in the newsletter", "the Thursday email", "the issue"), even for a one-word change.
---

# Changing the newsletter

About 425 people (plus Harvington's list) get it every Thursday, by Gmail from website@, opened in everything from Outlook to phone apps. An issue is **frozen** when it is built (06:30 Thursday, or on Rebuild) and covered by a content hash, and nothing is sent without Jon's tap (except in holiday mode). Those two facts drive most of this checklist. The CLAUDE.md newsletter bullets (Newsletter draft, counts, subject line, cartoon, Where in…, regulars band, website updates) describe each section.

## 1. Know the pipeline
- `select.js` chooses the issue's content into a **model** (the snapshot): items, keys, subject teaser, bands. `render.js` turns a model into the email (HTML and text). `index.js` builds, tests and sends. `draft.js` makes the panel's Newsletter draft. `shared.js` merges the other site's items. `send.js` enforces the hash, mode, count and the daily limit across sites.
- `render(model)` is also used to re-render **saved snapshots**, and Test send and Send refuse if the snapshot no longer renders to the built copy's hash ("the newsletter code changed: Rebuild first").
- So **render changes must handle older snapshots** that lack your new field: leave the output byte-for-byte the same when the field is absent (see the existing "Snapshots before 11 Nov…" comments in select.js and render.js). Otherwise every frozen issue breaks.

## 2. Timing
Don't merge a render or select change between Thursday's 06:30 build and Jon's Send unless he asks. A change merged then makes the built issue unsendable until he taps **Rebuild** then **Test send** again. If it must go in then, tell him exactly that. Changes on Wednesday are fine before 06:30 Thursday: the draft refreshes after the site build and every 3 hours, or from the panel's Refresh.

## 3. Rules for the email itself
- **Outlook-safe**: a 600px table layout, inline CSS (the one `<style>` block is a phone-width media query that only adjusts `.wrap`/`.px`; everything must still look right without it; no flex or grid), JPEG images (never WebP or SVG), absolute https links, alt text on every image. Outlook ignores much modern CSS, and a broken layout reaches everyone at once.
- **Both sites**: names, addresses, colours, tagline and area wording come from site.json via render.js `CFG` (`newsletterName`, `newsletterTagline`, `areaName`, `email`, `url`, `palette.vars`). Never type "Lenches" into shared output; the "Lenches" badge is the Lenches' issue only. Optional data files a site lacks (cartoons, Where in…?, On this day, bins, siteupdates) must read as null and leave their section out.
- **Subject** stays "The <Site> Newsletter – <d Mon>: …" (the panel's Messages filter matches the start).
- **Wording** that readers see needs Jon's approval before committing. Show it in a rendered preview.
- **Counts**: tracked links and the open pixel are added only on a live send, after all checks (track.js), so tested content and the hash stay untouched. Never add tracking anywhere else.
- **Privacy**: never put an address, name or Sheet data in logs. Send logs print counts.

## 4. Test and preview
- The newsletter tests: `node scripts/test-newsletter-sites.js`, `test-newsletter-draft.js`, `test-newsletter-shared.js`, `test-subject.js`, plus the section's own (`test-cartoon.js` with `SITE=lenches` and `SITE=harvington`, `test-where.js`, `test-regulars.js`, `test-notice-until.js`). Add a case for the new behaviour, including "older snapshot without the field renders as before".
- **Preview for Jon**: render a realistic model (copy a test's model, or build one from select.js with sample items) for **both sites**, write the HTML to the scratchpad, and screenshot it with Playwright at 600px and phone width. Show the before and after of the changed part. For anything structural, also check it at a narrow width with styles stripped, a rough proxy for Outlook.
- Visible change: once merged, have Jon tap **Refresh** on the Newsletter draft and look, then **Test send** before Thursday. Rimmer's Wednesday 19:00 check also reads the next issue.

## 5. Ship
- PR and merge (`finish-job` skill). The PR's "Next run" says what to look for in Thursday's issue on each site.
- A change readers will notice may deserve a WEBSITE UPDATE line (the `website-update` skill; Jon decides).
- Update that section's bullet in `docs/kryten/features.md` (CLAUDE.md only for working rules), keeping it dense and dated.
