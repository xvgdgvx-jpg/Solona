const { Bot, InlineKeyboard } = require('grammy');
const config = require('../config');
const { getQuote, getTokenAmount, getTokenBalance, executeSwap, getPortfolio, SOL_MINT, keypairFromSecret } = require('../services/solana');
const { getSettings, saveSettings, canTrade } = require('../services/settings');
const { PumpFunWatcher } = require('../services/pumpfun');
const { openPosition, refreshPositions, closePosition, getPositions } = require('../services/paper');
const { getUser, saveUser } = require('../services/storage');

const bot = new Bot(config.token);
const menu = () => new InlineKeyboard().text('المحفظة', 'wallet').text('المحفظة الاستثمارية', 'portfolio').row().text('اقتناص Pump.fun', 'snipe').text('الإعدادات', 'settings');
const controlMenu = (enabled, paperEnabled) => new InlineKeyboard().text('تشغيل المراقب', 'watcher:on').text('إيقاف المراقب', 'watcher:off').row().text(paperEnabled ? 'إيقاف شراء/بيع تجريبي' : 'تشغيل شراء/بيع تجريبي', paperEnabled ? 'paper:off' : 'paper:on').row().text('تحديث الحالة', 'watcher:status');
const tradeTokens = new Map();
const tradeMenu = (mint) => { const token = `t${(++paperTokenCounter).toString(36)}`; tradeTokens.set(token, mint); if (tradeTokens.size > 1000) tradeTokens.delete(tradeTokens.keys().next().value); return new InlineKeyboard().text('شراء 0.1 SOL', `b:${token}:0.1`).text('شراء 0.5 SOL', `b:${token}:0.5`).row().text('بيع 50٪', `s:${token}:0.5`).text('بيع 100٪', `s:${token}:1`); };
const paperTokens = new Map();
let paperTokenCounter = 0;
const paperMenu = (id, mint = null) => { const token = (paperTokenCounter++).toString(36); paperTokens.set(token, id); if (paperTokens.size > 1000) paperTokens.delete(paperTokens.keys().next().value); const keyboard = new InlineKeyboard(); if (mint) keyboard.copyText('نسخ عنوان العقد', mint).row(); return keyboard.text('تحديث السعر وPnL', `p:${token}`).row().text('بيع محاكاة 50٪', `ps:${token}:0.5`).text('بيع محاكاة 100٪', `ps:${token}:1`); };
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;
const shortAddress = (value) => value ? `${String(value).slice(0, 6)}…${String(value).slice(-5)}` : 'غير متاح';
const copyAddressKeyboard = (label, value) => new InlineKeyboard().copyText(label, value);
const settingsForAdmin = () => getSettings(config.adminId, config.encryptionKey);
const effectiveLiveTrading = (settings) => Boolean(config.liveTrading && settings.liveTrading);
const panelKeyboard = (s) => new InlineKeyboard().text(s.autoSniperEnabled ? 'إيقاف القنص والشراء' : 'تشغيل القنص تلقائياً', `panel:${s.autoSniperEnabled ? 'stop' : 'start'}`).row().text('ضبط الإعدادات', 'panel:settings').text('تحديث', 'panel:refresh').row().text('تفاصيل العمليات', 'panel:details').row().text(s.autoSellEnabled ? 'إيقاف البيع التلقائي' : 'تشغيل البيع التلقائي', `panel:${s.autoSellEnabled ? 'selloff' : 'sellon'}`).row().text('إيقاف الشراء فقط', 'panel:buyoff');
const settingsKeyboard = () => new InlineKeyboard().text('حجم الصفقة', 'cfg:allocation').row().text('عدد الصفقات اليومية', 'cfg:daily').row().text('هدف الربح والبيع', 'cfg:profit').row().text('نمط حجم الصفقة', 'cfg:sizing').row().text('⚙️ تعديل الفلاتر', 'filters').row().text('تأكيد البدء', 'cfg:confirm').text('رجوع', 'panel:back');
const pendingFilters = new Map();
const filterLabels = { curve: '📉 نسبة المنحنى', volume: '💵 الحد الأدنى للحجم', buyers: '👥 الحد الأدنى للمشترين', dev: '👨‍💻 أقصى نسبة للمطور', top: '🐋 كبار الملاك', social: '🔗 روابط التواصل', watch: '⏱️ مدة المراقبة' };
const filterValue = (s, field) => ({ curve: `${s.minCurveProgress}-${s.maxCurveProgress}%`, volume: `$${s.minVolumeUsd}`, buyers: `${s.minUniqueBuyers} محافظ`, dev: `${s.maxCreatorHoldingsPct}%`, top: `${s.maxTopHoldersPct}%`, social: s.requireSocialLinks ? 'إلزامية' : 'غير إلزامية', watch: `${s.watchlistMinutes} دقائق` }[field]);
const filterKeyboard = (s) => new InlineKeyboard().text(`${filterLabels.curve}: ${filterValue(s, 'curve')}`, 'filter:curve').row().text(`${filterLabels.volume}: ${filterValue(s, 'volume')}`, 'filter:volume').row().text(`${filterLabels.buyers}: ${filterValue(s, 'buyers')}`, 'filter:buyers').row().text(`${filterLabels.dev}: ${filterValue(s, 'dev')}`, 'filter:dev').row().text(`${filterLabels.top}: ${filterValue(s, 'top')}`, 'filter:top').row().text(`${filterLabels.social}: ${filterValue(s, 'social')}`, 'filter:social').row().text(`${filterLabels.watch}: ${filterValue(s, 'watch')}`, 'filter:watch').row().text('🔙 رجوع', 'panel:settings');
const optionKeyboard = (field, current) => { const options = { curve: [['5-25','5% - 25%'],['10-35','10% - 35%'],['15-50','15% - 50%'],['20-60','20% - 60%']], volume: [['500','500$'],['1000','1,000$'],['1500','1,500$'],['2500','2,500$'],['5000','5,000$']], buyers: [['5','5 محافظ'],['10','10 محافظ'],['15','15 محفظة'],['25','25 محفظة']], dev: [['3','3%'],['5','5%'],['8','8%'],['10','10%']], top: [['15','15%'],['20','20%'],['25','25%'],['30','30%']], social: [['on','إلزامي'],['off','غير إلزامي']], watch: [['1','1 دقيقة'],['3','3 دقائق'],['5','5 دقائق'],['10','10 دقائق']] }[field]; const k = new InlineKeyboard(); options.forEach(([value, label]) => k.text(`${String(current) === value ? '✔ ' : ''}${label}`, `fopt:${field}:${value}`).row()); return k.text('تأكيد الاختيار ✅', 'fconfirm').text('إلغاء ورجوع 🔙', 'fcancel'); };
const filterText = (s) => `⚙️ تعديل فلاتر القنص\n\nاختر الفلتر المطلوب. لا يتم حفظ الاختيار إلا بعد الضغط على تأكيد.\n\n${Object.keys(filterLabels).map((field) => `${filterLabels[field]}: ${filterValue(s, field)}`).join('\n')}`;
const allocationKeyboard = () => new InlineKeyboard().text('10٪', 'set:allocation:10').text('25٪', 'set:allocation:25').text('50٪', 'set:allocation:50').row().text('75٪', 'set:allocation:75').text('100٪', 'set:allocation:100').row().text('رجوع', 'panel:settings');
const dailyKeyboard = () => new InlineKeyboard().text('مفتوح', 'set:daily:0').text('5', 'set:daily:5').text('10', 'set:daily:10').text('50', 'set:daily:50').row().text('رجوع', 'cfg:allocation');
const profitKeyboard = () => new InlineKeyboard().text('5٪', 'set:profit:5').text('10٪', 'set:profit:10').text('25٪', 'set:profit:25').row().text('50٪', 'set:profit:50').text('75٪', 'set:profit:75').text('100٪', 'set:profit:100').row().text('رجوع', 'cfg:daily');
const sizingKeyboard = () => new InlineKeyboard().text('صفقة معزولة', 'set:sizing:isolated').row().text('شراء موسّع', 'set:sizing:expanded').row().text('رجوع', 'cfg:profit');
function panelText(s) { const events = (s.paperEvents || []).slice(-5).reverse(); const eventText = events.length ? events.map((e) => `${e.type}: ${e.name || e.mint} — ${e.detail}`).join('\n') : 'لا توجد عمليات بعد'; const openPositions = getPositions(config.adminId, config.encryptionKey).filter((p) => p.status === 'open'); const reserved = openPositions.reduce((sum, p) => sum + Number(p.investedSol || 0), 0); return `لوحة القنص التجريبي\n\nالحالة: ${s.autoSniperEnabled ? 'يعمل' : 'متوقف'}\nالشراء التجريبي: ${s.paperTradingEnabled ? 'مفعّل' : 'متوقف'}\nالبيع التلقائي عند الهدف: ${s.autoSellEnabled ? 'مفعّل' : 'متوقف'}\nرأس المال الأصلي: ${Number(s.paperCapitalSol).toFixed(4)} SOL\nالرصيد المتاح للشراء: ${Number(s.paperAvailableSol).toFixed(4)} SOL\nالمبلغ المحجوز في المراكز: ${reserved.toFixed(4)} SOL\nالمراكز المفتوحة: ${openPositions.length}\nإجمالي الأرباح المحققة: ${Number(s.paperPnlSol || 0).toFixed(4)} SOL\nهدف البيع: +${s.paperTakeProfitPct}% | SL: -${s.paperStopLossPct}% | TP1/TP2: ${s.paperTakeProfitFirstPct}%/${s.paperTakeProfitFinalPct}%\nالفلاتر: منحنى ${s.minCurveProgress}-${s.maxCurveProgress}% | حجم $${s.minVolumeUsd} | مشترون ${s.minUniqueBuyers}\nالمالك: ≤${s.maxCreatorHoldingsPct}% | كبار الملاك: ≤${s.maxTopHoldersPct}% | روابط: ${s.requireSocialLinks ? 'إلزامية' : 'اختيارية'} | مراقبة: ${s.watchlistMinutes} د\nآخر فحص Helius/الفلاتر: ${s.lastFilterResult || 'لا يوجد'}\nالحجم: ${s.paperAllocationPct}% — ${s.paperSizingMode === 'expanded' ? 'موسّع' : 'معزول'}\nالحد اليومي: ${s.maxTradesPerDay || 'مفتوح'}\n\nآخر العمليات:\n${eventText}\n\nالتداول الحقيقي: ${effectiveLiveTrading(s) ? 'مفعّل' : 'متوقف وآمن'}`; }
function detailsText(s) { const events = (s.paperEvents || []).slice().reverse(); return `تفاصيل عمليات Paper Trading\n\n${events.length ? events.map((e, i) => `${i + 1}. ${e.type}\n${e.name || 'بدون اسم'}\nالعقد: ${shortAddress(e.mint)}\n${e.detail}`).join('\n\n') : 'لا توجد عمليات مسجلة بعد.'}`; }
function detailsKeyboard(s) { const keyboard = new InlineKeyboard(); (s.paperEvents || []).slice().reverse().forEach((e, i) => keyboard.copyText(`نسخ عقد ${i + 1}`, e.mint).row()); return keyboard.text('رجوع', 'panel:back'); }
const paperTradeAmount = (s) => (Number(s.paperCapitalSol || 1) + (s.paperSizingMode === 'expanded' ? Number(s.paperPnlSol || 0) : 0)) * Number(s.paperAllocationPct || 10) / 100;
async function updatePanel(s = settingsForAdmin(), ctx = null) { const chatId = s.paperPanelChatId || config.adminId; const messageId = s.paperPanelMessageId; if (!messageId) return; try { await (ctx?.api || bot.api).editMessageText(chatId, messageId, panelText(s), { reply_markup: panelKeyboard(s) }); } catch (error) { console.error(`Panel update error: ${error.message}`); } }

async function dashboard(ctx) { if (!isAdmin(ctx)) return ctx.reply('هذه اللوحة متاحة للمشرف فقط.'); const s = settingsForAdmin(); if (s.paperPanelMessageId) { await updatePanel(s, ctx); return; } const sent = await ctx.reply(panelText(s), { reply_markup: panelKeyboard(s) }); s.paperPanelChatId = String(ctx.chat.id); s.paperPanelMessageId = sent.message_id; saveSettings(config.adminId, s, config.encryptionKey); }
bot.command(['start', 'menu'], dashboard);
bot.command('panel', dashboard);
bot.command('clean', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.'); const chatId = ctx.chat.id; const current = ctx.msg.message_id; for (let id = current; id > Math.max(0, current - 100); id -= 1) { try { await ctx.api.deleteMessage(chatId, id); } catch (_) {} } });
bot.command('status', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.'); const s = settingsForAdmin(); const status = watcher.status(); const lastPoll = status.lastPollAt ? new Date(status.lastPollAt).toLocaleString('ar-IQ') : 'لم تبدأ بعد'; const candidate = status.lastCandidate ? `${status.lastCandidate.symbol} — ${status.lastCandidate.mint}` : 'لا توجد عملة مطابقة بعد'; await ctx.reply(`حالة المراقب\n\nالتشغيل: ${status.running ? 'يعمل الآن' : 'متوقف'}\nالمراقبة مفعّلة: ${s.autoSniperEnabled ? 'نعم' : 'لا'}\nالقنص التجريبي: ${s.paperTradingEnabled ? 'مفعّل — شراء افتراضي وتحديث PnL عبر /pnl' : 'متوقف'}\nالتداول الحقيقي: ${effectiveLiveTrading(s) ? 'مفعّل' : 'معطّل'}\nمصدر البيانات: ${status.source}\nآخر فحص: ${lastPoll}\nآخر مرشح مطابق: ${candidate}\nآخر خطأ: ${status.lastError || 'لا يوجد'}\n\nالمراقب يعمل بصمت؛ استخدم /pnl لمراجعة المراكز.`); });
bot.command('wallet', async (ctx) => { try { const address = keypairFromSecret(userSecret()).publicKey.toBase58(); await ctx.reply(`عنوان المحفظة الرئيسية:\n${shortAddress(address)}\n\nاضغط زر النسخ لنسخ العنوان الكامل.\nلا تشارك عبارة الاسترداد أو المفتاح الخاص.`, { reply_markup: copyAddressKeyboard('نسخ عنوان المحفظة', address) }); } catch (e) { await ctx.reply(`تعذر تهيئة المحفظة.\n${e.message}`); } });
bot.command('portfolio', async (ctx) => { try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.reply(`المحفظة الاستثمارية\nالعنوان: ${shortAddress(p.address)}\nرصيد SOL: ${p.sol.toFixed(4)}\nحسابات العملات غير الفارغة: ${p.tokens.length}\n\nاضغط زر النسخ لنسخ العنوان الكامل.`, { reply_markup: copyAddressKeyboard('نسخ عنوان المحفظة', p.address) }); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة الاستثمارية.\n${e.message}`); } });
bot.command('pnl', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await sendPnl(ctx); });

function settingsText(s) { return `الإعدادات الديناميكية\nمراقبة Pump.fun: ${s.autoSniperEnabled ? 'مفعّلة' : 'متوقفة'}\nالقنص التجريبي: ${s.paperTradingEnabled ? 'مفعّل — شراء وبيع افتراضي' : 'متوقف'}\nهدف البيع التلقائي: +${s.paperTakeProfitPct}%\nالتداول الحقيقي الفعلي: ${effectiveLiveTrading(s) ? 'مفعّل' : 'معطّل — لا تُرسل معاملات'}\nالسماح من إعدادات البوت: ${s.liveTrading ? 'مفعّل' : 'معطّل'}\nحاجز البيئة LIVE_TRADING: ${config.liveTrading ? 'مفعّل' : 'معطّل'}\nحجم الصفقة: ${s.tradeSizeSol} SOL\nالحد الأقصى للصفقات اليومية: ${s.maxTradesPerDay || 'غير محدود'}\nالحد الأدنى للسيولة: ${s.minLiquiditySol || 'بدون حد'} SOL\nالحد الأقصى للقيمة السوقية: ${s.maxMarketCapUsd || 'بدون حد'} USD\nاشتراط تعطيل Mint/Freeze Authority: ${s.requireRenouncedAuthorities ? 'نعم' : 'لا'}\n\nأوامر التعديل:\n/settings live on|off\n/settings sniper on|off\n/settings paper on|off\n/settings takeprofit <٪>\n/settings size <SOL>\n/settings maxtrades <عدد أو 0>\n/settings minliq <SOL>\n/settings maxcap <USD>\n/settings authorities on|off`;
}
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.');
  const [, key, value] = ctx.message.text.trim().split(/\s+/);
  const s = settingsForAdmin();
  if (key) {
    const bool = value === 'on' ? true : value === 'off' ? false : null;
    if (['live', 'sniper', 'paper', 'authorities'].includes(key) && bool === null) return ctx.reply('استخدم on أو off.');
    if (key === 'live') s.liveTrading = bool;
    else if (key === 'sniper') s.autoSniperEnabled = bool;
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
      const closed = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: position.id, fraction: fraction === null ? 1 : fraction, jupiterUrl: config.jupiterUrl });
      return ctx.reply(`تمت محاكاة البيع بنسبة ${Math.round((fraction || 1) * 100)}٪\nالقيمة: ${closed.currentSol.toFixed(6)} SOL\nالربح/الخسارة: ${closed.pnlSol >= 0 ? '+' : ''}${closed.pnlSol.toFixed(6)} SOL (${closed.pnlPct.toFixed(2)}٪)\nلم تُرسل أي معاملة.`);
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: effectiveLiveTrading(s), priorityFeeMaxLamports: config.priorityFeeMaxLamports });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    if (result.simulated) return ctx.reply(`معاينة ${action} — الوضع التجريبي\nلم تُرسل معاملة.`, { reply_markup: tradeMenu(mint) });
    await ctx.reply(`${action} مؤكّد\nالتوقيع: ${result.signature}\n${explorer(result.signature)}`, { reply_markup: tradeMenu(mint) });
  } catch (e) { await ctx.reply(`تعذر تنفيذ ${action}.\n${e.message}`); }
}

async function sendPnl(ctx) {
  try {
    const { values, solUsd } = await refreshPositions({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
    if (!values.length) return ctx.reply('لا توجد مراكز Paper Trading مفتوحة. استخدم /buy أو شغّل القنص في الوضع التجريبي.');
    const lines = values.map((p) => p.pricingError ? `${p.mint}\nالمستثمر: ${p.investedSol.toFixed(6)} SOL\nالسعر الحالي: غير متاح مؤقتاً\nالسبب: ${p.pricingError}` : `${p.mint}\nالمستثمر: ${p.investedSol.toFixed(6)} SOL\nالقيمة الحالية: ${p.currentSol.toFixed(6)} SOL\nPnL: ${p.pnlSol >= 0 ? '+' : ''}${p.pnlSol.toFixed(6)} SOL (${p.pnlPct.toFixed(2)}٪)${solUsd ? `\nPnL بالدولار: ${(p.pnlSol * solUsd).toFixed(2)} USD` : ''}`);
    await ctx.reply(`حالة Paper Trading اللحظية\nسعر SOL: ${solUsd ? `${solUsd.toFixed(2)} USD` : 'غير متاح'}\n\n${lines.join('\n\n')}`, { reply_markup: paperMenu(values[0].id, values[0].mint) });
  } catch (error) { await ctx.reply(`تعذر تحديث PnL من بيانات السوق الحية.\n${error.message}`); }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /wallet لعرض العنوان.'); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /portfolio لعرض الأرصدة.'); });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('للمشرف: استخدم /settings لضبط الفلاتر، ثم /settings sniper on لتشغيل مراقبة Pump.fun.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا القسم متاح للمشرف فقط.'); await ctx.reply(settingsText(settingsForAdmin())); });
bot.callbackQuery('filters', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; await ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); });
bot.callbackQuery(/^filter:(curve|volume|buyers|dev|top|social|watch)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const field = ctx.match[1]; const s = settingsForAdmin(); pendingFilters.set(String(ctx.from.id), { field, value: filterValue(s, field) === 'إلزامية' ? 'on' : filterValue(s, field) === 'غير إلزامية' ? 'off' : field === 'curve' ? `${s.minCurveProgress}-${s.maxCurveProgress}` : field === 'volume' ? String(s.minVolumeUsd) : field === 'buyers' ? String(s.minUniqueBuyers) : field === 'dev' ? String(s.maxCreatorHoldingsPct) : field === 'top' ? String(s.maxTopHoldersPct) : String(s.watchlistMinutes) }); await ctx.editMessageText(`${filterLabels[field]}\n\nالقيمة الحالية: ${filterValue(s, field)}\nاختر قيمة جديدة ثم اضغط تأكيد الاختيار.`, { reply_markup: optionKeyboard(field, pendingFilters.get(String(ctx.from.id)).value) }); });
bot.callbackQuery(/^fopt:(curve|volume|buyers|dev|top|social|watch):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const field = ctx.match[1]; const value = ctx.match[2]; pendingFilters.set(String(ctx.from.id), { field, value }); const s = settingsForAdmin(); await ctx.editMessageText(`${filterLabels[field]}\n\nالاختيار المؤقت: ${value}\nاضغط تأكيد الاختيار للحفظ أو إلغاء ورجوع.`, { reply_markup: optionKeyboard(field, value) }); });
bot.callbackQuery('fconfirm', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const pending = pendingFilters.get(String(ctx.from.id)); if (!pending) return ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); const s = settingsForAdmin(); if (pending.field === 'curve') { const [min, max] = pending.value.split('-').map(Number); s.minCurveProgress = min; s.maxCurveProgress = max; } else if (pending.field === 'volume') s.minVolumeUsd = Number(pending.value); else if (pending.field === 'buyers') s.minUniqueBuyers = Number(pending.value); else if (pending.field === 'dev') s.maxCreatorHoldingsPct = Number(pending.value); else if (pending.field === 'top') s.maxTopHoldersPct = Number(pending.value); else if (pending.field === 'social') s.requireSocialLinks = pending.value === 'on'; else if (pending.field === 'watch') s.watchlistMinutes = Number(pending.value); saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); pendingFilters.delete(String(ctx.from.id)); await ctx.editMessageText(`تم حفظ ${filterLabels[pending.field]}: ${filterValue(s, pending.field)}\n\nتم تطبيق الإعداد فورياً على المراقب.`, { reply_markup: filterKeyboard(s) }); });
bot.callbackQuery('fcancel', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; pendingFilters.delete(String(ctx.from.id)); await ctx.editMessageText(filterText(settingsForAdmin()), { reply_markup: filterKeyboard(settingsForAdmin()) }); });
bot.callbackQuery(/^panel:(start|stop|buyoff|sellon|selloff|refresh|settings|details|back)$/, async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'للمشرف فقط' }); const action = ctx.match[1]; try { await ctx.answerCallbackQuery({ text: action === 'start' ? 'جارٍ التشغيل...' : 'تم' }); } catch (_) {} const s = settingsForAdmin(); s.paperPanelChatId = String(ctx.callbackQuery.message.chat.id); s.paperPanelMessageId = ctx.callbackQuery.message.message_id; try { if (action === 'start') { s.autoSniperEnabled = true; s.paperTradingEnabled = true; s.autoSellEnabled = true; watcher.updateSettings(s); watcher.start(); } if (action === 'stop') { s.autoSniperEnabled = false; s.paperTradingEnabled = false; watcher.updateSettings(s); watcher.stop(); } if (action === 'buyoff') s.paperTradingEnabled = false; if (action === 'sellon') s.autoSellEnabled = true; if (action === 'selloff') s.autoSellEnabled = false; saveSettings(config.adminId, s, config.encryptionKey); if (action === 'refresh') return ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); if (action === 'settings') return ctx.editMessageText('ضبط القنص التجريبي\nاختر الإعداد المطلوب:', { reply_markup: settingsKeyboard() }); if (action === 'details') return ctx.editMessageText(detailsText(s), { reply_markup: detailsKeyboard(s) }); if (action === 'back') return ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); await ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); } catch (error) { console.error(`Panel button ${action} error: ${error.stack || error.message}`); try { await ctx.reply(`تعذر تنفيذ الزر حالياً: ${error.message}`); } catch (_) {} } });
bot.callbackQuery(/^cfg:(allocation|daily|profit|sizing|confirm)$/, async (ctx) => { try { await ctx.answerCallbackQuery(); } catch (_) {} if (!isAdmin(ctx)) return; const page = ctx.match[1]; if (page === 'allocation') return ctx.editMessageText('اختر نسبة الصفقة من رأس المال الافتراضي 1 SOL:', { reply_markup: allocationKeyboard() }); if (page === 'daily') return ctx.editMessageText('اختر الحد الأقصى للصفقات في اليوم:', { reply_markup: dailyKeyboard() }); if (page === 'profit') return ctx.editMessageText('اختر نسبة الربح التي عندها يتم البيع التلقائي:', { reply_markup: profitKeyboard() }); if (page === 'sizing') return ctx.editMessageText('اختر طريقة حساب رأس المال:', { reply_markup: sizingKeyboard() }); const s = settingsForAdmin(); s.autoSniperEnabled = true; s.paperTradingEnabled = true; s.autoSellEnabled = true; s.paperPanelChatId = String(ctx.chat.id); s.paperPanelMessageId = ctx.callbackQuery.message.message_id; try { saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); watcher.start(); await ctx.editMessageText(panelText(s), { reply_markup: panelKeyboard(s) }); } catch (error) { console.error(`Start confirmation error: ${error.stack || error.message}`); await ctx.reply(`تعذر تشغيل القنص: ${error.message}`); } });
bot.callbackQuery(/^set:(allocation|daily|profit|sizing):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return; const [, key, value] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'allocation') { s.paperAllocationPct = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText('تم حفظ حجم الصفقة. اختر عدد الصفقات اليومية:', { reply_markup: dailyKeyboard() }); } if (key === 'daily') { s.maxTradesPerDay = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText('تم حفظ الحد اليومي. اختر هدف الربح والبيع:', { reply_markup: profitKeyboard() }); } if (key === 'profit') { s.paperTakeProfitPct = Number(value); saveSettings(config.adminId, s, config.encryptionKey); return ctx.editMessageText('تم حفظ هدف الربح. اختر نمط حجم الصفقة:', { reply_markup: sizingKeyboard() }); } s.paperSizingMode = value; saveSettings(config.adminId, s, config.encryptionKey); await ctx.editMessageText('تم حفظ نمط الصفقة. اضغط تأكيد البدء للانطلاق.', { reply_markup: settingsKeyboard() }); });
bot.callbackQuery(/^watcher:(on|off|status)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const action = ctx.callbackQuery.data.split(':')[1]; const s = settingsForAdmin(); if (action === 'on') { s.autoSniperEnabled = true; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); watcher.start(); return ctx.reply('تم تشغيل مراقب Pump.fun.', { reply_markup: controlMenu(true, s.paperTradingEnabled) }); } if (action === 'off') { s.autoSniperEnabled = false; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); watcher.stop(); return ctx.reply('تم إيقاف مراقب Pump.fun.', { reply_markup: controlMenu(false, s.paperTradingEnabled) }); } const status = watcher.status(); await ctx.reply(`حالة المراقب: ${status.running ? 'يعمل الآن' : 'متوقف'}\nآخر فحص: ${status.lastPollAt ? new Date(status.lastPollAt).toLocaleString('ar-IQ') : 'لم يبدأ بعد'}\nآخر خطأ: ${status.lastError || 'لا يوجد'}`, { reply_markup: controlMenu(s.autoSniperEnabled, s.paperTradingEnabled) }); });
bot.callbackQuery(/^paper:(on|off)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const s = settingsForAdmin(); s.paperTradingEnabled = ctx.match[1] === 'on'; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); await ctx.reply(s.paperTradingEnabled ? 'تم تشغيل الشراء والبيع التجريبي التلقائي. سيشتري فقط بعد الفلترة ويبيع عند هدف الربح.' : 'تم إيقاف الشراء والبيع التجريبي التلقائي. لم يتم تفعيل التداول الحقيقي.', { reply_markup: controlMenu(s.autoSniperEnabled, s.paperTradingEnabled) }); });
bot.callbackQuery(/^toggle:(sniper|live)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, key] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'sniper') s.autoSniperEnabled = !s.autoSniperEnabled; else s.liveTrading = !s.liveTrading; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (s.autoSniperEnabled) watcher.start(); else watcher.stop(); await ctx.reply(settingsText(s)); });
bot.callbackQuery(/^(b|s):([^:]+):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, action, token, value] = ctx.callbackQuery.data.split(':'); const mint = tradeTokens.get(token); if (!mint) return ctx.reply('انتهت صلاحية هذا الزر. استخدم /pnl أو أعد طلب العملة.'); const side = action === 'b' ? 'buy' : 'sell'; await trade(ctx, side, mint, side === 'buy' ? value : null, side === 'sell' ? Number(value) : null); });
bot.callbackQuery(/^p:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); if (!paperTokens.has(ctx.match[1])) return ctx.reply('انتهت صلاحية هذا الزر. استخدم /pnl من جديد.'); await sendPnl(ctx); });
bot.callbackQuery(/^ps:(.+):(0\.5|1)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const id = paperTokens.get(ctx.match[1]); const fraction = ctx.match[2]; if (!id) return ctx.reply('انتهت صلاحية هذا الزر. استخدم /pnl من جديد.'); try { const result = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: id, fraction: Number(fraction), jupiterUrl: config.jupiterUrl }); await ctx.reply(`تمت محاكاة البيع بنسبة ${Number(fraction) * 100}٪\nالقيمة: ${result.currentSol.toFixed(6)} SOL\nPnL: ${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(6)} SOL (${result.pnlPct.toFixed(2)}٪)`); } catch (error) { await ctx.reply(`تعذر محاكاة البيع.\n${error.message}`); } });

let lastSniperErrorAt = 0;
let paperMonitorBusy = false;
const watcher = new PumpFunWatcher({ adminId: config.adminId, settings: settingsForAdmin(), onError: (e) => console.error(`Pump.fun watcher error: ${e.message}`), onFilter: (candidate, reason) => { const s = settingsForAdmin(); s.lastFilterResult = `${candidate.symbol || candidate.mint}: مرفوض — ${reason}`; saveSettings(config.adminId, s, config.encryptionKey); updatePanel(s); }, onCandidate: async (candidate) => {
  const s = settingsForAdmin(); s.lastMint = candidate.mint; saveSettings(config.adminId, s, config.encryptionKey);
  if (!s.autoSniperEnabled) return;
  if (!canTrade(s)) return;
  if (!s.paperTradingEnabled && !effectiveLiveTrading(s)) return;
  try {
    const amountSol = paperTradeAmount(s);
    if (!effectiveLiveTrading(s) && (amountSol <= 0 || Number(s.paperAvailableSol) < amountSol)) return;
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, outputMint: candidate.mint, amountLamports: Math.round(amountSol * 1e9), slippageBps: 100 });
    if (!effectiveLiveTrading(s)) {
      await getQuote({ jupiterUrl: config.jupiterUrl, inputMint: candidate.mint, outputMint: SOL_MINT, amountLamports: Number(quote.outAmount), slippageBps: 100 });
      const position = await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint: candidate.mint, investedSol: amountSol, quote, metadata: candidate });
      s.paperAvailableSol = Number(s.paperAvailableSol) - amountSol; s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
      const tokenAmount = Number(quote.outAmount) / (10 ** Number(candidate.decimals ?? 6)); const unitPrice = amountSol / tokenAmount; s.paperEvents = [...(s.paperEvents || []), { type: 'شراء', name: `${candidate.name} (${candidate.symbol})`, mint: candidate.mint, detail: `${amountSol.toFixed(4)} SOL | ${tokenAmount.toLocaleString()} Token | سعر الوحدة ${unitPrice.toFixed(12)} SOL | سيولة ${candidate.liquiditySol.toFixed(2)} SOL` }].slice(-10);
      saveSettings(config.adminId, s, config.encryptionKey); await updatePanel(s);
      return;
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: effectiveLiveTrading(s), priorityFeeMaxLamports: config.priorityFeeMaxLamports });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    const status = result.simulated ? 'معاينة تجريبية — لم تُرسل معاملة' : `تم التنفيذ\n${explorer(result.signature)}`;
    console.log(`Auto-sniper trade completed for ${candidate.mint}: ${status}`);
  } catch (error) { const now = Date.now(); console.error(`Auto-sniper quote error: ${error.message}`); if (now - lastSniperErrorAt >= 600000) lastSniperErrorAt = now; }
}});
async function monitorPaperPositions() {
  const s = settingsForAdmin();
  if (paperMonitorBusy || effectiveLiveTrading(s) || !s.autoSellEnabled) return;
  paperMonitorBusy = true;
  try {
    const { values } = await refreshPositions({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
    for (const value of values) {
      if (value.pricingError) continue;
      const stopLoss = Number(s.paperStopLossPct || 15); const firstTarget = Number(s.paperTakeProfitFirstPct || 30); const finalTarget = Number(s.paperTakeProfitFinalPct || 60);
      const fraction = value.pnlPct <= -stopLoss ? 1 : value.pnlPct >= finalTarget ? 1 : (value.pnlPct >= firstTarget && !value.tp1Sold ? 0.5 : 0);
      if (!fraction) continue;
      const reason = value.pnlPct <= -stopLoss ? `وقف خسارة -${stopLoss}%` : (fraction === 0.5 ? `جني ربح +${firstTarget}% — بيع 50%` : `جني ربح +${finalTarget}% — إغلاق الباقي`);
      const sold = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: value.id, fraction, jupiterUrl: config.jupiterUrl });
      const positionAfter = getPositions(config.adminId, config.encryptionKey).find((p) => p.id === value.id); if (fraction < 1 && positionAfter) { positionAfter.tp1Sold = true; const user = getUser(config.adminId, config.encryptionKey); saveUser(config.adminId, { ...user, paperPositions: getPositions(config.adminId, config.encryptionKey) }, config.encryptionKey); }
      s.paperAvailableSol = Number(s.paperAvailableSol) + sold.currentSol; s.paperPnlSol = Number(s.paperPnlSol || 0) + sold.pnlSol; s.paperEvents = [...(s.paperEvents || []), { type: 'بيع', name: `${value.name} (${value.symbol})`, mint: value.mint, detail: `${reason} | ${sold.currentSol.toFixed(4)} SOL | ربح/خسارة ${sold.pnlSol.toFixed(4)} SOL (${sold.pnlPct.toFixed(1)}٪)` }].slice(-10); saveSettings(config.adminId, s, config.encryptionKey); await updatePanel(s);
    }
  } catch (error) { console.error(`Paper position monitor error: ${error.message}`); }
  finally { paperMonitorBusy = false; }
}
setInterval(monitorPaperPositions, 30000);
function startWatcher() { if (settingsForAdmin().autoSniperEnabled) { console.log('Pump.fun watcher started; polling every 30 seconds'); watcher.start(); } }
module.exports = bot;
module.exports.startWatcher = startWatcher;
module.exports.watcher = watcher;
