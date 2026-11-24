---
name: both-sites
description: Checklist for any change that could affect both websites (thelenches.org.uk and harvingtonvillage.org.uk) from the one repo: shared layouts, CSS, shared page includes, lib/, scripts/, .eleventy.js, a site's _data or pages, moving files, or content shared between the sites. Use whenever a job edits src/, lib/, .eleventy.js or sites/<site>/, adds a page or data file to one site, says "Harvington too", "both sites" or "the other site", or moves or reorganises files, even when Jon only names one site.
---

# Changes that touch both sites

One repo builds two sites. Shared code means a change made for one can quietly change or break the other, and data meant to match (bins, term dates, cartoons) can drift apart. The CLAUDE.md "Two sites" section is the detailed map; this is the working routine.

## 1. Work out what the change reaches
- **Shared by both**: `src/_includes/` (base.njk and the layouts), `src/style.css`, `src/_data/*.js`, `src/_includes/pages/*.njk` (events, notices, regulars, roads, search, bins, churches, council, schools, eat, trades, health, getting-around, what-to-do), `lib/`, `scripts/`, `worker/`, `.eleventy.js`, workflows.
- **One site's own**: `sites/<site>/` pages (`*.njk`), `_data/*.json`, `items/`, `images/`. The site comes from `SITE` (default `lenches`). Code finds files through `lib/site.js` (`siteDir()`, `siteRel()`, `siteData()`), never a hard-coded `src/` or `sites/lenches/` path.
- **Shared content**: the Lenches' hand-written items (`sites/lenches/items/`) also show on Harvington, unless an item has `"sites"`. Pipeline items go on both unless they are one of the three one-site exceptions (one parish's official news, a lane only one community uses, things only one community or club's members can use). Church services: one `sites/lenches/_data/services.json` for both.
- **Shared page with different words**: change the markup in `src/_includes/pages/<page>.njk` and each site's wording in its own `sites/<site>/<page>.njk` `{% set … %}` blocks. A wording block one site sets and the other doesn't must be on lib/parity.js `KNOWN`, with the reason.

## 2. Keep the Lenches unchanged unless meant
Most stages promised "the Lenches builds byte-for-byte as before". When a change shouldn't alter the Lenches (refactors, moves, Harvington-only features):
```
npx @11ty/eleventy --output=<scratch>/before        # on origin/main, before the change
# … make the change …
npx @11ty/eleventy && scripts/compare-build.sh <scratch>/before _site
```
`compare-build.sh` ignores only timestamps and the `data-src` template path, so any other difference is real: explain it or fix it. Do the same for Harvington with `SITE=harvington` and `--output=` when its pages shouldn't move either.

## 3. Build and check both
- `npx @11ty/eleventy` and `SITE=harvington npx @11ty/eleventy --output=<scratch>/harvington`. Look at the changed pages in each, and screenshot visible changes on both for Jon (phone and desktop).
- `node lib/parity.js` lists everything not in step (bins dates, term dates, cartoons, `_data` files, pages, wording blocks). A meant difference goes on `KNOWN` in lib/parity.js with its reason. Otherwise make the other site match: extend both bins.json files together, both schools.json term dates, both cartoons.json.
- Tests: `node scripts/test-site.js`, `node scripts/test-site-parity.js`, `node scripts/test-twosites.js`, `node scripts/test-shared-items.js` and `node scripts/test-shared-keys.js` (shared items), plus `scripts/test-sitefacts-sites.js` if Holly's site facts or pages changed.

## 4. Things that catch people out
- **What rebuilds Harvington**: `build-harvington.yml` runs on pushes to `sites/harvington/**`, `sites/lenches/items/**`, `sites/lenches/images/items/**`, `src/**`, `lib/**`, `.eleventy.js` and `package-lock.json`, and nightly at 00:07 UTC. Anything else it reads from the Lenches (e.g. `sites/lenches/_data/services.json`) reaches Harvington only at the nightly build, unless you dispatch build-harvington.yml (no inputs) after merging.
- **New `_data` file or page for one site**: parity flags it until it's on `KNOWN` or added to the other site. Ask Jon whether the other site should have it.
- **Wording is per site**: site name, address and newsletter name come from site.json (`brand`, `titleName`, `email`, `url`, `newsletterName`, `hollySignoff`…). Never type "the Lenches" into shared code or a shared page; read it from `site`. New public wording for either site needs Jon's approval.
- **Palette**: Harvington's colours come from site.json `palette.vars` over style.css's `:root`. Use the CSS variables in shared CSS rather than fixed colours, so both sites stay right.
- **Workflows and the Worker**: a workflow touching a Sheet sets `SITE` from the dispatch payload or input (default `lenches`), and the Worker reads the site from the request (`siteFromRequest`, `x-site`). For panel work, use the `panel-change` skill.
- **Photos**: Harvington's photos.json is hand-made. Never run photos.yml with site harvington.

## 5. Ship
PR and merge (`finish-job` skill), then check that both "Build and deploy to GitHub Pages" and "Build Harvington site" runs succeeded. Mention in the PR which site(s) changed visibly and how the "unchanged" one was proved unchanged.
