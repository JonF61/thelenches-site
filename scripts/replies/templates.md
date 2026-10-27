# Submitter reply templates

Used by scripts/ingest/replies.js. Each "## key" section is one block of the reply.
Placeholders in {braces} are filled in by code. Keep blocks as plain text (no Markdown
formatting): they are sent as the email body. Never use a team member's name: the only
name used is Holly, the website assistant (see voice.md).
Keep in step with src/_includes/guidelines.md and scripts/replies/voice.md. Don't rename
or remove a key: the code needs every one of them.

## greeting
Hi there,

## greeting_name
Hi {name},

## ack_one
Thanks for sending "{title}", it's on its way to the website and Thursday's newsletter.

## ack_one_held
Thanks for sending "{title}". We list events up to two weeks ahead, so we'll hang on to it and start showing it from {show_from}.

## ack_many
Thanks for these, they're on their way to the website and Thursday's newsletter:
{titles}

## ack_many_held
Thanks for these. We list events up to two weeks ahead, so we'll hang on to them and they'll start showing nearer the time:
{titles}

## ack_none
Thanks for getting in touch.

## own_wording
No problem, we'll use your wording for "{title}" exactly as written, just fixing any obvious typos or broken links.

## attachment_unusable
Sorry, we couldn't open {files}. Photos (JPEG, PNG or straight off an iPhone) and PDF flyers work best, or just paste the details into an email.

## too_early
"{title}" is a little way off yet, so we'll hang on to it and start showing it from {show_from} (we list events up to two weeks ahead).

## too_early_many
These ones are a little way off yet, so we'll hang on to them and start showing each one two weeks before (we list events up to two weeks ahead):
{titles}

## after_deadline
This arrived just after our Wednesday 6pm cut-off, so it'll go in the following week's newsletter.

## flyer_limit
We've shown the flyer for "{title}" twice now, which is as often as we show any one image, so this time it'll go in as text.

## newsletter_limit
"{title}" has had its three newsletter outings now, but it'll stay on the website right up to the day.

## people_in_image
Quick one about the photo for "{title}": could you check everyone in it is happy for it to go online, and that parents are OK with it for any children? If not, just say and we'll leave it out.

## people_in_image_many
Quick one about the photos for {titles}: could you check everyone in them is happy for them to go online, and that parents are OK with it for any children? If not, just say and we'll leave them out.

## out_of_scope
We mainly cover the Lenches and the villages around them, plus bigger events in Evesham, Pershore and Inkberrow, so this one might be a bit outside our patch.

## classified
Sorry, we don't run classified adverts (things for sale or wanted, lettings, jobs or services), so we can't include "{title}".

## political_commercial
We'll be in touch shortly about "{title}".

## political_commercial_many
We'll be in touch shortly about {titles}.

## clarify_deadline
If we haven't heard by Wednesday 6pm, no worries, we'll go with what we've got.

## guidelines
Our submission guidelines are on the Contact page if they're handy:
{guidelines_url}

## holding
Thanks for getting in touch. I've passed this on to the team and someone will get back to you shortly.

## what_to_do
Thanks for your email. I wasn't quite sure what you'd like us to do with it: is it something for the website or newsletter, a question, or something else? Just reply and let us know.

## sorry_rejected
Sorry, we said "{title}" was on its way, but we couldn't use it after all. Please do keep sending things in though.

## list_subscribed
Thanks, you're now on the list for the newsletter. It comes out every Thursday morning, and there's an unsubscribe link at the bottom of each one if you ever change your mind.

## list_already
Thanks, you're already on the list for the newsletter, so it should be with you every Thursday morning. If it isn't turning up, it's worth a quick look in your spam folder.

## list_unsubscribed
No problem, we've taken you off the newsletter list, so you won't get any more. If you change your mind, just let us know.

## outreach_optout
If you'd rather we didn't get in touch like this, just say and we won't.

## signature
Best wishes,
Holly
Lenches website assistant
