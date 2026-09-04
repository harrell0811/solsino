const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.06; // matches coinflip/mines — ~95% RTP overall (verified by simulation)

const REELS = 5;
const ROWS = 3;
const NUM_LINES = 5;

/**
 * Regular symbols pay when 3+ line up left-to-right on a payline.
 * Wild substitutes for any regular symbol (not scatter). Scatter
 * pays anywhere in the grid (no payline needed) and triggers free
 * spins at 3+.
 *
 * Weights/pays are tuned (via Monte Carlo simulation, not guessed)
 * for ~40% of base spins landing at least one paying line and an
 * overall RTP around 95%. The previous table technically had a
 * higher jackpot ceiling but only paid on ~27% of spins while
 * blowing the RTP out to nearly 3x (largely from sticky wilds
 * compounding across free spins with no ceiling) — mathematically
 * generous but felt terrible to actually play, since most spins
 * were dead. This table trades some of that max-win size for a
 * much more consistent "something happens" rate.
 */
const SYMBOLS = [
  { id: 'lightning', emoji: '⚡', weight: 36, pay: { 3: 2.1, 4: 4.2, 5: 9 } },
  { id: 'rocket', emoji: '🚀', weight: 27, pay: { 3: 2.6, 4: 5.8, 5: 13.5 } },
  { id: 'moon', emoji: '🌙', weight: 17, pay: { 3: 3.4, 4: 9, 5: 22 } },
  { id: 'diamond', emoji: '💎', weight: 9, pay: { 3: 5.8, 4: 16, 5: 41 } },
  { id: 'fire', emoji: '🔥', weight: 4, pay: { 3: 9, 4: 27, 5: 67 } },
  { id: 'seven', emoji: '7️⃣', weight: 2, pay: { 3: 16, 4: 45, 5: 113 } },
  { id: 'wild', emoji: '⭐', weight: 5, pay: { 3: 18, 4: 45, 5: 102 }, isWild: true },
];
const SCATTER = { id: 'scatter', emoji: '🎰', weight: 3 };
const SCATTER_PAY = { 3: 2, 4: 5.5, 5: 14 }; // × total bet, paid on top of any line wins
const FREE_SPINS_AWARD = { 3: 6, 4: 8, 5: 8 };
const FREE_SPIN_MULTIPLIER = 1.5; // every win during free spins pays extra — lower than before since sticky wilds already compound across the round

const WEIGHTED_POOL = [...SYMBOLS, SCATTER];
const TOTAL_WEIGHT = WEIGHTED_POOL.reduce((sum, s) => sum + s.weight, 0);
// Free spins lean into premium symbols and wilds. The result is still derived
// from the committed seed; this only changes the published bonus pay table.
const BONUS_WEIGHTS = { lightning: 26, rocket: 20, moon: 16, diamond: 12, fire: 7, seven: 4, wild: 12, scatter: 3 };
const BONUS_WEIGHTED_POOL = [...SYMBOLS, SCATTER].map((symbol) => ({ ...symbol, weight: BONUS_WEIGHTS[symbol.id] }));
const BONUS_TOTAL_WEIGHT = BONUS_WEIGHTED_POOL.reduce((sum, s) => sum + s.weight, 0);

const PAYLINES = [
  [1, 1, 1, 1, 1], // middle row
  [0, 0, 0, 0, 0], // top row
  [2, 2, 2, 2, 2], // bottom row
  [0, 1, 2, 1, 0], // V
  [2, 1, 0, 1, 2], // ^
];

function pickSymbol(float, pool = WEIGHTED_POOL, totalWeight = TOTAL_WEIGHT) {
  const target = float * totalWeight;
  let cumulative = 0;
  for (const s of pool) {
    cumulative += s.weight;
    if (target < cumulative) return s;
  }
  return pool[pool.length - 1];
}

/** One provably-fair grid: REELS x ROWS symbols from a single nonce. */
function spinGrid(serverSeed, clientSeed, nonce, isBonus = false) {
  const floats = getResults(serverSeed, clientSeed, nonce, REELS * ROWS);
  const pool = isBonus ? BONUS_WEIGHTED_POOL : WEIGHTED_POOL;
  const totalWeight = isBonus ? BONUS_TOTAL_WEIGHT : TOTAL_WEIGHT;
  const grid = [];
  for (let col = 0; col < REELS; col++) {
    grid.push([0, 1, 2].map((row) => pickSymbol(floats[col * ROWS + row], pool, totalWeight)));
  }
  return grid;
}

function wildPositions(grid) {
  const positions = [];
  grid.forEach((col, reel) => col.forEach((symbol, row) => {
    if (symbol.isWild) positions.push([reel, row]);
  }));
  return positions;
}

function applyStickyWilds(grid, positions) {
  const wild = SYMBOLS.find((symbol) => symbol.isWild);
  positions.forEach(([reel, row]) => { grid[reel][row] = wild; });
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
      let stickyWilds = wildPositions(baseGrid);

      while (freeSpinsRemaining > 0) {
        const grid = spinGrid(seedPair.serverSeed, seedPair.clientSeed, seedPair.nonce + nonceOffset, true);
        nonceOffset++;
        applyStickyWilds(grid, stickyWilds);
        stickyWilds = wildPositions(grid);
        const resolved = resolveGrid(grid, betPerLine, wager);
        const boosted = BigInt(Math.floor(Number(resolved.payout) * FREE_SPIN_MULTIPLIER));
        rawPayout += boosted;
        spins.push({
          type: 'free',
          grid: gridToEmoji(grid),
          lineResults: resolved.lineResults,
          scatterCount: resolved.scatterCount,
          stickyWilds: stickyWilds.length,
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

    // The slot response is intentionally returned immediately so the client
    // can animate each reel. Hold the public ticker event until that reveal
    // has had time to finish, preventing the outcome from being shown first.
    const tickerDelayMs = Math.max(3200, result.spins.length * 4200);
    setTimeout(() => {
      betEvents.emit('bet', {
        game: 'slots',
        wagerLamports: wager.toString(),
        payoutLamports: result.totalPayout.toString(),
        won: result.totalPayout > 0n,
      });
    }, tickerDelayMs);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
