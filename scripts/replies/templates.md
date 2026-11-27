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
Thanks for sending "{title}", it's on its way to the website. We include events in the newsletter up to two weeks ahead, so it'll go in from {show_from}.

## ack_many
Thanks for these, they're on their way to the website and Thursday's newsletter:
{titles}

## ack_many_held
Thanks for these, they're on their way to the website. We include events in the newsletter up to two weeks ahead, so they'll go in nearer the time:
{titles}

## ack_none
Thanks for getting in touch.

## ack_listed
Thanks for sending "{title}". We already have it on the website, so it's all set: {link}

## ack_listed_line
We already have "{title}" on the website: {link}

## listed_nl_this
It's in this Thursday's newsletter ({this_date}) too.

## listed_nl_this_and
It's in this Thursday's newsletter ({this_date}) too, and again on {later}.

## listed_nl_later
It'll be in the newsletter on {dates}.

## listed_nl_later_many
It'll be in the newsletters on {dates}.

## listed_nl_past
It's already been in the newsletter.

## live_one
Good news: "{title}" is now on the website: {link}
If you don't see it straight away, try refreshing the page.

## live_many
Good news: these are now on the website:
{titles}
If you don't see them straight away, try refreshing the page.

## ack_newsletter
We've also added you to our weekly newsletter so you can see your entry. To stop it, just reply UNSUBSCRIBE.

## own_wording
No problem, we'll use your wording for "{title}" exactly as written, just fixing any obvious typos or broken links.

## attachment_unusable
Sorry, we couldn't open {files}. Photos (JPEG, PNG or straight off an iPhone) and PDF flyers work best, or just paste the details into an email.

## too_early
"{title}" is on its way to the website too, and will go in the newsletter from {show_from} (we include events up to two weeks ahead).

## too_early_many
These ones are on their way to the website too, and will go in the newsletter nearer the time (we include events up to two weeks ahead):
{titles}

## after_deadline
This arrived just after our Wednesday 6pm cut-off, so it'll go in the following week's newsletter.

## flyer_limit
We've shown the flyer for "{title}" twice now, which is as often as we show any one image, so this time it'll go in as text.

## newsletter_limit
"{title}" has had its three newsletter outings now, but it'll stay on the website right up to the day.

## people_in_image
Quick one about the photo for "{title}": as it shows children, could you check their parents are happy for it to go online? If not, just say and we'll leave it out.

## people_in_image_many
Quick one about the photos for {titles}: as they show children, could you check their parents are happy for them to go online? If not, just say and we'll leave them out.

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

## org_check
I help look after thelenches.org.uk, the community website and weekly newsletter for the Lenches villages. {organisation} is listed on our {page} page, and we'd like to make sure the details are right:
{page_url}

This is what it shows at the moment:
{entry}

Could you let me know if anything needs changing? And if there's anything you'd like added, such as regular events, opening times or news, just reply to this email. You're always welcome to send us items for the newsletter too.

## org_chase
Just following up on my note about {organisation}'s entry on our {page} page. If everything's still correct, there's no need to reply, and we'll assume it's all fine. If anything has changed, a quick reply is all we need.

## listing_check
I help look after thelenches.org.uk, the community website and weekly newsletter for the Lenches villages. {name} is listed free of charge on our {page} page:
{page_url}

This is what it shows at the moment:
{entry}

Could you check it's right? If you'd like anything changed or added, such as what you do, the areas you cover or your website, just reply to this email. If you'd rather not be listed, let me know and we'll take it off.

## listing_check_eat
I help look after thelenches.org.uk, the community website and weekly newsletter for the Lenches villages. {name} is listed free of charge on our {page} page, where people can choose somewhere to eat by what they're after, such as a Sunday roast or somewhere that welcomes dogs:
{page_url}

This is what it shows at the moment:
{entry}

Could you check it's right? It would also help to know:
- which meals you serve (breakfast, lunch, evening meals, Sunday roast, afternoon tea, coffee and cake, takeaway)
- whether you have a garden or outdoor seating
- whether dogs and children are welcome
- whether you have vegetarian or vegan choices
- whether there's step-free access
- whether you have an open fire or rooms to stay

If you have a photo of the outside or inside that we could use on the page, we'd be glad of that too. If you'd like anything else changed or added, just reply to this email. If you'd rather not be listed, let me know and we'll take it off.

## listing_chase
Just following up on my note about {name}'s free listing on our {page} page. If everything's correct, there's no need to reply. If anything has changed, a quick reply is all we need.

## listing_check_harvington
I help look after harvingtonvillage.org.uk, the community website and weekly newsletter for Harvington, Norton and Lenchwick. {name} is listed free of charge on our {page} page:
{page_url}

This is what it shows at the moment:
{entry}

Could you check it's right? If you'd like anything changed or added, such as what you do, the areas you cover or your website, just reply to this email. If you'd rather not be listed, let me know and we'll take it off.

## listing_check_eat_harvington
I help look after harvingtonvillage.org.uk, the community website and weekly newsletter for Harvington, Norton and Lenchwick. {name} is listed free of charge on our {page} page, where people can choose somewhere to eat by what they're after, such as a Sunday roast or somewhere that welcomes dogs:
{page_url}

This is what it shows at the moment:
{entry}

Could you check it's right? It would also help to know:
- which meals you serve (breakfast, lunch, evening meals, Sunday roast, afternoon tea, coffee and cake, takeaway)
- whether you have a garden or outdoor seating
- whether dogs and children are welcome
- whether you have vegetarian or vegan choices
- whether there's step-free access
- whether you have an open fire or rooms to stay

If you have a photo of the outside or inside that we could use on the page, we'd be glad of that too. If you'd like anything else changed or added, just reply to this email. If you'd rather not be listed, let me know and we'll take it off.

## link_request
I help look after thelenches.org.uk, the free community website and weekly newsletter for Church, Rous, Ab, Atch and Sheriffs Lench near Evesham. It lists what's on across the villages, local news, road closures, bin days and local clubs and groups.

{listed_line}

Would you be happy to add a link to us from your website, perhaps on a links or community page? If it helps, something like:

The Lenches Website (https://thelenches.org.uk/): events, news and local information for the Lenches villages near Evesham.

It helps local people find what's going on, and it helps the site show up in Google.

And if you ever have news or events to share, just reply to this email and we'll put them on the website and in the newsletter.

## link_request_harvington
I help look after harvingtonvillage.org.uk, the free community website and weekly newsletter for Harvington, Norton and Lenchwick. It lists what's on across the villages, local news, road closures, bin days and local clubs and groups.

{listed_line}

Would you be happy to add a link to us from your website, perhaps on a links or community page? If it helps, something like:

The Harvington Website (https://harvingtonvillage.org.uk/): events, news and local information for Harvington, Norton and Lenchwick.

It helps local people find what's going on, and it helps the site show up in Google.

And if you ever have news or events to share, just reply to this email and we'll put them on the website and in the newsletter.

## link_request_listed
{organisation} is listed on our {page} page:
{page_url}

## link_request_known
I'm getting in touch about the Lenches Website (thelenches.org.uk).

{listed_line}

Would you be happy to add a link to us from your website, perhaps on a links or community page? If it helps, something like:

The Lenches Website (https://thelenches.org.uk/): events, news and local information for the Lenches villages near Evesham.

It helps local people find what's going on, and it helps the site show up in Google.

## link_request_known_harvington
I'm getting in touch about the Harvington Website (harvingtonvillage.org.uk).

{listed_line}

Would you be happy to add a link to us from your website, perhaps on a links or community page? If it helps, something like:

The Harvington Website (https://harvingtonvillage.org.uk/): events, news and local information for Harvington, Norton and Lenchwick.

It helps local people find what's going on, and it helps the site show up in Google.

## link_request_both
I'm getting in touch about our two community websites, the Lenches Website (thelenches.org.uk) and the Harvington Website (harvingtonvillage.org.uk).

{listed_line}

Would you be happy to add links to them from your website, perhaps on a links or community page? If it helps, something like:

The Lenches Website (https://thelenches.org.uk/): events, news and local information for the Lenches villages near Evesham.

The Harvington Website (https://harvingtonvillage.org.uk/): events, news and local information for Harvington, Norton and Lenchwick.

It helps local people find what's going on, and it helps both sites show up in Google.

## link_request_listed_both
{organisation} is listed on both websites:
{page_url}
{page_url2}

## link_chase
Just following up my email about a link to thelenches.org.uk from your website. If it's not something you can do, that's absolutely fine, and there's no need to reply.

## link_chase_harvington
Just following up my email about a link to harvingtonvillage.org.uk from your website. If it's not something you can do, that's absolutely fine, and there's no need to reply.

## link_chase_both
Just following up my email about links to thelenches.org.uk and harvingtonvillage.org.uk from your website. If it's not something you can do, that's absolutely fine, and there's no need to reply.

## signature
Best wishes,
Holly
Lenches website assistant

## sponsor_approach
I'm writing from The Lenches Website, the free community website and weekly newsletter for Church, Rous, Ab, Atch and Sheriffs Lench near Evesham. We're looking for local businesses to support the newsletter, one sponsor each month.

The newsletter is opened over {opens} times each month, and the website has around {visits} visits a month. The introductory price is {price}, for one month at a time, with nothing to sign up to beyond that.

Everything you need to know is here:
{sponsor_url}

## sponsor_chase
Just following up my note about sponsoring the Lenches newsletter:
{sponsor_url}

If it's not for you, no problem: reply "no thanks" and we won't contact you again.
