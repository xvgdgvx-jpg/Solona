const axios = require('axios');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const connection = (rpcUrl) => new Connection(rpcUrl, 'confirmed');

function validateSecretBytes(value) {
  if (!Array.isArray(value) || value.length !== 64 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('يجب أن يكون MASTER_WALLET_PRIVATE_KEY مصفوفة JSON من 64 رقماً بين 0 و255.');
  }
  return Uint8Array.from(value);
}

function keypairFromSecret(secret) {
  if (secret instanceof Uint8Array) return Keypair.fromSecretKey(validateSecretBytes(Array.from(secret)));
  const raw = String(secret ?? '').trim();
  if (!raw) throw new Error('قيمة MASTER_WALLET_PRIVATE_KEY فارغة.');
  if (raw.startsWith('[')) {
    try { return Keypair.fromSecretKey(validateSecretBytes(JSON.parse(raw))); } catch (error) {
      if (error.message.startsWith('يجب')) throw error;
      throw new Error('صيغة MASTER_WALLET_PRIVATE_KEY غير صالحة. استخدم مصفوفة JSON من 64 رقماً.');
    }
  }
  try {
    const decoded = bs58.decode(raw);
    if (decoded.length !== 64) throw new Error('length');
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new Error('صيغة MASTER_WALLET_PRIVATE_KEY غير صالحة. استخدم Base58 صحيحاً أو مصفوفة JSON من 64 رقماً.');
  }
}

async function getQuote({ jupiterUrl, inputMint = SOL_MINT, outputMint, amountLamports, slippageBps = 100 }) {
  try {
    if (!inputMint || !outputMint || !PublicKey.isOnCurve(new PublicKey(outputMint).toBytes())) throw new Error('عنوان العملة غير صالح.');
    const { data } = await axios.get(`${jupiterUrl}/quote`, { params: { inputMint, outputMint, amount: amountLamports, slippageBps, swapMode: 'ExactIn' }, timeout: 8000 });
    return data;
  } catch (error) {
    if (error.message === 'عنوان العملة غير صالح.') throw error;
    throw new Error(`تعذر الحصول على سعر العملة: ${error.response?.data?.error || error.message}`);
  }
}

async function getTokenAmount({ rpcUrl, ownerSecret, mint, uiAmount }) {
  const wallet = keypairFromSecret(ownerSecret);
  try {
    const accounts = await connection(rpcUrl).getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    const account = accounts.value.find(({ account }) => Number(account.data.parsed.info.tokenAmount.uiAmount || 0) >= uiAmount);
    if (!account) throw new Error('الرصيد غير كافٍ لهذه العملة.');
    const info = account.account.data.parsed.info.tokenAmount;
    return { raw: Math.round(uiAmount * (10 ** info.decimals)), decimals: info.decimals };
  } catch (error) {
    if (error.message === 'الرصيد غير كافٍ لهذه العملة.') throw error;
    throw new Error(`تعذر قراءة رصيد العملة: ${error.message}`);
  }
}

async function getTokenBalance({ rpcUrl, ownerSecret, mint, fraction = 1 }) {
  const wallet = keypairFromSecret(ownerSecret);
  try {
    const accounts = await connection(rpcUrl).getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    const account = accounts.value.find(({ account }) => Number(account.data.parsed.info.tokenAmount.uiAmount || 0) > 0);
    if (!account) throw new Error('لا يوجد رصيد لهذه العملة.');
    const info = account.account.data.parsed.info.tokenAmount;
    return { raw: Math.floor(Number(info.amount) * fraction), decimals: info.decimals };
  } catch (error) {
    if (error.message === 'لا يوجد رصيد لهذه العملة.') throw error;
    throw new Error(`تعذر قراءة رصيد العملة: ${error.message}`);
  }
}

async function executeSwap({ rpcUrl, jupiterUrl, secret, quote, liveTrading }) {
  const wallet = keypairFromSecret(secret);
  if (!liveTrading) return { simulated: true, wallet: wallet.publicKey.toBase58(), message: 'الوضع التجريبي: لم تُرسل أي معاملة.' };
  try {
    const { data } = await axios.post(`${jupiterUrl}/swap`, { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }, { timeout: 15000 });
    const transaction = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
    transaction.sign([wallet]);
    const conn = connection(rpcUrl);
    const signature = await conn.sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
    await conn.confirmTransaction(signature, 'confirmed');
    return { simulated: false, signature, wallet: wallet.publicKey.toBase58() };
  } catch (error) {
    throw new Error(`فشل إرسال المعاملة: ${error.response?.data?.error || error.message}`);
  }
}

async function getPortfolio({ rpcUrl, secret }) {
  const wallet = keypairFromSecret(secret);
  try {
    const conn = connection(rpcUrl);
    const balance = await conn.getBalance(wallet.publicKey);
    const tokens = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
    return { address: wallet.publicKey.toBase58(), sol: balance / 1e9, tokens: tokens.value.map(({ account }) => account.data.parsed.info.tokenAmount).filter((x) => Number(x.uiAmount) > 0) };
  } catch (error) {
    throw new Error(`تعذر الاتصال بشبكة Solana: ${error.message}`);
  }
}

module.exports = { SOL_MINT, keypairFromSecret, getQuote, getTokenAmount, getTokenBalance, executeSwap, getPortfolio };
