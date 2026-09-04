const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.03; // same as mines
const LEVELS = 9;

/**
 * Dragon Tower: climb a 9-level tower. Each level is a row of tiles;
 * pick one per level. Most tiles in the row are safe eggs, a
 * few are dragons — pick a dragon and the whole wager is lost,
 * otherwise the multiplier increases and the player can keep
 * climbing or cash out. Same start/reveal/cashout shape as
 * mines.js, just with a fresh row of odds per level instead of one
 * shared pool of tiles.
 */
const DIFFICULTIES = {
  easy: { tiles: 4, safe: 3 }, // 1 dragon per row
  medium: { tiles: 3, safe: 2 }, // 1 dragon per row
  hard: { tiles: 2, safe: 1 }, // 1 dragon per row
  expert: { tiles: 3, safe: 1 }, // 2 dragons per row
  master: { tiles: 4, safe: 1 }, // 3 dragons per row
};

/**
 * Determines, for every level, which tile indices within that
 * level's row are safe. All LEVELS * tiles floats are drawn from a
 * single nonce (same up-front-commitment approach as mines' full
 * grid) so the entire tower is fixed before the player takes a
 * single step, even though it's revealed one level at a time.
 */
function computeTowerLayout(serverSeed, clientSeed, nonce, tilesPerLevel, safePerLevel) {
  const floats = getResults(serverSeed, clientSeed, nonce, LEVELS * tilesPerLevel);
  const layout = [];
  for (let level = 0; level < LEVELS; level++) {
    const rowFloats = floats
      .slice(level * tilesPerLevel, (level + 1) * tilesPerLevel)
      .map((f, i) => ({ i, f }));
    rowFloats.sort((a, b) => a.f - b.f);
    // Lowest `safePerLevel` floats in the row are safe tiles — same
    // "sort and slice" trick mines.js uses to pick which indices win.
    const safeTiles = new Set(rowFloats.slice(0, safePerLevel).map((x) => x.i));
    layout.push(safeTiles);
  }
  return layout;
}

function fairMultiplier(levelsClimbed, tilesPerLevel, safePerLevel) {
  const perLevelOdds = tilesPerLevel / safePerLevel;
  return Math.pow(perLevelOdds, levelsClimbed) * (1 - HOUSE_EDGE);
}

/**
 * POST /api/games/dragontower/start
 * body: { userId, wagerLamports, difficulty }
 */
router.post('/start', async (req, res) => {
  const { userId, wagerLamports, difficulty } = req.body;
  const wager = BigInt(wagerLamports);
  const config = DIFFICULTIES[difficulty];

  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });
  if (!config) {
    return res.status(400).json({ error: `difficulty must be one of ${Object.keys(DIFFICULTIES).join(', ')}` });
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

      const bet = await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'dragontower',
          wagerLamports: wager,
          payoutLamports: 0n,
          choice: { difficulty, tiles: config.tiles, safe: config.safe },
          result: { level: 0, picks: [], status: 'in_progress' },
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
      difficulty,
      tilesPerLevel: config.tiles,
      levels: LEVELS,
      newBalanceLamports: result.newBalanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/dragontower/reveal
 * body: { userId, roundId, tile }
 * Picks a tile in the current (next unclimbed) level.
 */
router.post('/reveal', async (req, res) => {
  const { userId, roundId, tile } = req.body;
  const tileIndex = parseInt(tile, 10);

  try {
    const bet = await prisma.bet.findUnique({ where: { id: roundId }, include: { seedPair: true } });
    if (!bet || bet.userId !== userId) throw new Error('round not found');
    if (bet.result.status !== 'in_progress') throw new Error('round already finished');

    const { tiles, safe } = bet.choice;
    const currentLevel = bet.result.level;
    if (currentLevel >= LEVELS) throw new Error('already at the top of the tower');
    if (!(tileIndex >= 0 && tileIndex < tiles)) throw new Error(`tile must be between 0 and ${tiles - 1}`);

    const layout = computeTowerLayout(bet.seedPair.serverSeed, bet.seedPair.clientSeed, bet.nonce, tiles, safe);
    const safeTilesThisLevel = layout[currentLevel];
    const hitDragon = !safeTilesThisLevel.has(tileIndex);
    const picks = [...bet.result.picks, { level: currentLevel, tile: tileIndex, safe: !hitDragon }];

    if (hitDragon) {
      await prisma.bet.update({
        where: { id: roundId },
        data: {
          result: {
            level: currentLevel,
            picks,
            status: 'busted',
            // Reveal the whole layout on bust so the player can see
            // what they would have needed to pick, and independently
            // verify it against the (now-revealed, once rotated)
            // server seed later.
            layout: layout.map((set) => [...set]),
          },
          won: false,
        },
      });
      betEvents.emit('bet', { game: 'dragontower', wagerLamports: bet.wagerLamports.toString(), won: false });
      return res.json({
        hitDragon: true,
        level: currentLevel,
        safeTiles: [...safeTilesThisLevel],
        payoutLamports: '0',
      });
    }

    const newLevel = currentLevel + 1;
    const reachedTop = newLevel >= LEVELS;

    await prisma.bet.update({
      where: { id: roundId },
      data: {
        result: { level: newLevel, picks, status: reachedTop ? 'reached_top' : 'in_progress' },
      },
    });

    const multiplier = fairMultiplier(newLevel, tiles, safe);
    const currentPayout = BigInt(Math.floor(Number(bet.wagerLamports) * multiplier));

    res.json({
      hitDragon: false,
      level: newLevel,
      reachedTop,
      multiplier: multiplier.toFixed(4),
      currentCashoutLamports: currentPayout.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/dragontower/cashout
 * body: { userId, roundId }
 */
router.post('/cashout', async (req, res) => {
  const { userId, roundId } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const bet = await tx.bet.findUnique({ where: { id: roundId } });
      if (!bet || bet.userId !== userId) throw new Error('round not found');
      if (bet.result.status !== 'in_progress' && bet.result.status !== 'reached_top') {
        throw new Error('round already finished');
      }

      const level = bet.result.level;
      if (level === 0) throw new Error('climb at least one level before cashing out');

      const { tiles, safe } = bet.choice;
      const multiplier = fairMultiplier(level, tiles, safe);
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
      game: 'dragontower',
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
