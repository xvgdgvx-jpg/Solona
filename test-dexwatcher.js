const assert = require('node:assert/strict');
const { DexWatcher } = require('./services/dexwatcher');
const base = { dex: { minAgeSec: 0, maxAgeSec: 0, minVolumeUsd: 100, minLiquidityUsd: 100, minBuys24h: 1, minBuySellRatio: 1, minMarketCapUsd: 10, maxMarketCapUsd: 0, allowedDexes: 'all' }, goplus: { enabled: true, maxBuyTax: 10, maxSellTax: 10, rejectHoneypot: true, checkMintAuthority: true, checkFreezeAuthority: true }, tracker: { enabled: true, maxRiskScore: 5, rejectRugged: true, maxDeveloperHoldingPct: 20, maxSnipersPct: 30, maxInsidersPct: 30, maxBundlersPct: 50, maxTop10Pct: 40, minHolders: 1 } };
const candidate = { mint: 'So11111111111111111111111111111111111111112', createdAt: Date.now() / 1000, volumeUsd: 1000, liquidityUsd: 1000, dexBuys: 10, dexSells: 5, buySellRatio: 2, marketCapUsd: 1000, dexScreenerDex: 'raydium' };
async function run() {
  const results = []; const watcher = new DexWatcher({ settings: structuredClone(base), onCandidate: async () => results.push('pass'), onFilter: (_c, reason, stage) => results.push(`${stage}:${reason}`), onError: () => {} });
  watcher.goplus = async () => null; watcher.tracker = async () => null; assert.equal(await watcher.evaluate({ ...candidate }), true); assert.equal(results.at(-1), 'pass');
  watcher.settings.dex.minVolumeUsd = 5000; assert.equal(await watcher.evaluate({ ...candidate }), false); assert.match(results.at(-1), /^dex:/);
  watcher.settings.dex.minVolumeUsd = 100; watcher.goplus = async () => ({ is_honeypot: 1 }); assert.equal(await watcher.evaluate({ ...candidate }), false); assert.match(results.at(-1), /^goplus:/);
  watcher.goplus = async () => null; watcher.tracker = async () => ({ riskScore: 9 }); assert.equal(await watcher.evaluate({ ...candidate }), false); assert.match(results.at(-1), /^tracker:/);
  watcher.goplus = async () => { throw new Error('optional failure'); }; watcher.tracker = async () => { throw new Error('optional failure'); }; watcher.goplus = async () => null; watcher.tracker = async () => null; assert.equal(await watcher.evaluate({ ...candidate }), true);
  console.log('dexwatcher scenarios: 4 passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
