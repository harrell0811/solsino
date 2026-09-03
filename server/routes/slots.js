const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.06; // matches coinflip/mines — 94% RTP overall

const REELS = 5;
const ROWS = 3;
const NUM_LINES = 5;

/**
 * Regular symbols pay when 3+ line up left-to-right on a payline.
 * Wild substitutes for any regular symbol (not scatter). Scatter
 * pays anywhere in the grid (no payline needed) and triggers free
 * spins at 3+.
 */
const SYMBOLS = [
  { id: 'lightning', emoji: '⚡', weight: 30, pay: { 3: 1, 4: 2, 5: 5 } },
  { id: 'rocket', emoji: '🚀', weight: 25, pay: { 3: 1.5, 4: 4, 5: 10 } },
  { id: 'moon', emoji: '🌙', weight: 20, pay: { 3: 2, 4: 6, 5: 15 } },
  { id: 'diamond', emoji: '💎', weight: 15, pay: { 3: 3, 4: 10, 5: 25 } },
  { id: 'fire', emoji: '🔥', weight: 8, pay: { 3: 5, 4: 20, 5: 50 } },
  { id: 'seven', emoji: '7️⃣', weight: 5, pay: { 3: 10, 4: 40, 5: 100 } },
  { id: 'wild', emoji: '⭐', weight: 4, pay: { 3: 15, 4: 50, 5: 150 }, isWild: true },
];
const SCATTER = { id: 'scatter', emoji: '🎰', weight: 3 };
const SCATTER_PAY = { 3: 2, 4: 5, 5: 15 }; // × total bet, paid on top of any line wins
const FREE_SPINS_AWARD = { 3: 5, 4: 8, 5: 12 };
const FREE_SPIN_MULTIPLIER = 2; // every win during free spins pays double

const WEIGHTED_POOL = [...SYMBOLS, SCATTER];
const TOTAL_WEIGHT = WEIGHTED_POOL.reduce((sum, s) => sum + s.weight, 0);

const PAYLINES = [
  [1, 1, 1, 1, 1], // middle row
  [0, 0, 0, 0, 0], // top row
  [2, 2, 2, 2, 2], // bottom row
  [0, 1, 2, 1, 0], // V
  [2, 1, 0, 1, 2], // ^
];

function pickSymbol(float) {
  const target = float * TOTAL_WEIGHT;
  let cumulative = 0;
  for (const s of WEIGHTED_POOL) {
    cumulative += s.weight;
    if (target < cumulative) return s;
  }
  return WEIGHTED_POOL[WEIGHTED_POOL.length - 1];
}

/** One provably-fair grid: REELS x ROWS symbols from a single nonce. */
function spinGrid(serverSeed, clientSeed, nonce) {
  const floats = getResults(serverSeed, clientSeed, nonce, REELS * ROWS);
  const grid = [];
  for (let col = 0; col < REELS; col++) {
    grid.push([0, 1, 2].map((row) => pickSymbol(floats[col * ROWS + row])));
  }
  return grid;
}

function evaluateLine(lineSymbols) {
  if (lineSymbols[0].id === 'scatter') return null;

  let target = lineSymbols[0].isWild ? null : lineSymbols[0];
  let length = 1;

  for (let i = 1; i < lineSymbols.length; i++) {
    const s = lineSymbols[i];
    if (s.id === 'scatter') break;
    if (s.isWild) {
      length++;
      continue;
    }
    if (target === null) {
      target = s;
      length++;
      continue;
    }
    if (s.id === target.id) length++;
    else break;
  }

  if (target === null) target = lineSymbols[0]; // whole match was wilds
  if (length < 3) return null;

  const tier = Math.min(length, 5);
  const multiplier = target.pay ? target.pay[tier] ?? target.pay[5] : 0;
  if (!multiplier) return null;

  return { symbolId: target.id, length, multiplier };
}

function countScatters(grid) {
  let count = 0;
  for (const col of grid) for (const cell of col) if (cell.id === 'scatter') count++;
  return count;
}

function resolveGrid(grid, betPerLine, totalBet) {
  let payout = 0n;
  const lineResults = [];

  PAYLINES.forEach((rows, idx) => {
    const lineSymbols = rows.map((row, col) => grid[col][row]);
    const res = evaluateLine(lineSymbols);
    if (res) {
      const win = BigInt(Math.floor(Number(betPerLine) * res.multiplier));
      payout += win;
      lineResults.push({ line: idx, ...res, payoutLamports: win.toString() });
    }
  });

  const scatterCount = countScatters(grid);
  let scatterPayout = 0n;
  if (scatterCount >= 3 && SCATTER_PAY[scatterCount]) {
    scatterPayout = BigInt(Math.floor(Number(totalBet) * SCATTER_PAY[scatterCount]));
    payout += scatterPayout;
  }

  return { payout, lineResults, scatterCount, scatterPayout: scatterPayout.toString() };
}

function gridToEmoji(grid) {
  return grid.map((col) => col.map((s) => s.emoji));
}

/**
 * POST /api/games/slots/spin
 * body: { userId, wagerLamports }
 *
 * A single request resolves the WHOLE round including any bonus free
 * spins — the server has all the randomness it needs up front, so
 * there's no reason to make this stateful across requests. The
 * frontend gets back an ordered array of every grid spun (base +
 * any free spins) and animates through them for the reveal.
 */
router.post('/spin', async (req, res) => {
  const { userId, wagerLamports } = req.body;
  const wager = BigInt(wagerLamports);
  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });

  const betPerLine = wager / BigInt(NUM_LINES);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('user not found');
      if (user.balanceLamports < wager) throw new Error('insufficient balance');

      const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } });
      if (!seedPair) throw new Error('no active seed pair — call /api/seeds/rotate first');

      const spins = [];
      let rawPayout = 0n;
      let nonceOffset = 0;

      const baseGrid = spinGrid(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce + nonceOffset);
      nonceOffset++;
      const baseResolved = resolveGrid(baseGrid, betPerLine, wager);
      rawPayout += baseResolved.payout;
      spins.push({
        type: 'base',
        grid: gridToEmoji(baseGrid),
        lineResults: baseResolved.lineResults,
        scatterCount: baseResolved.scatterCount,
        payoutLamports: baseResolved.payout.toString(),
      });

      let freeSpinsRemaining = FREE_SPINS_AWARD[baseResolved.scatterCount] || 0;
      const bonusTriggered = freeSpinsRemaining > 0;

      while (freeSpinsRemaining > 0) {
        const grid = spinGrid(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce + nonceOffset);
        nonceOffset++;
        const resolved = resolveGrid(grid, betPerLine, wager);
        const boosted = resolved.payout * BigInt(FREE_SPIN_MULTIPLIER);
        rawPayout += boosted;
        spins.push({
          type: 'free',
          grid: gridToEmoji(grid),
          lineResults: resolved.lineResults,
          scatterCount: resolved.scatterCount,
          payoutLamports: boosted.toString(),
        });
        freeSpinsRemaining--;
      }

      const totalPayout = BigInt(Math.floor(Number(rawPayout) * (1 - HOUSE_EDGE)));
      const newBalance = user.balanceLamports - wager + totalPayout;

      await tx.user.update({ where: { id: userId }, data: { balanceLamports: newBalance } });

      const bet = await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'slots',
          wagerLamports: wager,
          payoutLamports: totalPayout,
          choice: { wagerLamports: wagerLamports.toString() },
          result: { spins, bonusTriggered },
          won: totalPayout > 0n,
        },
      });

      await tx.seedPair.update({
        where: { id: seedPair.id },
        data: { nonce: { increment: nonceOffset } },
      });

      return { bet, newBalance, spins, totalPayout, bonusTriggered };
    });

    res.json({
      betId: result.bet.id,
      spins: result.spins,
      bonusTriggered: result.bonusTriggered,
      totalPayoutLamports: result.totalPayout.toString(),
      newBalanceLamports: result.newBalance.toString(),
    });

    betEvents.emit('bet', {
      game: 'slots',
      wagerLamports: wager.toString(),
      won: result.totalPayout > 0n,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
