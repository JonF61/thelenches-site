module.exports = function (eleventyConfig) {
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
