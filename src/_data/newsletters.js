// Newsletter archive, generated at build time from MailerLite's sent campaigns.
// Falls back to cache/newsletters.json if the API key is missing or the call fails.
const fs = require("fs");
const path = require("path");

const CACHE = path.join(__dirname, "cache", "newsletters.json");
const API = "https://connect.mailerlite.com/api/campaigns";

const longDate = (stamp) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(stamp.replace(" ", "T") + "Z"));

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch (err) {
    console.warn(`[newsletters] Cache unreadable: ${err.message}`);
    return [];
  }
}

function writeCache(list) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(list, null, 2) + "\n");
  } catch (err) {
    console.warn(`[newsletters] Could not refresh cache: ${err.message}`);
  }
}

module.exports = async () => {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key) {
    console.warn("[newsletters] No MAILERLITE_API_KEY set — using cached list.");
    return readCache();
  }

  try {
    const campaigns = [];
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`${API}?filter[status]=sent&limit=100&page=${page}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`MailerLite responded ${res.status}`);
      const body = await res.json();
      const data = body.data || [];
      campaigns.push(...data);
      if (data.length < 100) break;
    }

    const list = campaigns
      .filter((c) => c.finished_at && c.emails && c.emails[0] && c.emails[0].preview_url)
      .sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1))
      .map((c) => ({ label: longDate(c.finished_at), url: c.emails[0].preview_url }));

    if (!list.length) throw new Error("no sent campaigns returned");

    writeCache(list);
    console.log(`[newsletters] ${list.length} editions loaded from MailerLite.`);
    return list;
  } catch (err) {
    console.warn(`[newsletters] ${err.message} — using cached list.`);
    return readCache();
  }
};
