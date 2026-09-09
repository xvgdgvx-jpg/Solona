const { Bot, InlineKeyboard } = require('grammy');
const config = require('../config');
const { getQuote, getTokenAmount, executeSwap, getPortfolio, SOL_MINT, keypairFromSecret } = require('../services/solana');

const bot = new Bot(config.token);
const menu = () => new InlineKeyboard()
  .text('المحفظة', 'wallet').text('المحفظة الاستثمارية', 'portfolio').row()
  .text('اقتناص عملة', 'snipe').text('الإعدادات', 'settings');
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;

async function dashboard(ctx) {
  await ctx.reply(`مُقتنص عملات Solana\nوضع التشغيل: ${config.liveTrading ? 'تداول حقيقي — راجع إعدادات المخاطر' : 'تجريبي — لن تُرسل أي معاملات'}\nاختر إجراءً من القائمة:`, { reply_markup: menu() });
}
bot.command(['start', 'menu'], dashboard);

bot.command('wallet', async (ctx) => {
  try {
    const address = keypairFromSecret(userSecret()).publicKey.toBase58();
    await ctx.reply(`عنوان المحفظة الرئيسية:\n${address}\n\nلا ترسل مفاتيحك الخاصة إلى أي شخص.`);
  } catch (error) {
    await ctx.reply(`تعذر تهيئة المحفظة.\n${error.message}`);
  }
});

bot.command('portfolio', async (ctx) => {
  try {
    const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() });
    await ctx.reply(`المحفظة الاستثمارية\nالعنوان: ${p.address}\nرصيد SOL: ${p.sol.toFixed(4)}\nعدد حسابات العملات غير الفارغة: ${p.tokens.length}`);
  } catch (error) {
    await ctx.reply(`تعذر تحميل المحفظة الاستثمارية.\n${error.message}`);
  }
});

bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للمشرف فقط.');
  await ctx.reply(`الإعدادات الحالية\nالتداول الحقيقي: ${config.liveTrading ? 'مفعّل' : 'معطّل — الوضع التجريبي'}\nالانزلاق السعري: 100 نقطة أساس\nتُدار إعدادات التنفيذ من متغيرات بيئة الخادم.`);
});

bot.command('snipe', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة للتحكم في التداول.');
  await ctx.reply('لشراء عملة، أرسل:\n/buy <عنوان_العملة> <مقدار_SOL>\n\nمثال:\n/buy 9xQeWvG816bUx9EPf5sG4xJt8hNfL3pQzR2aB7cD6eF 0.1\n\nالحد الأقصى للطلب الواحد: 10 SOL.', { reply_markup: menu() });
});
bot.command('buy', async (ctx) => trade(ctx, 'buy'));
bot.command('sell', async (ctx) => trade(ctx, 'sell'));

async function trade(ctx, side) {
  if (!isAdmin(ctx)) return ctx.reply('صلاحية المشرف مطلوبة لتنفيذ التداول.');
  const [, mint, amountText] = ctx.message.text.trim().split(/\s+/);
  const amount = Number(amountText);
  const action = side === 'buy' ? 'شراء' : 'بيع';
  if (!mint || !Number.isFinite(amount) || amount <= 0 || amount > 10) {
    return ctx.reply(`صيغة الأمر غير صحيحة.\nاستخدم: /${side} <عنوان_العملة> <${side === 'buy' ? 'مقدار_SOL' : 'مقدار_العملة'}>\nالحد الأقصى: 10.`);
  }
  try {
    const tokenSide = side === 'sell';
    const inputAmount = tokenSide
      ? await getTokenAmount({ rpcUrl: config.rpcUrl, ownerSecret: userSecret(), mint, uiAmount: amount })
      : { raw: Math.round(amount * 1e9) };
    const quote = await getQuote({
      jupiterUrl: config.jupiterUrl,
      inputMint: tokenSide ? mint : SOL_MINT,
      outputMint: tokenSide ? SOL_MINT : mint,
      amountLamports: inputAmount.raw,
      slippageBps: 100
    });
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: config.liveTrading });
    if (result.simulated) return ctx.reply(`معاينة ${action} — وضع تجريبي\nعنوان المحفظة: ${result.wallet}\nلم تُرسل أي معاملة إلى الشبكة.`);
    await ctx.reply(`${action} مؤكّد بنجاح\nتوقيع المعاملة: ${result.signature}\nرابط Solscan: ${explorer(result.signature)}`);
  } catch (error) {
    await ctx.reply(`تعذر تنفيذ ${action}.\n${error.message}`);
  }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('لعرض عنوان المحفظة، استخدم الأمر /wallet'); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('لعرض الأرصدة، استخدم الأمر /portfolio'); });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('للمشرف: استخدم /buy <عنوان_العملة> <مقدار_SOL> لتنفيذ معاينة شراء.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(isAdmin(ctx) ? 'الإعدادات تُدار من بيئة النشر.' : 'هذا القسم متاح للمشرف فقط.'); });
bot.catch((error) => console.error('Telegram bot error:', error.error));
module.exports = bot;
