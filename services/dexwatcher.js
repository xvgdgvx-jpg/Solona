const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DexWatcher {
  constructor({ settings, onCandidate, onError, onFilter }) {
    this.settings = settings; this.onCandidate = onCandidate; this.onError = onError || (() => {}); this.onFilter = onFilter || (() => {});
    this.running = false; this.timer = null; this.watchdog = null; this.lastPollAt = null; this.lastError = null;
    this.lastCandidate = null; this.seen = new Set(); this.checked = 0; this.pollInFlight = false; this.lastPollDurationMs = null;
    this.discoveryUrl = process.env.DEXPAPRIKA_URL || 'https://api.dexpaprika.com/networks/solana/pools/search';
    this.nextAllowedPollAt = 0; this.lastRateLimitNoticeAt = 0; this.lastRequestStatus = null;
  }
  updateSettings(settings) { this.settings = settings; }
  start() {
    if (this.running) return true;
    this.running = true; this.poll();
    this.timer = setInterval(() => this.poll(), 5000);
    this.watchdog = setInterval(() => { if (this.running && (!this.lastPollAt || Date.now() - this.lastPollAt > 20000)) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), 5000); this.poll(); } }, 60000);
    return true;
  }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); if (this.watchdog) clearInterval(this.watchdog); this.timer = this.watchdog = null; }
  reset() { this.seen.clear(); this.lastError = null; this.lastCandidate = null; this.checked = 0; this.lastPollAt = null; this.lastPollDurationMs = null; this.nextAllowedPollAt = 0; }
  status() { return { running: this.running, lastPollAt: this.lastPollAt, lastPollDurationMs: this.lastPollDurationMs, lastError: this.lastError, lastCandidate: this.lastCandidate, checked: this.checked, seen: this.seen.size, source: 'DexPaprika' }; }
  async request(url, options = {}) {
    try { return (await axios.get(url, { timeout: 10000, headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(options.headers || {}) }, ...options })).data; }
    catch (error) { this.lastRequestStatus = error.response?.status || null; this.lastError = error.message; if (Date.now() - this.lastRateLimitNoticeAt > 60000) { this.lastRateLimitNoticeAt = Date.now(); this.onError(error); } return null; }
  }
  async poll() {
    if (!this.running || this.pollInFlight || Date.now() < this.nextAllowedPollAt) return;
    this.pollInFlight = true; const startedAt = Date.now(); this.lastPollAt = startedAt;
    try {
      const createdAfter = Math.floor(Date.now() / 1000) - 3600;
      const params = { order_by: 'created_at', sort: 'desc', limit: 100, detailed: true, created_after: createdAfter };
      this.lastRequestStatus = null;
      let data = await this.request(this.discoveryUrl, { params });
      if (!data && this.lastRequestStatus === 400) {
        console.warn('[dexwatcher] DexPaprika rejected order_by — check API docs');
        this.lastRequestStatus = null;
        data = await this.request(this.discoveryUrl, { params: { ...params, order_by: 'price_change_percentage_5m' } });
      }
      if (!data) { this.nextAllowedPollAt = Date.now() + 60000; return; }
      const pools = Array.isArray(data) ? data : (data?.results || data?.pools || data?.data || []);
      for (const pool of pools) {
        const candidate = this.loadCandidate(pool);
        if (!candidate || !candidate.createdAt || candidate.ageSec > 7200 || candidate.volumeUsd <= 0 || this.seen.has(candidate.mint)) continue;
        this.seen.add(candidate.mint);
        await this.evaluate(candidate);
      }
    } catch (error) { this.lastError = error.message; this.onError(error); }
    finally { this.lastPollDurationMs = Date.now() - startedAt; this.pollInFlight = false; }
  }
  loadCandidate(pool) {
    try {
      const token = Array.isArray(pool.tokens) ? pool.tokens[0] : null; const mint = token?.id;
      if (!mint) return null;
      const txns = pool.txns_24h ?? pool.transactions_24h; const buys = Number(txns?.buys ?? txns?.buy ?? txns?.buy_count ?? txns ?? 0); const sells = Number(txns?.sells ?? txns?.sell ?? txns?.sell_count ?? 0);
      const created = typeof pool.created_at === 'number' ? pool.created_at : (pool.created_at ? Date.parse(pool.created_at) / 1000 : null);
      const ageSec = Number.isFinite(created) ? Math.max(0, Date.now() / 1000 - created) : null;
      return { mint, name: token.name || token.symbol || 'بدون اسم', symbol: token.symbol || 'N/A', decimals: Number(token.decimals || 6), createdAt: Number.isFinite(created) ? created : null, ageSec, marketCapUsd: Number(pool.fdv_usd || 0) || null, liquidityUsd: Number(pool.liquidity_usd || 0) || 0, volumeUsd: Number(pool.volume_usd_24h || 0) || 0, dexBuys: buys, dexSells: sells, buySellRatio: buys / Math.max(1, sells), mintAuthority: null, freezeAuthority: null, poolAddress: pool.id, dexName: pool.dex_name, marketDataSource: 'dexpaprika', source: 'dexpaprika' };
    } catch (_) { return null; }
  }
  async evaluate(candidate) {
    this.checked += 1; const dex = this.settings.dex; const age = candidate.createdAt ? Math.max(0, Date.now() / 1000 - candidate.createdAt) : null;
    const fail = (reason, stage) => { this.onFilter(candidate, reason, stage); return false; };
    if (!candidate.mint || (() => { try { new PublicKey(candidate.mint); return false; } catch (_) { return true; } })()) return fail('عنوان العملة غير صالح', 'dex');
    if (age != null && (age < Number(dex.minAgeSec) || (Number(dex.maxAgeSec) > 0 && age > Number(dex.maxAgeSec)))) return fail('العمر خارج الحدود', 'dex');
    if (candidate.volumeUsd < Number(dex.minVolumeUsd) || candidate.liquidityUsd < Number(dex.minLiquidityUsd)) return fail('الحجم أو السيولة أقل من الحد', 'dex');
    if (candidate.dexBuys < Number(dex.minBuys24h) || candidate.buySellRatio < Number(dex.minBuySellRatio)) return fail('المشتريات أو نسبة الشراء/البيع أقل من الحد', 'dex');
    if (candidate.marketCapUsd < Number(dex.minMarketCapUsd) || (Number(dex.maxMarketCapUsd) > 0 && candidate.marketCapUsd > Number(dex.maxMarketCapUsd))) return fail('القيمة السوقية خارج الحدود', 'dex');
    if (dex.allowedDexes !== 'all' && dex.allowedDexes === 'raydium' && String(candidate.dexName).toLowerCase() !== 'raydium') return fail('الـ DEX غير مسموح', 'dex');
    if (this.settings.goplus.enabled) { const result = await this.goplus(candidate.mint); if (result && !this.passGoplus(result)) return fail('رفض GoPlus: فشل فحص الأمان', 'goplus'); }
    if (this.settings.tracker.enabled) { const result = await this.tracker(candidate.mint); if (result && !this.passTracker(result)) return fail('رفض Solana Tracker: تجاوز حدود المخاطر', 'tracker'); }
    this.lastCandidate = candidate; await this.onCandidate(candidate); return true;
  }
  async goplus(mint) { return this.request(process.env.GOPLUS_API_URL || `https://api.gopluslabs.io/api/v1/token_security/solana?contract_addresses=${mint}`, { headers: process.env.GOPLUS_API_KEY ? { Authorization: `Bearer ${process.env.GOPLUS_API_KEY}` } : {} }).then((d) => d?.result?.[mint] || null); }
  async tracker(mint) { if (!process.env.SOLANA_TRACKER_API_URL) return null; return this.request(`${process.env.SOLANA_TRACKER_API_URL.replace(/\/$/, '')}/${mint}`, { headers: process.env.SOLANA_TRACKER_API_KEY ? { 'x-api-key': process.env.SOLANA_TRACKER_API_KEY } : {} }); }
  passGoplus(r) { const g = this.settings.goplus; const num = (...keys) => { for (const k of keys) if (r[k] != null) return Number(r[k]); return null; }; const buy = num('buy_tax', 'buy_tax_rate'); const sell = num('sell_tax', 'sell_tax_rate'); if (g.rejectHoneypot && ['1', 1, true, 'true'].includes(r.is_honeypot)) return false; if (buy != null && Number(g.maxBuyTax) >= 0 && buy > Number(g.maxBuyTax)) return false; if (sell != null && Number(g.maxSellTax) >= 0 && sell > Number(g.maxSellTax)) return false; if (g.checkMintAuthority && ['1', 1, true, 'true'].includes(r.mintable)) return false; if (g.checkFreezeAuthority && ['1', 1, true, 'true'].includes(r.freezable)) return false; return true; }
  passTracker(r) { const t = this.settings.tracker; const val = (...keys) => { for (const k of keys) if (r[k] != null) return Number(r[k]); return null; }; if (t.rejectRugged && (r.rugged === true || r.is_rugged === true)) return false; const checks = [[val('riskScore', 'risk_score'), t.maxRiskScore], [val('developerHoldingPct', 'developer_holding_percentage'), t.maxDeveloperHoldingPct], [val('snipersPct', 'snipers_percentage'), t.maxSnipersPct], [val('insidersPct', 'insiders_percentage'), t.maxInsidersPct], [val('bundlersPct', 'bundlers_percentage'), t.maxBundlersPct], [val('top10Pct', 'top_10_percentage'), t.maxTop10Pct]]; if (checks.some(([x, max]) => x != null && Number(max) > 0 && x > Number(max))) return false; const holders = val('holders', 'holderCount', 'holder_count'); return holders == null || Number(t.minHolders) <= 0 || holders >= Number(t.minHolders); }
}
module.exports = { DexWatcher };
