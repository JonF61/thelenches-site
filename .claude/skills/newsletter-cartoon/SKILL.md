---
name: newsletter-cartoon
description: Weekly newsletter cartoon for both sites (the Lenches and Harvington). Use when Jon asks for cartoon or gag ideas, an image prompt for this week's cartoon, attaches a cartoon picture to add, or when the Wednesday cartoon check runs.
---

# Newsletter cartoon

One single-panel pocket cartoon per Thursday issue, signed "Dave", in **both** sites' newsletters. Jon draws it with ChatGPT or Gemini from Kryten's prompt; Kryten proposes the gag, writes the prompt and adds the finished picture.

## 1. Check what's needed
- The next issue date is the coming Thursday (YYYY-MM-DD). Look in `sites/lenches/_data/cartoons.json` and `sites/harvington/_data/cartoons.json` `entries` for that key. If both have it and the JPEG is in each `sites/<site>/images/cartoons/`, nothing to do.

## 2. Propose 2–3 gags (on screen)
- Draw on this week's items: `ls -t sites/lenches/items/events sites/lenches/items/notices | head`, recent files in `sites/harvington/items/`, and the issue's Coming up (the panel's Newsletter draft, or `/k` read of the "Newsletter draft" tab if needed). Roadworks, weather, fayres, bins, parish matters and village life suit well.
- Read the last few captions in cartoons.json so the joke, setting and characters vary (the regulars so far: an older woman in headscarf and wellies, a man in flat cap, sometimes a spaniel; "Gerald" has been used).
- For each: a one-line scene and a draft caption. Gentle, dry, understated British village humour. **Never**: named private people, sponsors, party politics, mocking a real organisation's volunteers or a misfortune (illness, accidents, bereavement). Parish councils and utilities may be teased gently.
- Ask Jon to pick one (he may rewrite the caption). Wait.

## 3. Write the image prompt
- Use the template in `scripts/cartoon/prompt.md`: fill in **Scene**, the joke paragraph, the people paragraph and the `{setting}` / `{main feature}` / `{supporting details}` slots; keep the opening line, **Art style**, **Overall mood** and **Strict requirements** paragraphs word for word.
- Never name or imitate a real cartoonist. The caption is **never** in the picture. The only words allowed are a sign's exact text ("CLEARLY READING" in the scene); with no sign, the last line ends "no lettering or other words anywhere in the image."
- Show the prompt in a code block, ready to paste. Jon makes the picture and attaches it to the session.

## 4. Add the picture (both sites)
- File name: `<issue date>-<short-slug>-signed.jpg` (a new name every time; never reuse one).
- Sign and resize (920px, Outlook-safe JPEG, "Dave" bottom right):
  `node scripts/cartoon/sign.js <attached picture> sites/lenches/images/cartoons/<name>.jpg`
  then copy the same file to `sites/harvington/images/cartoons/<name>.jpg`.
- Look at the signed JPEG (Read it) to check the signature doesn't sit on anything important and no stray lettering crept in; if the picture has unwanted words, ask Jon to regenerate.
- Add the same entry to **both** `sites/lenches/_data/cartoons.json` and `sites/harvington/_data/cartoons.json`, keyed by the issue date:
```json
"2026-11-26": {
  "image": "/images/cartoons/2026-11-26-short-slug-signed.jpg",
  "alt": "Cartoon: <plain description of what is drawn, including any sign text>.",
  "caption": "“The approved caption, with curly quotes.”"
}
```
- Caption: exactly as Jon approved, curly quotes and apostrophes (’). Alt: describes the picture, not the joke.

## 5. Check, commit, merge
- `SITE=lenches node scripts/test-cartoon.js` and `SITE=harvington node scripts/test-cartoon.js`; `node lib/parity.js` should show no cartoon difference.
- Commit subject like "Add 26 Nov newsletter cartoon: <short gag>"; branch, PR, merge (per CLAUDE.md). If that issue is already built (status built/tested), tell Jon to tap **Rebuild** then **Test send** on the Newsletter draft screen so the cartoon is in it.
