module.exports = async function (eleventyConfig) {
  // Eleventy v3 is ESM; load the RenderPlugin from this CommonJS config via import()
  const { RenderPlugin } = await import("@11ty/eleventy");
  eleventyConfig.addPlugin(RenderPlugin); // {% renderFile %} for src/_includes/guidelines.md

  eleventyConfig.addPassthroughCopy("src/style.css");
  eleventyConfig.addPassthroughCopy("src/images");

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

  // Join two lists, e.g. hand-written whatson.json items plus pipeline.json items
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

  // Road closures and roadworks (the Roads page; left off Notices): "roads": true in
  // whatson.json, or any item linking to one.network (all pipeline roadworks alerts do).
  const isRoad = (i) =>
    !!i && (i.roads === true || /one\.network/i.test(String((i.link && i.link.url) || "")));
  eleventyConfig.addFilter("roadItems", (items) => (items || []).filter(isRoad));
  eleventyConfig.addFilter("notRoadItems", (items) => (items || []).filter((i) => !isRoad(i)));

  // Roads page: "Closure" or "Roadworks" tag, and the title without a "Road closure —" prefix
  eleventyConfig.addFilter("roadKind", (i) =>
    /\bclos(ure|ures|ed|ing)\b/i.test(`${(i && i.title) || ""} ${(i && i.body) || ""}`) ? "Closure" : "Roadworks"
  );
  eleventyConfig.addFilter("roadTitle", (title) =>
    String(title || "").replace(/^road\s*(closures?|works)\s*[—–-]\s*/i, "")
  );
  // Split road items by start date: { now: started or undated, soon: starting after today }
  eleventyConfig.addFilter("roadSplit", (items) => {
    const now = today();
    const list = (items || []).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    return {
      now: list.filter((i) => !i.date || i.date <= now),
      soon: list.filter((i) => i.date && i.date > now),
    };
  });

  // All current notices, roads included: pipeline (newest first) then whatson.json.
  // "news" lists are read as notices (the News page was retired 21 Oct 2026; pipeline.json
  // drops "news" on its next publish run, whatson.json has none).
  eleventyConfig.addFilter("allNotices", (pipeline, whatson) => {
    const now = today();
    const p = pipeline || {};
    const w = whatson || {};
    return [...(p.notices || []), ...(p.news || []), ...(w.notices || []), ...(w.news || [])]
      .filter((i) => i && i.title && (!i.expires || i.expires >= now));
  });

  // Home page: notices added (approved) in the last 7 days. Pipeline items carry "added";
  // hand-written whatson.json notices count only if given one.
  eleventyConfig.addFilter("newThisWeek", (items) => {
    const d = new Date(today() + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 6);
    const from = d.toISOString().slice(0, 10);
    return (items || []).filter((i) => i.added && i.added >= from && i.added <= today()).length;
  });

  // Home page: next collection for the first area in bins.json, or null when the calendar
  // has run out. { area, date, bins: ["green", "brown"] }
  eleventyConfig.addFilter("nextBin", (bins) => {
    const area = bins && bins.areas && bins.areas[0];
    if (!area) return null;
    const now = today();
    for (const c of (bins.collections || []).slice().sort((a, b) => a.date.localeCompare(b.date))) {
      const d = new Date(c.date + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + (Number(area.offset) || 0));
      const date = d.toISOString().slice(0, 10);
      if (date >= now) return { area: area.name, date, bins: c.bins || [] };
    }
    return null;
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
