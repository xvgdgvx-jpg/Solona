const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('bot/index.js', 'utf8');
const exactRoutes = [
  'watch:on', 'watch:off', 'settings', 'dashboard', 'wallet', 'wallet:balance', 'unsold',
  'cfg:allocation', 'cfg:trades', 'cfg:profit', 'cfg:stop', 'cfg:buy', 'cfg:sell',
  'roadmap', 'reset:ask', 'reset:do', 'mode:toggle', 'mode:live', 'mode:paper',
  'filters', 'filters:dex', 'filters:onchain', 'filters:goplus', 'filters:tracker', 'filters:risk',
  'toggle-filter:onchain', 'toggle-filter:goplus', 'toggle-filter:tracker', 'home'
];
for (const route of exactRoutes) assert.ok(source.includes(`'${route}'`) || source.includes('`' + route + '`'), `missing route: ${route}`);
for (const route of ['watch:on', 'watch:off', 'settings', 'dashboard', 'wallet', 'unsold', 'roadmap', 'reset:ask', 'reset:do', 'mode:toggle', 'mode:live', 'mode:paper']) assert.ok(source.includes(`callbackQuery('${route}'`), `missing handler: ${route}`);
assert.match(source, /callbackQuery\(\/\^position:sell/);
assert.match(source, /callbackQuery\(\/\^position:price/);
assert.match(source, /callbackQuery\(\/\^choose:\(dex\|onchain\|goplus\|tracker\|risk\)/);
assert.match(source, /callbackQuery\(\/\^set:\(dex\|onchain\|goplus\|tracker\|risk\)/);
assert.match(source, /replacePositions\(config\.adminId, livePositions, config\.encryptionKey\)/);
assert.match(source, /s\.paperAvailableSol = Number\(s\.paperCapitalSol \|\| 0\)/);
assert.match(source, /s\.paperEvents = \[\]/);
assert.match(source, /s\.rejectStats = \{\}/);
assert.match(source, /watcher\.reset\(\)/);
assert.match(source, /stopMonitor\(\); watcher\.stop\(\)/);
assert.match(source, /if \(wasRunning\) watcher\.start\(\)/);
assert.match(source, /if \(wasRunning && s\.autoSellEnabled\) startMonitor\(\)/);
assert.match(source, /catch \(error\).*فشلت إعادة الضبط/s);
assert.match(source, /takeProfitPct/);
assert.match(source, /mergeDuplicateOpenPositions/);
assert.match(source, /autoSellMints/);
assert.match(source, /جني أرباح كامل \+.*fraction: 1/);
assert.doesNotMatch(source, /fraction: 0\.5/);
assert.doesNotMatch(source, /paperTakeProfitFinalPct/);
console.log(`button graph: ${exactRoutes.length} routes and reset lifecycle verified`);
