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

  // Drop pipeline news/notices past their expiry date (between publish runs)
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
