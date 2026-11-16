// Each site's Local trades and Where to eat data as this Worker was deployed (Harvington
// stage 7, 16 Nov; deploy-worker.yml runs when any site's trades.json or eat.json changes):
// the Recommend buttons accept only a listed entry of the site the form came from, and the
// panel's Suggestions cards draft against the site they are for.
import lenchesTrades from '../../sites/lenches/_data/trades.json' with { type: 'json' };
import lenchesEat from '../../sites/lenches/_data/eat.json' with { type: 'json' };
import harvingtonTrades from '../../sites/harvington/_data/trades.json' with { type: 'json' };
import harvingtonEat from '../../sites/harvington/_data/eat.json' with { type: 'json' };
import { siteName } from './sites.js';

const DATA = {
  lenches: { trades: lenchesTrades, eat: lenchesEat },
  harvington: { trades: harvingtonTrades, eat: harvingtonEat },
};

// { trades, eat } for a site (unknown = the default site).
export const listingData = (s) => DATA[siteName(s)] || DATA.lenches;
