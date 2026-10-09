# CLAUDE.md — standing instructions for Claude Code

Read this first in every session. The full Project Plan is a Claude Doc you can't open; this file carries what you need. Jon (the owner) also works with Claude in a claude.ai Project chat that reads your pull requests, so **the PR description is how your work reaches that chat**.

## The project
- thelenches.org.uk: community website + weekly newsletter for the Lenches villages (Worcestershire). Eleventy v3 + Nunjucks, GitHub Pages, commits to main rebuild automatically. `pathPrefix` must stay "/".
- Pipeline: GitHub Actions + a Google Sheet ("Lenches Pipeline") as data hub + a Cloudflare Worker (`worker/`, deployed by deploy-worker.yml on push) for signed approval/send links and crons. Claude API for extraction. Newsletter sends via Gmail API from website@.
- Key code: `scripts/ingest` (Gmail + RSS ingestion, extract.js, replies.js = "Holly" submitter replies, rules.md), `scripts/newsletter` (select, render, index, send), `scripts/digest`, `scripts/approve`, `scripts/publish`, `lib/` (lenches.js, anchors.js), `src/_data/` (whatson.json, siteupdates.json, services.json, bins.json, site.json), `.eleventy.js`, `src/_includes/base.njk`.

## Working with Jon
- British English. Succinct. He is a GitHub novice: give exact click-by-click steps (direct links, which button, what he should see).
- One step at a time: when you need him to do or check something, ask only that, then wait.
- If this session is on Jon's PC without Git/Node, move to a cloud session straight away rather than asking to install anything.
- Ask before finalising anything that is a judgement call about content or wording; show public-facing wording for approval before committing it.

## Hard rules
- Never edit `.github/workflows/` (Jon pastes workflow files himself) or `package.json` (the lockfile must be regenerated on a runner; `npm ci` everywhere).
- Work on a branch and open one pull request; Jon merges.
- Before pushing: `npm ci`, Eleventy build, and offline tests/sample renders of anything you changed (mock the Claude API and Google calls). Show Jon previews of visual or email changes.
- Anonymity: nothing public or sent to anyone but Jon may name him or expose jon@. System mail uses from_name "The Lenches Website and Newsletter Team"; Holly signs as "Lenches website assistant".
- Statements from parish councils, councillors and other official bodies are published in their own words: only obvious typos and broken links fixed.
- Newsletter: content is frozen in the build snapshot and covered by a content hash; sends never happen without Jon's tap except holiday mode; extra sends are always manual. Email must be Outlook-safe: 600px table layout, inline CSS, JPEG not WebP.
- Sheet: code reads columns by header name. Never rename or move headers or tabs; add new columns at the END only. The grid ends at the last column and tidyTabs hides technical columns, so tell Jon to unhide and insert columns before typing headers, with exact cells and header text.
- Cloudflare cron day-of-week is 1=Sunday..7=Saturday: always write day names (WED,THU).
- Commits made with GITHUB_TOKEN don't trigger other workflows.
- When you make a significant visible site change, propose an entry for `src/_data/siteupdates.json` (Jon decides; never reuse a key).

## Finishing a job: the PR description
Write it for the project chat, which will read it from GitHub: what changed (files and behaviour), anything Jon must do by hand (Sheet headers, settings, workflow pastes), how it was tested, and what to check on the next live/shadow run. Keep it factual and complete; Jon shouldn't need to paste anything back.
