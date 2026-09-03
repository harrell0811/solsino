/**
 * Solana connection + house hot-wallet helpers.
 *
 * Model: a single house wallet receives ALL user deposits (each
 * deposit tagged with a memo containing the user's ID so it can be
 * matched to an account), and sends ALL withdrawals. This avoids
 * managing a unique keypair per user, at the cost of needing a
 * deposit-watcher that reads memos (see depositWatcher.js).
 *
 * Required env vars:
 *   SOLANA_RPC_URL          e.g. https://api.mainnet-beta.solana.com
 *   HOUSE_WALLET_SECRET_KEY JSON array secret key, e.g. "[12,45,...]"
 *   PROFIT_WALLET_ADDRESS   where house edge revenue gets swept to
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// House wallet secret key must be kept OUT of source control — env var
// or a secrets manager only. Never commit HOUSE_WALLET_SECRET_KEY.
function loadHouseKeypair() {
  const raw = process.env.HOUSE_WALLET_SECRET_KEY;
  if (!raw) {
    throw new Error('HOUSE_WALLET_SECRET_KEY is not set');
  }
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

// This is where accumulated house edge revenue gets swept to.
// Set explicitly so it can't silently drift.
const PROFIT_WALLET_ADDRESS = new PublicKey(
  process.env.PROFIT_WALLET_ADDRESS || 'BpWUJke7bm1dvizMAZD4EDMjn7PruAuuAVNJBqxWTAVg'
);

async function getHouseBalanceLamports() {
  const houseKeypair = loadHouseKeypair();
  return connection.getBalance(houseKeypair.publicKey);
}

/**
 * Sends `lamports` from the house wallet to `toAddress`.
 * Used for both user withdrawals and profit sweeps.
 */
async function sendSol(toAddress, lamports) {
  const houseKeypair = loadHouseKeypair();
  const toPubkey = new PublicKey(toAddress);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: houseKeypair.publicKey,
      toPubkey,
      lamports: Number(lamports),
    })
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [houseKeypair]);
  return signature;
}

module.exports = {
  connection,
  loadHouseKeypair,
  getHouseBalanceLamports,
  sendSol,
  PROFIT_WALLET_ADDRESS,
};
