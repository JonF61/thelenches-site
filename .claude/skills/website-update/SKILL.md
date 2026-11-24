---
name: website-update
description: Write a WEBSITE UPDATE entry for the newsletter in sites/<site>/_data/siteupdates.json (the Lenches or Harvington), checking what else is due for that issue and showing Jon the whole band. Use after any significant visible change to either site (a new page, feature or form), when a devtasks to-do asks for website updates for an issue, or when Jon wants to tell readers about something new on the website, even if he doesn't say "website update".
---

# Website update entries

Each site's `sites/<site>/_data/siteupdates.json` feeds the **WEBSITE UPDATE** band under the newsletter header (select.js `siteUpdatesFor`, render.js). Each due entry is its own short paragraph, ordered by `from` and then `key`. One site link follows the last one. An entry appears in **one** issue that is sent live and then retires itself (its key `s:<key>` is in that issue's Issues `item_keys`).

Jon decides every entry. Propose, show the wording, and only commit after he approves. Routine new events or notices never get one.

## 1. Work out the issue
- Find the issue date (a Thursday). The cutoff is 6pm the Wednesday before, but an entry can still go in until the issue is built (06:30 Thursday). After a Rebuild it is in.
- Read the entries already due for that issue on that site: `from` ≤ issue date, `until` blank or ≥ issue date, and **not already in a sent issue** (old entries without `until` stay in the file after they've gone out). This lists them, reading sent keys from the Issues tab (`item_keys`, column M) with /k. Set `S` and `I`, and add `,"site":"harvington"` to the /k call for Harvington:
  ```
  S=lenches I=2026-11-26; curl -sS https://approvals.lenches.workers.dev/k -H "authorization: Bearer $KRYTEN_TOKEN" -H 'content-type: application/json' -d '{"op":"read","tab":"Issues","range":"A1:M500","max_rows":500}' | S=$S I=$I python3 -c "
  import json,sys,csv,io,os
  r=list(csv.reader(io.StringIO(json.load(sys.stdin)['csv'])))[1:]; h=r[0]; ix=h.index
  sent={k for x in r[1:] if x[ix('status')]=='sent' and x[ix('issue_date')][:10]<os.environ['I'] for k in x[ix('item_keys')].split()}
  for e in json.load(open('sites/%s/_data/siteupdates.json'%os.environ['S']))['entries']:
    if e['from']<=os.environ['I'] and (not e.get('until') or e['until']>=os.environ['I']) and 's:'+e['key'] not in sent: print(e['key'],'|',e['text'])"
  ```
  Without `KRYTEN_TOKEN`, look at the panel's Newsletter draft instead (ask Jon), or read the Issues tab with the Read Sheet tab workflow.
- Harvington has no siteupdates.json yet. Create one with the same shape: copy the Lenches file's `_help` (changing the site name in it) and `"entries": []`. No newsletter code change is needed (a missing file just means no band). lib/parity.js already lists `siteupdates` as Lenches-only data: if you add Harvington's, remove it from that list so the parity check passes, and run `node lib/parity.js`.

## 2. Write the entry
```json
{
  "key": "harvington-launch-2026-11",
  "from": "2026-11-26",
  "until": "2026-12-02",
  "text": "Our neighbours in Harvington now have their own village website, harvingtonvillage.org.uk, with events shared between the two sites.",
  "link": "https://harvingtonvillage.org.uk/"
}
```
- `key`: unique, letters, numbers and hyphens, ending with the year and month. **Never reuse a key**, even one that has expired (grep the file first): a key that was in a sent issue counts as done for good, so a reused key would silently never appear.
- `from`: the first issue it can appear in. `until`: the last date it can appear (usually the following Wednesday), so it doesn't sneak into a later issue if that one is skipped.
- `link`: required (an entry without a valid one is dropped), but kept for the record only and not shown.
- `text`: one or two plain sentences, British English. No "New on the website:" and no "Have a look" (the link line is added after the last entry). Don't name Jon. Each site's wording uses its own name (thelenches.org.uk / harvingtonvillage.org.uk).

## 3. Show Jon the whole block
Show the WEBSITE UPDATE band as readers will see it: **every** entry due for that issue in order, then "Have a look at <site>". Check that no entry repeats another (Jon's rule). If two overlap, propose merging or moving one to a later `from`. Wait for his OK or edits.

## 4. Finish
- Add the entry at the end of `entries`, keeping the 2-space layout. Validate the JSON (`node -e "require('./sites/<site>/_data/siteupdates.json')"`).
- Run `node scripts/test-newsletter-sites.js`. If the issue is already built, tell Jon to tap **Rebuild** then **Test send** on the Newsletter draft screen. Otherwise the panel's Refresh shows it in the draft.
- Commit ("Website update for the 26 Nov issue: Harvington launch"), then PR and merge (`finish-job` skill).
