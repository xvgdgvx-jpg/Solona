const { getUser, saveUser } = require('./storage');

const defaults = {
  autoSniperEnabled: false,
  paperTradingEnabled: true,
  autoSellEnabled: true,
  paperCapitalSol: 1,
  paperAvailableSol: 1,
  paperAllocationPct: 10,
  paperSizingMode: 'isolated',
  paperPanelChatId: null,
  paperPanelMessageId: null,
  paperEvents: [],
  paperPnlSol: 0,
  paperTakeProfitPct: 50,
  paperStopLossPct: 15,
  paperTakeProfitFirstPct: 30,
  paperTakeProfitFinalPct: 60,
  liveTrading: false,
  tradeSizeSol: 0.1,
  maxTradesPerDay: 0,
  tradesToday: 0,
  tradeDay: new Date().toISOString().slice(0, 10),
  minLiquiditySol: 0,
  maxMarketCapUsd: 0,
  requireRenouncedAuthorities: false,
  requireBuyVolumeDominance: false,
  minCurveProgress: 10,
  maxCurveProgress: 35,
  minVolumeUsd: 2500,
  minUniqueBuyers: 15,
  maxCreatorHoldingsPct: 5,
  maxTopHoldersPct: 25,
  requireSocialLinks: true,
  watchlistMinutes: 5,
  lastMint: null,
  lastFilterResult: 'لم يبدأ الفحص بعد',
  rejectStats: {},
  checkedCount: 0,
  lastCheckAt: null
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
