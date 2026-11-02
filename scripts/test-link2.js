// Second link (2 Nov): pagelinks.js reads a source page's links; extract.js keepLink2 keeps only an address Claude was given.
process.env.ANTHROPIC_API_KEY='x';
const assert=require('assert');
const {keepLink2}=require('./ingest/extract.js');
const {linksFromHtml}=require('./ingest/pagelinks.js');
const html=`<nav><a href="/home">Home</a></nav><article>${'x'.repeat(300)}<p>Report <a href="https://www.westmercia.police.uk/ro/report/">online</a> or <a href='mailto:clerk@harvington-pc.gov.uk'>email</a> <a href="#top">top</a></p></article>`;
const L=linksFromHtml(html,'https://harvington-pc.gov.uk/news/a');
assert.deepStrictEqual(L.map(l=>l.url),['https://www.westmercia.police.uk/ro/report/','mailto:clerk@harvington-pc.gov.uk']);
const src=L.map(l=>l.url).join('\n');
let it=keepLink2({link_url:'https://harvington-pc.gov.uk/news/a',link2_text:'Report to West Mercia Police',link2_url:'https://www.westmercia.police.uk/ro/report/'},src);
assert.equal(it.link2_url,'https://www.westmercia.police.uk/ro/report/');
it=keepLink2({link_url:'',link2_text:'x',link2_url:'https://www.westmercia.police.uk/invented'},src);
assert.equal(it.link2_url,''); assert.equal(it.link2_text,'');
it=keepLink2({link_url:'https://a.org/x',link2_url:'https://a.org/x'},'https://a.org/x');
assert.equal(it.link2_url,'');
it=keepLink2({link_url:'',link2_url:'mailto:clerk@harvington-pc.gov.uk'},'Email clerk@harvington-pc.gov.uk');
assert.equal(it.link2_text,'More details');
console.log('ok');
