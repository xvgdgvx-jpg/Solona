const { getUser, saveUser } = require('./storage');

const defaults = {
  autoWatcherEnabled: false, paperTradingEnabled: true, autoSellEnabled: true, killSwitch: false,
  paperCapitalSol: 3, paperAvailableSol: 3, paperAllocationPct: 5,
  paperTakeProfitFirstPct: 30, paperStopLossPct: 15,
  paperEvents: [], paperPnlSol: 0, liveTrading: false,
  maxTradesPerDay: 0, tradesToday: 0, tradeDay: new Date().toISOString().slice(0, 10),
  // لا نستبعد أي DEX افتراضيًا؛ التقييد يتم اختياريًا من واجهة الإعدادات.
  dex: { minAgeSec: 30, maxAgeSec: 0, minVolumeUsd: 0, minLiquidityUsd: 500, minBuys24h: 0, minBuySellRatio: 0, minMarketCapUsd: 0, maxMarketCapUsd: 0, allowedDexes: 'all', antiDuplicate: true },
  onchain: { enabled: true, checkAuthorities: true, checkTop10: true, checkSupply: false, checkDecimals: false, checkUpdateAuthority: false, maxTop10Pct: 50, maxSupply: 0, maxDecimals: 9 },
  goplus: { enabled: false, maxBuyTax: 10, maxSellTax: 10, rejectHoneypot: true, checkMintAuthority: true, checkFreezeAuthority: true },
  tracker: { enabled: false, maxRiskScore: 3, rejectRugged: true, maxDeveloperHoldingPct: 15, maxSnipersPct: 15, maxInsidersPct: 15, maxBundlersPct: 30, maxTop10Pct: 25, minHolders: 100, maxDeveloperTokens: 0 },
  risk: { stopLossPct: 10, capitalProtection: '50@-10', timedSellMin: 0, emergencyBreaker: true, dailyLossPct: 0 },
  lastMint: null, lastFilterResult: 'لم يبدأ الفحص بعد', rejectStats: {}, checkedCount: 0, lastCheckAt: null,
  tradeAttempts: 0, tradeSuccesses: 0, tradeFailures: 0, lastTradeError: null,
};

function merge(base, value) {
  const result = { ...base, ...(value || {}) };
  for (const section of ['dex', 'onchain', 'goplus', 'tracker', 'risk']) result[section] = { ...base[section], ...(value?.[section] || {}) };
  return result;
}
function getSettings(adminId, key) {
  const user = getUser(adminId, key);
  const settings = merge(defaults, user.settings);
  // Remove legacy fields that no longer control any behavior.
  delete settings.autoSellStrategy;
  delete settings.tradeSizeSol;
  const today = new Date().toISOString().slice(0, 10);
  if (settings.tradeDay !== today) { settings.tradeDay = today; settings.tradesToday = 0; }
  // Legacy versions used the auto-buy button to flip paperTradingEnabled, which could leave an unsafe ambiguous state.
  if (settings.paperTradingEnabled === false && settings.liveTrading !== true) settings.paperTradingEnabled = true;
  const numericDefaults = { 'goplus.maxBuyTax': 10, 'goplus.maxSellTax': 10, 'tracker.maxRiskScore': 3, 'tracker.maxDeveloperHoldingPct': 15, 'tracker.maxSnipersPct': 15, 'tracker.maxInsidersPct': 15, 'tracker.maxBundlersPct': 30, 'tracker.maxTop10Pct': 25, 'tracker.minHolders': 100, 'tracker.maxDeveloperTokens': 0, 'risk.stopLossPct': 10, 'risk.timedSellMin': 0, 'risk.dailyLossPct': 0 }; for (const [path, fallback] of Object.entries(numericDefaults)) { const [section, field] = path.split('.'); if (typeof settings[section][field] === 'boolean' || !Number.isFinite(Number(settings[section][field]))) settings[section][field] = fallback; }
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
