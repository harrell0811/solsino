/**
 * Provably Fair Engine
 * ---------------------------------------------------------
 * Industry-standard commit-reveal scheme (same approach used by
 * Stake, Rollbit, etc.) so a player can independently verify that
 * the house did not know or alter the outcome of a bet in advance.
 *
 * Flow:
 *  1. Server generates a random `serverSeed`, hashes it (SHA-256),
 *     and shows the player the HASH before the bet (the "commit").
 *  2. Player supplies (or is assigned) a `clientSeed`.
 *  3. Each bet increments a `nonce` for that seed pair.
 *  4. Outcome = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`),
 *     converted to a float in [0, 1).
 *  5. When the player rotates their seed (or on request), the server
 *     reveals the original `serverSeed`. Anyone can hash it and
 *     confirm it matches the original commit, then recompute every
 *     bet's outcome to prove nothing was tampered with.
 */

const crypto = require('crypto');

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

function generateClientSeed() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Core RNG: deterministic given (serverSeed, clientSeed, nonce).
 * Returns a float in [0, 1).
 */
function getResult(serverSeed, clientSeed, nonce, cursor = 0) {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${cursor}`)
    .digest('hex');

  // Use first 8 hex chars (32 bits) for a uniform float
  const int = parseInt(hmac.substring(0, 8), 16);
  return int / 0x100000000; // divide by 2^32
}

/**
 * Produces N independent floats from the same bet (e.g. Mines needs
 * one float per tile, Keno needs one per drawn number) by varying
 * the cursor.
 */
function getResults(serverSeed, clientSeed, nonce, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(getResult(serverSeed, clientSeed, nonce, i));
  }
  return out;
}

/** Coinflip: single float -> 'heads' | 'tails' */
function resolveCoinflip(serverSeed, clientSeed, nonce) {
  return resolveCoinflipAt(serverSeed, clientSeed, nonce, 0);
}

/**
 * Coinflip at a specific cursor within a nonce. Lets a single bet
 * (one nonce) produce a whole streak of independent flips — cursor
 * 0 is the first flip, cursor 1 the second if the player keeps
 * going, etc. — the same multi-cursor trick getResults() uses for
 * mines/slots, just resolved one flip at a time on demand.
 */
function resolveCoinflipAt(serverSeed, clientSeed, nonce, cursor) {
  const r = getResult(serverSeed, clientSeed, nonce, cursor);
  return r < 0.5 ? 'heads' : 'tails';
}

/**
 * Independent verification function — this is exactly what you'd
 * publish for players to run client-side (e.g. in a "Verify" modal
 * or a standalone JS file) to check a past bet themselves.
 */
function verifyBet({ serverSeed, serverSeedHash, clientSeed, nonce, game }) {
  const computedHash = hashServerSeed(serverSeed);
  if (computedHash !== serverSeedHash) {
    return { valid: false, reason: 'server seed does not match original commit hash' };
  }
  const result = game === 'coinflip'
    ? resolveCoinflip(serverSeed, clientSeed, nonce)
    : getResult(serverSeed, clientSeed, nonce);
  return { valid: true, result };
}

module.exports = {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
  getResult,
  getResults,
  resolveCoinflip,
  resolveCoinflipAt,
  verifyBet,
};
