const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { HeliusService } = require('./helius');

const DEFAULT_URLS = ['https://frontend-api-v3.pump.fun/coins', 'https://frontend-api.pump.fun/coins'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PumpFunWatcher {
  constructor({ adminId, settings, onCandidate, onError, onFilter }) {
    this.adminId = adminId; this.settings = settings; this.onCandidate = onCandidate; this.onError = onError; this.onFilter = onFilter || (() => {});
    this.running = false; this.seen = new Set(); this.watchlist = new Map(); this.watchTimer = null; this.lastPollAt = null; this.lastCandidate = null; this.lastError = null;
    this.source = process.env.PUMPFUN_API_URL || DEFAULT_URLS[0];
    this.helius = new HeliusService({ apiKey: process.env.HELIUS_API_KEY, rpcUrl: process.env.HELIUS_RPC_URL, wsUrl: process.env.HELIUS_WS_URL, onMint: (event) => this.handleHeliusMint(event), onError });
    this.streamMode = false;
  }
  updateSettings(settings) { this.settings = settings; }
  start() { if (this.running) return; this.running = true; this.streamMode = this.helius.start(); this.watchTimer = setInterval(() => this.recheckWatchlist(), 15000); if (!this.streamMode) this.loop(); else console.log('Helius Pump.fun WebSocket stream started'); }
  stop() { this.running = false; this.helius.stop(); if (this.watchTimer) clearInterval(this.watchTimer); this.watchTimer = null; this.watchlist.clear(); }
  status() { return { running: this.running, streamMode: this.streamMode, lastPollAt: this.lastPollAt, lastCandidate: this.lastCandidate, lastError: this.lastError, source: this.streamMode ? 'Helius WebSocket + DAS' : this.source }; }
  async fetchCoin(mint) {
    const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS;
    for (const base of urls) {
      try {
        const root = base.replace(/\/$/, ''); const { data } = await axios.get(`${root}/${mint}`, { timeout: 8000 });
        if (data && (data.mint || data.address)) return data;
      } catch (_) {}
    }
    return null;
  }
  async handleHeliusMint(event) {
    if (!this.running || this.seen.has(event.mint)) return;
    const coin = await this.fetchCoin(event.mint); if (!coin) return;
    this.seen.add(event.mint); const candidate = this.normalize(coin); candidate.creator = event.creator || coin.creator; candidate.source = 'helius-websocket';
    try { const enriched = await this.helius.enrichToken(candidate.mint, candidate.creator, candidate.bondingCurve); Object.assign(candidate, enriched); } catch (error) { this.lastError = `Helius DAS: ${error.message}`; return; }
    await this.evaluate(candidate);
  }
  async loop() {
    while (this.running && !this.streamMode) {
      try {
        this.lastPollAt = new Date().toISOString(); const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS; let response; let lastError;
        for (const url of urls) { try { response = await axios.get(url, { params: { offset: 0, limit: 25, sort: 'created_timestamp', order: 'DESC', includeNsfw: false }, timeout: 10000 }); this.source = url; break; } catch (error) { lastError = error; } }
        if (!response) throw lastError; this.lastError = null; const data = response.data; const coins = Array.isArray(data) ? data : (data.coins || data.data || []);
        for (const coin of coins.reverse()) { const mint = coin.mint || coin.address; if (!mint || this.seen.has(mint)) continue; this.seen.add(mint); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value); const candidate = this.normalize(coin); await this.evaluate(candidate); }
      } catch (error) { this.lastError = error.message; this.onError(error); }
      await sleep(30000);
    }
  }
  normalize(coin) {
    return { mint: coin.mint || coin.address, name: coin.name || '', symbol: coin.symbol || 'N/A', decimals: Number(coin.decimals ?? 6), marketCapUsd: Number(coin.market_cap ?? coin.usd_market_cap ?? 0), liquiditySol: Number(coin.liquidity_sol ?? coin.virtual_sol_reserves ?? coin.sol_reserves ?? 0) / (coin.virtual_sol_reserves ? 1e9 : 1), volumeUsd: Number(coin.volume ?? coin.volume_usd ?? coin.usd_volume ?? 0), buyVolumeUsd: Number(coin.buy_volume ?? coin.buy_volume_usd ?? 0), sellVolumeUsd: Number(coin.sell_volume ?? coin.sell_volume_usd ?? 0), uniqueBuyers: Number(coin.unique_buyers ?? coin.buyers ?? 0), bondingCurveProgress: Number(coin.bonding_curve_progress ?? coin.progress ?? 0), mintAuthority: coin.mint_authority ?? coin.mintAuthority ?? null, freezeAuthority: coin.freeze_authority ?? coin.freezeAuthority ?? null, creator: coin.creator || coin.creator_address || null, bondingCurve: coin.bonding_curve || coin.bondingCurve || null, socialLinks: [coin.twitter, coin.telegram, coin.website].filter(Boolean), createdAt: coin.created_timestamp || null };
  }
  filterReason(candidate) {
    try { new PublicKey(candidate.mint); } catch { return 'عنوان Mint غير صالح'; }
    const s = this.settings;
    if (!candidate.name) return 'اسم العملة فارغ';
    if (s.requireSocialLinks && !candidate.socialLinks?.length) return 'رابط تواصل مفقود';
    if (s.requireRenouncedAuthorities && (candidate.mintAuthority || candidate.freezeAuthority)) return 'Mint/Freeze Authority غير معطلة';
    if (candidate.bondingCurveProgress < Number(s.minCurveProgress ?? 10) || candidate.bondingCurveProgress > Number(s.maxCurveProgress ?? 35)) return `Bonding Curve خارج ${s.minCurveProgress}-${s.maxCurveProgress}%`;
    if (candidate.liquiditySol < (s.minLiquiditySol || 5)) return 'السيولة أقل من الحد';
    if (candidate.marketCapUsd <= 0 || candidate.marketCapUsd > (s.maxMarketCapUsd || 100000)) return 'Market Cap خارج الحدود';
    if (candidate.volumeUsd < Number(s.minVolumeUsd ?? 2500)) return `حجم التداول أقل من ${s.minVolumeUsd} USD`;
    if (candidate.uniqueBuyers < Number(s.minUniqueBuyers ?? 15)) return `عدد المشترين الفريدين أقل من ${s.minUniqueBuyers}`;
    if (candidate.buyVolumeUsd <= candidate.sellVolumeUsd) return 'حجم الشراء ليس أكبر من البيع';
    if (candidate.heliusVerified && candidate.creatorHoldingsPct > Number(s.maxCreatorHoldingsPct ?? 5)) return `حيازة المنشئ تتجاوز ${s.maxCreatorHoldingsPct}%`;
    if (candidate.heliusVerified && candidate.topHoldersPct > Number(s.maxTopHoldersPct ?? 25)) return `حيازة أكبر 10 محافظ تتجاوز ${s.maxTopHoldersPct}%`;
    return null;
  }
  async evaluate(candidate) {
    const reason = this.filterReason(candidate);
    if (!reason) { this.watchlist.delete(candidate.mint); this.lastCandidate = candidate; await this.onCandidate(candidate); return true; }
    const minutes = Number(this.settings.watchlistMinutes || 0);
    if (minutes > 0 && reason !== 'عنوان Mint غير صالح') {
      const current = this.watchlist.get(candidate.mint) || { createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000 };
      if (Date.now() < current.expiresAt) { this.watchlist.set(candidate.mint, current); this.onFilter(candidate, `${reason} — قيد المراقبة`); return false; }
      this.watchlist.delete(candidate.mint);
    }
    this.onFilter(candidate, reason); return false;
  }
  async recheckWatchlist() {
    if (!this.running || !this.watchlist.size) return;
    for (const [mint, entry] of this.watchlist) {
      if (Date.now() >= entry.expiresAt) { this.watchlist.delete(mint); continue; }
      try {
        const coin = await this.fetchCoin(mint); if (!coin) continue;
        const candidate = this.normalize(coin); candidate.source = this.streamMode ? 'helius-watchlist' : 'pumpfun-watchlist';
        if (this.streamMode) Object.assign(candidate, await this.helius.enrichToken(mint, candidate.creator, candidate.bondingCurve));
        await this.evaluate(candidate);
      } catch (error) { this.lastError = `إعادة فحص: ${error.message}`; }
    }
  }
  matches(candidate) {
    const reason = this.filterReason(candidate); if (reason) { this.onFilter(candidate, reason); return false; }
    return true;
  }
}
module.exports = { PumpFunWatcher };
