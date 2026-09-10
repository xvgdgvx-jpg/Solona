const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');

const DEFAULT_URLS = ['https://frontend-api-v3.pump.fun/coins', 'https://frontend-api.pump.fun/coins'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PumpFunWatcher {
  constructor({ adminId, settings, onCandidate, onError }) {
    this.adminId = adminId;
    this.settings = settings;
    this.onCandidate = onCandidate;
    this.onError = onError;
    this.running = false;
    this.seen = new Set();
    this.lastPollAt = null;
    this.lastCandidate = null;
    this.lastError = null;
    this.source = process.env.PUMPFUN_API_URL || DEFAULT_URLS[0];
  }
  updateSettings(settings) { this.settings = settings; }
  start() { if (!this.running) { this.running = true; this.loop(); } }
  stop() { this.running = false; }
  status() { return { running: this.running, lastPollAt: this.lastPollAt, lastCandidate: this.lastCandidate, lastError: this.lastError, source: this.source }; }
  async loop() {
    while (this.running) {
      try {
        this.lastPollAt = new Date().toISOString();
        const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS;
        let response;
        let lastError;
        for (const url of urls) {
          try { response = await axios.get(url, { params: { offset: 0, limit: 25, sort: 'created_timestamp', order: 'DESC', includeNsfw: false }, timeout: 10000 }); this.source = url; break; }
          catch (error) { lastError = error; }
        }
        if (!response) throw lastError;
        const { data } = response;
        this.lastError = null;
        const coins = Array.isArray(data) ? data : (data.coins || data.data || []);
        for (const coin of coins.reverse()) {
          const mint = coin.mint || coin.address;
          if (!mint || this.seen.has(mint)) continue;
          this.seen.add(mint);
          if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
          const candidate = this.normalize(coin);
          if (this.matches(candidate)) { this.lastCandidate = candidate; await this.onCandidate(candidate); }
        }
      } catch (error) { this.lastError = error.message; this.onError(error); }
      await sleep(30000);
    }
  }
  normalize(coin) {
    return {
      mint: coin.mint || coin.address,
      name: coin.name || 'بدون اسم',
      symbol: coin.symbol || 'N/A',
      decimals: Number(coin.decimals ?? 6),
      marketCapUsd: Number(coin.market_cap ?? coin.usd_market_cap ?? 0),
      liquiditySol: Number(coin.liquidity_sol ?? coin.virtual_sol_reserves ?? coin.sol_reserves ?? 0) / (coin.virtual_sol_reserves ? 1e9 : 1),
      mintAuthority: coin.mint_authority ?? coin.mintAuthority ?? null,
      freezeAuthority: coin.freeze_authority ?? coin.freezeAuthority ?? null,
      createdAt: coin.created_timestamp || null
    };
  }
  matches(candidate) {
    try { new PublicKey(candidate.mint); } catch { return false; }
    if (this.settings.requireRenouncedAuthorities && (candidate.mintAuthority || candidate.freezeAuthority)) return false;
    const minLiquidity = this.settings.minLiquiditySol > 0 ? this.settings.minLiquiditySol : 5;
    const maxMarketCap = this.settings.maxMarketCapUsd > 0 ? this.settings.maxMarketCapUsd : 100000;
    if (candidate.liquiditySol < minLiquidity) return false;
    if (candidate.marketCapUsd <= 0 || candidate.marketCapUsd > maxMarketCap) return false;
    return true;
  }
}
module.exports = { PumpFunWatcher };
