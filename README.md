# Solana Meme Sniper Telegram Bot

A Node.js Telegram bot for Solana wallet monitoring, Jupiter quotes, portfolio visibility, and explicitly guarded swaps. It includes a lightweight Express health endpoint for Render and a silent ten-minute self-ping.

## Safety

The default is **dry run**. No transaction is sent unless `LIVE_TRADING=true` is deliberately configured. This bot is not financial advice; meme-token trading can result in total loss, failed transactions, slippage, scams, and irreversible transfers. Review Jupiter routes, mint addresses, wallet permissions, RPC reliability, and transaction limits before enabling live execution.

## Render

Use a Node web service with build command `npm install` and start command `npm start`. Configure the required variables listed in `.env.example`: `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `ENCRYPTION_KEY` (64 hexadecimal characters), and `ADMIN_TELEGRAM_ID`. Set `PHANTOM_MNEMONIC` to the 12-word recovery phrase; the bot validates it, derives the wallet using `m/44'/501'/0'/0'`, and uses the resulting Solana Keypair automatically. `SOLANA_MNEMONIC` and `MASTER_WALLET_MNEMONIC` are accepted aliases. `MASTER_WALLET_PRIVATE_KEY` remains a fallback for an existing Base58 key or JSON array of 64 bytes. Never commit, log, or share either secret format. Optional variables are `LIVE_TRADING`, `JUPITER_API_URL`, `KEEPALIVE_URL`, and `PORT`.

The service exposes `GET /health` and binds to `PORT` or 3000. The keep-alive request is best-effort and never crashes the process. Render sleep prevention is platform-dependent; self-pinging does not guarantee a free-tier instance remains awake.

## Pump.fun auto-sniper

The optional Pump.fun watcher polls recent launches every 30 seconds. It is disabled by default and can be enabled by the admin with `/settings sniper on`. It applies configurable mint-authority and freeze-authority checks, minimum liquidity, maximum market cap, trade size, daily trade limit, and live/dry-run mode. The admin can change these at runtime with `/settings live on|off`, `/settings size <SOL>`, `/settings maxtrades <عدد أو 0>`, `/settings minliq <SOL>`, `/settings maxcap <USD>`, and `/settings authorities on|off`. The source endpoint can be overridden with `PUMPFUN_API_URL`; use a reliable authenticated data provider if the public endpoint is unavailable or rate-limited.

The watcher is a risk-control feature, not a guarantee of fills or profitability. Pump.fun bonding-curve price impact, fees, migration to PumpSwap, RPC delay, slippage, and malicious launches can cause losses. Keep dry-run mode enabled until the filters and alerts are independently verified.

## Commands

`/start` and `/menu` open the single inline-keyboard dashboard. `/wallet` shows the configured wallet address. `/portfolio` reads SOL and non-zero token accounts. `/snipe` and `/settings` are admin-only. Admin trading uses `/buy <TOKEN_MINT> <SOL_AMOUNT>` and `/sell <TOKEN_MINT> <SOL_AMOUNT>`; the current implementation uses Jupiter exact-in quotes and a bounded 10 SOL request limit.

## Local checks

```bash
npm install
npm run check
npm start
```

Do not commit `.env`, private keys, or the encrypted `data/` directory.
