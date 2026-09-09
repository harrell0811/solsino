const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');
const router = express.Router(); const prisma = new PrismaClient();
// A smaller selection is harder to hit, so it receives a larger multiplier.
// The boost is applied to the hit-based table rather than just changing the
// displayed odds, making it part of the authoritative server result.
const PAYOUTS = [0, 1, 2, 5, 12, 30, 80, 200, 500, 1200, 3000];
// Replaces the old selectionBoost() heuristic, which multiplied the
// same PAYOUTS curve by a rough (11-picks)/3 guess — that produced
// RTPs from 150% up to 352% for every pick count except 1 (verified
// by exact hypergeometric calculation, not a guess). The hit-count
// probability distribution shifts a LOT with pick count (picking 1
// number can only ever hit 0 or 1; picking 10 can hit anywhere from
// 0 to 10), so a single linear "boost" can't correct for it — each
// pick count needs its own exact normalizing factor. These factors
// are solved exactly so every pick count lands at 95% RTP:
// factor(picks) = 0.95 / E[PAYOUTS[hits]] computed via the real
// hypergeometric distribution for drawing 10 of 40 numbers.
const SELECTION_FACTOR = {
  1: 3.8,
  2: 1.9,
  3: 1.2269,
  4: 0.8659,
  5: 0.6355,
  6: 0.4756,
  7: 0.3596,
  8: 0.2735,
  9: 0.2089,
  10: 0.16,
};
function selectionBoost(selectionCount) {
  return SELECTION_FACTOR[selectionCount] ?? 0.16;
}

router.post('/play', async (req, res) => {
  const { userId, wagerLamports, picks } = req.body;
  try {
    const wager = BigInt(wagerLamports);
    const cleaned = [...new Set((picks || []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 40);
    if (wager <= 0n || cleaned.length < 1 || cleaned.length > 10) throw new Error('choose 1 to 10 unique numbers');
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } }); if (!user || user.balanceLamports < wager) throw new Error('insufficient devnet balance');
      const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } }); if (!seedPair) throw new Error('no active seed pair');
      const floats = getResults(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce, 60); const drawn = [];
      for (const f of floats) { const n = Math.floor(f * 40) + 1; if (!drawn.includes(n)) drawn.push(n); if (drawn.length === 10) break; }
      const hits = cleaned.filter((n) => drawn.includes(n));
      const multiplier = Number((PAYOUTS[hits.length] * selectionBoost(cleaned.length)).toFixed(2));
      const payout = BigInt(Math.floor(Number(wager) * multiplier));
      const updated = await tx.user.update({ where: { id: userId }, data: { balanceLamports: { increment: payout - wager } } });
      await tx.bet.create({ data: { userId, seedPairId: seedPair.id, nonce: seedPair.nonce, game: 'keno', wagerLamports: wager, payoutLamports: payout, choice: { picks: cleaned }, result: { drawn, hits, multiplier }, won: payout > wager } });
      await tx.seedPair.update({ where: { id: seedPair.id }, data: { nonce: { increment: 1 } } });
      return { drawn, hits, multiplier, payout, newBalanceLamports: updated.balanceLamports };
    });
    betEvents.emit('bet', { game: 'keno', wagerLamports: wager.toString(), payoutLamports: result.payout.toString(), won: result.payout > wager });
    // Do not spread the internal result: it carries BigInt values which
    // JSON.stringify cannot serialize.
    res.json({ drawn: result.drawn, hits: result.hits, multiplier: result.multiplier, selectionBoost: selectionBoost(cleaned.length), payoutLamports: result.payout.toString(), newBalanceLamports: result.newBalanceLamports.toString() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
module.exports = router;
