// One .ics per upcoming event (/calendar/<event anchor>.ics), the Events page's "Other calendar" link.
// Shared by every site's calendar.11ty.js (Harvington stage 6b, 16 Nov 2026; was sites/lenches/calendar.11ty.js).
const { eventIcs } = require('./ics.js');
const { ukToday } = require('./whatson.js');

module.exports = class {
  data() {
    return {
      pagination: {
        data: 'whatson.events',
        size: 1,
        alias: 'ev',
        before(events, full) {
          const today = ukToday();
          return [...(events || []), ...((full.pipeline && full.pipeline.events) || [])]
            .filter((e) => e.date && e.title && (e.endDate || e.date) >= today)
            .filter((e, i, all) => all.findIndex((x) => x.date === e.date && x.title === e.title) === i);
        },
      },
      permalink(data) { return `/calendar/${this.slugify('ev-' + data.ev.date + '-' + data.ev.title)}.ics`; },
      eleventyExcludeFromCollections: true,
    };
  }

  render(data) {
    const id = this.slugify('ev-' + data.ev.date + '-' + data.ev.title);
    // The event's own page where the site has them (SEO step 1, 26 Nov 2026), else its Events-page anchor.
    const url = data.site.eventPages === true ? `${data.site.url}${require('./eventpage.js').eventPath(data.ev)}` : `${data.site.url}/events/#${id}`;
    return eventIcs(data.ev, { id, url });
  }
};
