const { Bot, InlineKeyboard, webhookCallback } = require('grammy');
const config = require('../config');
const { getQuote, getTokenAmount, getTokenBalance, executeSwap, getPortfolio, getSolBalance, sendSol, SOL_MINT, keypairFromSecret } = require('../services/solana');
const { getSettings, saveSettings, canTrade } = require('../services/settings');
const { PumpFunWatcher } = require('../services/pumpfun');
const { openPosition, refreshPositions, refreshPositionsCached, closePosition, getPositions, cleanupStaleClosing } = require('../services/paper');
const { getUser, saveUser, resetSettings } = require('../services/storage');
const { startHealthServer, app } = require('../health-server');

startHealthServer();
process.on('uncaughtException', (error) => console.error('[uncaughtException]', error.stack || error.message));
process.on('unhandledRejection', (error) => console.error('[unhandledRejection]', error?.stack || error));
setInterval(() => {
  global.LAST_ACTIVITY = new Date().toISOString();
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  console.log(`[heartbeat] Uptime: ${Math.floor(uptime)}s | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | ${global.LAST_ACTIVITY}`);
}, 60 * 1000);

const bot = new Bot(config.token);
let botStarted = false;
const originalStart = bot.start.bind(bot);
const IS_PRODUCTION = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';
const webhookPath = `/webhook/${config.token}`;
let webhookSetupPromise = null;
let webhookMounted = false;
const configureWebhook = async () => {
  if (webhookSetupPromise) return webhookSetupPromise;
  webhookSetupPromise = (async () => {
    if (!process.env.RENDER_EXTERNAL_URL) throw new Error('RENDER_EXTERNAL_URL is required for Telegram webhook mode');
    if (!webhookMounted) {
      app.use(webhookPath, webhookCallback(bot, 'express'));
      webhookMounted = true;
    }
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}${webhookPath}`;
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log('[telegram] ✅ Webhook set (path hidden)');
  })().catch((error) => {
    webhookSetupPromise = null;
    throw error;
  });
  return webhookSetupPromise;
};
bot.start = (...args) => {
  if (botStarted) {
    console.warn('[bot] start() called twice — ignoring');
    return Promise.resolve();
  }
  botStarted = true;
  const result = IS_PRODUCTION ? configureWebhook() : originalStart({ drop_pending_updates: true, ...args[0] });
  if (result?.catch) result.catch(() => { botStarted = false; });
  return result;
};
Object.defineProperty(bot, 'botStarted', { enumerable: true, get: () => botStarted });
const menu = () => new InlineKeyboard().text('المحفظة', 'wallet').text('المحفظة الاستثمارية', 'portfolio').row().text('اقتناص Pump.fun', 'snipe').text('الإعدادات', 'settings');
const walletKeyboard = (address) => new InlineKeyboard().text('🔄 تحديث الرصيد', 'wallet:refresh').text('📥 إيداع SOL', 'wallet:deposit').row().text('📤 سحب SOL', 'wallet:withdraw').row().copyText('نسخ عنوان المحفظة', address).row().text('رجوع', 'public:back');
const publicMenu = () => new InlineKeyboard().text('حالة المراقب', 'public:status').row().text('شرح البوت', 'public:help');
const controlMenu = (enabled, paperEnabled) => new InlineKeyboard().text('تشغيل المراقب', 'watcher:on').text('إيقاف المراقب', 'watcher:off').row().text(paperEnabled ? 'إيقاف شراء/بيع تجريبي' : 'تشغيل شراء/بيع تجريبي', paperEnabled ? 'paper:off' : 'paper:on').row().text('تحديث الحالة', 'watcher:status');
const tradeTokens = new Map();
const tradeMenu = (mint) => { const token = `t${(++paperTokenCounter).toString(36)}`; tradeTokens.set(token, mint); if (tradeTokens.size > 1000) tradeTokens.delete(tradeTokens.keys().next().value); return new InlineKeyboard().text('شراء 0.1 SOL', `b:${token}:0.1`).text('شراء 0.5 SOL', `b:${token}:0.5`).row().text('بيع 50٪', `s:${token}:0.5`).text('بيع 100٪', `s:${token}:1`); };
const paperTokens = new Map();
const manualSellTokens = new Map();
let paperTokenCounter = 0;
const paperMenu = (id, mint = null) => { const token = (paperTokenCounter++).toString(36); paperTokens.set(token, id); if (paperTokens.size > 1000) paperTokens.delete(paperTokens.keys().next().value); const keyboard = new InlineKeyboard(); if (mint) keyboard.copyText('نسخ عنوان العقد', mint).row(); return keyboard.text('تحديث السعر وPnL', `p:${token}`).row().text('بيع محاكاة 50٪', `ps:${token}:0.5`).text('بيع محاكاة 100٪', `ps:${token}:1`); };
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;
const shortAddress = (value) => value ? `${String(value).slice(0, 6)}…${String(value).slice(-5)}` : 'غير متاح';
const copyAddressKeyboard = (label, value) => new InlineKeyboard().copyText(label, value);
const settingsForAdmin = () => getSettings(config.adminId, config.encryptionKey);
const effectiveLiveTrading = (settings) => Boolean(config.liveTrading && settings.liveTrading);
const panelKeyboard = (s) => new InlineKeyboard()
  .text(s.autoSniperEnabled ? '⏹ إيقاف' : '▶️ تشغيل', `panel:${s.autoSniperEnabled ? 'stop' : 'start'}`)
  .text('🔄 تحديث', 'panel:refresh').row()
  .text(s.paperTradingEnabled ? '🚫 إيقاف الشراء' : '✅ تشغيل الشراء', 'panel:buyoff')
  .text(s.autoSellEnabled ? '🛑 إيقاف البيع' : '💰 تشغيل البيع', `panel:${s.autoSellEnabled ? 'selloff' : 'sellon'}`).row()
  .text(s.killSwitch ? '▶️ إلغاء القاطع' : '🛑 قاطع الطوارئ', `panel:${s.killSwitch ? 'killoff' : 'killon'}`).row()
  .text('⚙️ الإعدادات', 'panel:settings').text('📋 التفاصيل', 'panel:details').row()
  .text('💼 المحفظة', 'wallet').text('📊 الرصيد والأصول', 'portfolio').row()
  .text('🔄 إعادة ضبط الرصيد', 'balance:confirm');
const settingsKeyboard = () => new InlineKeyboard().text('حجم الصفقة', 'cfg:allocation').row().text('عدد الصفقات اليومية', 'cfg:daily').row().text('هدف الربح والبيع', 'cfg:profit').row().text('نمط حجم الصفقة', 'cfg:sizing').row().text('⚙️ تعديل الفلاتر', 'filters').row().text('♻️ الإعدادات الافتراضية', 'settings:reset:confirm').row().text('رجوع للوحة', 'panel:back');
const pendingFilters = new Map();
const filterLabels = { curve: '📉 نسبة المنحنى', ageMin: '⏱️ عمر العملة الأدنى', ageMax: '📅 عمر العملة الأقصى', volume: '💵 الحد الأدنى للحجم', allowZeroVolume: '📊 السماح بحجم صفر', buyers: '👥 الحد الأدنى للمشترين', dev: '👨‍💻 أقصى نسبة للمطور', top: '🐋 كبار الملاك', social: '🔗 روابط التواصل', authorities: '🔒 تأمين العقد والسيولة', liquidity: '💧 الحد الأدنى لسيولة SOL', dominance: '📊 تفوق الشراء على البيع', mcapMin: '🎯 الحد الأدنى للقيمة السوقية', marketcap: '🎯 سقف القيمة السوقية', watch: '⏱️ مدة المراقبة', sl: '🛑 وقف الخسارة', rugProtection: '🚨 حماية من الـ Rug', capitalProtection: '🛡️ حماية رأس المال', maxHoldTime: '⏰ البيع الزمني' };
const filterValue = (s, field) => ({ curve: `${s.minCurveProgress}-${s.maxCurveProgress}%`, ageMin: Number(s.minTokenAgeSec) > 0 ? `${s.minTokenAgeSec} ثانية` : 'لا يهم', ageMax: Number(s.maxTokenAgeSec) > 0 ? `${s.maxTokenAgeSec} ثانية` : 'مفتوح', mcapMin: Number(s.minMarketCapUsd) > 0 ? `$${Number(s.minMarketCapUsd).toLocaleString()}` : 'مفتوح', volume: Number(s.minVolumeUsd) > 0 ? `$${s.minVolumeUsd}` : 'لا يهم', allowZeroVolume: s.allowZeroVolume ? `مفعل — سيولة ≥ ${s.allowZeroVolumeMinLiq} SOL` : 'معطل', buyers: Number(s.minUniqueBuyers) > 0 ? `${s.minUniqueBuyers} محافظ` : 'لا يهم', dev: `${s.maxCreatorHoldingsPct}%`, top: `${s.maxTopHoldersPct}%`, social: s.requireSocialLinks ? 'إلزامية' : 'غير إلزامية', watch: `${s.watchlistMinutes} دقائق`, authorities: s.requireRenouncedAuthorities ? 'إلزامي' : 'غير إلزامي', liquidity: s.minLiquiditySol ? `${s.minLiquiditySol} SOL` : 'لا يهم', dominance: s.requireBuyVolumeDominance ? 'مفعل' : 'معطل', marketcap: s.maxMarketCapUsd ? `$${s.maxMarketCapUsd}` : 'مفتوح', sl: `-${s.paperStopLossPct}%`, rugProtection: s.rugProtectionEnabled ? 'مفعل' : 'معطل', capitalProtection: s.capitalProtectionEnabled ? `مفعل — بيع ${s.capitalProtectionSellPct}% عند -${s.capitalProtectionTriggerPct}%` : 'معطل', maxHoldTime: Number(s.maxHoldTimeMin) > 0 ? `${s.maxHoldTimeMin} دقيقة` : 'غير مفعل' }[field]);
const filterKeyboard = (s) => new InlineKeyboard().text(`${filterLabels.curve}: ${filterValue(s, 'curve')}`, 'filter:curve').row().text(`${filterLabels.ageMin}: ${filterValue(s, 'ageMin')}`, 'filter:ageMin').row().text(`${filterLabels.ageMax}: ${filterValue(s, 'ageMax')}`, 'filter:ageMax').row().text(`${filterLabels.volume}: ${filterValue(s, 'volume')}`, 'filter:volume').row().text(`${filterLabels.allowZeroVolume}: ${filterValue(s, 'allowZeroVolume')}`, 'filter:allowZeroVolume').row().text(`${filterLabels.buyers}: ${filterValue(s, 'buyers')}`, 'filter:buyers').row().text(`${filterLabels.dev}: ${filterValue(s, 'dev')}`, 'filter:dev').row().text(`${filterLabels.top}: ${filterValue(s, 'top')}`, 'filter:top').row().text(`${filterLabels.social}: ${filterValue(s, 'social')}`, 'filter:social').row().text(`${filterLabels.authorities}: ${filterValue(s, 'authorities')}`, 'filter:authorities').row().text(`${filterLabels.liquidity}: ${filterValue(s, 'liquidity')}`, 'filter:liquidity').row().text(`${filterLabels.dominance}: ${filterValue(s, 'dominance')}`, 'filter:dominance').row().text(`${filterLabels.mcapMin}: ${filterValue(s, 'mcapMin')}`, 'filter:mcapMin').row().text(`${filterLabels.marketcap}: ${filterValue(s, 'marketcap')}`, 'filter:marketcap').row().text(`${filterLabels.watch}: ${filterValue(s, 'watch')}`, 'filter:watch').row().text(`${filterLabels.sl}: ${filterValue(s, 'sl')}`, 'filter:sl').row().text(`${filterLabels.rugProtection}: ${filterValue(s, 'rugProtection')}`, 'filter:rugProtection').row().text(`${filterLabels.capitalProtection}: ${filterValue(s, 'capitalProtection')}`, 'filter:capitalProtection').row().text(`${filterLabels.maxHoldTime}: ${filterValue(s, 'maxHoldTime')}`, 'filter:maxHoldTime').row().text('🔙 رجوع', 'panel:settings');
const optionKeyboard = (field, current) => { const options = { curve: [['0-100','0% - 100% (بلا قيد)'],['0-60','0% - 60%'],['0-35','0% - 35%'],['1-60','1% - 60%'],['5-25','5% - 25%'],['10-35','10% - 35%'],['15-50','15% - 50%'],['20-60','20% - 60%']], ageMin: [['0','لا يهم'],['15','15 ثانية'],['30','30 ثانية'],['45','45 ثانية'],['60','60 ثانية'],['90','90 ثانية']], ageMax: [['0','مفتوح'],['120','دقيقتان'],['300','5 دقائق'],['600','10 دقائق'],['1800','30 دقيقة']], mcapMin: [['0','مفتوح'],['1000','1,000$'],['5000','5,000$'],['10000','10,000$'],['25000','25,000$']], volume: [['0','لا يهم (تعطيل)'],['100','100$'],['250','250$'],['500','500$'],['1000','1,000$'],['1500','1,500$'],['2500','2,500$'],['5000','5,000$']], buyers: [['0','لا يهم (تعطيل)'],['1','مشترٍ واحد'],['2','2 مشترين'],['3','3 مشترين'],['5','5 محافظ'],['10','10 محافظ'],['15','15 محفظة'],['25','25 محفظة']], dev: [['5','أقصى حد 5%'],['10','أقصى حد 10%'],['20','أقصى حد 20%'],['25','أقصى حد 25%']], top: [['15','15%'],['20','20%'],['25','25%'],['30','30%']], social: [['on','إلزامي'],['off','غير إلزامي']], watch: [['1','1 دقيقة'],['3','3 دقائق'],['5','5 دقائق'],['10','10 دقائق']], sl: [['5','-5%'],['10','-10%'],['15','-15%'],['20','-20%'],['25','-25%'],['30','-30%']], rugProtection: [['on','مفعل'],['off','معطل']], capitalProtection: [['off','معطل'],['10-25','بيع 10% عند -25%'],['20-20','بيع 20% عند -20%'],['30-15','بيع 30% عند -15%'],['50-15','بيع 50% عند -15%'],['50-10','بيع 50% عند -10%'],['100-20','بيع كامل عند -20%'],['100-15','بيع كامل عند -15%']], maxHoldTime: [['0','غير مفعل'],['1','دقيقة واحدة'],['5','5 دقائق'],['10','10 دقائق'],['15','15 دقيقة'],['30','30 دقيقة'],['60','ساعة واحدة']], authorities: [['on','إلزامي (Renounced)'],['off','غير إلزامي']], liquidity: [['0.5','0.5 SOL'],['1','1.0 SOL'],['2.5','2.5 SOL'],['5','5.0 SOL'],['10','10 SOL'],['15','15 SOL'],['30','30 SOL'],['0','لا يهم']], dominance: [['on','مفعل (الشراء أكبر من البيع)'],['off','معطل (قبول أي نسبة)']], allowZeroVolume: [['off','معطل'],['10','مفعل — سيولة ≥ 10 SOL'],['20','مفعل — سيولة ≥ 20 SOL'],['30','مفعل — سيولة ≥ 30 SOL'],['50','مفعل — سيولة ≥ 50 SOL']], marketcap: [['10000','10,000$'],['20000','20,000$'],['25000','25,000$'],['30000','30,000$'],['60000','60,000$'],['100000','100,000$'],['0','مفتوح']] }[field]; const k = new InlineKeyboard(); options.forEach(([value, label]) => k.text(`${String(current) === value ? '✔ ' : ''}${label}`, `fopt:${field}:${value}`).row()); return k.text('تأكيد الاختيار ✅', 'fconfirm').text('إلغاء ورجوع 🔙', 'fcancel'); };
const curveMinKeyboard = (current) => { const k = new InlineKeyboard(); [['0','0٪'],['1','1٪'],['5','5٪'],['10','10٪'],['15','15٪'],['20','20٪']].forEach(([v, label]) => k.text(`${current === v ? '✔ ' : ''}${label}`, `fmin:${v}`).row()); return k.text('رجوع', 'fcancel'); };
const curveMaxKeyboard = (min) => { const k = new InlineKeyboard(); [['35','35٪'],['60','60٪'],['100','100٪']].filter(([v]) => Number(v) > Number(min)).forEach(([v, label]) => k.text(`${label}`, `fmax:${min}:${v}`).row()); return k.text('رجوع', 'fcancel'); };
const filterText = (s) => `⚙️ تعديل فلاتر القنص\n\nاختر الفلتر المطلوب. لا يتم حفظ الاختيار إلا بعد الضغط على تأكيد.\n\n${Object.keys(filterLabels).map((field) => `${filterLabels[field]}: ${filterValue(s, field)}`).join('\n')}`;
const allocationKeyboard = () => new InlineKeyboard()
  .text('1٪', 'set:allocation:1').text('2٪', 'set:allocation:2').text('3٪', 'set:allocation:3').row()
  .text('5٪', 'set:allocation:5').text('7٪', 'set:allocation:7').text('10٪', 'set:allocation:10').row()
  .text('15٪', 'set:allocation:15').text('20٪', 'set:allocation:20').text('25٪', 'set:allocation:25').row()
  .text('50٪', 'set:allocation:50').text('75٪', 'set:allocation:75').text('100٪', 'set:allocation:100').row()
  .text('رجوع', 'panel:settings');
const dailyKeyboard = () => new InlineKeyboard().text('مفتوح', 'set:daily:0').text('5', 'set:daily:5').text('10', 'set:daily:10').text('50', 'set:daily:50').row().text('رجوع', 'cfg:allocation');
const profitKeyboard = () => new InlineKeyboard().text('5٪', 'set:profit:5').text('10٪', 'set:profit:10').text('25٪', 'set:profit:25').row().text('50٪', 'set:profit:50').text('75٪', 'set:profit:75').text('100٪', 'set:profit:100').row().text('رجوع', 'cfg:daily');
const sizingKeyboard = () => new InlineKeyboard().text('صفقة معزولة', 'set:sizing:isolated').row().text('شراء موسّع', 'set:sizing:expanded').row().text('رجوع', 'cfg:profit');
function panelText(s) {
  const events = (s.paperEvents || []).slice(-3).reverse();
  const openPositions = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open');
  const reserved = openPositions.reduce((sum, p) => sum + Number(p.investedSol || 0), 0);
  const available = Number(s.paperAvailableSol || 0);
  const total = Number(s.paperCapitalSol || 0);
  const pnl = Number(s.paperPnlSol || 0);
  const pnlSign = pnl > 0 ? '+' : '';
  const usedPct = total > 0 ? Math.min(100, Math.round((reserved / total) * 100)) : 0;
  const barLen = 8;
  const barFilled = Math.round((usedPct / 100) * barLen);
  const bar = '█'.repeat(barFilled) + '░'.repeat(barLen - barFilled);
  const eventLines = events.length ? events.map((e) => {
    const isBuy = e.type === 'شراء';
    const icon = isBuy ? '🟢' : '🔴';
    const shortName = (e.name || e.mint || '—').slice(0, 22);
    const m = e.metadata || {};
    const extra = isBuy ? `$${Number(m.amountSol || 0).toFixed(2)}` : `${Number(m.pnlPct || 0) >= 0 ? '+' : ''}${Number(m.pnlPct || 0).toFixed(0)}%`;
    return `${icon} ${shortName} → ${extra}`;
  }).join('\n') : 'لا توجد عمليات بعد';
  const rejectLines = Object.entries(s.rejectStats || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => {
      const shortReason = reason.length > 35 ? reason.slice(0, 35) + '…' : reason;
      return `  • ${count}× ${shortReason}`;
    })
    .join('\n') || '  لا يوجد رفض بعد';
  return [
    '📊 لوحة القنص', '',
    `⚡ الحالة: ${s.autoSniperEnabled ? 'يعمل' : 'متوقف'} | ${s.paperTradingEnabled ? 'شراء ✓' : 'شراء ✗'} | ${s.autoSellEnabled ? 'بيع ✓' : 'بيع ✗'}`, '',
    '💰 رأس المال', `├ الإجمالي: ${total.toFixed(2)} SOL`, `├ المتاح: ${available.toFixed(2)} SOL`, `├ المحجوز: ${reserved.toFixed(2)} SOL`, `├ حجم الصفقة: ${Number(s.paperAllocationPct || 0)}% = ${paperTradeAmount(s).toFixed(4)} SOL`, `├ [${bar}] ${usedPct}%`, `└ صافي الأرباح: ${pnlSign}${pnl.toFixed(4)} SOL`, '',
    `📈 المراكز المفتوحة: ${openPositions.length}`, '',
    '🎯 الفلاتر النشطة', `├ منحنى: ${s.minCurveProgress}-${s.maxCurveProgress}%`, `├ حجم: ${s.minVolumeUsd > 0 ? '$' + s.minVolumeUsd : 'لا يهم'} | مشترون: ${s.minUniqueBuyers > 0 ? s.minUniqueBuyers : 'لا يهم'}`, `├ 📊 السماح بحجم صفر: ${s.allowZeroVolume ? `مفعل (≥${s.allowZeroVolumeMinLiq} SOL)` : 'معطل'}`, `├ مطور: ≤${s.maxCreatorHoldingsPct}% | كبار: ≤${s.maxTopHoldersPct}%`, `├ سيولة: ${s.minLiquiditySol || 'مفتوح'} SOL`, `├ عمر: ${s.minTokenAgeSec || 0}-${s.maxTokenAgeSec || 0}ث`, `└ عقد: ${s.requireRenouncedAuthorities ? 'إلزامي' : 'حر'}`, '',
    '🛡️ إدارة المخاطر', `├ الهدف: +${s.paperTakeProfitFirstPct}% / +${s.paperTakeProfitFinalPct}%`, `├ وقف الخسارة: -${s.paperStopLossPct}%`, `├ حماية رأس المال: ${s.capitalProtectionEnabled ? `${s.capitalProtectionSellPct}%@-${s.capitalProtectionTriggerPct}%` : 'معطل'}`, `└ بيع زمني: ${s.maxHoldTimeMin > 0 ? `${s.maxHoldTimeMin}د` : 'معطل'}`, '',
    `📡 الفحص: ${s.checkedCount || 0} عملة | ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleTimeString('ar-IQ').slice(0, 5) : '—'}`, '',
    '❌ أكثر أسباب الرفض:', rejectLines, '',
    '📋 آخر 3 عمليات:', eventLines, '', `🛡️ التداول الحقيقي: ${effectiveLiveTrading(s) ? '⚠️ مفعّل' : '✅ متوقف'}`,
  ].join('\n');
}
function detailsText(s) {
  const events = (s.paperEvents || []).slice().reverse().slice(0, 8);
  const openPositions = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open');
  const openText = openPositions.length ? `🟡 العملات المفتوحة الآن (${openPositions.length})\n${openPositions.map((p) => `• ${p.name || p.symbol || 'عملة'} — ${shortAddress(p.mint)} — ${Number(p.investedSol || 0).toFixed(4)} SOL`).join('\n')}\n\n` : '✅ لا توجد عملات مفتوحة حالياً.\n\n';
  if (!events.length) return `${openText}📭 لا توجد عمليات مسجلة بعد.`;
  const lines = events.map((e, i) => {
    const isBuy = e.type === 'شراء';
    const m = e.metadata || {};
    const icon = isBuy ? '🟢' : '🔴';
    if (isBuy) return [
      `${icon} #${i + 1} شراء — ${e.name || '—'}`, `🔗 ${shortAddress(e.mint)}`,
      `💵 المبلغ: ${Number(m.amountSol || 0).toFixed(4)} SOL`, `💧 السيولة: ${Number(m.liquiditySol || 0).toFixed(2)} SOL`,
      `🎯 MC: $${Number(m.marketCapUsd || 0).toFixed(0)}`, `📊 الحجم: ${m.volumeUsd == null ? 'غير معروف ❌' : '$' + m.volumeUsd.toFixed(0)} | المشترون: ${m.uniqueBuyers == null ? 'غير معروف ❌' : m.uniqueBuyers}`,
      `📉 المنحنى: ${Number(m.bondingCurveProgress || 0).toFixed(1)}%`, `⏱️ العمر: ${m.ageSeconds || 0}ث`,
      `🔒 العقد: ${m.mintAuthority || '—'} | ${m.freezeAuthority || '—'}`,
      `✅ الفلاتر: ${m.filtersAtBuy?.curveRange || '—'} | ${m.filtersAtBuy?.minVolume || '—'} | ${m.filtersAtBuy?.minBuyers || 0} مشتري`,
    ].join('\n');
    const mins = Math.floor(Number(m.holdSeconds || 0) / 60); const secs = Number(m.holdSeconds || 0) % 60;
    const pnl = Number(m.pnlPct || 0); const sign = pnl >= 0 ? '+' : '';
    return [
      `${icon} #${i + 1} بيع — ${e.name || '—'}`, `🔗 ${shortAddress(e.mint)}`, `📌 السبب: ${m.reason || e.detail || '—'}`,
      `📊 النوع: ${m.triggerType || 'Manual'}`, `💰 المستثمر: ${Number(m.investedSol || 0).toFixed(4)} SOL`, `💵 العائد: ${Number(m.currentSol || 0).toFixed(4)} SOL`,
      `📈 PnL: ${sign}${Number(m.pnlSol || 0).toFixed(4)} SOL (${sign}${pnl.toFixed(1)}%)`, `⏱️ المدة: ${mins}د ${secs}ث`,
      `⚙️ القيم: SL -${s.paperStopLossPct}% | TP +${s.paperTakeProfitFirstPct}%/+${s.paperTakeProfitFinalPct}%`,
    ].join('\n');
  });
  const result = `${openText}📊 سجل العمليات (آخر ${events.length})\n\n${lines.join('\n\n')}`;
  return result.length > 3900 ? result.slice(0, 3890) + '\n…' : result;
}
function detailsKeyboard(s) { const keyboard = new InlineKeyboard(); const openPositions = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open'); openPositions.forEach((p) => { const token = `m${(++paperTokenCounter).toString(36)}`; manualSellTokens.set(token, p.id); keyboard.text(`💰 بيع ${p.symbol || p.name || shortAddress(p.mint)}`, `manualsell:${token}:ask`).row(); }); if (openPositions.length > 1) keyboard.text('💰 بيع جميع العملات المفتوحة', 'manualsell:all:ask').row(); (s.paperEvents || []).slice().reverse().forEach((e, i) => keyboard.copyText(`نسخ عقد ${i + 1}`, e.mint).row()); return keyboard.text('🧹 تنظيف بعد الإيقاف', 'panel:cleanup').row().text('رجوع', 'panel:back'); }
const paperTradeAmount = (s) => (Number(s.paperCapitalSol || 1) + (s.paperSizingMode === 'expanded' ? Number(s.paperPnlSol || 0) : 0)) * Number(s.paperAllocationPct || 10) / 100;
const panelEditQueue = new Map();
function retryAfterMs(error) { const seconds = Number(error?.parameters?.retry_after || error?.response?.parameters?.retry_after || 1); return Math.min(Math.max(seconds, 1) * 1000, 10000); }
async function flushPanelEdit(key) { const entry = panelEditQueue.get(key); if (!entry || entry.running || !entry.pending) return; entry.running = true; const pending = entry.pending; entry.pending = null; try { await bot.api.editMessageText(pending.chatId, pending.messageId, pending.text, { reply_markup: pending.keyboard }); } catch (error) { if (error?.error_code === 429 || error?.response?.status === 429) { entry.pending = pending; await new Promise((resolve) => setTimeout(resolve, retryAfterMs(error))); } else if (!String(error.message || '').includes('message is not modified')) console.error(`Panel update error: ${error.message}`); } finally { entry.running = false; if (entry.pending) { clearTimeout(entry.timer); entry.timer = setTimeout(() => flushPanelEdit(key), 3000); } } }
function updatePanel(s = settingsForAdmin()) { const chatId = String(s.paperPanelChatId || config.adminId); const messageId = s.paperPanelMessageId; if (!messageId) return Promise.resolve(); const key = `${chatId}:${messageId}`; const entry = panelEditQueue.get(key) || { pending: null, running: false, timer: null }; entry.pending = { chatId, messageId, text: panelText(s), keyboard: panelKeyboard(s) }; panelEditQueue.set(key, entry); clearTimeout(entry.timer); entry.timer = setTimeout(() => flushPanelEdit(key), 3000); return Promise.resolve(); }
async function recordPaperSale(value, sold, reason, triggerType = 'Manual') {
  const currentSettings = settingsForAdmin();
  const s = currentSettings;
  if (value.mode !== 'live') {
    s.paperAvailableSol = Number(s.paperAvailableSol || 0) + Number(sold.currentSol || 0);
    s.paperPnlSol = Number(s.paperPnlSol || 0) + Number(sold.pnlSol || 0);
  }
  let autoType = triggerType;
  if (reason.includes('وقف خسارة')) autoType = 'وقف خسارة'; else if (reason.includes('الربح النهائي')) autoType = 'هدف ثاني'; else if (reason.includes('الربح الأول')) autoType = 'هدف أول'; else if (reason.includes('Trailing')) autoType = 'تراجع'; else if (reason.includes('حماية رأس المال')) autoType = 'حماية'; else if (reason.includes('بيع زمني')) autoType = 'زمني'; else if (reason.includes('يدوي')) autoType = 'يدوي';
  const holdSec = value.openedAt ? Math.round((Date.now() - new Date(value.openedAt).getTime()) / 1000) : 0;
  s.paperEvents = [...(s.paperEvents || []), { type: 'بيع', name: `${value.name} (${value.symbol})`, mint: value.mint, detail: `${reason} | ${Number(sold.currentSol).toFixed(4)} SOL (${Number(sold.pnlPct).toFixed(1)}%)`, metadata: { reason, triggerType: autoType, investedSol: Number(value.investedSol || 0), currentSol: Number(sold.currentSol || 0), pnlSol: Number(sold.pnlSol || 0), pnlPct: Number(sold.pnlPct || 0), fraction: Number(sold.fraction || 1), holdSeconds: holdSec, filtersAtSell: { stopLoss: `-${s.paperStopLossPct}%`, tp1: `+${s.paperTakeProfitFirstPct}%`, tp2: `+${s.paperTakeProfitFinalPct}%`, capitalProtection: s.capitalProtectionEnabled ? `${s.capitalProtectionSellPct}%@-${s.capitalProtectionTriggerPct}%` : 'معطل', maxHoldTime: s.maxHoldTimeMin > 0 ? `${s.maxHoldTimeMin}د` : 'معطل' } }, timestamp: Date.now() }].slice(-20);
  saveSettings(config.adminId, s, config.encryptionKey);
  await updatePanel(s);
}
async function dashboard(ctx) { if (!isAdmin(ctx)) return ctx.reply('أهلاً بك في بوت Solana. يمكنك متابعة حالة المراقب وقراءة التعليمات من الأزرار أدناه.', { reply_markup: publicMenu() }); const s = settingsForAdmin(); if (s.paperPanelMessageId) { await updatePanel(s, ctx); return; } const sent = await ctx.reply(panelText(s), { reply_markup: panelKeyboard(s) }); s.paperPanelChatId = String(ctx.chat.id); s.paperPanelMessageId = sent.message_id; saveSettings(config.adminId, s, config.encryptionKey); }
bot.command(['start', 'menu'], dashboard);
bot.command('panel', dashboard);
bot.command('clean', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.'); const chatId = ctx.chat.id; const current = ctx.msg.message_id; for (let id = current; id > Math.max(0, current - 100); id -= 1) { try { await ctx.api.deleteMessage(chatId, id); } catch (_) {} } });
bot.command('status', async (ctx) => { const s = settingsForAdmin(); const status = watcher.status(); const lastPoll = status.lastPollAt ? new Date(status.lastPollAt).toLocaleString('ar-IQ') : 'لم تبدأ بعد'; const candidate = status.lastCandidate ? status.lastCandidate.symbol : 'لا توجد عملة مطابقة بعد'; await ctx.reply(`حالة مراقب Pump.fun\n\nالتشغيل: ${status.running ? 'يعمل الآن' : 'متوقف'}\nالمراقبة: ${s.autoSniperEnabled ? 'مفعّلة' : 'متوقفة'}\nآخر فحص: ${lastPoll}\nآخر مرشح مطابق: ${candidate}\nمصدر البيانات: ${status.source}\n\nللمستخدمين: هذا العرض للقراءة فقط.`); });
bot.command('wallet', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('المحفظة الشخصية متاحة للمشرف فقط.'); try { const address = keypairFromSecret(userSecret()).publicKey.toBase58(); const sol = await getSolBalance({ rpcUrl: config.rpcUrl, owner: address }); await ctx.reply(`💼 محفظتك الشخصية\n\nالعنوان:\n${address}\n\nالرصيد: ${sol.toFixed(9)} SOL\nالعمولة: 0%\nالحد الأدنى للإيداع: لا يوجد\nالحد الأدنى للسحب: لا يوجد\n\nالإيداع: أرسل SOL إلى العنوان أعلاه.\nالسحب: استخدم زر سحب SOL أو /withdraw <العنوان> <المبلغ>.`, { reply_markup: walletKeyboard(address) }); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة.\n${e.message}`); } });
bot.command('portfolio', async (ctx) => { try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.reply(`المحفظة الاستثمارية\nالعنوان: ${shortAddress(p.address)}\nرصيد SOL: ${p.sol.toFixed(4)}\nحسابات العملات غير الفارغة: ${p.tokens.length}\n\nاضغط زر النسخ لنسخ العنوان الكامل.`, { reply_markup: copyAddressKeyboard('نسخ عنوان المحفظة', p.address) }); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة الاستثمارية.\n${e.message}`); } });
bot.command('withdraw', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('السحب متاح للمشرف فقط.'); const [, destination, amount] = ctx.message.text.trim().split(/\s+/); if (!destination || !amount) return ctx.reply('استخدم:\n/withdraw <عنوان Solana> <المبلغ SOL>\nلا يوجد حد أدنى للسحب.'); try { const result = await sendSol({ rpcUrl: config.rpcUrl, secret: userSecret(), destination, amountSol: amount, liveTrading: effectiveLiveTrading(settingsForAdmin()), priorityFeeLamports: config.priorityFeeMaxLamports }); if (result.simulated) return ctx.reply(`معاينة سحب فقط — التداول الحقيقي مغلق.\nإلى: ${result.destination}\nالمبلغ: ${result.amountSol} SOL\nلم تُرسل معاملة.`); await ctx.reply(`تم إرسال السحب بنجاح.\nالمبلغ: ${result.amountSol} SOL\n${explorer(result.signature)}`); } catch (e) { await ctx.reply(`تعذر تنفيذ السحب.\n${e.message}`); } });
bot.command('pnl', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await sendPnl(ctx); });

function settingsText(s) { return `الإعدادات الديناميكية\nمراقبة Pump.fun: ${s.autoSniperEnabled ? 'مفعّلة' : 'متوقفة'}\nالقنص التجريبي: ${s.paperTradingEnabled ? 'مفعّل — شراء وبيع افتراضي' : 'متوقف'}\nهدف البيع التلقائي: +${s.paperTakeProfitPct}%\nالتداول الحقيقي الفعلي: ${effectiveLiveTrading(s) ? 'مفعّل' : 'معطّل — لا تُرسل معاملات'}\nالسماح من إعدادات البوت: ${s.liveTrading ? 'مفعّل' : 'معطّل'}\nحاجز البيئة LIVE_TRADING: ${config.liveTrading ? 'مفعّل' : 'معطّل'}\nحجم الصفقة: ${s.tradeSizeSol} SOL\nالحد الأقصى للصفقات اليومية: ${s.maxTradesPerDay || 'غير محدود'}\nالحد الأدنى للسيولة: ${s.minLiquiditySol || 'بدون حد'} SOL\nالحد الأقصى للقيمة السوقية: ${s.maxMarketCapUsd || 'بدون حد'} USD\nاشتراط تعطيل Mint/Freeze Authority: ${s.requireRenouncedAuthorities ? 'نعم' : 'لا'}\n\nأوامر التعديل:\n/settings live on|off\n/settings sniper on|off\n/settings paper on|off\n/settings takeprofit <٪>\n/settings size <SOL>\n/settings maxtrades <عدد أو 0>\n/settings minliq <SOL>\n/settings maxcap <USD>\n/settings authorities on|off`;
}
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.');
  const [, key, value] = ctx.message.text.trim().split(/\s+/);
  if (key === 'reset') {
    resetSettings(config.adminId, config.encryptionKey);
    const reset = settingsForAdmin();
    watcherManuallyEnabled = Boolean(reset.autoSniperEnabled && !reset.killSwitch);
    watcher.updateSettings(reset);
    if (watcherManuallyEnabled) watcher.start(); else watcher.stop();
    return ctx.reply(`✅ تمت إعادة الإعدادات الافتراضية بنجاح.

المنحنى: ${reset.minCurveProgress}-${reset.maxCurveProgress}%
العمر: ${reset.minTokenAgeSec}-${reset.maxTokenAgeSec} ثانية
الحجم: لا يهم
حجم صفر: مسموح مع سيولة ≥ ${reset.allowZeroVolumeMinLiq} SOL
المشترون: لا يهم
المطور: ≤ ${reset.maxCreatorHoldingsPct}%
كبار الملاك: ≤ ${reset.maxTopHoldersPct}%
السيولة: ≥ ${reset.minLiquiditySol} SOL
القيمة السوقية: مفتوح - ${reset.maxMarketCapUsd}$
المراقبة: ${reset.watchlistMinutes} دقائق
وقف الخسارة: -${reset.paperStopLossPct}%

يمكن تغيير أي قيمة من أزرار Telegram.`);
  }
  const s = settingsForAdmin();
  if (key) {
    const bool = value === 'on' ? true : value === 'off' ? false : null;
    if (['live', 'sniper', 'paper', 'authorities'].includes(key) && bool === null) return ctx.reply('استخدم on أو off.');
    if (key === 'live') s.liveTrading = bool;
    else if (key === 'sniper') { s.autoSniperEnabled = bool; if (bool) s.killSwitch = false; }
    else if (key === 'authorities') s.requireRenouncedAuthorities = bool;
    else if (key === 'paper') s.paperTradingEnabled = bool;
    else if (key === 'takeprofit' && Number(value) > 0) s.paperTakeProfitPct = Number(value);
    else if (key === 'size' && Number(value) > 0) s.tradeSizeSol = Number(value);
    else if (key === 'maxtrades' && Number(value) >= 0) s.maxTradesPerDay = Number(value);
    else if (key === 'minliq' && Number(value) >= 0) s.minLiquiditySol = Number(value);
    else if (key === 'maxcap' && Number(value) >= 0) s.maxMarketCapUsd = Number(value);
    else if (!['live', 'sniper', 'paper', 'takeprofit', 'authorities', 'size', 'maxtrades', 'minliq', 'maxcap'].includes(key)) return ctx.reply('إعداد غير معروف.');
    saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (s.autoSniperEnabled) watcher.start(); else watcher.stop();
  }
  await ctx.reply(settingsText(s));
});

bot.command('snipe', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await ctx.reply('المراقبة تستهدف Pump.fun وتفحصه كل 30 ثانية.\nشغّلها: /settings sniper on\nأوقفها: /settings sniper off\nتحقق من حالتها: /status\nالوضع التجريبي يستخدم بيانات حقيقية ولا يرسل معاملات.\nللشراء: /buy <عنوان_العملة> <مقدار_SOL>\nلعرض PnL اللحظي: /pnl'); });
bot.command('buy', async (ctx) => trade(ctx, 'buy'));
bot.command('sell', async (ctx) => trade(ctx, 'sell'));

async function trade(ctx, side, mintArg, amountArg, fraction = null) {
  if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة لتنفيذ التداول.');
  const parts = ctx.message?.text?.trim().split(/\s+/) || [];
  const mint = mintArg || parts[1]; const amount = Number(amountArg || parts[2]); const action = side === 'buy' ? 'شراء' : 'بيع';
  if (!mint || (fraction === null && (!Number.isFinite(amount) || amount <= 0))) return ctx.reply(`استخدم /${side} <عنوان_العملة> <${side === 'buy' ? 'مقدار_SOL' : 'مقدار_العملة'}>`);
  const s = settingsForAdmin();
  if (!canTrade(s)) return ctx.reply('تم الوصول إلى حد الصفقات اليومية المحدد في الإعدادات.');
  try {
    const tokenSide = side === 'sell';
    let quote;
    if (effectiveLiveTrading(s) || side === 'buy') {
      const inputAmount = tokenSide ? (fraction === null ? await getTokenAmount({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint, uiAmount: amount }) : await getTokenBalance({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint, fraction })) : { raw: Math.round(amount * 1e9) };
      quote = await getQuote({ jupiterUrl: config.jupiterUrl, inputMint: tokenSide ? mint : SOL_MINT, outputMint: tokenSide ? SOL_MINT : mint, amountLamports: inputAmount.raw, slippageBps: 100 });
    }
    if (!effectiveLiveTrading(s)) {
      if (side === 'buy') {
        const position = await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint, investedSol: amount, quote });
        const current = await refreshPositions({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
        const value = current.values.find((p) => p.id === position.id);
        if (!value || value.pricingError) return ctx.reply(`تم تسجيل الشراء التجريبي، لكن لا يوجد Route للبيع حالياً.\nالعنوان: ${mint}\nسيتمكن البوت من حساب PnL عند توفر السيولة.\nلم تُرسل أي معاملة.`);
        return ctx.reply(`تمت محاكاة الشراء ببيانات حقيقية من Jupiter\nالعقد: ${shortAddress(mint)}\nالمبلغ الافتراضي: ${amount} SOL\nالقيمة الحالية: ${value.currentSol.toFixed(6)} SOL\nPnL: ${value.pnlSol >= 0 ? '+' : ''}${value.pnlSol.toFixed(6)} SOL (${value.pnlPct.toFixed(2)}٪)\nلم تُرسل أي معاملة.`, { reply_markup: paperMenu(position.id, mint) });
      }
      const position = getPositions(config.adminId, config.encryptionKey).find((p) => p.mint === mint && p.status === 'open');
      if (!position) return ctx.reply('لا يوجد مركز Paper Trading مفتوح لهذه العملة.');
      const closed = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: position.id, fraction: fraction === null ? 1 : fraction, jupiterUrl: config.jupiterUrl, rpcUrl: config.rpcUrl, ownerSecret: userSecret() });
      return ctx.reply(`تمت محاكاة البيع بنسبة ${Math.round((fraction || 1) * 100)}٪\nالقيمة: ${closed.currentSol.toFixed(6)} SOL\nالربح/الخسارة: ${closed.pnlSol >= 0 ? '+' : ''}${closed.pnlSol.toFixed(6)} SOL (${closed.pnlPct.toFixed(2)}٪)\nلم تُرسل أي معاملة.`);
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: effectiveLiveTrading(s), priorityFeeMaxLamports: config.priorityFeeMaxLamports });
    if (!result.signature && effectiveLiveTrading(s)) throw new Error('لم تُرجع المعاملة توقيعاً.');
    if (side === 'buy' && effectiveLiveTrading(s)) {
      const actualBalance = await getTokenBalance({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint });
      await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint, investedSol: amount, quote: { ...quote, outAmount: actualBalance.raw }, mode: 'live', buySignature: result.signature, metadata: { name: mint, symbol: 'N/A', decimals: actualBalance.decimals } });
    }
    s.tradesToday += 1; resetConsecutiveFailures(s); saveSettings(config.adminId, s, config.encryptionKey);
    if (result.simulated) return ctx.reply(`معاينة ${action} — الوضع التجريبي\nلم تُرسل معاملة.`, { reply_markup: tradeMenu(mint) });
    await ctx.reply(`${action} مؤكّد\nالتوقيع: ${result.signature}\n${explorer(result.signature)}`, { reply_markup: tradeMenu(mint) });
  } catch (e) { await ctx.reply(`تعذر تنفيذ ${action}.\n${e.message}`); }
}

async function sendPnl(ctx) {
  try {
    const { values, solUsd } = await refreshPositions({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
    if (!values.length) return ctx.reply('لا توجد مراكز Paper Trading مفتوحة. استخدم /buy أو شغّل القنص في الوضع التجريبي.');
    const lines = values.map((p) => { const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString('ar-IQ') : 'غير متاح'; return p.pricingError ? `${p.mint}\nالمستثمر: ${p.investedSol.toFixed(6)} SOL\nالسعر الحالي: غير متاح مؤقتاً\nآخر تحديث: ${updated}\nالسبب: ${p.pricingError}` : `${p.mint}\nالمستثمر: ${p.investedSol.toFixed(6)} SOL\nالسعر الحالي: ${p.currentSol.toFixed(6)} SOL\nPnL: ${p.pnlSol >= 0 ? '+' : ''}${p.pnlSol.toFixed(6)} SOL (${p.pnlPct.toFixed(2)}٪)\nآخر تحديث: ${updated}${solUsd ? `\nPnL بالدولار: ${(p.pnlSol * solUsd).toFixed(2)} USD` : ''}`; });
    await ctx.reply(`حالة Paper Trading اللحظية\nسعر SOL: ${solUsd ? `${solUsd.toFixed(2)} USD` : 'غير متاح'}\n\n${lines.join('\n\n')}`, { reply_markup: paperMenu(values[0].id, values[0].mint) });
  } catch (error) { await ctx.reply(`تعذر تحديث PnL من بيانات السوق الحية.\n${error.message}`); }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('عرض المحفظة متاح للمشرف فقط لحماية بيانات الحساب.'); try { const address = keypairFromSecret(userSecret()).publicKey.toBase58(); const sol = await getSolBalance({ rpcUrl: config.rpcUrl, owner: address }); await ctx.editMessageText(`💼 محفظتك الشخصية\n\nالعنوان:\n${address}\n\nالرصيد: ${sol.toFixed(9)} SOL\nالعمولة: 0%\nالحد الأدنى للإيداع والسحب: لا يوجد`, { reply_markup: walletKeyboard(address) }); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة.\n${e.message}`); } });
bot.callbackQuery('wallet:refresh', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const address = keypairFromSecret(userSecret()).publicKey.toBase58(); const sol = await getSolBalance({ rpcUrl: config.rpcUrl, owner: address }); await ctx.editMessageText(`💼 محفظتك الشخصية\n\nالعنوان:\n${address}\n\nالرصيد: ${sol.toFixed(9)} SOL\nالعمولة: 0%\nآخر تحديث: ${new Date().toLocaleString('ar-IQ')}`, { reply_markup: walletKeyboard(address) }); });
bot.callbackQuery('wallet:deposit', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const address = keypairFromSecret(userSecret()).publicKey.toBase58(); await ctx.editMessageText(`📥 إيداع SOL\n\nأرسل SOL إلى هذا العنوان:\n${address}\n\nلا يوجد حد أدنى للإيداع. تأكد من استخدام شبكة Solana فقط.`, { reply_markup: new InlineKeyboard().copyText('نسخ عنوان الإيداع', address).row().text('رجوع للمحفظة', 'wallet') }); });
bot.callbackQuery('wallet:withdraw', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText('📤 سحب SOL\n\nلا يوجد حد أدنى للسحب.\nاستخدم الأمر التالي بعد التأكد من العنوان:\n\n/withdraw <عنوان Solana> <المبلغ SOL>\n\nسيتم رفض المبلغ الذي يساوي أو يتجاوز الرصيد حتى تبقى رسوم الشبكة متاحة.', { reply_markup: new InlineKeyboard().text('رجوع للمحفظة', 'wallet') }); });
bot.callbackQuery('public:back', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText('القائمة الرئيسية', { reply_markup: menu() }); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('عرض الأرصدة متاح للمشرف فقط.'); try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.editMessageText(`📊 رصيد وأصول المحفظة\n\nالعنوان: ${p.address}\nرصيد SOL: ${p.sol.toFixed(9)}\nحسابات العملات غير الفارغة: ${p.tokens.length}\n\nهذه الأصول تخص محفظة المشرف فقط.`, { reply_markup: new InlineKeyboard().copyText('نسخ العنوان', p.address).row().text('💼 رجوع للمحفظة', 'wallet').text('رجوع للوحة', 'panel:back') }); } catch (e) { await ctx.reply(`تعذر تحميل الأصول.\n${e.message}`); } });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(isAdmin(ctx) ? 'للمشرف: استخدم /settings لضبط الفلاتر، ثم /settings sniper on لتشغيل مراقبة Pump.fun.' : 'القنص والتداول من وظائف المشرف فقط. يمكنك متابعة الحالة باستخدام /status.'); });
bot.callbackQuery('public:status', async (ctx) => { await ctx.answerCallbackQuery(); const status = watcher.status(); await ctx.reply(`حالة المراقب: ${status.running ? 'يعمل الآن' : 'متوقف'}\nالمصدر: ${status.source}\nآخر فحص: ${status.lastPollAt ? new Date(status.lastPollAt).toLocaleString('ar-IQ') : 'لم يبدأ بعد'}`); });
bot.callbackQuery('public:help', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('هذا البوت يراقب فرص Pump.fun وفق فلاتر أمان محددة.\n\n/status — عرض حالة المراقب\n/start — فتح الواجهة العامة\n\nالتداول والإعدادات محمية للمشرف.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا القسم متاح للمشرف فقط.'); await ctx.editMessageText(settingsText(settingsForAdmin()), { reply_markup: settingsKeyboard() }); });
bot.callbackQuery('settings:reset:confirm', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText('⚠️ ستتم إعادة فلاتر القنص وقيم التشغيل إلى الإعدادات الافتراضية الظاهرة في القائمة، مع بقائها قابلة للتغيير لاحقاً من الأزرار. هل تريد المتابعة؟', { reply_markup: new InlineKeyboard().text('تأكيد الإعدادات الافتراضية ✅', 'settings:reset:do').row().text('إلغاء 🔙', 'panel:settings') }); });
bot.callbackQuery('settings:reset:do', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; resetSettings(config.adminId, config.encryptionKey); const reset = settingsForAdmin(); watcherManuallyEnabled = Boolean(reset.autoSniperEnabled && !reset.killSwitch); watcher.updateSettings(reset); if (watcherManuallyEnabled) watcher.start(); else watcher.stop(); await ctx.editMessageText(`✅ تمت إعادة الإعدادات الافتراضية وتطبيقها فوراً.\n\n${filterText(reset)}\n\nيمكنك تعديل أي فلتر من الأزرار.`, { reply_markup: filterKeyboard(reset) }); });
bot.callbackQuery('filters', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); });
bot.callbackQuery(/^filter:(curve|volume|buyers|dev|top|social|watch|authorities|liquidity|dominance|marketcap|ageMin|ageMax|mcapMin|sl|rugProtection|capitalProtection|maxHoldTime|allowZeroVolume)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const field = ctx.match[1]; const s = settingsForAdmin(); if (field === 'curve') { pendingFilters.set(String(ctx.from.id), { field, min: String(s.minCurveProgress), max: String(s.maxCurveProgress) }); return ctx.editMessageText(`${filterLabels.curve}\n\nالقيمة الحالية: ${filterValue(s, 'curve')}\n\nحدد الحد الأدنى أولاً:`, { reply_markup: curveMinKeyboard(String(s.minCurveProgress)) }); } const value = field === 'ageMin' ? String(s.minTokenAgeSec || 0) : field === 'ageMax' ? String(s.maxTokenAgeSec || 0) : field === 'mcapMin' ? String(s.minMarketCapUsd || 0) : field === 'sl' ? String(s.paperStopLossPct || 15) : field === 'rugProtection' ? (s.rugProtectionEnabled ? 'on' : 'off') : field === 'capitalProtection' ? (s.capitalProtectionEnabled ? `${s.capitalProtectionSellPct}-${s.capitalProtectionTriggerPct}` : 'off') : field === 'maxHoldTime' ? String(s.maxHoldTimeMin || 0) : field === 'volume' ? String(s.minVolumeUsd) : field === 'allowZeroVolume' ? (s.allowZeroVolume ? String(s.allowZeroVolumeMinLiq) : 'off') : field === 'buyers' ? String(s.minUniqueBuyers) : field === 'dev' ? String(s.maxCreatorHoldingsPct) : field === 'top' ? String(s.maxTopHoldersPct) : field === 'watch' ? String(s.watchlistMinutes) : field === 'social' ? (s.requireSocialLinks ? 'on' : 'off') : field === 'authorities' ? (s.requireRenouncedAuthorities ? 'on' : 'off') : field === 'dominance' ? (s.requireBuyVolumeDominance ? 'on' : 'off') : field === 'liquidity' ? String(s.minLiquiditySol || 0) : String(s.maxMarketCapUsd || 0); pendingFilters.set(String(ctx.from.id), { field, value }); await ctx.editMessageText(`${filterLabels[field]}\n\nالقيمة الحالية: ${filterValue(s, field)}\nاختر قيمة جديدة ثم اضغط تأكيد الاختيار.`, { reply_markup: optionKeyboard(field, value) }); });
bot.callbackQuery(/^fmin:(0|1|5|10|15|20)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const pending = pendingFilters.get(String(ctx.from.id)) || { field: 'curve' }; pending.field = 'curve'; pending.min = ctx.match[1]; pendingFilters.set(String(ctx.from.id), pending); await ctx.editMessageText(`📉 نسبة المنحنى\n\nالحد الأدنى المختار: ${pending.min}%\n\nحدد الحد الأعلى:`, { reply_markup: curveMaxKeyboard(pending.min) }); });
bot.callbackQuery(/^fmax:(0|1|5|10|15|20):(35|60|100)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const pending = pendingFilters.get(String(ctx.from.id)) || { field: 'curve' }; pending.field = 'curve'; pending.min = ctx.match[1]; pending.max = ctx.match[2]; pending.value = `${pending.min}-${pending.max}`; pendingFilters.set(String(ctx.from.id), pending); await ctx.editMessageText(`📉 نسبة المنحنى\n\nالاختيار المؤقت: ${pending.min}% - ${pending.max}%\nاضغط تأكيد الاختيار للحفظ أو إلغاء ورجوع.`, { reply_markup: new InlineKeyboard().text('تأكيد الاختيار ✅', 'fconfirm').text('إلغاء ورجوع 🔙', 'fcancel') }); });
bot.callbackQuery(/^fopt:(curve|volume|buyers|dev|top|social|watch|authorities|liquidity|dominance|marketcap|ageMin|ageMax|mcapMin|sl|rugProtection|capitalProtection|maxHoldTime|allowZeroVolume):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const field = ctx.match[1]; const value = ctx.match[2]; pendingFilters.set(String(ctx.from.id), { field, value }); await ctx.editMessageText(`${filterLabels[field]}\n\nالاختيار المؤقت: ${value}\nاضغط تأكيد الاختيار للحفظ أو إلغاء ورجوع.`, { reply_markup: optionKeyboard(field, value) }); });
bot.callbackQuery('fconfirm', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const pending = pendingFilters.get(String(ctx.from.id)); if (!pending) return ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); const s = settingsForAdmin(); if (pending.field === 'curve') { const [min, max] = pending.value.split('-').map(Number); s.minCurveProgress = min; s.maxCurveProgress = max; } else if (pending.field === 'ageMin') s.minTokenAgeSec = Number(pending.value); else if (pending.field === 'ageMax') s.maxTokenAgeSec = Number(pending.value); else if (pending.field === 'mcapMin') s.minMarketCapUsd = Number(pending.value); else if (pending.field === 'volume') s.minVolumeUsd = Number(pending.value); else if (pending.field === 'sl') s.paperStopLossPct = Number(pending.value); else if (pending.field === 'rugProtection') s.rugProtectionEnabled = pending.value === 'on'; else if (pending.field === 'capitalProtection') { if (pending.value === 'off') s.capitalProtectionEnabled = false; else { const [sell, trigger] = pending.value.split('-').map(Number); s.capitalProtectionEnabled = true; s.capitalProtectionSellPct = sell; s.capitalProtectionTriggerPct = trigger; } } else if (pending.field === 'maxHoldTime') s.maxHoldTimeMin = Number(pending.value); else if (pending.field === 'buyers') s.minUniqueBuyers = Number(pending.value); else if (pending.field === 'dev') s.maxCreatorHoldingsPct = Number(pending.value); else if (pending.field === 'top') s.maxTopHoldersPct = Number(pending.value); else if (pending.field === 'social') s.requireSocialLinks = pending.value === 'on'; else if (pending.field === 'watch') s.watchlistMinutes = Number(pending.value); else if (pending.field === 'authorities') s.requireRenouncedAuthorities = pending.value === 'on'; else if (pending.field === 'liquidity') s.minLiquiditySol = Number(pending.value); else if (pending.field === 'dominance') s.requireBuyVolumeDominance = pending.value === 'on'; else if (pending.field === 'marketcap') s.maxMarketCapUsd = Number(pending.value); else if (pending.field === 'allowZeroVolume') { if (pending.value === 'off') s.allowZeroVolume = false; else { s.allowZeroVolume = true; s.allowZeroVolumeMinLiq = Number(pending.value); } } saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); pendingFilters.delete(String(ctx.from.id)); await ctx.editMessageText(`تم حفظ ${filterLabels[pending.field]}: ${filterValue(s, pending.field)}\n\nتم تطبيق الإعداد فورياً على المراقب.`, { reply_markup: filterKeyboard(s) }); });
bot.callbackQuery('fcancel', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; pendingFilters.delete(String(ctx.from.id)); await ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); });
bot.callbackQuery('balance:confirm', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText('⚠️ إعادة ضبط الدورة ستعيد الرصيد، تغلق المراكز التجريبية، وتمسح كل العملات المفحوصة وقائمة المراقبة والإحصاءات وسجل العمليات. هل تريد بدء دورة جديدة؟', { reply_markup: new InlineKeyboard().text('تأكيد دورة جديدة ✅', 'balance:do').row().text('إلغاء 🔙', 'panel:back') }); });
bot.callbackQuery('balance:do', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const s = settingsForAdmin(); const user = getUser(config.adminId, config.encryptionKey); const positions = getPositions(config.adminId, config.encryptionKey).map((position) => ({ ...position, status: 'closed', updatedAt: Date.now() })); watcher.resetCycle(); s.paperAvailableSol = Number(s.paperCapitalSol || 0); s.paperPnlSol = 0; s.paperEvents = []; s.tradesToday = 0; s.lastMint = null; s.lastFilterResult = 'لم تبدأ الدورة الجديدة بعد'; s.rejectStats = {}; s.checkedCount = 0; s.lastCheckAt = null; saveUser(config.adminId, { ...user, paperPositions: positions, settings: s }, config.encryptionKey); watcher.updateSettings(s); await ctx.editMessageText('✅ تمت إعادة ضبط الرصيد ومسح بيانات الدورة السابقة. تم تجهيز دورة فحص جديدة، ولم تُرسل أي معاملة حقيقية.', { reply_markup: panelKeyboard(s) }); });
bot.callbackQuery(/^panel:(start|stop|buyon|buyoff|sellon|selloff|killon|killoff|refresh|settings|details|back)$/, async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'للمشرف فقط' }); const action = ctx.match[1]; try { await ctx.answerCallbackQuery({ text: action === 'start' ? 'جارٍ التشغيل...' : 'تم' }); } catch (_) {} const s = settingsForAdmin(); s.paperPanelChatId = String(ctx.callbackQuery.message.chat.id); s.paperPanelMessageId = ctx.callbackQuery.message.message_id; try { if (action === 'start') { s.killSwitch = false; watcherManuallyEnabled = true; s.autoSniperEnabled = true; watcher.updateSettings(s); watcher.start(); } if (action === 'stop') { watcherManuallyEnabled = false; s.autoSniperEnabled = false; s.paperTradingEnabled = false; s.autoSellEnabled = false; watcher.updateSettings(s); watcher.stop(); } if (action === 'buyon') s.paperTradingEnabled = true; if (action === 'buyoff') s.paperTradingEnabled = false; if (action === 'sellon') s.autoSellEnabled = true; if (action === 'selloff') s.autoSellEnabled = false; if (action === 'killon') { s.killSwitch = true; s.autoSniperEnabled = false; s.paperTradingEnabled = false; s.autoSellEnabled = false; watcherManuallyEnabled = false; watcher.updateSettings(s); watcher.stop(); } if (action === 'killoff') { s.killSwitch = false; s.autoSniperEnabled = true; watcherManuallyEnabled = true; watcher.updateSettings(s); watcher.start(); } saveSettings(config.adminId, s, config.encryptionKey); if (action === 'refresh') return ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); if (action === 'settings') return ctx.editMessageText('ضبط القنص التجريبي\nاختر الإعداد المطلوب:', { reply_markup: settingsKeyboard() }); if (action === 'details') return ctx.editMessageText(detailsText(s), { reply_markup: detailsKeyboard(s) }); if (action === 'back') return ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); await ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); } catch (error) { console.error(`Panel button ${action} error: ${error.stack || error.message}`); try { await ctx.reply(`تعذر تنفيذ الزر حالياً: ${error.message}`); } catch (_) {} } });
bot.callbackQuery(/^cfg:(allocation|daily|profit|sizing|confirm)$/, async (ctx) => { try { await ctx.answerCallbackQuery(); } catch (_) {} if (!isAdmin(ctx)) return; const page = ctx.match[1]; if (page === 'allocation') return ctx.editMessageText('اختر نسبة الصفقة من رأس المال الافتراضي 1 SOL:', { reply_markup: allocationKeyboard() }); if (page === 'daily') return ctx.editMessageText('اختر الحد الأقصى للصفقات في اليوم:', { reply_markup: dailyKeyboard() }); if (page === 'profit') return ctx.editMessageText('اختر نسبة الربح التي عندها يتم البيع التلقائي:', { reply_markup: profitKeyboard() }); if (page === 'sizing') return ctx.editMessageText('اختر طريقة حساب رأس المال:', { reply_markup: sizingKeyboard() }); const s = settingsForAdmin(); saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); await ctx.editMessageText(settingsText(s), { reply_markup: settingsKeyboard() }); });
 bot.callbackQuery(/^set:(allocation|daily|profit|sizing):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const [, key, value] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'allocation') { s.paperAllocationPct = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText(`تم حفظ حجم الصفقة: ${s.paperAllocationPct}% = ${paperTradeAmount(s).toFixed(4)} SOL. اختر عدد الصفقات اليومية:`, { reply_markup: dailyKeyboard() }); } if (key === 'daily') { s.maxTradesPerDay = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText('تم حفظ الحد اليومي. اختر هدف الربح والبيع:', { reply_markup: profitKeyboard() }); } if (key === 'profit') { s.paperTakeProfitPct = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText('تم حفظ هدف الربح. اختر نمط حجم الصفقة:', { reply_markup: sizingKeyboard() }); } s.paperSizingMode = value; saveSettings(config.adminId, s, config.encryptionKey); await ctx.editMessageText('تم حفظ نمط الصفقة. القنص متوقف؛ استخدم زر تشغيل القنص من اللوحة عند الحاجة.', { reply_markup: settingsKeyboard() }); });
bot.callbackQuery(/^watcher:(on|off|status)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const action = ctx.callbackQuery.data.split(':')[1]; const s = settingsForAdmin(); if (action === 'on') { watcherManuallyEnabled = true; s.killSwitch = false; s.autoSniperEnabled = true; watcher.updateSettings(s); watcher.start(); } if (action === 'off') { watcherManuallyEnabled = false; s.autoSniperEnabled = false; watcher.updateSettings(s); watcher.stop(); } s.paperPanelChatId = String(ctx.chat.id); s.paperPanelMessageId = ctx.callbackQuery.message.message_id; saveSettings(config.adminId, s, config.encryptionKey); await updatePanel(s); });
bot.callbackQuery(/^paper:(on|off)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const s = settingsForAdmin(); s.paperTradingEnabled = ctx.match[1] === 'on'; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); await updatePanel(s); });
bot.callbackQuery(/^toggle:(sniper|live)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, key] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'sniper') { s.autoSniperEnabled = !s.autoSniperEnabled; if (s.autoSniperEnabled) s.killSwitch = false; watcherManuallyEnabled = s.autoSniperEnabled; } else s.liveTrading = !s.liveTrading; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (key === 'sniper' && s.autoSniperEnabled) watcher.start(); else if (key === 'sniper') watcher.stop(); await updatePanel(s); await ctx.reply(settingsText(s)); });
bot.callbackQuery(/^(b|s):([^:]+):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, action, token, value] = ctx.callbackQuery.data.split(':'); const mint = tradeTokens.get(token); if (!mint) return ctx.reply('انتهت صلاحية هذا الزر. استخدم /pnl أو أعد طلب العملة.'); const side = action === 'b' ? 'buy' : 'sell'; await trade(ctx, side, mint, side === 'buy' ? value : null, side === 'sell' ? Number(value) : null); });
bot.callbackQuery(/^p:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); if (!paperTokens.has(ctx.match[1])) return ctx.reply('انتهت صلاحية هذا الزر. استخدم /pnl من جديد.'); await sendPnl(ctx); });
bot.callbackQuery(/^ps:(.+):(0\.5|1)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const id = paperTokens.get(ctx.match[1]); const fraction = Number(ctx.match[2]); if (!id) return updatePanel(settingsForAdmin(), ctx); try { const value = getPositions(config.adminId, config.encryptionKey).find((p) => p.id === id); const result = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: id, fraction, jupiterUrl: config.jupiterUrl, rpcUrl: config.rpcUrl, ownerSecret: userSecret() }); if (value) await recordPaperSale(value, result, `بيع يدوي ${fraction * 100}٪`); } catch (error) { console.error(`Paper sale error: ${error.message}`); await updatePanel(settingsForAdmin(), ctx); } });
bot.callbackQuery(/^manualsell:(.+):ask$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const token = ctx.match[1]; if (token === 'all') return ctx.editMessageText('⚠️ تأكيد بيع جميع العملات المفتوحة بسعر السوق؟ سيتم تنفيذ كل عملية بشكل منفصل وتسجيل توقيعها.', { reply_markup: new InlineKeyboard().text('تأكيد بيع الكل ✅', 'manualsell:all:do').row().text('إلغاء', 'panel:back') }); const id = manualSellTokens.get(token); const position = getPositions(config.adminId, config.encryptionKey).find((p) => p.id === id && p.status === 'open'); if (!position) return ctx.reply('المركز غير موجود أو تم بيعه.'); await ctx.editMessageText(`⚠️ تأكيد بيع ${position.name || position.symbol || shortAddress(position.mint)} بسعر السوق؟\nالعقد: ${position.mint}\nالمبلغ المستثمر: ${Number(position.investedSol || 0).toFixed(6)} SOL\n\nسيتم استخدام Route الحالي من Jupiter.`, { reply_markup: new InlineKeyboard().text('تأكيد البيع ✅', `manualsell:${token}:do`).row().text('إلغاء', 'panel:back') }); });
bot.callbackQuery(/^manualsell:(.+):do$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const token = ctx.match[1]; const s = settingsForAdmin(); if (!effectiveLiveTrading(s)) { const positions = token === 'all' ? getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open') : [getPositions(config.adminId, config.encryptionKey).find((p) => p.id === manualSellTokens.get(token))].filter(Boolean); await ctx.editMessageText(`التداول الحقيقي مغلق حالياً (LIVE_TRADING=false).\nلم تُرسل أي معاملة.\nالمراكز التي كانت ستُباع: ${positions.length}`, { reply_markup: new InlineKeyboard().text('رجوع للتفاصيل', 'panel:details') }); return; } const positions = token === 'all' ? getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open') : [getPositions(config.adminId, config.encryptionKey).find((p) => p.id === manualSellTokens.get(token))].filter(Boolean); const results = []; for (const value of positions) { try { const sold = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: value.id, fraction: 1, jupiterUrl: config.jupiterUrl, rpcUrl: config.rpcUrl, ownerSecret: userSecret() }); if (sold) { await recordPaperSale(value, sold, 'بيع يدوي بسعر السوق', 'Manual'); results.push(`✅ ${value.symbol || shortAddress(value.mint)}: ${sold.signature ? explorer(sold.signature) : 'تم'}`); } } catch (error) { results.push(`❌ ${value.symbol || shortAddress(value.mint)}: ${error.message}`); } } await ctx.editMessageText(`نتيجة البيع اليدوي\n\n${results.join('\n') || 'لا توجد مراكز مفتوحة.'}`, { reply_markup: new InlineKeyboard().text('رجوع للتفاصيل', 'panel:details') }); });
bot.callbackQuery('panel:cleanup', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const s = settingsForAdmin(); const open = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open'); if (s.autoSniperEnabled || s.paperTradingEnabled || s.autoSellEnabled) return ctx.editMessageText('أوقف القنص والشراء والبيع التلقائي أولاً ثم اضغط التنظيف.', { reply_markup: new InlineKeyboard().text('رجوع للوحة', 'panel:back') }); if (open.length) return ctx.editMessageText(`لا يمكن التنظيف الآن: ما زالت هناك ${open.length} عملة مفتوحة. أوقف الشراء والبيع التلقائي ثم بع العملات من أزرار البيع أولاً.`, { reply_markup: new InlineKeyboard().text('رجوع للتفاصيل', 'panel:details') }); s.paperEvents = []; s.lastMint = null; s.lastFilterResult = 'تم التنظيف يدوياً'; s.rejectStats = {}; s.checkedCount = 0; s.lastCheckAt = null; saveSettings(config.adminId, s, config.encryptionKey); await ctx.editMessageText('✅ تم تنظيف سجل العمليات وإحصاءات الدورة بعد التأكد من عدم وجود عملات مفتوحة.', { reply_markup: new InlineKeyboard().text('رجوع للوحة', 'panel:back') }); });

let lastSniperErrorAt = 0;
let paperMonitorBusy = false;
let sniperTradeBusy = false;
let watcherManuallyEnabled = false;
let _rejectBuf = {};
let _checkedBuf = 0;
const isTransientQuoteError = (error) => /429|Too Many Requests|Jupiter مشغول حالياً|rate.?limit/i.test(String(error?.message || error || ''));
const watcher = new PumpFunWatcher({ adminId: config.adminId, settings: settingsForAdmin(), onError: (e) => console.error(`Pump.fun watcher error: ${e.message}`), onFilter: (_candidate, reason) => { const key = reason.replace(/—.*$/, '').trim().slice(0, 40); _rejectBuf[key] = (_rejectBuf[key] || 0) + 1; _checkedBuf += 1; }, onCandidate: async (candidate) => {
  let s = settingsForAdmin(); s.lastMint = candidate.mint; saveSettings(config.adminId, s, config.encryptionKey);
  const safetyBlock = await checkSafetyRails(s);
  if (safetyBlock) { console.log(safetyBlock); return; }
  if (!s.autoSniperEnabled) return;
  if (sniperTradeBusy) { console.log(`[sniper] تخطي مرشح أثناء تنفيذ صفقة أخرى: ${candidate.mint}`); return; }
  if (!canTrade(s)) return;
  if (!s.paperTradingEnabled && !effectiveLiveTrading(s)) return;
  sniperTradeBusy = true;
  try {
    let amountSol = paperTradeAmount(s);
    if (effectiveLiveTrading(s)) {
      const walletAddress = keypairFromSecret(userSecret()).publicKey.toBase58();
      const liveBalance = await getSolBalance({ rpcUrl: config.rpcUrl, owner: walletAddress });
      const reserveSol = Math.max(0, Number(process.env.LIVE_SOL_RESERVE_SOL || 0.01));
      amountSol = Math.max(0, liveBalance - reserveSol) * Number(s.paperAllocationPct || 0) / 100;
    }
    if (!effectiveLiveTrading(s) && (amountSol <= 0 || Number(s.paperAvailableSol) < amountSol)) return;
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, outputMint: candidate.mint, amountLamports: Math.round(amountSol * 1e9), slippageBps: 100 });
    if (!effectiveLiveTrading(s)) {
      await getQuote({ jupiterUrl: config.jupiterUrl, inputMint: candidate.mint, outputMint: SOL_MINT, amountLamports: Number(quote.outAmount), slippageBps: 100 });
      s = settingsForAdmin();
      if (Number(s.paperAvailableSol) < amountSol) return;
      const position = await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint: candidate.mint, investedSol: amountSol, quote, mode: 'paper', buySignature: null, metadata: candidate });
      s.paperAvailableSol = Number(s.paperAvailableSol) - amountSol; s.tradesToday += 1; resetConsecutiveFailures(s); saveSettings(config.adminId, s, config.encryptionKey);
      const tokenAmount = Number(quote.outAmount) / (10 ** Number(candidate.decimals ?? 6)); const unitPrice = amountSol / tokenAmount; const ageSec = candidate.createdAt ? Math.round(Date.now() / 1000 - Number(candidate.createdAt)) : 0; s.paperEvents = [...(s.paperEvents || []), { type: 'شراء', name: `${candidate.name} (${candidate.symbol})`, mint: candidate.mint, detail: `${amountSol.toFixed(4)} SOL | ${tokenAmount.toLocaleString()} Token`, metadata: { amountSol: Number(amountSol), tokenAmount, unitPrice, liquiditySol: Number(candidate.liquiditySol || 0), marketCapUsd: Number(candidate.marketCapUsd || 0), volumeUsd: Number(candidate.volumeUsd || 0), uniqueBuyers: Number(candidate.uniqueBuyers || 0), bondingCurveProgress: Number(candidate.bondingCurveProgress || 0), bondingCurveSource: candidate.bondingCurveProgressSource || '—', ageSeconds: ageSec, socialLinks: candidate.socialLinks?.length || 0, mintAuthority: candidate.mintAuthority ? 'موجود' : 'معطل', freezeAuthority: candidate.freezeAuthority ? 'موجود' : 'معطل', filtersAtBuy: { curveRange: `${s.minCurveProgress}-${s.maxCurveProgress}%`, minVolume: `$${s.minVolumeUsd}`, minBuyers: s.minUniqueBuyers, maxDev: `≤${s.maxCreatorHoldingsPct}%`, maxTop: `≤${s.maxTopHoldersPct}%`, minLiquidity: `${s.minLiquiditySol} SOL`, ageRange: `${s.minTokenAgeSec}-${s.maxTokenAgeSec}ث`, authorities: s.requireRenouncedAuthorities ? 'إلزامي' : 'حر', social: s.requireSocialLinks ? 'إلزامي' : 'حر' } }, timestamp: Date.now() }].slice(-20);
      saveSettings(config.adminId, s, config.encryptionKey); await updatePanel(s);
      return;
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: true, priorityFeeMaxLamports: config.priorityFeeMaxLamports });
    if (!result.signature) throw new Error('لم تُرجع المعاملة توقيعاً.');
    const actualBalance = await getTokenBalance({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint: candidate.mint });
    s = settingsForAdmin();
    const livePosition = await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint: candidate.mint, investedSol: amountSol, quote: { ...quote, outAmount: actualBalance.raw }, mode: 'live', buySignature: result.signature, metadata: candidate });
    if (!livePosition) throw new Error('تعذر فتح سجل المركز الحي.');
    s.tradesToday += 1; resetConsecutiveFailures(s); saveSettings(config.adminId, s, config.encryptionKey);
    const status = `تم التنفيذ\n${explorer(result.signature)}`;
    console.log(`Auto-sniper trade completed for ${candidate.mint}: ${status}`);
  } catch (error) { const now = Date.now(); console.error(`Auto-sniper quote error: ${error.message}`); if (now - lastSniperErrorAt >= 600000) lastSniperErrorAt = now; }
  finally { sniperTradeBusy = false; }
}});
const watcherStart = watcher.start.bind(watcher);
watcher.start = () => {
  if (!watcherManuallyEnabled) {
    console.warn('[watcher] start ignored because no explicit Telegram تشغيل action is active');
    return false;
  }
  return watcherStart();
};
setInterval(() => {
  const s = settingsForAdmin();
  if (!watcherManuallyEnabled || !s.autoSniperEnabled) return;
  const status = watcher.status();
  if (!status.running) { console.log('[watchdog] Watcher stopped — restarting'); watcher.start(); return; }
  const lastPoll = status.lastPollAt ? new Date(status.lastPollAt).getTime() : Date.now();
  if (!status.streamMode && Date.now() - lastPoll > 120000) { console.log('[watchdog] Watcher stalled > 2min — restarting'); watcher.stop(); setTimeout(() => watcher.start(), 2000); }
}, 60000);
// Restore the persisted watcher state after a process restart. Trading remains
// paper-only unless LIVE_TRADING=true and live mode is explicitly enabled.
const bootSettings = settingsForAdmin();
bootSettings.autoSniperEnabled = false;
watcherManuallyEnabled = false;
watcher.updateSettings(bootSettings);
saveSettings(config.adminId, bootSettings, config.encryptionKey);
console.log('[startup] Watcher kept stopped; use the Telegram تشغيل button to start it explicitly');
let monitorErrorsCount = 0;
let monitorBackoffOnce = false;
let monitorQueued = false;
async function checkSafetyRails(s) {
  if (s.killSwitch) return '🛑 قاطع الطوارئ مفعّل';
  const today = new Date().toISOString().slice(0, 10);
  if (s.dailyLossResetDay !== today) {
    s.dailyLossResetDay = today;
    s.dailyLossStartSol = Number(s.paperAvailableSol || 0);
    saveSettings(config.adminId, s, config.encryptionKey);
  }
  if (Number(s.dailyLossLimitSol) > 0 && s.dailyLossStartSol !== null) {
    const loss = Number(s.dailyLossStartSol) - Number(s.paperAvailableSol || 0);
    if (loss >= Number(s.dailyLossLimitSol)) return `🛑 تم الوصول لحد الخسارة اليومي (${loss.toFixed(4)} SOL)`;
  }
  if (Number(s.maxConsecutiveFailures) > 0 && Number(s.consecutiveFailures || 0) >= Number(s.maxConsecutiveFailures)) {
    return `🛑 توقف بسبب ${s.consecutiveFailures} أخطاء متتالية`;
  }
  return null;
}

function resetConsecutiveFailures(s) {
  if (s.consecutiveFailures) { s.consecutiveFailures = 0; saveSettings(config.adminId, s, config.encryptionKey); }
}

async function monitorPaperPositions() {
  const startTime = Date.now();
  if (paperMonitorBusy) { monitorQueued = true; return; }
  const s = settingsForAdmin();
  if (!s.autoSellEnabled || s.killSwitch) return;
  if (monitorBackoffOnce) { monitorBackoffOnce = false; return; }
  paperMonitorBusy = true;
  try {
    const { values } = await refreshPositionsCached({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
    monitorErrorsCount = 0;
    for (const value of values) {
      if (value.pricingError) {
        console.warn(`[monitor] تعذر تسعير ${value.mint}: ${value.pricingError} — استمرار المراقبة`);
        return;
      }
      const position = getPositions(config.adminId, config.encryptionKey).find((p) => p.id === value.id);
      if (!position || position.status !== 'open') return;
      const stopLoss = Number(s.paperStopLossPct || 15);
      const firstTarget = Number(s.paperTakeProfitFirstPct || 30);
      const finalTarget = Number(s.paperTakeProfitFinalPct || 60);
      const capitalTrigger = Number(s.capitalProtectionTriggerPct || 10);
      const capitalSellPct = Number(s.capitalProtectionSellPct || 50);
      const highestPnlPct = position.highestPnlPct == null ? value.pnlPct : Number(position.highestPnlPct);
      const ageMin = position.openedAt ? (Date.now() - new Date(position.openedAt).getTime()) / 60000 : 0;
      let fraction = 0;
      let reason = '';
      let triggerType = 'Manual';
      let capitalProtection = false;
      if (Number(s.maxHoldTimeMin) > 0 && ageMin >= Number(s.maxHoldTimeMin)) {
        fraction = 1;
        triggerType = 'TimeBased';
        reason = `بيع زمني بعد ${Number(s.maxHoldTimeMin)} دقيقة`;
      } else if (s.capitalProtectionEnabled && value.pnlPct <= -capitalTrigger && !position.capitalProtectionTriggered) {
        fraction = Math.min(Math.max(capitalSellPct / 100, 0), 1);
        capitalProtection = fraction > 0;
        triggerType = 'CapitalProtection';
        reason = `حماية رأس المال — بيع ${capitalSellPct}% عند -${capitalTrigger}%`;
      } else if (value.pnlPct <= -stopLoss) {
        fraction = 1;
        triggerType = 'SL';
        reason = `وقف خسارة -${stopLoss}% — إغلاق المركز بالكامل`;
      } else if (value.pnlPct <= highestPnlPct - 15) {
        fraction = 1;
        triggerType = 'Trailing';
        reason = `Trailing Stop — تراجع من أعلى ربح ${highestPnlPct.toFixed(1)}% إلى ${value.pnlPct.toFixed(1)}%`;
      } else if (value.pnlPct >= finalTarget) {
        fraction = 1;
        triggerType = 'TP2';
        reason = `جني الربح النهائي +${finalTarget}% — إغلاق المركز بالكامل`;
      } else if (value.pnlPct >= firstTarget && !position.tp1Sold) {
        fraction = 0.5;
        triggerType = 'TP1';
        reason = `جني الربح الأول +${firstTarget}% — بيع 50٪`;
      }
      if (!fraction) return;
      const positionBeforeClose = getPositions(config.adminId, config.encryptionKey).find((p) => p.id === value.id);
      if (!positionBeforeClose || positionBeforeClose.status !== 'open') return;
      try {
        const sold = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: value.id, fraction, jupiterUrl: config.jupiterUrl, rpcUrl: config.rpcUrl, ownerSecret: userSecret() });
        if (!sold) return;
        resetConsecutiveFailures(s);
        if (capitalProtection) {
          const user = getUser(config.adminId, config.encryptionKey);
          const updatedPositions = (user.paperPositions || []).map((p) => p.id === value.id ? { ...p, capitalProtectionTriggered: true } : p);
          saveUser(config.adminId, { ...user, paperPositions: updatedPositions }, config.encryptionKey);
        }
        await recordPaperSale(value, sold, reason, triggerType);
      } catch (error) { console.error(`Close error ${value.id}: ${error.message}`); }
    }
  } catch (error) {
    monitorErrorsCount += 1;
    console.error(`Paper position monitor error: ${error.message}`);
    if (monitorErrorsCount >= 5) {
      console.log('[monitor] 5 أخطاء متتالية — تباطؤ مؤقت إلى 1 ثانية');
      monitorBackoffOnce = true;
    }
  } finally {
    paperMonitorBusy = false;
    if (monitorQueued) { monitorQueued = false; setImmediate(monitorPaperPositions); }
    const cycleMs = Date.now() - startTime;
    if (cycleMs > 500) console.warn(`[monitor] دورة بطيئة: ${cycleMs}ms`);
  }
}
const paperMonitorIntervalMs = Math.max(2000, Number(process.env.PAPER_MONITOR_INTERVAL_MS || 5000));
setInterval(monitorPaperPositions, paperMonitorIntervalMs);
console.log(`[monitor] Paper position checks every ${paperMonitorIntervalMs}ms`);
let _rejectFlushRunning = false;
setInterval(() => {
  if (!_checkedBuf || _rejectFlushRunning) return;
  _rejectFlushRunning = true;
  const rejectBuf = _rejectBuf;
  const checkedBuf = _checkedBuf;
  _rejectBuf = {};
  _checkedBuf = 0;
  const s = settingsForAdmin();
  s.rejectStats = s.rejectStats || {};
  for (const [key, value] of Object.entries(rejectBuf)) s.rejectStats[key] = (s.rejectStats[key] || 0) + value;
  s.checkedCount = (s.checkedCount || 0) + checkedBuf;
  s.lastCheckAt = new Date().toISOString();
  try {
    saveSettings(config.adminId, s, config.encryptionKey);
    updatePanel(s)
      .catch((error) => console.error(`[stats] تحديث اللوحة فشل: ${error.message}`))
      .finally(() => { _rejectFlushRunning = false; });
  } catch (error) {
    console.error(`[stats] حفظ إحصاءات الرفض فشل: ${error.message}`);
    _rejectFlushRunning = false;
  }
}, 10000);
setInterval(() => {
  cleanupStaleClosing(config.adminId, config.encryptionKey).catch((error) => console.error(`[cleanup] ${error.message}`));
}, 60 * 1000);
function startWatcher() {
  watcherManuallyEnabled = true;
  watcher.start();
  console.log('Pump.fun watcher started: Helius WebSocket + REST fallback are running in parallel.');
  return true;
}
module.exports = bot;
module.exports.startWatcher = startWatcher;
module.exports.watcher = watcher;
