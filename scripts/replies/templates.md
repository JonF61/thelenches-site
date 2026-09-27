# Submitter reply templates

Used by scripts/ingest/replies.js. Each "## key" section is one block of the reply.
Placeholders in {braces} are filled in by code. Keep blocks as plain text (no Markdown
formatting): they are sent as the email body. Never use a personal name.
Minimal first version (step 6a); step 6b refines the wording.

## greeting
Hello,

## ack_one
Thank you for sending us "{title}". We've received it and will consider it for the website and the weekly newsletter.

## ack_many
Thank you for sending us the following, which we've received and will consider for the website and the weekly newsletter:
{titles}

## ack_none
Thank you for your email.

## too_early
"{title}" is more than two weeks away, so we'll hold it until then and list it from {show_from}.

## after_deadline
Your email arrived after our Wednesday 6pm deadline, so it will be considered for the following week's newsletter.

## flyer_limit
The flyer for "{title}" has already been shown twice, which is our limit, so we'll include the details as text only.

## newsletter_limit
"{title}" has already appeared in the newsletter three times, which is our limit, but it will stay listed on the website until the event.

## people_in_image
The image for "{title}" shows people. Please make sure everyone pictured is happy for it to be published, and that a parent or guardian has agreed for any children.

## out_of_scope
Some or all of what you sent appears to be outside the area we cover, so it may not be included.

## classified
We don't normally include classified adverts (items for sale or wanted, lettings, jobs or personal services), so "{title}" may not be included.

## political_commercial
The team will review "{title}" before deciding whether it can be included.

## clarify_deadline
If we don't hear back by Wednesday 6pm, we'll go ahead with the details we have.

## guidelines
Our submission guidelines are on the Contact page: {guidelines_url}

## signature
Best wishes,
The Website and Newsletter Team
