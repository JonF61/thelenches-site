# Extraction rules — The Lenches

Edit this file freely; it is read on every run. No code changes needed.

## Scope
- Core area: Church Lench, Rous Lench, Ab Lench, Atch Lench, Sheriffs Lench and Harvington.
- Also include events of clear interest within roughly 10 miles (e.g. Evesham, Pershore,
  Bishampton, Bretforton, Broadway, Inkberrow, Abbots Morton).
- Skip anything outside that, and anything that is not an item for residents: receipts,
  auto-replies, delivery failures, marketing emails, mailing-list admin. Return no items and
  give a skip_reason.

## Category (use exactly one)
- event — has a date and something to attend.
- news — community news without an attendable date.
- notice — practical information: road closures and works, utilities, bins, council
  notices, deadlines, safety.

## Village
One of: Church Lench, Rous Lench, Ab Lench, Atch Lench, Sheriffs Lench, Harvington,
Lenches (for items covering several or all of the villages), or the town/village name for
nearby places (e.g. Evesham).

## House style
- British English. Plain, warm, factual; no hype, no exclamation marks.
- Title: "What — Where", e.g. "Harvest Lunch — Church Lench Village Hall",
  "Cash Bingo — The Lenches Club". Keep under about 60 characters.
- Summary: one or two sentences, roughly 25–50 words, written fresh (do not copy the email).
  Include the time, place, price and how to book where known.
- Times as "7.30pm", "from 8pm", "12.15 for 12.30". Dates as "Friday 16 October".
  Prices as "£10", "free".
- cost: short, e.g. "£15 per person", "Free", or empty if not stated.
- contact: as given by the sender (name plus phone or email). Don't invent any.

## Dates
- event_date is YYYY-MM-DD, the first day for multi-day events. Mention the date range in the summary.
- Resolve relative dates ("this Saturday") against the Received date. If no year is given,
  assume the next occurrence on or after the Received date.
- News and notices usually have no event_date, but road works may use their start date.

## Flags
- urgent: TRUE only for cancellations or postponements of a local event within the next 7 days,
  emergency or unplanned road closures on Lenches roads, loss of water or power, or safety
  warnings. Planned works announced well ahead are not urgent.
- political_commercial: TRUE for party-political or campaigning material, candidate or
  election promotion, or advertising whose main purpose is selling a product or service.
  Community events at commercial venues (clubs, pubs, golf club) are fine and not flagged.
  Always extract flagged items; the editor decides.
- people_in_image: TRUE if the image shows any identifiable person or any child.
  Illustrations and clip-art figures on posters don't count. If unsure, TRUE.
- confidence: 0.9+ when what, where, when and contact are all clear; 0.6–0.8 when one detail
  is missing or inferred; below 0.6 when the item is unclear or you have guessed.
  List what is missing in notes.

## Images
- Assign an image to an item only if it plainly belongs to it (its poster or photo).
- Posters: extract all details from the poster itself, as well as the email text.
- alt_text: describe the image briefly, e.g. "Poster for the Harvest Lunch showing a basket
  of apples". Don't start with "Image of".
- Ignore logos, signatures, social-media icons and tracking pixels.

## Source-specific
- one.network (roadworks): one item per alert, category notice. Include road name,
  village, dates, reason and diversion. Include only works in the core area or on the main
  routes into it.
- Wychavon newsletter: extract only items of practical use to Lenches residents (bin changes,
  consultations, grants, council tax, local events, fly-tipping etc.). Skip generic promotion.
  Category news or notice.
- ARCH Messenger (PDF): extract special services and events at Harvington, Rous Lench,
  Church Lench and Abbots Morton churches (harvest, remembrance, carols, fundraisers). Skip
  the regular Sunday service rota, which the site covers in a standing footnote.
- Submissions (community groups and residents): usually one item per email, occasionally
  several. The sender is often the organiser; use them as contact if no other is given.
