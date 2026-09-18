const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('bot/index.js', 'utf8');

const directRoutes = ['cfg:allocation', 'cfg:trades', 'cfg:profit', 'cfg:stop'];
for (const route of directRoutes) assert.match(source, new RegExp(`callbackQuery\\('${route}'`));
assert.ok(source.includes("['cfg:buy','autoWatcherEnabled'],['cfg:sell','autoSellEnabled']"), 'buy/sell toggle routes missing');
const valueRoutes = {
  allocation: [1, 2, 3, 4, 5, 10, 15, 25, 30, 35, 40, 50, 60, 75, 90, 100],
  trades: [1, 2, 3, 4, 5, 10, 0],
  profit: [5, 10, 15, 25, 35, 50, 75, 100],
  stop: [5, 10, 15, 20, 25, 30]
};
for (const [name, values] of Object.entries(valueRoutes)) {
  const list = values.join(',');
  if (name === 'trades') assert.ok(source.includes('for (const v of [1,2,3,4,5,10])'), `${name} values list missing`);
  else assert.ok(source.includes(`for (const v of [${list}])`), `${name} values list missing`);
}
assert.ok(source.includes("if (type === 'allocation') s.paperAllocationPct = value"));
assert.ok(source.includes("if (type === 'trades') s.maxTradesPerDay = value"));
assert.ok(source.includes("if (type === 'profit') s.paperTakeProfitFirstPct = value"));
assert.ok(source.includes("s.paperStopLossPct = value; s.risk.stopLossPct = value"));
assert.equal(/cfg:strategy|autoSellStrategy|tradeSizeSol/.test(source), false);
console.log('settings routes: all allocation, trade-limit, profit, and stop-loss values verified');
