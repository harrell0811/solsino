const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.03; // 3% — mines supports a slightly higher edge than coinflip
const GRID_SIZE = 25; // 5x5 grid, tile indices 0-24

/**
 * Mines works differently from coinflip/keno: it's a multi-step bet
 * where the player reveals tiles one at a time and can cash out at
 * any point before hitting a mine. That means we can't resolve the
 * whole bet in one request — we need to track an in-progress round.
 *
 * Simplification for this slice: the ENTIRE mine layout for the round
 * is derived once (from the seed pair + nonce) when the round starts,
 * using getResults() for GRID_SIZE cursor positions. This is safe to
 * do up front because the layout itself is committed via the
 * server-seed hash before the player ever plays — revealing tiles one
 * at a time doesn't require re-rolling anything, just checking against
 * the already-determined layout.
 *
 * Fair payout math: revealing N safe tiles out of T total with M
 * mines pays a multiplier equal to the inverse probability of getting
 * that far by chance, i.e. the product of (remaining safe) /
 * (remaining total) for each pick, inverted — then the house edge
 * discounts it same as coinflip.
 */

function computeMineLayout(serverSeed, clientSeed, nonce, mineCount) {
  const floats = getResults(serverSeed, clientSeed, nonce, GRID_SIZE);
  // Pair each tile index with its float, sort, take the lowest
  // `mineCount` as mine positions. Deterministic given the inputs.
  const indexed = floats.map((f, i) => ({ i, f }));
  indexed.sort((a, b) => a.f - b.f);
  const mineTiles = new Set(indexed.slice(0, mineCount).map((x) => x.i));
  return mineTiles;
}

function fairMultiplier(tilesRevealed, mineCount) {
  // Probability of surviving `tilesRevealed` picks in a row, with
  // `mineCount` mines among GRID_SIZE tiles, tiles removed as picked.
  let probability = 1;
  for (let i = 0; i < tilesRevealed; i++) {
    const safeRemaining = GRID_SIZE - mineCount - i;
    const totalRemaining = GRID_SIZE - i;
    probability *= safeRemaining / totalRemaining;
  }
  const fairPayout = 1 / probability;
  return fairPayout * (1 - HOUSE_EDGE);
}

/**
 * POST /api/games/mines/start
 * body: { userId, wagerLamports, mineCount }
 * Starts a round: debits the wager, determines (but does not reveal)
 * the mine layout, and returns a roundId to use for subsequent
 * /reveal and /cashout calls.
 */
router.post('/start', async (req, res) => {
  const { userId, wagerLamports, mineCount } = req.body;
  const wager = BigInt(wagerLamports);
  const mines = parseInt(mineCount, 10);

  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });
  if (!(mines >= 1 && mines <= 24)) {
    return res.status(400).json({ error: 'mineCount must be between 1 and 24' });
  }

  try {
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

      // Store the in-progress round as a Bet row with won=false and
      // result holding round state; it gets finalized on cashout/bust.
      const bet = await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'mines',
          wagerLamports: wager,
          payoutLamports: 0n,
          choice: { mineCount: mines },
          result: { revealedTiles: [], status: 'in_progress' },
          won: false,
        },
      });

      await tx.seedPair.update({
        where: { id: seedPair.id },
        data: { nonce: { increment: 1 } },
      });

      return { betId: bet.id, newBalanceLamports: updatedUser.balanceLamports };
    });

    res.json({
      roundId: result.betId,
      mineCount: mines,
      gridSize: GRID_SIZE,
      // The wager is already debited above — send the new balance back
      // immediately so the frontend doesn't show a stale (pre-debit)
      // number until the next unrelated refresh.
      newBalanceLamports: result.newBalanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/mines/reveal
 * body: { userId, roundId, tile }  (tile: 0-24)
 * Reveals one tile. If it's a mine, the round busts (wager lost).
 * If safe, returns the current multiplier and lets the player
 * continue or cash out.
 */
router.post('/reveal', async (req, res) => {
  const { userId, roundId, tile } = req.body;
  const tileIndex = parseInt(tile, 10);

  try {
    const bet = await prisma.bet.findUnique({
      where: { id: roundId },
      include: { seedPair: true },
    });
    if (!bet || bet.userId !== userId) throw new Error('round not found');
    if (bet.result.status !== 'in_progress') throw new Error('round already finished');
    if (bet.result.revealedTiles.includes(tileIndex)) throw new Error('tile already revealed');

    const mineCount = bet.choice.mineCount;
    const mineTiles = computeMineLayout(
      bet.seedPair.serverSeed,
      bet.seedPair.clientSeed,
      bet.nonce,
      mineCount
    );

    const hitMine = mineTiles.has(tileIndex);
    const revealedTiles = [...bet.result.revealedTiles, tileIndex];

    if (hitMine) {
      await prisma.bet.update({
        where: { id: roundId },
        data: {
          result: { revealedTiles, status: 'busted', mineTiles: [...mineTiles] },
          won: false,
        },
      });
      betEvents.emit('bet', { game: 'mines', wagerLamports: bet.wagerLamports.toString(), won: false });
      return res.json({ hitMine: true, mineTiles: [...mineTiles], payoutLamports: '0' });
    }

    await prisma.bet.update({
      where: { id: roundId },
      data: { result: { revealedTiles, status: 'in_progress' } },
    });

    const multiplier = fairMultiplier(revealedTiles.length, mineCount);
    const currentPayout = BigInt(Math.floor(Number(bet.wagerLamports) * multiplier));

    res.json({
      hitMine: false,
      revealedTiles,
      multiplier: multiplier.toFixed(4),
      currentCashoutLamports: currentPayout.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/mines/cashout
 * body: { userId, roundId }
 * Locks in the payout at the current multiplier and credits the
 * user's balance.
 */
router.post('/cashout', async (req, res) => {
  const { userId, roundId } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const bet = await tx.bet.findUnique({ where: { id: roundId } });
      if (!bet || bet.userId !== userId) throw new Error('round not found');
      if (bet.result.status !== 'in_progress') throw new Error('round already finished');

      const revealedCount = bet.result.revealedTiles.length;
      if (revealedCount === 0) throw new Error('reveal at least one tile before cashing out');

      const mineCount = bet.choice.mineCount;
      const multiplier = fairMultiplier(revealedCount, mineCount);
      const payout = BigInt(Math.floor(Number(bet.wagerLamports) * multiplier));

      await tx.user.update({
        where: { id: userId },
        data: { balanceLamports: { increment: payout } },
      });

      await tx.bet.update({
        where: { id: roundId },
        data: {
          payoutLamports: payout,
          won: true,
          result: { ...bet.result, status: 'cashed_out' },
        },
      });

      const user = await tx.user.findUnique({ where: { id: userId } });
      return { payout, newBalance: user.balanceLamports, wagerLamports: bet.wagerLamports };
    });

    betEvents.emit('bet', {
      game: 'mines',
      wagerLamports: result.wagerLamports.toString(),
      payoutLamports: result.payout.toString(),
      won: true,
    });

    res.json({
      payoutLamports: result.payout.toString(),
      newBalanceLamports: result.newBalance.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
