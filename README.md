# Solana Meme Sniper Telegram Bot

A Node.js Telegram bot for Solana wallet monitoring, Jupiter quotes, portfolio visibility, and explicitly guarded swaps. It includes a lightweight Express health endpoint for Render and a silent ten-minute self-ping.

## Safety

The default is **dry run**. No transaction is sent unless `LIVE_TRADING=true` is deliberately configured. This bot is not financial advice; meme-token trading can result in total loss, failed transactions, slippage, scams, and irreversible transfers. Review Jupiter routes, mint addresses, wallet permissions, RPC reliability, and transaction limits before enabling live execution.

## Render

Use a Node web service with build command `npm install` and start command `npm start`. Configure the required variables listed in `.env.example`: `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `ENCRYPTION_KEY` (64 hexadecimal characters), `MASTER_WALLET_PRIVATE_KEY`, and `ADMIN_TELEGRAM_ID`. Optional variables are `LIVE_TRADING`, `JUPITER_API_URL`, `KEEPALIVE_URL`, and `PORT`.

The service exposes `GET /health` and binds to `PORT` or 3000. The keep-alive request is best-effort and never crashes the process. Render sleep prevention is platform-dependent; self-pinging does not guarantee a free-tier instance remains awake.

## Commands

`/start` and `/menu` open the single inline-keyboard dashboard. `/wallet` shows the configured wallet address. `/portfolio` reads SOL and non-zero token accounts. `/snipe` and `/settings` are admin-only. Admin trading uses `/buy <TOKEN_MINT> <SOL_AMOUNT>` and `/sell <TOKEN_MINT> <SOL_AMOUNT>`; the current implementation uses Jupiter exact-in quotes and a bounded 10 SOL request limit.

## Local checks

```bash
npm install
npm run check
npm start
```

Do not commit `.env`, private keys, or the encrypted `data/` directory.
