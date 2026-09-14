const { getUser, saveUser } = require('./storage');

const defaults = {
  autoWatcherEnabled: false, paperTradingEnabled: true, autoSellEnabled: true, killSwitch: false,
  paperCapitalSol: 3, paperAvailableSol: 3, paperAllocationPct: 5,
  paperTakeProfitFirstPct: 50, paperStopLossPct: 10,
  paperEvents: [], paperPnlSol: 0, liveTrading: false, tradeSizeSol: 0.1,
  maxTradesPerDay: 0, tradesToday: 0, tradeDay: new Date().toISOString().slice(0, 10),
  dex: { minAgeSec: 60, maxAgeSec: 86400, minVolumeUsd: 1000, minLiquidityUsd: 5000, minBuys24h: 25, minBuySellRatio: 1, minMarketCapUsd: 10000, maxMarketCapUsd: 0, allowedDexes: 'raydium' },
  goplus: { enabled: true, maxBuyTax: 10, maxSellTax: 10, rejectHoneypot: true, checkMintAuthority: true, checkFreezeAuthority: true },
  tracker: { enabled: true, maxRiskScore: 5, rejectRugged: true, maxDeveloperHoldingPct: 20, maxSnipersPct: 30, maxInsidersPct: 30, maxBundlersPct: 50, maxTop10Pct: 40, minHolders: 25, maxDeveloperTokens: 0 },
  risk: { stopLossPct: 10, capitalProtection: '50@-10', timedSellMin: 0, emergencyBreaker: true, dailyLossPct: 0 },
  lastMint: null, lastFilterResult: 'لم يبدأ الفحص بعد', rejectStats: {}, checkedCount: 0, lastCheckAt: null,
};

function merge(base, value) {
  const result = { ...base, ...(value || {}) };
  for (const section of ['dex', 'goplus', 'tracker', 'risk']) result[section] = { ...base[section], ...(value?.[section] || {}) };
  return result;
}
function getSettings(adminId, key) {
  const user = getUser(adminId, key);
  const settings = merge(defaults, user.settings);
  const today = new Date().toISOString().slice(0, 10);
  if (settings.tradeDay !== today) { settings.tradeDay = today; settings.tradesToday = 0; }
  return settings;
}
let lock = Promise.resolve();
function saveSettings(adminId, settings, key) {
  const previous = lock; let release;
  lock = new Promise((resolve) => { release = resolve; });
  return previous.then(() => {
    const user = getUser(adminId, key);
    const latest = merge(defaults, user.settings);
    saveUser(adminId, { ...user, settings: merge(latest, settings) }, key);
  }).finally(() => release());
}
function canTrade(settings) { return Number(settings.maxTradesPerDay) <= 0 || Number(settings.tradesToday) < Number(settings.maxTradesPerDay); }
module.exports = { defaults, getSettings, saveSettings, canTrade };
