const assert = require('node:assert/strict');
const { defaults, getSettings, canTrade } = require('./services/settings');

assert.equal(Object.hasOwn(defaults, 'autoSellStrategy'), false);
assert.equal(Object.hasOwn(defaults, 'tradeSizeSol'), false);
const settings = getSettings(`test-${process.pid}`, Buffer.alloc(32));
assert.equal(Object.hasOwn(settings, 'autoSellStrategy'), false);
assert.equal(Object.hasOwn(settings, 'tradeSizeSol'), false);
assert.equal(canTrade({ maxTradesPerDay: 0, tradesToday: 999 }), true);
assert.equal(canTrade({ maxTradesPerDay: 2, tradesToday: 2 }), false);
assert.equal(canTrade({ maxTradesPerDay: 2, tradesToday: 1 }), true);
console.log('settings cleanup: legacy fields removed and trade limit verified');
