// Version of src/style.css for its link in base.njk (/style.css?v=...): a short hash of the
// file, so browsers fetch the new stylesheet as soon as it changes instead of pairing new
// pages with a cached old one (25 Oct 2026: the new footer showed as one long list).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = () => crypto.createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, '..', 'style.css')))
  .digest('hex').slice(0, 10);
