# Submitter reply templates

Used by scripts/ingest/replies.js. Each "## key" section is one block of the reply.
Placeholders in {braces} are filled in by code. Keep blocks as plain text (no Markdown
formatting): they are sent as the email body. Never use a personal name.
Keep in step with src/_includes/guidelines.md. Don't rename or remove a key: the code
needs every one of them.

## greeting
Hello,

## ack_one
Thank you for sending us "{title}". We've received it and will consider it for the website and Thursday's newsletter.

## ack_many
Thank you for sending us the following. We've received them and will consider them for the website and Thursday's newsletter:
{titles}

## ack_none
Thank you for your email.

## too_early
"{title}" is more than two weeks away. We list events no earlier than two weeks before they take place, so we'll hold it and include it from {show_from}.

## after_deadline
Your email arrived after our Wednesday 6pm deadline, so we'll consider it for the following week's newsletter.

## flyer_limit
The flyer for "{title}" has already been shown twice, which is our limit for any one image, so we'll include the details as text only.

## newsletter_limit
"{title}" has already appeared in the newsletter three times, which is our limit, but it will stay listed on the website until the event.

## people_in_image
The image for "{title}" shows people. Please make sure everyone pictured is happy for it to be published, and that a parent or guardian has agreed for any children. If that isn't the case, let us know and we'll leave the image out.

## out_of_scope
We cover the Lenches and nearby villages, plus events of clear interest in Evesham, Pershore and Inkberrow. Some or all of what you sent appears to be outside that area, so it may not be included.

## classified
We don't include classified adverts (items for sale or wanted, lettings, jobs or personal services), so "{title}" is unlikely to be included.

## political_commercial
The team will review "{title}" before deciding whether it can be included.

## clarify_deadline
If we don't hear back by Wednesday 6pm, we'll go ahead with the details we have.

## guidelines
You can find our submission guidelines on the Contact page: {guidelines_url}

## signature
Best wishes,
The Website and Newsletter Team
