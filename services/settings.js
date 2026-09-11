const { getUser, saveUser } = require('./storage');

const defaults = {
  // ── حالة التشغيل ──
  autoSniperEnabled: true,
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

  // ── التداول الحقيقي ──
  liveTrading: false,
  tradeSizeSol: 0.1,
  maxTradesPerDay: 0,
  tradesToday: 0,
  tradeDay: new Date().toISOString().slice(0, 10),

  // ── الفلاتر ──
  minCurveProgress: 2,
  maxCurveProgress: 35,
  minVolumeUsd: 500,
  allowZeroVolume: false,
  allowZeroVolumeMinLiq: 30,
  minUniqueBuyers: 5,
  maxCreatorHoldingsPct: 0,
  maxTopHoldersPct: 0,
  requireSocialLinks: false,
  requireRenouncedAuthorities: false,
  requireBuyVolumeDominance: true,
  minLiquiditySol: 25,
  maxMarketCapUsd: 30000,
  minMarketCapUsd: 3000,
  minTokenAgeSec: 60,
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

function saveSettings(adminId, settings, key) {
  const user = getUser(adminId, key);
  saveUser(adminId, { ...user, settings: { ...defaults, ...settings } }, key);
}

function canTrade(settings) {
  return settings.maxTradesPerDay <= 0 || settings.tradesToday < settings.maxTradesPerDay;
}

module.exports = { defaults, getSettings, saveSettings, canTrade };
