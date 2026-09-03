const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { generateServerSeed, hashServerSeed, generateClientSeed } = require('../provablyFair');

const prisma = new PrismaClient();

/**
 * POST /api/user/connect
 * body: { walletAddress }
 * Called right after a wallet connects on the frontend. Finds or
 * creates the User row for that address, and — for brand new users —
 * commits their first seed pair so they can bet immediately without
 * a separate /api/seeds/rotate call from the frontend.
 */
router.post('/connect', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

  try {
    let user = await prisma.user.findUnique({ where: { walletAddress } });

    if (!user) {
      user = await prisma.user.create({ data: { walletAddress } });

      const serverSeed = generateServerSeed();
      await prisma.seedPair.create({
        data: {
          userId: user.id,
          serverSeed,
          serverSeedHash: hashServerSeed(serverSeed),
          clientSeed: generateClientSeed(),
          nonce: 0,
          active: true,
        },
      });
    }

    res.json({
      userId: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      balanceLamports: user.balanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/user/:id
 * Simple balance/status lookup, used to refresh the UI after
 * deposits, bets, and withdrawals.
 */
router.get('/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: 'user not found' });

  res.json({
    userId: user.id,
    walletAddress: user.walletAddress,
    displayName: user.displayName,
    balanceLamports: user.balanceLamports.toString(),
  });
});

/**
 * PATCH /api/user/:id/profile
 * body: { displayName }
 * Currently just the display name — the only profile field a
 * player can edit. Pass an empty string / null to clear it back to
 * showing the wallet address.
 */
router.patch('/:id/profile', async (req, res) => {
  const { displayName } = req.body;

  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
    return res.status(400).json({ error: 'displayName must be a string' });
  }
  const trimmed = typeof displayName === 'string' ? displayName.trim() : null;
  if (trimmed && trimmed.length > 24) {
    return res.status(400).json({ error: 'displayName must be 24 characters or fewer' });
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { displayName: trimmed || null },
    });
    res.json({
      userId: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      balanceLamports: user.balanceLamports.toString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/user/:id/bets
 * This user's own bet history (win/loss, wager, payout) for the
 * profile panel — separate from /api/admin/bets/recent, which is
 * the site-wide feed across every player.
 */
router.get('/:id/bets', async (req, res) => {
  try {
    const bets = await prisma.bet.findMany({
      where: { userId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({
      bets: bets.map((b) => ({
        id: b.id,
        game: b.game,
        wagerLamports: b.wagerLamports.toString(),
        payoutLamports: b.payoutLamports.toString(),
        won: b.won,
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/user/:id/transactions
 * Deposit + withdrawal history plus lifetime wagered total, all in
 * one call since the profile panel shows them together.
 */
router.get('/:id/transactions', async (req, res) => {
  const userId = req.params.id;
  try {
    const [deposits, withdrawals, wagerAgg, betCount] = await Promise.all([
      prisma.transaction.findMany({
        where: { depositUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.transaction.findMany({
        where: { withdrawUserId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.bet.aggregate({ where: { userId }, _sum: { wagerLamports: true } }),
      prisma.bet.count({ where: { userId } }),
    ]);

    const mapTx = (t) => ({
      id: t.id,
      amountLamports: t.amountLamports.toString(),
      status: t.status,
      txSignature: t.txSignature,
      createdAt: t.createdAt,
    });

    res.json({
      deposits: deposits.map(mapTx),
      withdrawals: withdrawals.map(mapTx),
      totalWageredLamports: (wagerAgg._sum.wagerLamports || 0n).toString(),
      betCount,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
