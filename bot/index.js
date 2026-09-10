const { Bot, InlineKeyboard } = require('grammy');
const config = require('../config');
const { getQuote, getTokenAmount, getTokenBalance, executeSwap, getPortfolio, SOL_MINT, keypairFromSecret } = require('../services/solana');
const { getSettings, saveSettings, canTrade } = require('../services/settings');
const { PumpFunWatcher } = require('../services/pumpfun');

const bot = new Bot(config.token);
const menu = () => new InlineKeyboard().text('المحفظة', 'wallet').text('المحفظة الاستثمارية', 'portfolio').row().text('اقتناص Pump.fun', 'snipe').text('الإعدادات', 'settings');
const tradeMenu = (mint) => new InlineKeyboard().text('شراء 0.1 SOL', `buy:${mint}:0.1`).text('شراء 0.5 SOL', `buy:${mint}:0.5`).row().text('بيع 50٪', `sell:${mint}:0.5`).text('بيع 100٪', `sell:${mint}:1`);
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;
const settingsForAdmin = () => getSettings(config.adminId, config.encryptionKey);

async function dashboard(ctx) { await ctx.reply(`مُقتنص عملات Solana\nالوضع: ${settingsForAdmin().liveTrading ? 'تداول حقيقي' : 'تجريبي — لا تُرسل معاملات'}\nالمراقب: ${settingsForAdmin().autoSniperEnabled ? 'مفعّل' : 'متوقف'}\nاختر إجراءً:`, { reply_markup: menu() }); }
bot.command(['start', 'menu'], dashboard);
bot.command('wallet', async (ctx) => { try { await ctx.reply(`عنوان المحفظة الرئيسية:\n${keypairFromSecret(userSecret()).publicKey.toBase58()}\n\nلا تشارك عبارة الاسترداد أو المفتاح الخاص.`); } catch (e) { await ctx.reply(`تعذر تهيئة المحفظة.\n${e.message}`); } });
bot.command('portfolio', async (ctx) => { try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.reply(`المحفظة الاستثمارية\nالعنوان: ${p.address}\nرصيد SOL: ${p.sol.toFixed(4)}\nحسابات العملات غير الفارغة: ${p.tokens.length}`); } catch (e) { await ctx.reply(`تعذر تحميل المحفظة الاستثمارية.\n${e.message}`); } });

function settingsText(s) { return `الإعدادات الديناميكية\nمراقبة Pump.fun: ${s.autoSniperEnabled ? 'مفعّلة' : 'متوقفة'}\nالتداول الحقيقي: ${s.liveTrading ? 'مفعّل' : 'معطّل — تجريبي'}\nحجم الصفقة: ${s.tradeSizeSol} SOL\nالحد الأقصى للصفقات اليومية: ${s.maxTradesPerDay || 'غير محدود'}\nالحد الأدنى للسيولة: ${s.minLiquiditySol || 'بدون حد'} SOL\nالحد الأقصى للقيمة السوقية: ${s.maxMarketCapUsd || 'بدون حد'} USD\nاشتراط تعطيل Mint/Freeze Authority: ${s.requireRenouncedAuthorities ? 'نعم' : 'لا'}\n\nأوامر التعديل:\n/settings live on|off\n/settings sniper on|off\n/settings size <SOL>\n/settings maxtrades <عدد أو 0>\n/settings minliq <SOL>\n/settings maxcap <USD>\n/settings authorities on|off`;
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

bot.command('snipe', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة.'); await ctx.reply('المراقبة للمشرف فقط وتستهدف Pump.fun. عدّل الفلاتر ثم استخدم /settings sniper on لتشغيلها.\nللشراء اليدوي: /buy <عنوان_العملة> <مقدار_SOL>'); });
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
    const inputAmount = tokenSide ? (fraction === null ? await getTokenAmount({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint, uiAmount: amount }) : await getTokenBalance({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint, fraction })) : { raw: Math.round(amount * 1e9) };
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, inputMint: tokenSide ? mint : SOL_MINT, outputMint: tokenSide ? SOL_MINT : mint, amountLamports: inputAmount.raw, slippageBps: 100 });
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: s.liveTrading });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    if (result.simulated) return ctx.reply(`معاينة ${action} — الوضع التجريبي\nلم تُرسل معاملة.`, { reply_markup: tradeMenu(mint) });
    await ctx.reply(`${action} مؤكّد\nالتوقيع: ${result.signature}\n${explorer(result.signature)}`, { reply_markup: tradeMenu(mint) });
  } catch (e) { await ctx.reply(`تعذر تنفيذ ${action}.\n${e.message}`); }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /wallet لعرض العنوان.'); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('استخدم /portfolio لعرض الأرصدة.'); });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('للمشرف: استخدم /settings لضبط الفلاتر، ثم /settings sniper on لتشغيل مراقبة Pump.fun.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا القسم متاح للمشرف فقط.'); await ctx.reply(settingsText(settingsForAdmin())); });
bot.callbackQuery(/^toggle:(sniper|live)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, key] = ctx.callbackQuery.data.split(':'); const s = settingsForAdmin(); if (key === 'sniper') s.autoSniperEnabled = !s.autoSniperEnabled; else s.liveTrading = !s.liveTrading; saveSettings(config.adminId, s, config.encryptionKey); watcher.updateSettings(s); if (s.autoSniperEnabled) watcher.start(); else watcher.stop(); await ctx.reply(settingsText(s)); });
bot.callbackQuery(/^(buy|sell):([^:]+):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!isAdmin(ctx)) return ctx.reply('هذا الزر متاح للمشرف فقط.'); const [, side, mint, value] = ctx.callbackQuery.data.split(':'); await trade(ctx, side, mint, side === 'buy' ? value : null, side === 'sell' ? Number(value) : null); });

const watcher = new PumpFunWatcher({ adminId: config.adminId, settings: settingsForAdmin(), onError: (e) => console.error(`Pump.fun watcher error: ${e.message}`), onCandidate: async (candidate) => {
  const s = settingsForAdmin(); s.lastMint = candidate.mint; saveSettings(config.adminId, s, config.encryptionKey);
  if (!s.autoSniperEnabled) return;
  if (!canTrade(s)) return bot.api.sendMessage(config.adminId, 'تم إيقاف القنص تلقائياً بسبب بلوغ حد الصفقات اليومية.');
  try {
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, outputMint: candidate.mint, amountLamports: Math.round(s.tradeSizeSol * 1e9), slippageBps: 100 });
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: s.liveTrading });
    s.tradesToday += 1; saveSettings(config.adminId, s, config.encryptionKey);
    const status = result.simulated ? 'معاينة تجريبية — لم تُرسل معاملة' : `تم التنفيذ\n${explorer(result.signature)}`;
    await bot.api.sendMessage(config.adminId, `قنص آلي من Pump.fun\n${candidate.name} (${candidate.symbol})\nالعنوان: ${candidate.mint}\nحجم الصفقة: ${s.tradeSizeSol} SOL\n${status}`, { reply_markup: tradeMenu(candidate.mint) });
  } catch (error) { await bot.api.sendMessage(config.adminId, `فشل القنص الآلي لهذه العملة:\n${error.message}`); }
}});
function startWatcher() { if (settingsForAdmin().autoSniperEnabled) watcher.start(); }
module.exports = bot;
module.exports.startWatcher = startWatcher;
module.exports.watcher = watcher;
