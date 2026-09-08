const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const prisma = new PrismaClient();
const HOUSE_EDGE = 0.06; // matches the rest of the games — 94% RTP overall

const COLS = 6;
const ROWS = 5;
const MIN_CLUSTER = 5; // 5+ touching (up/down/left/right) symbols pays
const MAX_TUMBLES = 15; // safety cap so a freak cascade can't run forever
const MULTIPLIER_TRAIL = [1, 2, 3, 5, 8, 13, 21]; // climbs each consecutive tumble, caps at 21x

/**
 * Retro-arcade symbol set — deliberately not reskinning a real slot's
 * IP, just a Solana-flavored arcade cabinet cast: a coin, a joystick,
 * a ghost, a UFO, a game-over skull, and two mascots (rare, big pay).
 */
const SYMBOLS = [
  { id: 'coin', emoji: '🪙', weight: 26, pay: { 5: 0.4, 8: 1, 12: 3 } },
  { id: 'joystick', emoji: '🕹️', weight: 22, pay: { 5: 0.6, 8: 1.5, 12: 4 } },
  { id: 'ghost', emoji: '👾', weight: 18, pay: { 5: 1, 8: 2.5, 12: 6 } },
  { id: 'ufo', emoji: '🛸', weight: 14, pay: { 5: 1.5, 8: 4, 12: 10 } },
  { id: 'skull', emoji: '💀', weight: 10, pay: { 5: 3, 8: 8, 12: 20 } },
  { id: 'mascotFox', emoji: '🦊', weight: 6, pay: { 5: 6, 8: 16, 12: 40 } },
  { id: 'mascotCat', emoji: '🐱', weight: 4, pay: { 5: 10, 8: 25, 12: 60 } },
];
const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0);

function pickSymbol(float) {
  const target = float * TOTAL_WEIGHT;
  let cumulative = 0;
  for (const s of SYMBOLS) {
    cumulative += s.weight;
    if (target < cumulative) return s;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

/** Fresh COLS x ROWS grid from `count` provably-fair floats. */
function buildGrid(floats) {
  const grid = [];
  for (let col = 0; col < COLS; col++) {
    grid.push([]);
    for (let row = 0; row < ROWS; row++) grid[col].push(pickSymbol(floats[col * ROWS + row]));
  }
  return grid;
}

/** Flood-fill connected same-symbol clusters (4-directional adjacency). */
function findClusters(grid) {
  const visited = Array.from({ length: COLS }, () => Array(ROWS).fill(false));
  const clusters = [];

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      if (visited[col][row]) continue;
      const symbolId = grid[col][row].id;
      const stack = [[col, row]];
      const cells = [];
      visited[col][row] = true;

      while (stack.length) {
        const [c, r] = stack.pop();
        cells.push([c, r]);
        const neighbors = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]];
        for (const [nc, nr] of neighbors) {
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          if (visited[nc][nr]) continue;
          if (grid[nc][nr].id !== symbolId) continue;
          visited[nc][nr] = true;
          stack.push([nc, nr]);
        }
      }

      if (cells.length >= MIN_CLUSTER) clusters.push({ symbolId, cells });
    }
  }
  return clusters;
}

function clusterPayoutMultiplier(symbol, size) {
  const tiers = Object.keys(symbol.pay).map(Number).sort((a, b) => a - b);
  let mult = 0;
  for (const t of tiers) if (size >= t) mult = symbol.pay[t];
  return mult;
}

/** Remove winning cells, drop remaining symbols down, refill from top with fresh floats. */
function tumble(grid, clusters, floatSource) {
  const toRemove = new Set();
  clusters.forEach((c) => c.cells.forEach(([col, row]) => toRemove.add(`${col},${row}`)));

  const newGrid = [];
  for (let col = 0; col < COLS; col++) {
    const survivors = [];
    for (let row = 0; row < ROWS; row++) {
      if (!toRemove.has(`${col},${row}`)) survivors.push(grid[col][row]);
    }
    const missing = ROWS - survivors.length;
    const fresh = [];
    for (let i = 0; i < missing; i++) fresh.push(pickSymbol(floatSource()));
    newGrid.push([...fresh, ...survivors]); // fresh symbols enter from the top
  }
  return newGrid;
}

/**
 * POST /api/games/cluster-slot/spin
 * body: { userId, wagerLamports }
 * Resolves the entire cascade server-side in one request: initial
 * grid, then repeated cluster-clear/tumble/re-evaluate steps with an
 * escalating multiplier, until no clusters remain or MAX_TUMBLES hits.
 * The frontend gets back every intermediate grid to animate through.
 */
router.post('/spin', async (req, res) => {
  const { userId, wagerLamports } = req.body;
  const wager = BigInt(wagerLamports);
  if (wager <= 0n) return res.status(400).json({ error: 'wager must be positive' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('user not found');
      if (user.balanceLamports < wager) throw new Error('insufficient balance');

      const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } });
      if (!seedPair) throw new Error('no active seed pair — call /api/seeds/rotate first');

      // Pre-derive a generous pool of floats (initial grid + every
      // possible refill across MAX_TUMBLES) from ONE committed nonce —
      // same fully-committed-up-front approach as Mines/Slots.
      const floatPool = getResults(
        seedPair.serverSeed,
        seedPair.clientSeed,
        seedPair.nonce,
        COLS * ROWS * (MAX_TUMBLES + 2)
      );
      let cursor = 0;
      const nextFloat = () => floatPool[cursor++];

      let grid = buildGrid(Array.from({ length: COLS * ROWS }, nextFloat));
      const steps = [{ grid: gridToEmoji(grid), clusters: [] }];

      let rawPayout = 0n;
      let tumbleIndex = 0;

      while (tumbleIndex < MAX_TUMBLES) {
        const clusters = findClusters(grid);
        if (clusters.length === 0) break;

        const multiplier = MULTIPLIER_TRAIL[Math.min(tumbleIndex, MULTIPLIER_TRAIL.length - 1)];
        let stepPayout = 0n;
        const clusterInfo = clusters.map((c) => {
          const symbol = SYMBOLS.find((s) => s.id === c.symbolId);
          const payMult = clusterPayoutMultiplier(symbol, c.cells.length);
          const win = BigInt(Math.floor(Number(wager) * payMult * multiplier));
          stepPayout += win;
          return { symbolId: c.symbolId, size: c.cells.length, cells: c.cells, payoutLamports: win.toString() };
        });
        rawPayout += stepPayout;

        grid = tumble(grid, clusters, nextFloat);
        tumbleIndex++;
        steps.push({
          grid: gridToEmoji(grid),
          clusters: clusterInfo,
          multiplier,
          stepPayoutLamports: stepPayout.toString(),
        });
      }

      const totalPayout = BigInt(Math.floor(Number(rawPayout) * (1 - HOUSE_EDGE)));
      const newBalance = user.balanceLamports - wager + totalPayout;

      await tx.user.update({ where: { id: userId }, data: { balanceLamports: newBalance } });

      const bet = await tx.bet.create({
        data: {
          userId,
          seedPairId: seedPair.id,
          nonce: seedPair.nonce,
          game: 'cluster_slot',
          wagerLamports: wager,
          payoutLamports: totalPayout,
          choice: { wagerLamports: wagerLamports.toString() },
          result: { steps, tumbles: tumbleIndex },
          won: totalPayout > 0n,
        },
      });

      // Consumed a single nonce's worth of cursor space, not the
      // whole floatPool — the pool is oversized on purpose so a
      // maximal cascade never runs out of fresh symbols.
      await tx.seedPair.update({ where: { id: seedPair.id }, data: { nonce: { increment: 1 } } });

      return { bet, newBalance, steps, totalPayout, tumbles: tumbleIndex };
    });

    res.json({
      betId: result.bet.id,
      steps: result.steps,
      tumbles: result.tumbles,
      totalPayoutLamports: result.totalPayout.toString(),
      newBalanceLamports: result.newBalance.toString(),
    });

    betEvents.emit('bet', { game: 'cluster_slot', wagerLamports: wager.toString(), won: result.totalPayout > 0n });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function gridToEmoji(grid) {
  return grid.map((col) => col.map((s) => s.emoji));
}

module.exports = router;
