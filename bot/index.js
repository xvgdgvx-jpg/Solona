const { Bot, InlineKeyboard } = require('grammy');
const config = require('../config');
const { getQuote, executeSwap, getPortfolio, SOL_MINT } = require('../services/solana');
const { getUser, saveUser } = require('../services/storage');

const bot = new Bot(config.token);
const menu = () => new InlineKeyboard().text('Wallet', 'wallet').text('Portfolio', 'portfolio').row().text('Snipe', 'snipe').text('Settings', 'settings');
const isAdmin = (ctx) => String(ctx.from?.id) === config.adminId;
const userSecret = () => config.masterPrivateKey;
const explorer = (sig) => `https://solscan.io/tx/${sig}`;

async function dashboard(ctx) { await ctx.reply(`Solana Meme Sniper\nMode: ${config.liveTrading ? 'LIVE (review risk controls)' : 'DRY RUN'}\nChoose an action:`, { reply_markup: menu() }); }
bot.command(['start', 'menu'], dashboard);
bot.command('wallet', async (ctx) => { const { keypairFromSecret } = require('../services/solana'); await ctx.reply(`Master wallet: ${keypairFromSecret(userSecret()).publicKey.toBase58()}`); });
bot.command('portfolio', async (ctx) => { try { const p = await getPortfolio({ rpcUrl: config.rpcUrl, secret: userSecret() }); await ctx.reply(`Wallet: ${p.address}\nSOL: ${p.sol.toFixed(4)}\nNon-zero token accounts: ${p.tokens.length}`); } catch (e) { await ctx.reply(`Portfolio unavailable: ${e.message}`); } });
bot.command('settings', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('Admin authorization required.'); await ctx.reply(`Live trading: ${config.liveTrading}\nSlippage: 100 bps\nExecution is controlled by deployment environment.`); });
bot.command('snipe', async (ctx) => { if (!isAdmin(ctx)) return ctx.reply('Admin authorization required for trade controls.'); await ctx.reply('Enter a token mint with /buy <MINT> <SOL_AMOUNT>, or use the menu.', { reply_markup: menu() }); });
bot.command('buy', async (ctx) => trade(ctx, 'buy'));
bot.command('sell', async (ctx) => trade(ctx, 'sell'));

async function trade(ctx, side) {
  if (!isAdmin(ctx)) return ctx.reply('Admin authorization required for trading.');
  const [, mint, amountText] = ctx.message.text.trim().split(/\s+/);
  const amountSol = Number(amountText);
  if (!mint || !Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 10) return ctx.reply(`Usage: /${side} <TOKEN_MINT> <SOL_AMOUNT>, max 10 SOL per request.`);
  try {
    const quote = await getQuote({ jupiterUrl: config.jupiterUrl, outputMint: mint, amountLamports: Math.round(amountSol * 1e9), slippageBps: 100 });
    const result = await executeSwap({ rpcUrl: config.rpcUrl, jupiterUrl: config.jupiterUrl, secret: userSecret(), quote, liveTrading: config.liveTrading });
    await ctx.reply(result.simulated ? `DRY RUN ${side.toUpperCase()}\nWallet: ${result.wallet}\nNo transaction was sent.` : `${side.toUpperCase()} confirmed\nSignature: ${result.signature}\n${explorer(result.signature)}`);
  } catch (e) { await ctx.reply(`Trade rejected: ${e.message}`); }
}

bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('/wallet'); });
bot.callbackQuery('portfolio', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('/portfolio'); });
bot.callbackQuery('snipe', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('Admin: use /buy <MINT> <SOL_AMOUNT>.'); });
bot.callbackQuery('settings', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(isAdmin(ctx) ? 'Settings are deployment-controlled.' : 'Admin authorization required.'); });
bot.catch((err) => console.error('Telegram bot error:', err.error));
module.exports = bot;
