const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// 5% of the theoretical house edge generated since a player's last
// claim — i.e. rakeback, not a share of actual net losses. Each
// game bakes a fixed house edge into its payout math (see the
// HOUSE_EDGE constant in that game's route file); the "edge
// revenue" on any single bet is wagerLamports * that game's edge,
// regardless of whether the bet happened to win or lose. Basing
// cashback on this theoretical figure — rather than on realized
// wins/losses — means it isn't at the mercy of a player's short-term
// variance (a lucky player still earns cashback; the house isn't
// paying out of pocket on a session it actually lost money on).
const CASHBACK_RATE_NUMERATOR = 5n;
const CASHBACK_RATE_DENOMINATOR = 100n;

// Mirrors the HOUSE_EDGE constant declared in each game's own route
// file. Games not listed here (currently keno and blackjack, whose
// edge is baked into a fixed paytable / rule set rather than a
// single multiplier, and crash, which doesn't persist to the Bet
// table at all yet) fall back to DEFAULT_EDGE — a reasonable
// industry-average estimate rather than an exact figure for those
// games specifically.
const GAME_EDGE = {
  coinflip: 0.06,
  mines: 0.03,
  dragontower: 0.03,
  limbo: 0.04,
  slots: 0.06,
  cluster_slot: 0.06,
};
const DEFAULT_EDGE = 0.05;

function edgeRevenueForBet(bet) {
  const edge = GAME_EDGE[bet.game] ?? DEFAULT_EDGE;
  // Same float-then-floor pattern used everywhere else edge is applied
  // (e.g. slots.js), so rounding behaves consistently across the app.
  return BigInt(Math.floor(Number(bet.wagerLamports) * edge));
}

// NOTE: this only covers games that persist to the `Bet` table
// (coinflip, mines, slots, cluster-slot, limbo, dragon tower,
// blackjack, keno). Crash currently keeps its rounds in memory
// rather than writing them to the ledger, so crash wagers aren't
// counted here yet.
async function computePendingCashback(tx, user) {
  const bets = await tx.bet.findMany({
    where: { userId: user.id, createdAt: { gt: user.lastCashbackClaimAt } },
    select: { wagerLamports: true, game: true },
  });

  let edgeRevenue = 0n;
  for (const b of bets) {
    edgeRevenue += edgeRevenueForBet(b);
  }

  const cashback = (edgeRevenue * CASHBACK_RATE_NUMERATOR) / CASHBACK_RATE_DENOMINATOR;
  return { cashback, betsConsidered: bets.length };
}

/**
 * GET /api/cashback/status?userId=...
 * Read-only preview of what's currently claimable, for the UI badge.
 */
router.get('/status', async (req, res) => {
  const { userId } = req.query;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'user not found' });

    const { cashback } = await computePendingCashback(prisma, user);
    res.json({ pendingCashbackLamports: cashback.toString(), ratePercent: 5 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/cashback/claim
 * body: { userId }
 * Recomputes pending cashback fresh inside the transaction (so a
 * claim can't race with a bet landing in the same window), credits
 * it, and advances the checkpoint so it can't be claimed twice.
 */
router.post('/claim', async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('user not found');

      const { cashback } = await computePendingCashback(tx, user);
      if (cashback <= 0n) throw new Error('no cashback available to claim yet');

      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          balanceLamports: { increment: cashback },
          lastCashbackClaimAt: new Date(),
        },
      });

      return { cashback, newBalance: updated.balanceLamports };
    });

    res.json({
      claimedLamports: result.cashback.toString(),
      newBalanceLamports: result.newBalance.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
