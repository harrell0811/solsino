const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { resolveCoinflipAt } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.06; // 6% house edge -> payout multiplier below (94% RTP)

/**
 * Coinflip is a streak game, same shape as mines: the player wagers
 * once, then keeps flipping heads/tails. Each correct guess doubles
 * the multiplier and lets them either cash out or push their luck
 * on the next flip; one wrong guess busts the whole wager. This
 * mirrors mines.js's start/reveal/cashout split instead of
 * resolving everything in one request.
 *
 * Fairness: the round is pinned to a single (seedPair, nonce) at
 * start, same as any other bet. Each flip within the round pulls an
 * independent float from that nonce via an incrementing cursor
 * (resolveCoinflipAt) — the same multi-cursor trick mines/slots use
 * for their multi-step outcomes — so the whole streak is already
 * fully determined (and later verifiable) the moment the round
 * starts, even though the player reveals it one flip at a time.
 *
 * Payout math: N correct flips in a row has fair odds of 2^N (each
 * flip is an independent 50/50), discounted once by the house edge
 * — same "apply edge once to the fair value" approach as mines'
 * fairMultiplier, rather than compounding the edge per flip.
 */

function fairMultiplier(consecutiveWins) {
  return Math.pow(2, consecutiveWins) * (1 - HOUSE_EDGE);
}

function isValidChoice(choice) {
  return choice === 'heads' || choice === 'tails';
}

/**
 * POST /api/games/coinflip/start
 * body: { userId, wagerLamports, choice: 'heads' | 'tails' }
 * Debits the wager and resolves the first flip. If it wins, the
 * round stays open (roundId returned) for further /flip calls or a
 * /cashout. If it loses, the round ends immediately — same as a bust
 * on the very first mines tile.
 */
router.post('/start', async (req, res) => {
  const { userId, wagerLamports, choice } = req.body;

  if (!isValidChoice(choice)) {
    return res.status(400).json({ error: 'choice must be heads or tails' });
  }
  const wager = BigInt(wagerLamports);
  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });

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

      const outcome = resolveCoinflipAt(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce, 0);
      const won = outcome === choice;
      const flips = [{ cursor: 0, choice, outcome, won }];

      const bet = await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'coinflip',
          wagerLamports: wager,
          payoutLamports: 0n,
          choice: { mode: 'streak' },
          result: { flips, status: won ? 'in_progress' : 'busted' },
          won: false, // only set true once actually cashed out
        },
      });

      await tx.seedPair.update({
        where: { id: seedPair.id },
        data: { nonce: { increment: 1 } },
      });

      return { bet, newBalanceLamports: updatedUser.balanceLamports, outcome, won };
    });

    if (!result.won) {
      betEvents.emit('bet', { game: 'coinflip', wagerLamports: wager.toString(), won: false });
      return res.json({
        roundId: result.bet.id,
        busted: true,
        outcome: result.outcome,
        streak: 0,
        payoutLamports: '0',
        newBalanceLamports: result.newBalanceLamports.toString(),
      });
    }

    const multiplier = fairMultiplier(1);
    const currentPayout = BigInt(Math.floor(Number(wager) * multiplier));

    res.json({
      roundId: result.bet.id,
      busted: false,
      outcome: result.outcome,
      streak: 1,
      multiplier: multiplier.toFixed(4),
      currentCashoutLamports: currentPayout.toString(),
      newBalanceLamports: result.newBalanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/coinflip/flip
 * body: { userId, roundId, choice: 'heads' | 'tails' }
 * Continues an in-progress round with another flip. Wrong guess
 * busts the round (wager already taken at /start); right guess
 * bumps the streak and returns the new multiplier.
 */
router.post('/flip', async (req, res) => {
  const { userId, roundId, choice } = req.body;

  if (!isValidChoice(choice)) {
    return res.status(400).json({ error: 'choice must be heads or tails' });
  }

  try {
    const bet = await prisma.bet.findUnique({ where: { id: roundId }, include: { seedPair: true } });
    if (!bet || bet.userId !== userId) throw new Error('round not found');
    if (bet.result.status !== 'in_progress') throw new Error('round already finished');

    const cursor = bet.result.flips.length;
    const outcome = resolveCoinflipAt(bet.seedPair.serverSeed, bet.seedPair.clientSeed, bet.nonce, cursor);
    const won = outcome === choice;
    const flips = [...bet.result.flips, { cursor, choice, outcome, won }];

    if (!won) {
      await prisma.bet.update({
        where: { id: roundId },
        data: { result: { flips, status: 'busted' } },
      });
      betEvents.emit('bet', { game: 'coinflip', wagerLamports: bet.wagerLamports.toString(), won: false });
      return res.json({ busted: true, outcome, streak: 0, payoutLamports: '0' });
    }

    await prisma.bet.update({
      where: { id: roundId },
      data: { result: { flips, status: 'in_progress' } },
    });

    const streak = flips.filter((f) => f.won).length;
    const multiplier = fairMultiplier(streak);
    const currentPayout = BigInt(Math.floor(Number(bet.wagerLamports) * multiplier));

    res.json({
      busted: false,
      outcome,
      streak,
      multiplier: multiplier.toFixed(4),
      currentCashoutLamports: currentPayout.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/coinflip/cashout
 * body: { userId, roundId }
 * Locks in the payout at the current streak's multiplier.
 */
router.post('/cashout', async (req, res) => {
  const { userId, roundId } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const bet = await tx.bet.findUnique({ where: { id: roundId } });
      if (!bet || bet.userId !== userId) throw new Error('round not found');
      if (bet.result.status !== 'in_progress') throw new Error('round already finished');

      const streak = bet.result.flips.filter((f) => f.won).length;
      if (streak === 0) throw new Error('win at least one flip before cashing out');

      const multiplier = fairMultiplier(streak);
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
      return { payout, newBalance: user.balanceLamports, wagerLamports: bet.wagerLamports, streak };
    });

    betEvents.emit('bet', { game: 'coinflip', wagerLamports: result.wagerLamports.toString(), won: true });

    res.json({
      streak: result.streak,
      payoutLamports: result.payout.toString(),
      newBalanceLamports: result.newBalance.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
