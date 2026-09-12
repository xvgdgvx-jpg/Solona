const { getUser, saveUser } = require('./storage');

const defaults = {
  // ── حالة التشغيل ──
  autoSniperEnabled: false,
  paperTradingEnabled: true,
  autoSellEnabled: true,

  // ── رأس المال ──
  paperCapitalSol: 3,
  paperAvailableSol: 3,
  paperAllocationPct: 5,
  paperSizingMode: 'isolated',
  paperPanelChatId: null,
  paperPanelMessageId: null,
  paperEvents: [],
  paperPnlSol: 0,
  paperTakeProfitPct: 50,
  paperStopLossPct: 15,
  paperTakeProfitFirstPct: 30,
  paperTakeProfitFinalPct: 60,
  capitalProtectionEnabled: true,
  capitalProtectionSellPct: 50,
  capitalProtectionTriggerPct: 10,
  maxHoldTimeMin: 0,
  rugProtectionEnabled: true,

  // ── حدود الحماية ──
  dailyLossLimitSol: 0,
  dailyLossStartSol: null,
  dailyLossResetDay: null,
  maxConsecutiveFailures: 5,
  consecutiveFailures: 0,
  killSwitch: false,

  // ── التداول الحقيقي ──
  liveTrading: false,
  tradeSizeSol: 0.1,
  maxTradesPerDay: 0,
  tradesToday: 0,
  tradeDay: new Date().toISOString().slice(0, 10),

  // ── الفلاتر ──
  minCurveProgress: 1,
  maxCurveProgress: 35,
  minVolumeUsd: 0,
  allowZeroVolume: true,
  allowZeroVolumeMinLiq: 30,
  minUniqueBuyers: 0,
  maxCreatorHoldingsPct: 10,
  maxTopHoldersPct: 20,
  requireSocialLinks: false,
  requireRenouncedAuthorities: false,
  requireBuyVolumeDominance: false,
  minLiquiditySol: 30,
  maxMarketCapUsd: 30000,
  minMarketCapUsd: 0,
  minTokenAgeSec: 30,
  maxTokenAgeSec: 600,
  watchlistMinutes: 10,

  // ── الحالة ──
  lastMint: null,
  lastFilterResult: 'لم يبدأ الفحص بعد',
  rejectStats: {},
  checkedCount: 0,
  lastCheckAt: null,
};

function getSettings(adminId, key) {
  const user = getUser(adminId, key);
  const settings = { ...defaults, ...(user.settings || {}) };
  const today = new Date().toISOString().slice(0, 10);
  if (settings.tradeDay !== today) { settings.tradeDay = today; settings.tradesToday = 0; }
  return settings;
}

let _lock = Promise.resolve();
function withLock(fn) {
  const previous = _lock;
  let release;
  _lock = new Promise((resolve) => { release = resolve; });
  return previous.then(fn).finally(() => release());
}

function saveSettings(adminId, settings, key) {
  return withLock(() => {
    const user = getUser(adminId, key);
    const latestSettings = { ...defaults, ...(user.settings || {}) };
    saveUser(adminId, { ...user, settings: { ...latestSettings, ...settings } }, key);
  });
}

function canTrade(settings) {
  return settings.maxTradesPerDay <= 0 || settings.tradesToday < settings.maxTradesPerDay;
}

module.exports = { defaults, getSettings, saveSettings, canTrade };
