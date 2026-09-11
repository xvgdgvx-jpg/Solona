const axios = require('axios');
const { getQuote, SOL_MINT } = require('./solana');
const { getUser, saveUser } = require('./storage');

const getPositions = (adminId, key) => getUser(adminId, key).paperPositions || [];
const savePositions = (adminId, positions, key) => { const user = getUser(adminId, key); saveUser(adminId, { ...user, paperPositions: positions }, key); };
let priceCache = { data: null, timestamp: 0 };
const PRICE_CACHE_MS = 50;

async function solUsd() {
  try { const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'solana', vs_currencies: 'usd' }, timeout: 5000 }); return Number(data.solana.usd); } catch { return null; }
}
async function openPosition({ adminId, key, jupiterUrl, mint, investedSol, quote, metadata = {} }) {
  const positions = getPositions(adminId, key);
  const outAmount = Number(quote.outAmount);
  if (!Number.isFinite(outAmount) || outAmount <= 0) throw new Error('لم يُرجع مصدر التسعير كمية صالحة.');
  const existing = positions.find((p) => p.mint === mint && p.status === 'open');
  if (existing) { existing.investedSol += investedSol; existing.tokenAmountRaw += outAmount; existing.tokenAmount = existing.tokenAmountRaw / (10 ** existing.decimals); existing.entryPriceSol = existing.investedSol / existing.tokenAmount; existing.updatedAt = Date.now(); }
  else positions.push({ id: `${mint}:${Date.now()}`, mint, name: metadata.name || 'بدون اسم', symbol: metadata.symbol || 'N/A', liquiditySol: Number(metadata.liquiditySol || 0), marketCapUsd: Number(metadata.marketCapUsd || 0), investedSol, tokenAmountRaw: outAmount, tokenAmount: outAmount / (10 ** Number(metadata.decimals ?? 6)), decimals: Number(metadata.decimals ?? 6), entryPriceSol: investedSol / (outAmount / (10 ** Number(metadata.decimals ?? 6))), tp1Sold: false, highestPnlPct: null, entryQuote: quote, openedAt: Date.now(), updatedAt: Date.now(), status: 'open' });
  savePositions(adminId, positions, key);
  return positions.find((p) => p.mint === mint && p.status === 'open');
}
async function refreshSinglePosition({ jupiterUrl, position }) {
  try {
    const quote = await getQuote({ jupiterUrl, inputMint: position.mint, outputMint: SOL_MINT, amountLamports: position.tokenAmountRaw, slippageBps: 100 });
    const currentSol = Number(quote.outAmount) / 1e9;
    return { ...position, currentSol, pnlSol: currentSol - position.investedSol, pnlPct: position.investedSol ? ((currentSol / position.investedSol) - 1) * 100 : 0, quote, pricingError: null };
  } catch (error) {
    return { ...position, currentSol: null, pnlSol: null, pnlPct: null, quote: null, pricingError: error.message };
  }
}
async function refreshPositions({ adminId, key, jupiterUrl }) {
  const positions = getPositions(adminId, key).filter((p) => p.status === 'open');
  const values = await Promise.all(positions.map((position) => refreshSinglePosition({ jupiterUrl, position })));
  let highestChanged = false;
  for (const value of values) {
    if (!Number.isFinite(value.pnlPct)) continue;
    const position = positions.find((p) => p.id === value.id);
    if (position && value.pnlPct > Number(position.highestPnlPct ?? -Infinity)) {
      position.highestPnlPct = value.pnlPct;
      position.updatedAt = Date.now();
      highestChanged = true;
    }
  }
  if (highestChanged) savePositions(adminId, positions, key);
  const usd = await solUsd();
  return { values, solUsd: usd };
}
async function refreshPositionsCached(params) {
  const now = Date.now();
  if (priceCache.data && now - priceCache.timestamp < PRICE_CACHE_MS) return priceCache.data;
  const result = await refreshPositions(params);
  priceCache = { data: result, timestamp: now };
  return result;
}
async function closePosition({ adminId, key, positionId, fraction = 1, jupiterUrl }) {
  const positions = getPositions(adminId, key);
  const position = positions.find((p) => p.id === positionId && p.status === 'open');
  if (!position) return null;
  if (position.status !== 'open') return null;
  position.status = 'closing';
  position.updatedAt = Date.now();
  savePositions(adminId, positions, key);
  const value = await refreshSinglePosition({ jupiterUrl, position: { ...position, tokenAmountRaw: Math.floor(position.tokenAmountRaw * fraction), investedSol: position.investedSol * fraction } });
  if (value.pricingError) {
    position.status = 'open';
    position.updatedAt = Date.now();
    savePositions(adminId, positions, key);
    throw new Error(`لا يمكن محاكاة البيع الآن: ${value.pricingError}`);
  }
  if (fraction >= 1) position.status = 'closed';
  else { position.tokenAmountRaw -= Math.floor(position.tokenAmountRaw * fraction); position.investedSol -= position.investedSol * fraction; position.tp1Sold = true; position.status = 'open'; }
  position.updatedAt = Date.now();
  savePositions(adminId, positions, key);
  return { ...value, fraction };
}
module.exports = { openPosition, refreshSinglePosition, refreshPositions, refreshPositionsCached, closePosition, getPositions };
