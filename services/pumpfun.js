const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { HeliusService } = require('./helius');

const DEFAULT_URLS = ['https://frontend-api-v3.pump.fun/coins', 'https://frontend-api.pump.fun/coins'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PumpFunWatcher {
  constructor({ adminId, settings, onCandidate, onError, onFilter }) {
    this.adminId = adminId; this.settings = settings; this.onCandidate = onCandidate; this.onError = onError; this.onFilter = onFilter || (() => {});
    this.running = false; this.seen = new Set(); this.watchlist = new Map(); this.watchTimer = null; this.watchlistBusy = false;
    this.lastPollAt = null; this.lastCandidate = null; this.lastError = null; this.source = process.env.PUMPFUN_API_URL || DEFAULT_URLS[0];
    this.helius = new HeliusService({ apiKey: process.env.HELIUS_API_KEY, rpcUrl: process.env.HELIUS_RPC_URL, wsUrl: process.env.HELIUS_WS_URL, onMint: (event) => this.handleHeliusMint(event), onError: (error) => this.handleHeliusError(error) });
    this.streamMode = false;
  }
  updateSettings(settings) { this.settings = settings; }
  handleHeliusError(error) { this.lastError = `Helius: ${error.message}`; this.onError(error); if (this.running && this.streamMode) { this.streamMode = false; this.helius.stop(); this.loop(); } }
  start() { if (this.running) return; this.running = true; this.streamMode = this.helius.start(); const interval = Math.max(3000, Number(process.env.WATCHLIST_POLL_MS || 5000)); this.watchTimer = setInterval(() => this.recheckWatchlist(), interval); console.log(`Pump.fun watchlist polling every ${interval}ms`); if (!this.streamMode) this.loop(); else console.log('Helius Pump.fun WebSocket stream started'); }
  stop() { this.running = false; this.helius.stop(); if (this.watchTimer) clearInterval(this.watchTimer); this.watchTimer = null; this.watchlist.clear(); }
  status() { return { running: this.running, streamMode: this.streamMode, watchlistSize: this.watchlist.size, lastPollAt: this.lastPollAt, lastCandidate: this.lastCandidate, lastError: this.lastError, source: this.streamMode ? 'Helius WebSocket + DAS' : this.source }; }
  async fetchCoin(mint) {
    const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS;
    for (const base of urls) {
      const root = base.replace(/\/$/, '');
      try { const { data } = await axios.get(`${root}/${mint}`, { timeout: 8000 }); if (data && (data.mint || data.address)) return data; } catch (_) {}
      try { const { data } = await axios.get(root, { params: { offset: 0, limit: 100, sort: 'created_timestamp', order: 'DESC', includeNsfw: false }, timeout: 8000 }); const coins = Array.isArray(data) ? data : (data.coins || data.data || []); const match = coins.find((coin) => String(coin.mint || coin.address) === String(mint)); if (match) return match; } catch (_) {}
    }
    return null;
  }
  async handleHeliusMint(event) { if (!this.running) return; const coin = await this.fetchCoin(event.mint); if (!coin) return; this.seen.add(event.mint); const candidate = this.normalize(coin); candidate.creator = event.creator || coin.creator; candidate.source = 'helius-websocket'; try { Object.assign(candidate, await this.helius.enrichToken(candidate.mint, candidate.creator, candidate.bondingCurve)); } catch (error) { this.lastError = `Helius DAS: ${error.message}`; return; } await this.evaluate(candidate); }
  async loop() {
    while (this.running && !this.streamMode) {
      try { this.lastPollAt = new Date().toISOString(); const urls = process.env.PUMPFUN_API_URL ? [process.env.PUMPFUN_API_URL] : DEFAULT_URLS; let response; let lastError; for (const url of urls) { try { response = await axios.get(url, { params: { offset: 0, limit: 25, sort: 'created_timestamp', order: 'DESC', includeNsfw: false }, timeout: 10000 }); this.source = url; break; } catch (error) { lastError = error; } } if (!response) throw lastError; this.lastError = null; const data = response.data; const coins = Array.isArray(data) ? data : (data.coins || data.data || []); for (const coin of coins.reverse()) { const mint = coin.mint || coin.address; if (!mint || this.seen.has(mint)) continue; this.seen.add(mint); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value); await this.evaluate(this.normalize(coin)); } } catch (error) { this.lastError = error.message; this.onError(error); }
      await sleep(30000);
    }
  }
  normalize(coin) {
    const progressKey = ['bonding_curve_progress', 'bondingCurveProgress', 'bonding_curve_percent', 'progress'].find((key) => coin[key] !== undefined && coin[key] !== null);
    const rawProgress = progressKey ? Number(coin[progressKey]) : NaN;
    // Pump.fun providers may return progress as either 0..100 or 0..1. The filters always use percent.
    const progressIsFraction = Number.isFinite(rawProgress) && rawProgress >= 0 && rawProgress <= 1;
    const bondingCurveProgress = Number.isFinite(rawProgress) ? (progressIsFraction ? rawProgress * 100 : rawProgress) : 0;
    const virtualSol = Number(coin.virtual_sol_reserves ?? coin.virtualSolReserves ?? 0);
    const liquiditySol = Number(coin.liquidity_sol ?? coin.sol_reserves ?? 0) || (virtualSol > 0 ? virtualSol / 1e9 : 0);
    return { mint: coin.mint || coin.address, name: coin.name || '', symbol: coin.symbol || 'N/A', decimals: Number(coin.decimals ?? 6), marketCapUsd: Number(coin.market_cap ?? coin.usd_market_cap ?? 0), liquiditySol, volumeUsd: Number(coin.volume ?? coin.volume_usd ?? coin.usd_volume ?? 0), buyVolumeUsd: Number(coin.buy_volume ?? coin.buy_volume_usd ?? 0), sellVolumeUsd: Number(coin.sell_volume ?? coin.sell_volume_usd ?? 0), uniqueBuyers: Number(coin.unique_buyers ?? coin.buyers ?? 0), bondingCurveProgress, bondingCurveProgressSource: progressKey || 'unavailable', virtualSolReserves: virtualSol, mintAuthority: coin.mint_authority ?? coin.mintAuthority ?? null, freezeAuthority: coin.freeze_authority ?? coin.freezeAuthority ?? null, creator: coin.creator || coin.creator_address || null, bondingCurve: coin.bonding_curve || coin.bondingCurve || null, socialLinks: [coin.twitter, coin.telegram, coin.website].filter(Boolean), createdAt: coin.created_timestamp || null };
  }
  filterReason(candidate) {
    try { new PublicKey(candidate.mint); } catch { return 'عنوان Mint غير صالح'; }
    const s = this.settings; if (!candidate.name) return 'اسم العملة فارغ'; if (s.requireSocialLinks && !candidate.socialLinks?.length) return 'رابط تواصل مفقود'; if (s.requireRenouncedAuthorities && (candidate.mintAuthority || candidate.freezeAuthority)) return 'Mint/Freeze Authority غير معطلة';
    if (candidate.bondingCurveProgress < Number(s.minCurveProgress ?? 10) || candidate.bondingCurveProgress > Number(s.maxCurveProgress ?? 35)) return `Bonding Curve خارج ${s.minCurveProgress}-${s.maxCurveProgress}%`; if (s.minLiquiditySol && candidate.liquiditySol < Number(s.minLiquiditySol)) return 'السيولة أقل من الحد'; if (s.maxMarketCapUsd && candidate.marketCapUsd > 0 && candidate.marketCapUsd > Number(s.maxMarketCapUsd)) return 'Market Cap تجاوز السقف';
    if (!(candidate.volumeUsd >= Number(s.minVolumeUsd ?? 2500))) return `حجم التداول أقل من ${s.minVolumeUsd} USD`; if (!(candidate.uniqueBuyers >= Number(s.minUniqueBuyers ?? 15))) return `عدد المشترين الفريدين أقل من ${s.minUniqueBuyers}`; if (s.requireBuyVolumeDominance && candidate.buyVolumeUsd > 0 && candidate.sellVolumeUsd > 0 && candidate.buyVolumeUsd <= candidate.sellVolumeUsd) return 'حجم الشراء ليس أكبر من البيع'; if (candidate.heliusVerified && !(candidate.creatorHoldingsPct <= Number(s.maxCreatorHoldingsPct ?? 5))) return `حيازة المنشئ تتجاوز ${s.maxCreatorHoldingsPct}%`; if (candidate.heliusVerified && !(candidate.topHoldersPct <= Number(s.maxTopHoldersPct ?? 25))) return `حيازة أكبر 10 محافظ تتجاوز ${s.maxTopHoldersPct}%`; return null;
  }
  async evaluate(candidate) { const reason = this.filterReason(candidate); if (!reason) { this.watchlist.delete(candidate.mint); this.lastCandidate = candidate; console.log(`[candidate] ${candidate.symbol} ${candidate.mint} passed filters; launching trade`); await this.onCandidate(candidate); return true; } const minutes = Number(this.settings.watchlistMinutes || 0); if (minutes > 0 && reason !== 'عنوان Mint غير صالح') { const current = this.watchlist.get(candidate.mint) || { createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000 }; if (Date.now() < current.expiresAt) { this.watchlist.set(candidate.mint, { ...current, lastReason: reason }); this.onFilter(candidate, `${reason} — قيد المراقبة`); return false; } this.watchlist.delete(candidate.mint); } this.onFilter(candidate, reason); return false; }
  async recheckWatchlist() { if (!this.running || !this.watchlist.size || this.watchlistBusy) return; this.watchlistBusy = true; try { for (const [mint, entry] of this.watchlist) { if (Date.now() >= entry.expiresAt) { this.watchlist.delete(mint); continue; } try { const coin = await this.fetchCoin(mint); if (!coin) { console.log(`[watchlist] ${mint}: لا توجد بيانات محدثة`); continue; } const candidate = this.normalize(coin); candidate.source = this.streamMode ? 'helius-watchlist' : 'pumpfun-watchlist'; if (this.streamMode) Object.assign(candidate, await this.helius.enrichToken(mint, candidate.creator, candidate.bondingCurve)); const reason = this.filterReason(candidate); console.log(`[watchlist] ${candidate.symbol} ${mint} | curve=${candidate.bondingCurveProgress.toFixed(2)}% (${candidate.bondingCurveProgressSource}) | volume=$${candidate.volumeUsd.toFixed(2)} | buyers=${candidate.uniqueBuyers} | result=${reason || 'PASS'}`); await this.evaluate(candidate); } catch (error) { this.lastError = `إعادة فحص: ${error.message}`; console.error(`[watchlist] ${mint}: ${this.lastError}`); } } } finally { this.watchlistBusy = false; } }
  matches(candidate) { const reason = this.filterReason(candidate); if (reason) { this.onFilter(candidate, reason); return false; } return true; }
}
module.exports = { PumpFunWatcher };
