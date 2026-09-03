/**
 * Crash game engine.
 *
 * Unlike coinflip/mines (resolved in a single request), crash is a
 * shared round that every connected player watches and bets into at
 * once: a multiplier climbs from 1.00x in real time and can be
 * cashed out at any point — until it "crashes", at which point every
 * player still in loses their wager.
 *
 * Provably fair: a fresh server seed is generated for each round and
 * its HASH is broadcast the moment betting opens (the commit). The
 * crash point is derived from that seed via a standard
 * hash-to-crash-point formula (the same approach used by Bustabit/
 * Stake-style crash games) so the house edge is baked into the
 * distribution itself rather than needing a separate multiplier
 * discount. The seed itself is only revealed once the round ends,
 * so anyone can verify afterwards that it wasn't chosen to dodge
 * cashouts.
 *
 * This lives as a standalone module (rather than inside routes/) so
 * both server/index.js (which owns the io instance and starts the
 * round loop) and routes/crash.js (which handles bet/cashout HTTP
 * calls) can share one in-memory round state.
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const betEvents = require('./events');

const prisma = new PrismaClient();

const HOUSE_EDGE_PERCENT = 4; // 4% — same ballpark as mines
const WAITING_MS = 7000; // betting window before a round starts
const CRASHED_PAUSE_MS = 3500; // pause on the crash screen before the next round
const TICK_MS = 100; // multiplier broadcast cadence
const GROWTH_PER_MS = 0.00006; // tuned so ~2x lands around 11-12s in

let io = null;
let phase = 'waiting'; // 'waiting' | 'running' | 'crashed'
let roundId = null;
let roundServerSeed = null;
let roundServerSeedHash = null;
let crashPoint = 1.0; // multiplier at which this round busts
let runningStartedAt = null;
let currentMultiplier = 1.0;
let phaseEndsAt = null;
let tickHandle = null;
let phaseTimer = null;

// userId -> { betId, wagerLamports, cashedOut, cashoutMultiplier }
let activeBets = new Map();

// Most recent crash points, newest first — purely in-memory, just
// for the "recent history" strip in the UI (not used for fairness
// verification, which relies on the per-round serverSeed instead).
const MAX_HISTORY = 25;
let roundHistory = [];

function generateRoundSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * Standard hash-to-crash-point formula. Deterministic given the
 * seed, and produces an outcome distribution whose expected payout
 * ratio is exactly (1 - houseEdge) — an "instant crash" at 1.00x
 * happens with probability houseEdge%, baking the edge in without
 * needing to discount every individual cashout.
 */
function crashPointFromSeed(seed, houseEdgePercent) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const h = parseInt(hash.slice(0, 13), 16);
  const maxH = Math.pow(2, 52);

  if (h % Math.floor(100 / houseEdgePercent) === 0) {
    return 1.0; // instant bust
  }

  const point = Math.floor((100 * maxH - h) / (maxH - h));
  return Math.max(point, 100) / 100;
}

function computeCurrentMultiplier() {
  if (phase === 'crashed') return crashPoint;
  if (phase !== 'running' || !runningStartedAt) return 1.0;
  const elapsed = Date.now() - runningStartedAt;
  return Math.exp(GROWTH_PER_MS * elapsed);
}

function getPublicState() {
  return {
    phase,
    roundId,
    serverSeedHash: roundServerSeedHash,
    multiplier: Number(computeCurrentMultiplier().toFixed(4)),
    crashPoint: phase === 'crashed' ? crashPoint : null,
    serverSeed: phase === 'crashed' ? roundServerSeed : null,
    phaseEndsAt,
    playerCount: activeBets.size,
    recentCrashes: roundHistory,
  };
}

function broadcast(event, extra = {}) {
  if (!io) return;
  io.emit(event, { ...getPublicState(), ...extra });
}

async function settleLosers() {
  const losers = [...activeBets.entries()].filter(([, b]) => !b.cashedOut);
  if (losers.length === 0) return;

  await Promise.all(
    losers.map(async ([userId, b]) => {
      try {
        await prisma.bet.update({
          where: { id: b.betId },
          data: {
            payoutLamports: 0n,
            won: false,
            result: { status: 'busted', crashPoint },
          },
        });
        betEvents.emit('bet', { game: 'crash', wagerLamports: b.wagerLamports.toString(), won: false });
      } catch (err) {
        console.error('[crashEngine] failed to settle loser', userId, err.message);
      }
    })
  );
}

function startWaitingPhase() {
  phase = 'waiting';
  roundId = crypto.randomUUID();
  roundServerSeed = generateRoundSeed();
  roundServerSeedHash = hashSeed(roundServerSeed);
  crashPoint = crashPointFromSeed(roundServerSeed, HOUSE_EDGE_PERCENT);
  currentMultiplier = 1.0;
  runningStartedAt = null;
  activeBets = new Map();
  phaseEndsAt = Date.now() + WAITING_MS;

  broadcast('crash:waiting');

  phaseTimer = setTimeout(startRunningPhase, WAITING_MS);
}

function startRunningPhase() {
  phase = 'running';
  runningStartedAt = Date.now();
  phaseEndsAt = null;

  broadcast('crash:running');

  tickHandle = setInterval(() => {
    currentMultiplier = computeCurrentMultiplier();
    if (currentMultiplier >= crashPoint) {
      finishRound();
      return;
    }
    broadcast('crash:tick');
  }, TICK_MS);
}

function finishRound() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
  phase = 'crashed';
  currentMultiplier = crashPoint;
  phaseEndsAt = Date.now() + CRASHED_PAUSE_MS;

  roundHistory = [Number(crashPoint.toFixed(2)), ...roundHistory].slice(0, MAX_HISTORY);

  broadcast('crash:crashed');
  settleLosers();

  phaseTimer = setTimeout(startWaitingPhase, CRASHED_PAUSE_MS);
}

function init(ioInstance) {
  io = ioInstance;
  if (!roundId) startWaitingPhase();
}

/**
 * Places a bet into the current round. Only allowed during the
 * waiting phase. Debits the wager immediately, same pattern as
 * mines/coinflip, and records a Bet row against the user's own
 * active seed pair (used for audit/nonce bookkeeping — the crash
 * point itself comes from the round's own seed above, not the
 * user's, since it's shared across every player in the round).
 */
async function placeBet(userId, wagerLamportsStr) {
  if (phase !== 'waiting') {
    throw new Error('betting is closed for this round — wait for the next one');
  }
  if (activeBets.has(userId)) {
    throw new Error('you already have a bet in this round');
  }

  const wager = BigInt(wagerLamportsStr);
  if (wager <= 0n) throw new Error('wager must be positive');

  const capturedRoundId = roundId;

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('user not found');
    if (user.balanceLamports < wager) throw new Error('insufficient balance');

    const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } });
    if (!seedPair) throw new Error('no active seed pair — call /api/seeds/rotate first');

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balanceLamports: { decrement: wager } },
    });

    const bet = await tx.bet.create({
      data: {
        userId,
        seedPairId: seedPair.id,
        nonce: seedPair.nonce,
        game: 'crash',
        wagerLamports: wager,
        payoutLamports: 0n,
        choice: { roundId: capturedRoundId },
        result: { status: 'in_progress' },
        won: false,
      },
    });

    await tx.seedPair.update({
      where: { id: seedPair.id },
      data: { nonce: { increment: 1 } },
    });

    return { betId: bet.id, newBalanceLamports: updatedUser.balanceLamports };
  });

  // Round may have rolled over while the transaction was in flight —
  // refuse rather than silently attaching the bet to the wrong round.
  if (roundId !== capturedRoundId || phase !== 'waiting') {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { balanceLamports: { increment: wager } } });
      await tx.bet.update({
        where: { id: result.betId },
        data: { result: { status: 'voided_round_rollover' } },
      });
    });
    throw new Error('round changed while placing bet — try again');
  }

  activeBets.set(userId, { betId: result.betId, wagerLamports: wager, cashedOut: false, cashoutMultiplier: null });
  broadcast('crash:waiting');

  return { roundId, betId: result.betId, newBalanceLamports: result.newBalanceLamports.toString() };
}

/**
 * Cashes out the caller's active bet in the current round at
 * whatever multiplier has been reached the instant this is called.
 */
async function cashout(userId) {
  if (phase !== 'running') {
    throw new Error('no round is currently running');
  }
  const bet = activeBets.get(userId);
  if (!bet) throw new Error('you have no active bet this round');
  if (bet.cashedOut) throw new Error('already cashed out');

  const multiplier = computeCurrentMultiplier();
  if (multiplier >= crashPoint) {
    throw new Error('too late — round already crashed');
  }

  const payout = BigInt(Math.floor(Number(bet.wagerLamports) * multiplier));

  const updatedUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { balanceLamports: { increment: payout } },
    });
    await tx.bet.update({
      where: { id: bet.betId },
      data: {
        payoutLamports: payout,
        won: true,
        result: { status: 'cashed_out', multiplier },
      },
    });
    return user;
  });

  bet.cashedOut = true;
  bet.cashoutMultiplier = multiplier;

  betEvents.emit('bet', { game: 'crash', wagerLamports: bet.wagerLamports.toString(), won: true });

  return {
    payoutLamports: payout.toString(),
    multiplier: Number(multiplier.toFixed(4)),
    newBalanceLamports: updatedUser.balanceLamports.toString(),
  };
}

module.exports = { init, placeBet, cashout, getPublicState };
