// One "Add to calendar" file per upcoming event: /calendar/<event id>.ics, where the id is the
// Events page anchor ('ev-' + date + '-' + title, slugified), so events.njk can link to it.
// Same list as the Events page (hand-written items plus pipeline.json, finished events dropped). See lib/ics.js.
const { eventIcs } = require('../lib/ics.js');
const { ukToday } = require('../lib/whatson.js');

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
            // Same date and title = same page anchor: keep the first, as the Events page's link would.
            .filter((e, i, all) => all.findIndex((x) => x.date === e.date && x.title === e.title) === i);
        },
      },
      permalink(data) { return `/calendar/${this.slugify('ev-' + data.ev.date + '-' + data.ev.title)}.ics`; },
      eleventyExcludeFromCollections: true,
    };
  }

  render(data) {
    const id = this.slugify('ev-' + data.ev.date + '-' + data.ev.title);
    return eventIcs(data.ev, { id, url: `${data.site.url}/events/#${id}` });
  }
};
