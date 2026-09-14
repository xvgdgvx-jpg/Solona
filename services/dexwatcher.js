const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DexWatcher {
  constructor({ settings, onCandidate, onError, onFilter }) {
    this.settings = settings; this.onCandidate = onCandidate; this.onError = onError || (() => {}); this.onFilter = onFilter || (() => {});
    this.running = false; this.timer = null; this.watchdog = null; this.lastPollAt = null; this.lastError = null;
    this.lastCandidate = null; this.seen = new Set(); this.checked = 0; this.pollInFlight = false; this.lastPollDurationMs = null;
    this.discoveryUrl = process.env.DEX_DISCOVERY_URL || 'https://api.dexscreener.com/token-profiles/latest/v1';
    this.discoveryFallbackUrl = process.env.DEX_DISCOVERY_FALLBACK_URL || 'https://api.dexscreener.com/token-boosts/latest/v1';
    this.nextAllowedPollAt = 0; this.lastRateLimitNoticeAt = 0;
  }
  updateSettings(settings) { this.settings = settings; }
  start() {
    if (this.running) return true;
    this.running = true; this.poll();
    this.timer = setInterval(() => this.poll(), Number(process.env.DEX_POLL_INTERVAL_MS || 15000));
    this.watchdog = setInterval(() => { if (this.running && (!this.lastPollAt || Date.now() - this.lastPollAt > 45000)) { clearInterval(this.timer); this.timer = setInterval(() => this.poll(), Number(process.env.DEX_POLL_INTERVAL_MS || 15000)); this.poll(); } }, 60000);
    return true;
  }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); if (this.watchdog) clearInterval(this.watchdog); this.timer = this.watchdog = null; }
  reset() { this.seen.clear(); this.lastError = null; this.lastCandidate = null; this.checked = 0; this.lastPollAt = null; this.lastPollDurationMs = null; this.nextAllowedPollAt = 0; }
  status() { return { running: this.running, lastPollAt: this.lastPollAt, lastPollDurationMs: this.lastPollDurationMs, lastError: this.lastError, lastCandidate: this.lastCandidate, checked: this.checked, seen: this.seen.size, source: 'DexScreener' }; }
  async request(url, options = {}) {
    const attempts = Number(options.retries ?? 2); const requestOptions = { timeout: 10000, headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(options.headers || {}) }, ...options }; delete requestOptions.retries;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try { return (await axios.get(url, requestOptions)).data; } catch (error) {
        const status = error.response?.status;
        if (status === 429 && attempt < attempts) { const retryAfter = Number(error.response.headers?.['retry-after'] || 0); await sleep(Math.min(30000, Math.max(1500, retryAfter * 1000 || (attempt + 1) * 3000))); continue; }
        this.lastError = status === 429 ? 'DexScreener حدّ الطلبات (429)' : error.message;
        if (status !== 429 || Date.now() - this.lastRateLimitNoticeAt > 60000) { this.lastRateLimitNoticeAt = Date.now(); this.onError(new Error(this.lastError)); }
        return null;
      }
    }
    return null;
  }
  async poll() {
    if (!this.running || this.pollInFlight || Date.now() < this.nextAllowedPollAt) return;
    this.pollInFlight = true; const startedAt = Date.now(); this.lastPollAt = startedAt;
    try {
      let data = await this.request(this.discoveryUrl);
      if (!data && this.discoveryFallbackUrl) data = await this.request(this.discoveryFallbackUrl);
      const profiles = Array.isArray(data) ? data : (data?.profiles || data?.data || []);
      const candidates = profiles.filter((x) => String(x.chainId).toLowerCase() === 'solana' && x.tokenAddress).slice(0, 50);
      for (const profile of candidates) { const mint = profile.tokenAddress; if (this.seen.has(mint)) continue; const candidate = await this.loadCandidate(mint, profile); if (!candidate) continue; this.seen.add(mint); await this.evaluate(candidate); }
      if (!data) this.nextAllowedPollAt = Date.now() + 60000;
    } catch (error) { this.lastError = error.message; this.onError(error); }
    finally { this.lastPollDurationMs = Date.now() - startedAt; this.pollInFlight = false; }
  }
  async loadCandidate(mint, profile) {
    try {
      const data = await this.request(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { retries: 1 });
      const pairs = (data?.pairs || []).filter((p) => String(p.chainId).toLowerCase() === 'solana'); const pair = pairs.sort((a, b) => Number(b.volume?.h24 || 0) - Number(a.volume?.h24 || 0))[0]; if (!pair) return null;
      const createdAt = Number(pair.pairCreatedAt || 0);
      return { mint, name: pair.baseToken?.name || profile.description || '', symbol: pair.baseToken?.symbol || 'N/A', decimals: 6, createdAt: createdAt ? createdAt / 1000 : null, marketCapUsd: Number(pair.marketCap || pair.fdv || 0) || null, liquidityUsd: Number(pair.liquidity?.usd || 0) || null, volumeUsd: Number(pair.volume?.h24 || 0) || 0, dexBuys: Number(pair.txns?.h24?.buys || 0), dexSells: Number(pair.txns?.h24?.sells || 0), buySellRatio: Number(pair.txns?.h24?.buys || 0) / Math.max(1, Number(pair.txns?.h24?.sells || 0)), mintAuthority: null, freezeAuthority: null, dexScreenerPair: pair.pairAddress, dexScreenerDex: pair.dexId, marketDataSource: 'dexscreener', source: 'dexscreener' };
    } catch (error) { this.onError(error); return null; }
  }
  async evaluate(candidate) {
    this.checked += 1; const dex = this.settings.dex; const age = candidate.createdAt ? Math.max(0, Date.now() / 1000 - candidate.createdAt) : null;
    const fail = (reason, stage) => { this.onFilter(candidate, reason, stage); return false; };
    if (!candidate.mint || (() => { try { new PublicKey(candidate.mint); return false; } catch (_) { return true; } })()) return fail('عنوان العملة غير صالح', 'dex');
    if (age != null && (age < Number(dex.minAgeSec) || (Number(dex.maxAgeSec) > 0 && age > Number(dex.maxAgeSec)))) return fail('العمر خارج الحدود', 'dex');
    if (candidate.volumeUsd < Number(dex.minVolumeUsd) || candidate.liquidityUsd < Number(dex.minLiquidityUsd)) return fail('الحجم أو السيولة أقل من الحد', 'dex');
    if (candidate.dexBuys < Number(dex.minBuys24h) || candidate.buySellRatio < Number(dex.minBuySellRatio)) return fail('المشتريات أو نسبة الشراء/البيع أقل من الحد', 'dex');
    if (candidate.marketCapUsd < Number(dex.minMarketCapUsd) || (Number(dex.maxMarketCapUsd) > 0 && candidate.marketCapUsd > Number(dex.maxMarketCapUsd))) return fail('القيمة السوقية خارج الحدود', 'dex');
    if (dex.allowedDexes !== 'all' && dex.allowedDexes === 'raydium' && candidate.dexScreenerDex !== 'raydium') return fail('الـ DEX غير مسموح', 'dex');
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
