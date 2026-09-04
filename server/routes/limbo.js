const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResult } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.04; // 4% — same family as coinflip/mines/slots (96% RTP)
const MIN_TARGET = 1.01;
const MAX_TARGET = 1_000_000;

/**
 * Limbo is the simplest provably-fair game in the lineup: no rounds,
 * no reveal/cashout steps, just one request that both places the bet
 * and resolves it. The player picks a target multiplier; the server
 * derives a "roll" multiplier from the seed pair the exact same way
 * Crash derives its crash point (see server/crashEngine.js), and the
 * player wins their target multiplier if the roll is >= target.
 *
 * Roll distribution: for a uniform float f in [0, 1), 1 / (1 - f)
 * produces a heavy-tailed distribution where P(roll >= m) = 1/m for
 * any m >= 1 — exactly what you want for a fair "pick your own odds"
 * game. Discounting once by HOUSE_EDGE (same "apply the edge once to
 * the fair value" approach used everywhere else in this codebase)
 * gives the house its edge regardless of what target the player
 * picks.
 */
function rollMultiplier(serverSeed, clientSeed, nonce) {
  const f = getResult(serverSeed, clientSeed, nonce);
  // f is in [0, 1); guard the extremely unlikely f === 1-epsilon case
  // that would blow up division, same guard style as crashEngine.
  const raw = 1 / Math.max(1 - f, 1e-9);
  const discounted = raw * (1 - HOUSE_EDGE);
  return Math.max(1, Math.floor(discounted * 100) / 100);
}

/**
 * POST /api/games/limbo/bet
 * body: { userId, wagerLamports, targetMultiplier }
 * Resolves immediately — win or lose, balance updated in one call.
 */
router.post('/bet', async (req, res) => {
  const { userId, wagerLamports, targetMultiplier } = req.body;
  const wager = BigInt(wagerLamports);
  const target = Number(targetMultiplier);

  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });
  if (!(target >= MIN_TARGET && target <= MAX_TARGET)) {
    return res.status(400).json({ error: `targetMultiplier must be between ${MIN_TARGET} and ${MAX_TARGET}` });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('user not found');
      if (user.balanceLamports < wager) throw new Error('insufficient balance');

      const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } });
      if (!seedPair) throw new Error('no active seed pair — call /api/seeds/rotate first');

      const roll = rollMultiplier(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce);
      const won = roll >= target;
      const payout = won ? BigInt(Math.floor(Number(wager) * target)) : 0n;

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balanceLamports: { increment: payout - wager } },
      });

      await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'limbo',
          wagerLamports: wager,
          payoutLamports: payout,
          choice: { targetMultiplier: target },
          result: { roll },
          won,
        },
      });

      await tx.seedPair.update({
        where: { id: seedPair.id },
        data: { nonce: { increment: 1 } },
      });

      return { won, roll, payout, newBalanceLamports: updatedUser.balanceLamports };
    });

    betEvents.emit('bet', {
      game: 'limbo',
      wagerLamports: wager.toString(),
      payoutLamports: result.payout.toString(),
      won: result.won,
    });

    res.json({
      won: result.won,
      rollMultiplier: result.roll.toFixed(2),
      targetMultiplier: target,
      payoutLamports: result.payout.toString(),
      newBalanceLamports: result.newBalanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
