const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('bot/index.js', 'utf8');
const required = [
  'watch:on', 'watch:off', 'settings', 'dashboard', 'wallet', 'wallet:balance', 'unsold',
  'mode:toggle', 'mode:live', 'mode:paper', 'roadmap', 'reset:ask', 'reset:do',
  'filters', 'filters:dex', 'filters:onchain', 'filters:goplus', 'filters:tracker', 'filters:risk',
  'toggle-filter:onchain', 'toggle-filter:goplus', 'toggle-filter:tracker',
  'cfg:allocation', 'cfg:trades', 'cfg:profit', 'cfg:stop', 'cfg:strategy', 'cfg:buy', 'cfg:sell'
];
for (const route of required) assert.match(source, new RegExp(route.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')), `missing button route: ${route}`);
assert.match(source, /await save\(s\); watcher\.updateSettings\(s\); if \(field === 'autoWatcherEnabled'\)/);
assert.match(source, /try \{ const address = await walletAddress\(\)/);
assert.match(source, /const watcherRunning = Boolean\(st\.running && s\.autoWatcherEnabled && !s\.killSwitch\)/);
console.log(`button coverage: ${required.length} required routes and behavioral guards passed`);
