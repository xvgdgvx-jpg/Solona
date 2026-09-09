const axios = require('axios');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const connection = (rpcUrl) => new Connection(rpcUrl, 'confirmed');

function keypairFromSecret(secret) {
  if (Array.isArray(secret)) return Keypair.fromSecretKey(Uint8Array.from(secret));
  const raw = String(secret).trim();
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function getQuote({ jupiterUrl, inputMint = SOL_MINT, outputMint, amountLamports, slippageBps = 100 }) {
  if (!outputMint || !PublicKey.isOnCurve(new PublicKey(outputMint).toBytes())) throw new Error('Invalid output token mint');
  const { data } = await axios.get(`${jupiterUrl}/quote`, { params: { inputMint, outputMint, amount: amountLamports, slippageBps, swapMode: 'ExactIn' }, timeout: 8000 });
  return data;
}

async function getTokenAmount({ rpcUrl, ownerSecret, mint, uiAmount }) {
  const wallet = keypairFromSecret(ownerSecret);
  const accounts = await connection(rpcUrl).getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  const account = accounts.value.find(({ account }) => Number(account.data.parsed.info.tokenAmount.uiAmount || 0) >= uiAmount);
  if (!account) throw new Error('Insufficient token balance');
  const info = account.account.data.parsed.info.tokenAmount;
  return { raw: Math.round(uiAmount * (10 ** info.decimals)), decimals: info.decimals };
}

async function executeSwap({ rpcUrl, jupiterUrl, secret, quote, liveTrading }) {
  const wallet = keypairFromSecret(secret);
  if (!liveTrading) return { simulated: true, wallet: wallet.publicKey.toBase58(), message: 'Dry run only: set LIVE_TRADING=true after independent review to enable execution.' };
  const { data } = await axios.post(`${jupiterUrl}/swap`, { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }, { timeout: 15000 });
  const transaction = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
  transaction.sign([wallet]);
  const signature = await connection(rpcUrl).sendRawTransaction(transaction.serialize(), { maxRetries: 3, skipPreflight: false });
  await connection(rpcUrl).confirmTransaction(signature, 'confirmed');
  return { simulated: false, signature, wallet: wallet.publicKey.toBase58() };
}

async function getPortfolio({ rpcUrl, secret }) {
  const wallet = keypairFromSecret(secret);
  const conn = connection(rpcUrl);
  const balance = await conn.getBalance(wallet.publicKey);
  const tokens = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  return { address: wallet.publicKey.toBase58(), sol: balance / 1e9, tokens: tokens.value.map(({ account }) => account.data.parsed.info.tokenAmount).filter((x) => Number(x.uiAmount) > 0) };
}

module.exports = { SOL_MINT, keypairFromSecret, getQuote, getTokenAmount, executeSwap, getPortfolio };
