// worker/test/help.test.mjs: every admin panel screen has an intro and a "How this works" guide
// (Jon, 4 Nov: every screen should say how to use it and what its words mean).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_JS } from '../src/admin/ui/client.js';

test('every menu screen, and Health, has an intro and How this works', () => {
  const views = [...CLIENT_JS.match(/var VIEWS = \[(.*?)\];/)[1].matchAll(/\['([a-z]+)', '/g)].map((m) => m[1]).concat('health');
  const block = (name) => CLIENT_JS.slice(CLIENT_JS.indexOf(`var ${name} = {`), CLIENT_JS.indexOf('};', CLIENT_JS.indexOf(`var ${name} = {`)));
  for (const v of views) {
    assert.match(block('INTROS'), new RegExp(`\\n    ${v}: '`), `intro for ${v}`);
    assert.match(block('HELP'), new RegExp(`\\n    ${v}: \\[`), `How this works for ${v}`);
  }
});
