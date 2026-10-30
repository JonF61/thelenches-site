module.exports = async function (eleventyConfig) {
  // Eleventy v3 is ESM; load the RenderPlugin from this CommonJS config via import()
  const { RenderPlugin } = await import("@11ty/eleventy");
  eleventyConfig.addPlugin(RenderPlugin); // {% renderFile %} for src/_includes/guidelines.md

  eleventyConfig.addPassthroughCopy("src/style.css");
  eleventyConfig.addPassthroughCopy("src/images");
  // Hand-written items (src/items/, read by src/_data/whatson.js): rebuild on change when serving
  eleventyConfig.addWatchTarget("src/items/");

  // Today in Europe/London as YYYY-MM-DD, so dates compare as plain strings
  const today = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  const fmt = (iso, opts) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(
      new Date(iso + "T12:00:00Z")
    );

  // Drop finished events, sort the rest soonest-first
  eleventyConfig.addFilter("upcoming", (events) => {
    const now = today();
    return (events || [])
      .filter((e) => e.date && (e.endDate || e.date) >= now)
      .sort((a, b) => a.date.localeCompare(b.date));
  });

  // Group an already-sorted event list by month: [{ label: "October 2026", items: [...] }]
  eleventyConfig.addFilter("byMonth", (events) => {
    const groups = [];
    for (const e of events || []) {
      const label = fmt(e.date.slice(0, 7) + "-01", { month: "long", year: "numeric" });
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  });

  // Join two lists, e.g. hand-written src/items/ items plus pipeline.json items
  eleventyConfig.addFilter("merge", (a, b) => [...(a || []), ...(b || [])]);

  // Split a body into paragraphs at blank lines ("\n\n" in the JSON). Returns plain strings,
  // so templates still escape each one; always at least one (possibly empty) paragraph.
  eleventyConfig.addFilter("paras", (text) => {
    const out = String(text || "")
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return out.length ? out : [""];
  });

  // A notice card's opening and the rest (Notices page, 28 Oct): the opening is the first
  // paragraph cut after the sentence that passes `min` characters, so a long first paragraph
  // folds behind "More" too. Returns [lead, rest paragraphs...]; plain strings, escaped by the template.
  eleventyConfig.addFilter("leadSplit", (text, min = 140) => {
    const ps = String(text || "").split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
    if (!ps.length) return [""];
    const first = ps[0];
    const re = /[.!?](?=\s+[A-Z(‘“"'])/g;
    let m;
    while ((m = re.exec(first))) {
      if (m.index + 1 >= min && first.length - m.index > 40) {
        return [first.slice(0, m.index + 1), first.slice(m.index + 1).trim(), ...ps.slice(1)];
      }
    }
    return ps;
  });

  // Road closures and roadworks (the Roads page; left off Notices): "roads": true on
  // a src/items/ notice, or any item linking to one.network (all pipeline roadworks alerts do).
  // Shared with scripts/publish: lib/roads.js.
  const roads = require("./lib/roads.js");
  eleventyConfig.addFilter("roadItems", (items) => (items || []).filter(roads.isRoad));
  eleventyConfig.addFilter("notRoadItems", (items) => (items || []).filter((i) => !roads.isRoad(i)));

  // Roads page: "Closure" or "Roadworks" tag, and the title without a "Road closure —" prefix
  eleventyConfig.addFilter("roadKind", roads.roadKind);
  eleventyConfig.addFilter("roadTitle", roads.roadTitle);

  // Roads page map data: one entry per current road item (pipeline, then src/items/), with its
  // dates and cached geometry (src/_data/roadgeo.json; else a pin at the village). The page's
  // script picks the works active on the chosen day. Plus the home frame and centre.
  eleventyConfig.addFilter("roadMap", (pipeline, whatson, roadgeo) => {
    const now = today();
    const current = (i) => i && i.title && roads.isRoad(i);
    const p = pipeline || {};
    const w = whatson || {};
    const works = [
      ...[...(p.notices || []), ...(p.news || [])]
        .filter((i) => current(i) && (!i.expires || i.expires >= now))
        .map((i) => roads.mapEntry(i, roadgeo, true)),
      ...[...(w.notices || []), ...(w.news || [])]
        .filter(current)
        .map((i) => roads.mapEntry(i, roadgeo, false)),
    ];
    return { home: roads.HOME_BOUNDS, centre: roads.HOME_CENTRE, works };
  });

  // Split road items by start date ("start", else "date"): { now: started or undated,
  // soon: starting after today }
  eleventyConfig.addFilter("roadSplit", (items) => {
    const now = today();
    const from = (i) => i.start || i.date || "";
    const list = (items || []).slice().sort((a, b) => from(a).localeCompare(from(b)));
    return {
      now: list.filter((i) => !from(i) || from(i) <= now),
      soon: list.filter((i) => from(i) && from(i) > now),
    };
  });

  // All current notices, roads included: pipeline (newest first) then src/items/ (by "order").
  // "news" lists are read as notices (the News page was retired 21 Oct 2026; pipeline.json
  // drops "news" on its next publish run, src/items/ has none).
  eleventyConfig.addFilter("allNotices", (pipeline, whatson) => {
    const now = today();
    const p = pipeline || {};
    const w = whatson || {};
    return [...(p.notices || []), ...(p.news || []), ...(w.notices || []), ...(w.news || [])]
      .filter((i) => i && i.title && (!i.expires || i.expires >= now));
  });

  // Home page: notices added (approved) in the last 7 days. Pipeline items carry "added";
  // hand-written src/items/ notices count only if given one.
  eleventyConfig.addFilter("newThisWeek", (items) => {
    const d = new Date(today() + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 6);
    const from = d.toISOString().slice(0, 10);
    return (items || []).filter((i) => i.added && i.added >= from && i.added <= today()).length;
  });

  // Home page: next collection for the first area in bins.json, or null when the calendar
  // has run out. { area, date, bins: ["green", "brown"] }
  // Next bin collection for each collection day (areas grouped by offset, in bins.json order):
  // [{ label, date, bins }]. label is the village, or "<first> & others" for a group of
  // three or more. Build-time fallback only: the home page script recalculates it in the
  // browser with the bins page's rule (a collection counts until 10am on the day).
  eleventyConfig.addFilter("nextBins", (bins) => {
    const groups = [];
    for (const a of (bins && bins.areas) || []) {
      const off = Number(a.offset) || 0;
      let g = groups.find((x) => x.offset === off);
      if (!g) groups.push((g = { offset: off, villages: [] }));
      g.villages.push(a.name);
    }
    const now = today();
    const sorted = ((bins && bins.collections) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const out = [];
    for (const g of groups) {
      for (const c of sorted) {
        const d = new Date(c.date + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + g.offset);
        const date = d.toISOString().slice(0, 10);
        if (date >= now) {
          const label = g.villages.length > 2 ? `${g.villages[0]} & others` : g.villages.join(" & ");
          out.push({ label, date, bins: c.bins || [] });
          break;
        }
      }
    }
    return out;
  });

  eleventyConfig.addFilter("isArray", (v) => Array.isArray(v));

  // What to do if… call button: { ref } takes its number from health.json numbers (one copy of
  // each number); a ref that isn't there stops the build rather than showing a blank button.
  eleventyConfig.addFilter("callNumber", (c, numbers) => {
    if (!c.ref) return c.number;
    const n = (numbers || []).find((x) => x.label === c.ref);
    if (!n) throw new Error(`whattodo.json: no health.json number labelled "${c.ref}"`);
    return n.number;
  });

  // bins.json trimmed for the home page script: areas, and collections from a week before the build
  eleventyConfig.addFilter("binsSoon", (bins) => {
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    return {
      areas: (bins && bins.areas) || [],
      collections: ((bins && bins.collections) || []).filter((c) => c.date >= from).slice(0, 12),
    };
  });

  // "green and brown"
  eleventyConfig.addFilter("andList", (list) => {
    const l = (list || []).map(String);
    return l.length > 1 ? l.slice(0, -1).join(", ") + " and " + l[l.length - 1] : l[0] || "";
  });

  // Illustrated fallback tile for an event with no image (Events page only; lib/tiles.js)
  const { tileSvg } = require("./lib/tiles.js");
  eleventyConfig.addFilter("tileSvg", tileSvg);

  // Standing image for a recurring event: the event's own image if it has one, else the
  // first photos.json item with a target "event:<key>" whose key appears in the title
  // (letters and digits only, so "event:gloquiz" matches "Glo-Quiz — The Lenches Club").
  // Set in the Photos tab: status approved, target event:<key>. Returns { url, alt } or null.
  const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  eleventyConfig.addFilter("eventImage", (e, photos) => {
    if (e && e.image && e.image.url) return e.image;
    const title = squash(e && e.title);
    if (!title) return null;
    for (const p of photos || []) {
      for (const t of p.targets || []) {
        const m = String(t).match(/^event:(.+)$/);
        if (m && squash(m[1]) && title.includes(squash(m[1])) && p.src) {
          return { url: p.src, alt: p.alt || "" };
        }
      }
    }
    return null;
  });

  // schema.org JSON-LD for search engines (lib/schema.js): the site on the home page, and the
  // Events page's upcoming events (ids as the page anchors, images as eventImage).
  const schema = require("./lib/schema.js");
  eleventyConfig.addFilter("siteLd", (site) => schema.ldJson(schema.siteSchema(site)));
  eleventyConfig.addFilter("eventsLd", (events, photos, site) => {
    const slugify = eleventyConfig.getFilter("slugify");
    const imageOf = eleventyConfig.getFilter("eventImage");
    const seen = new Set();
    const list = (events || []).filter((e) => {
      const id = slugify("ev-" + e.date + "-" + e.title);
      return e.title && !seen.has(id) && seen.add(id);
    }).map((e) => {
      const img = imageOf(e, photos);
      return schema.eventSchema(e, { siteUrl: site.url, id: slugify("ev-" + e.date + "-" + e.title), image: (img && img.url) || site.ogImage });
    });
    return schema.ldJson({ "@context": "https://schema.org", "@graph": list });
  });

  // True for items in the five Lenches ("Lenches" badge on Events; lib/lenches.js)
  const { inLenches } = require("./lib/lenches.js");
  eleventyConfig.addFilter("inLenches", inLenches);

  // Drop pipeline notices past their expiry date (between publish runs)
  eleventyConfig.addFilter("current", (items) => {
    const now = today();
    return (items || []).filter((i) => !i.expires || i.expires >= now);
  });

  // "Fri" / "31" / "Jul" for the date block
  eleventyConfig.addFilter("dateParts", (iso) => ({
    dow: fmt(iso, { weekday: "short" }),
    day: fmt(iso, { day: "numeric" }),
    mon: fmt(iso, { month: "short" }),
  }));

  // "Sat 24 Oct"
  eleventyConfig.addFilter("shortDate", (iso) =>
    fmt(iso, { weekday: "short", day: "numeric", month: "short" })
  );

  // Where each published photo appears (slug -> page links), for the admin panel's
  // "On the website" links: _site/photo-pages.json, public facts only (lib/photopages.js)
  const { photoPages, eventEnds } = require("./lib/photopages.js");
  eleventyConfig.on("eleventy.after", ({ results, dir }) => {
    const fs = require("fs");
    const path = require("path");
    const photos = JSON.parse(fs.readFileSync(path.join(__dirname, "src/_data/photos.json"), "utf8"));
    const out = photoPages(results, photos.map((p) => p.slug));
    out.eventEnds = eventEnds(require("./lib/whatson.js").loadWhatson({ all: true }).events);
    fs.writeFileSync(path.join(dir.output, "photo-pages.json"), JSON.stringify(out, null, 1) + "\n");
    // Events and road works coming up, for the admin panel's Summary page (lib/comingup.js).
    const ukToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const pipeline = JSON.parse(fs.readFileSync(path.join(__dirname, "src/_data/pipeline.json"), "utf8"));
    const coming = require("./lib/comingup.js").comingUp({ whatson: require("./lib/whatson.js").loadWhatson(), pipeline }, ukToday);
    fs.writeFileSync(path.join(dir.output, "coming-up.json"), JSON.stringify(coming, null, 1) + "\n");
  });

  // "October 2026" from "2026-10" (Regular activities: details last checked)
  eleventyConfig.addFilter("monthYear", (ym) =>
    /^\d{4}-\d{2}$/.test(String(ym || "")) ? fmt(`${ym}-01`, { month: "long", year: "numeric" }) : ""
  );

  // "Friday 31 July 2026"
  eleventyConfig.addFilter("longDate", (iso) =>
    fmt(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
  );

  return {
    pathPrefix: "/",
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
