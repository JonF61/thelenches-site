---
name: preview
description: Show Jon screenshots of a visible change to either website (thelenches.org.uk, harvingtonvillage.org.uk) or either newsletter before it is merged, built from this working copy in about a minute with the bundled shot.js, so he never waits for a merge, rebuild or Test send to judge a look. Use for any change readers will see beyond the trivial (a typo, a date, one routine content item): CSS, layouts, page includes, a new page or section, a newsletter band, render.js/select.js output, card or image changes, wording blocks, and whenever Jon asks "what will it look like", "show me", "mock it up", "preview" or "before and after", even if he doesn't say screenshot.
---

# Preview before merge

Jon decided (25 Nov 2026) that he sees every non-trivial visible change before it is merged, so he judges the look in a minute rather than after a merge, a two-minute Pages deploy and a newsletter Rebuild/Test send. He is not a developer: pictures, not diffs.

## When
- Do it: anything that changes how a page or the newsletter looks or reads (layout, CSS, includes, a new page or band, a section's wording, images, link placement).
- Skip it: a typo, a date, a single routine event or notice file, data-only changes Jon has already approved word for word. If unsure, preview; it is cheap.
- Both sites share layouts, CSS, page includes and the newsletter code, so a shared change is previewed on **both** sites (the `both-sites` skill says which files are shared).

## How (bundled script)
Run from the repo root; put output in the session scratchpad.

```bash
# Site pages: builds the site, serves it locally, shoots desktop 1280 and phone 390
node .claude/skills/preview/shot.js site --site lenches --pages /notices/,/living-here/planning/ \
     --out <scratchpad>/preview --label after --selector '.planning-week'

# Newsletter: renders the next issue live from this working copy, shoots 600 (email) and 390
node .claude/skills/preview/shot.js newsletter --site harvington --out <scratchpad>/preview --label after --sheet
```
- `--selector` shoots only the changed part. Use it: whole pages run to thousands of pixels and the change gets lost.
- `--label before` / `after`: for a change to something that exists, shoot `before` first (on a fresh `origin/main` checkout, or `git stash` your edits), then `after`, and show them side by side. The before picture is what makes the difference obvious.
- `--no-build --build-dir <dir>` reuses a build you already made (saves ~20s per page set).
- Newsletter `--sheet` adds this site's live Pending items through k.py (needs `KRYTEN_TOKEN`); without it the issue has only hand-written items and data files, which is fine for judging layout. It always renders live, never the frozen snapshot, because you are previewing code or data that isn't built yet. Images point at the live site, so a brand-new picture shows only after merge; say so if it matters.
- `--today YYYY-MM-DD` picks the issue (the next Thursday on or after it).
- Pictures are at scale 1, for checking; `--scale 2` for ones Jon keeps.

## Showing Jon
1. Read the pictures yourself first (Read tool). Check the change is there, nothing nearby broke, and the phone width doesn't overflow. Fix before showing; Jon's time is the scarce thing.
2. Show the few that matter: the changed part, before and after, desktop and phone. Send them with SendUserFile (`display: render`), or publish one small page that holds them if there are many.
3. One line on what changed and what to look at, then ask: "Merge it?" Merge only on his yes; if he asks for changes, re-shoot `after`.
4. For the newsletter, also remind him that a change merged after an issue is built needs **Rebuild** then **Test send** (the `newsletter-change` skill's timing rule).
