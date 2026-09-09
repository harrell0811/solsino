const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// 10% of a player's net losses since their last claim — noticeable
// (real money coming back regularly) while remaining comfortably
// profitable, since it's always a fraction of money the house has
// already won. Because it's computed on demand rather than accrued
// as a running balance, there's no separate ledger to keep in sync —
// just sum (wager - payout) across bets since the checkpoint, floor
// negatives (wins) at zero so they don't offset other losses, and
// take 10% of that.
const CASHBACK_RATE_NUMERATOR = 10n;
const CASHBACK_RATE_DENOMINATOR = 100n;

// NOTE: this only covers games that persist to the `Bet` table
// (coinflip, mines, slots, cluster-slot, limbo, dragon tower,
// blackjack, keno). Crash currently keeps its rounds in memory
// rather than writing them to the ledger, so crash losses aren't
// counted here yet.
async function computePendingCashback(tx, user) {
  const bets = await tx.bet.findMany({
    where: { userId: user.id, createdAt: { gt: user.lastCashbackClaimAt } },
    select: { wagerLamports: true, payoutLamports: true },
  });

  let netLoss = 0n;
  for (const b of bets) {
    const diff = b.wagerLamports - b.payoutLamports;
    if (diff > 0n) netLoss += diff; // only count bets that were net losses
  }

  const cashback = (netLoss * CASHBACK_RATE_NUMERATOR) / CASHBACK_RATE_DENOMINATOR;
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
    res.json({ pendingCashbackLamports: cashback.toString(), ratePercent: 10 });
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
