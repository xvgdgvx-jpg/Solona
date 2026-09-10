const { Bot, InlineKeyboard } = require('grammy');
const config = require('../config');
const { getQuote, getTokenAmount, getTokenBalance, executeSwap, getPortfolio, SOL_MINT, keypairFromSecret } = require('../services/solana');
const { getSettings, saveSettings, canTrade } = require('../services/settings');
const { PumpFunWatcher } = require('../services/pumpfun');
const { openPosition, refreshPositions, closePosition, getPositions } = require('../services/paper');

const bot = new Bot(config.token);
const menu = () => new InlineKeyboard().text('المحفظة', 'wallet').text('المحفظة الاستثمارية', 'portfolio').row().text('اقتناص Pump.fun', 'snipe').text('الإعدادات', 'settings');
const tradeMenu = (mint) => new InlineKeyboard().text('شراء 0.1 SOL', `buy:${mint}:0.1`).text('شراء 0.5 SOL', `buy:${mint}:0.5`).row().text('بيع 50٪', `sell:${mint}:0.5`).text('بيع 100٪', `sell:${mint}:1`);
const paperMenu = (id) => new InlineKeyboard().text('تحديث السعر وPnL', `pnl:${id}`).row().text('بيع محاكاة 50٪', `paper-sell:${id}:0.5`).text('بيع محاكاة 100٪', `paper-sell:${id}:1`);
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;
const settingsForAdmin = () => getSettings(config.adminId, config.encryptionKey);
const effectiveLiveTrading = (settings) => Boolean(config.liveTrading && settings.liveTrading);

async function dashboard(ctx) { const s = settingsForAdmin(); await ctx.reply(`مُقتنص عملات Solana\nالوضع: ${effectiveLiveTrading(s) ? 'تداول حقيقي' : 'Paper Trading — لا تُرسل معاملات'}\nالمراقب: ${s.autoSniperEnabled ? 'مفعّل' : 'متوقف'}\nاختر إجراءً:`, { reply_markup: menu() }); }
bot.command(['start', 'menu'], dashboard);
bot.command('wallet', async (ctx) => { try { await ctx.reply(`عنوان المحفظة الرئيسية:\n${keypairFromSecret(userSecret()).publicKey.toBase58()}\n\nلا تشارك عبارة الاسترداد أو المفتاح الخاص.`); } catch (e) { await ctx.reply(`تعذر تهيئة المحفظة.\n${e.message}`); } });
bot.command('portfolio', async (ctx) => { try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.reply(`المحفظة الاستثمارية\nالعنوان: ${p.address}\nرصيد SOL: ${p.sol.toFixed(4)}\nحسابات العملات غير الفارغة: ${p.tokens.length}`); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة الاستثمارية.\n${e.message}`); } });
bot.command('pnl', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await sendPnl(ctx); });

function settingsText(s) { return `الإعدادات الديناميكية\nمراقبة Pump.fun: ${s.autoSniperEnabled ? 'مفعّلة' : 'متوقفة'}\nالتداول الحقيقي الفعلي: ${effectiveLiveTrading(s) ? 'مفعّل' : 'معطّل — Paper Trading'}\nالسماح من إعدادات البوت: ${s.liveTrading ? 'مفعّل' : 'معطّل'}\nحاجز البيئة LIVE_TRADING: ${config.liveTrading ? 'مفعّل' : 'معطّل'}\nحجم الصفقة: ${s.tradeSizeSol} SOL\nالحد الأقصى للصفقات اليومية: ${s.maxTradesPerDay || 'غير محدود'}\nالحد الأدنى للسيولة: ${s.minLiquiditySol || 'بدون حد'} SOL\nالحد الأقصى للقيمة السوقية: ${s.maxMarketCapUsd || 'بدون حد'} USD\nاشتراط تعطيل Mint/Freeze Authority: ${s.requireRenouncedAuthorities ? 'نعم' : 'لا'}\n\nأوامر التعديل:\n/settings live on|off\n/settings sniper on|off\n/settings size <SOL>\n/settings maxtrades <عدد أو 0>\n/settings minliq <SOL>\n/settings maxcap <USD>\n/settings authorities on|off`;
}
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.');
  const [, key, value] = ctx.message.text.trim().split(/\s+/);
  const s = settingsForAdmin();
  if (key) {
    const bool = value === 'on' ? true : value === 'off' ? false : null;
    if (['live', 'sniper', 'authorities'].includes(key) && bool === null) return ctx.reply('استخدم on أو off.');
    if (key === 'live') s.liveTrading = bool;
    else if (key === 'sniper') s.autoSniperEnabled = bool;
    else if (key === 'authorities') s.requireRenouncedAuthorities = bool;
    else if (key === 'size' && Number(value) > 0) s.tradeSizeSol = Number(value);
    else if (key === 'maxtrades' && Number(value) >= 0) s.maxTradesPerDay = Number(value);
    else if (key === 'minliq' && Number(value) >= 0) s.minLiquiditySol = Number(value);
    else if (key === 'maxcap' && Number(value) >= 0) s.maxMarketCapUsd = Number(value);
    else if (!['live', 'sniper', 'authorities', 'size', 'maxtrades', 'minliq', 'maxcap'].includes(key)) return ctx.reply('إعداد غير معروف.');
    saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (s.autoSniperEnabled) watcher.start(); else watcher.stop();
  }
  await ctx.reply(settingsText(s), { reply_markup: new InlineKeyboard().text(s.autoSniperEnabled ? 'إيقاف المراقب' : 'تشغيل المراقب', 'toggle:sniper').text(s.liveTrading ? 'تعطيل الحقيقي' : 'تفعيل الحقيقي', 'toggle:live') });
});

bot.command('snipe', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await ctx.reply('المراقبة للمشرف فقط وتستهدف Pump.fun. عدّل الفلاتر ثم استخدم /settings sniper on لتشغيلها.\nالوضع التجريبي يستخدم بيانات حقيقية ولا يرسل معاملات.\nللشراء: /buy <عنوان_العملة> <مقدار_SOL>\nلعرض PnL اللحظي: /pnl'); });
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
        return ctx.reply(`تمت محاكاة الشراء ببيانات حقيقية من Jupiter\nالعنوان: ${mint}\nالمبلغ الافتراضي: ${amount} SOL\nالقيمة الحالية: ${value.currentSol.toFixed(6)} SOL\nPnL: ${value.pnlSol >= 0 ? '+' : ''}${value.pnlSol.toFixed(6)} SOL (${value.pnlPct.toFixed(2)}٪)\nلم تُرسل أي معاملة.`, { reply_markup: paperMenu(position.id) });
      }
      const position = getPositions(config.adminId, config.encryptionKey).find((p) => p.mint === mint && p.status === 'open');
      if (!position) return ctx.reply('لا يوجد مركز Paper Trading مفتوح لهذه العملة.');
      const closed = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: position.id, fraction: fraction === null ? 1 : fraction, jupiterUrl: config.jupiterUrl });
      return ctx.reply(`تمت محاكاة البيع بنسبة ${Math.round((fraction || 1) * 100)}٪\nالقيمة: ${closed.currentSol.toFixed(6)} SOL\nالربح/الخسارة: ${closed.pnlSol >= 0 ? '+' : ''}${closed.pnlSol.toFixed(6)} SOL (${closed.pnlPct.toFixed(2)}٪)\nلم تُرسل أي معاملة.`);
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: effectiveLiveTrading(s) });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    if (result.simulated) return ctx.reply(`معاينة ${action} — الوضع التجريبي\nلم تُرسل معاملة.`, { reply_markup: tradeMenu(mint) });
    await ctx.reply(`${action} مؤكّد\nالتوقيع: ${result.signature}\n${explorer(result.signature)}`, { reply_markup: tradeMenu(mint) });
  } catch (e) { await ctx.reply(`تعذر تنفيذ ${action}.\n${e.message}`); }
}

async function sendPnl(ctx) {
  try {
    const { values, solUsd } = await refreshPositions({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl });
    if (!values.length) return ctx.reply('لا توجد مراكز Paper Trading مفتوحة. استخدم /buy أو شغّل القنص في الوضع التجريبي.');
    const lines = values.map((p) => `${p.mint}\nالمستثمر: ${p.investedSol.toFixed(6)} SOL\nالقيمة الحالية: ${p.currentSol.toFixed(6)} SOL\nPnL: ${p.pnlSol >= 0 ? '+' : ''}${p.pnlSol.toFixed(6)} SOL (${p.pnlPct.toFixed(2)}٪)${solUsd ? `\nPnL بالدولار: ${(p.pnlSol * solUsd).toFixed(2)} USD` : ''}`);
    await ctx.reply(`حالة Paper Trading اللحظية\nسعر SOL: ${solUsd ? `${solUsd.toFixed(2)} USD` : 'غير متاح'}\n\n${lines.join('\n\n')}`, { reply_markup: paperMenu(values[0].id) });
  } catch (error) { await ctx.reply(`تعذر تحديث PnL من بيانات السوق الحية.\n${error.message}`); }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /wallet لعرض العنوان.'); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /portfolio لعرض الأرصدة.'); });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('للمشرف: استخدم /settings لضبط الفلاتر، ثم /settings sniper on لتشغيل مراقبة Pump.fun.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا القسم متاح للمشرف فقط.'); await ctx.reply(settingsText(settingsForAdmin())); });
bot.callbackQuery(/^toggle:(sniper|live)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, key] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'sniper') s.autoSniperEnabled = !s.autoSniperEnabled; else s.liveTrading = !s.liveTrading; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (s.autoSniperEnabled) watcher.start(); else watcher.stop(); await ctx.reply(settingsText(s)); });
bot.callbackQuery(/^(buy|sell):([^:]+):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, side, mint, value] = ctx.callbackQuery.data.split(':'); await trade(ctx, side, mint, side === 'buy' ? value : null, side === 'sell' ? Number(value) : null); });
bot.callbackQuery(/^pnl:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); await sendPnl(ctx); });
bot.callbackQuery(/^paper-sell:(.+):(0\.5|1)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const match = ctx.callbackQuery.data.match(/^paper-sell:(.+):(0\.5|1)$/); const id = match[1]; const fraction = match[2]; try { const result = await closePosition({ adminId: config.adminId, key: config.encryptionKey, positionId: id, fraction: Number(fraction), jupiterUrl: config.jupiterUrl }); await ctx.reply(`تمت محاكاة البيع بنسبة ${Number(fraction) * 100}٪\nالقيمة: ${result.currentSol.toFixed(6)} SOL\nPnL: ${result.pnlSol >= 0 ? '+' : ''}${result.pnlSol.toFixed(6)} SOL (${result.pnlPct.toFixed(2)}٪)`); } catch (error) { await ctx.reply(`تعذر محاكاة البيع.\n${error.message}`); } });

const watcher = new PumpFunWatcher({ adminId: config.adminId, settings: settingsForAdmin(), onError: (e) => console.error(`Pump.fun watcher error: ${e.message}`), onCandidate: async (candidate) => {
  const s = settingsForAdmin(); s.lastMint = candidate.mint; saveSettings(config.adminId, s, config.encryptionKey);
  if (!s.autoSniperEnabled) return;
  if (!canTrade(s)) return bot.api.sendMessage(config.adminId, 'تم إيقاف القنص تلقائياً بسبب بلوغ حد الصفقات اليومية.');
  try {
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, outputMint: candidate.mint, amountLamports: Math.round(s.tradeSizeSol * 1e9), slippageBps: 100 });
    if (!effectiveLiveTrading(s)) {
      const position = await openPosition({ adminId: config.adminId, key: config.encryptionKey, jupiterUrl: config.jupiterUrl, mint: candidate.mint, investedSol: s.tradeSizeSol, quote });
      s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
      return bot.api.sendMessage(config.adminId, `قنص تجريبي ببيانات حقيقية من Pump.fun/Jupiter\n${candidate.name} (${candidate.symbol})\nالعنوان: ${candidate.mint}\nالمبلغ الافتراضي: ${s.tradeSizeSol} SOL\nلم تُرسل أي معاملة.`, { reply_markup: paperMenu(position.id) });
    }
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: effectiveLiveTrading(s) });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    const status = result.simulated ? 'معاينة تجريبية — لم تُرسل معاملة' : `تم التنفيذ\n${explorer(result.signature)}`;
    await bot.api.sendMessage(config.adminId, `قنص آلي من Pump.fun\n${candidate.name} (${candidate.symbol})\nالعنوان: ${candidate.mint}\nحجم الصفقة: ${s.tradeSizeSol} SOL\n${status}`, { reply_markup: tradeMenu(candidate.mint) });
  } catch (error) { await bot.api.sendMessage(config.adminId, `فشل القنص الآلي لهذه العملة:\n${error.message}`); }
}});
function startWatcher() { if (settingsForAdmin().autoSniperEnabled) watcher.start(); }
module.exports = bot;
module.exports.startWatcher = startWatcher;
module.exports.watcher = watcher;
