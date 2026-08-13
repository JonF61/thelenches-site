// Stamped automatically at each build — today's date in Europe/London.
// Every commit triggers a rebuild, so this can never go stale.
module.exports = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
