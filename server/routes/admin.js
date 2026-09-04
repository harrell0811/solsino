const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { getHouseBalanceLamports } = require('../solana');
const { requireAdmin } = require('../adminAuth');
const crashEngine = require('../crashEngine');

const prisma = new PrismaClient();

router.use(requireAdmin);

/**
 * GET /api/admin/stats
 * Top-line numbers for the dashboard: house profit, what's owed to
 * players, what's already been swept out, and a per-game breakdown.
 */
router.get('/stats', async (req, res) => {
  try {
    const [betAgg, sweptAgg, userAgg, userCount, betCount, perGame] = await Promise.all([
      prisma.bet.aggregate({ _sum: { wagerLamports: true, payoutLamports: true } }),
      prisma.profitSweep.aggregate({ _sum: { amountLamports: true } }),
      prisma.user.aggregate({ _sum: { balanceLamports: true } }),
      prisma.user.count(),
      prisma.bet.count(),
      prisma.bet.groupBy({
        by: ['game'],
        _sum: { wagerLamports: true, payoutLamports: true },
        _count: { _all: true },
      }),
    ]);

    const totalWagered = betAgg._sum.wagerLamports || 0n;
    const totalPaidOut = betAgg._sum.payoutLamports || 0n;
    const grossProfit = totalWagered - totalPaidOut;
    const totalSwept = sweptAgg._sum.amountLamports || 0n;
    const unsweptProfit = grossProfit - totalSwept;
    const totalOwedToUsers = userAgg._sum.balanceLamports || 0n;

    let houseBalanceLamports = null;
    try {
      houseBalanceLamports = (await getHouseBalanceLamports()).toString();
    } catch (err) {
      // Non-fatal — RPC might be down; dashboard can still show DB-derived stats.
    }

    res.json({
      totalWageredLamports: totalWagered.toString(),
      totalPaidOutLamports: totalPaidOut.toString(),
      grossProfitLamports: grossProfit.toString(),
      totalSweptLamports: totalSwept.toString(),
      unsweptProfitLamports: unsweptProfit.toString(),
      totalOwedToUsersLamports: totalOwedToUsers.toString(),
      houseBalanceLamports,
      userCount,
      betCount,
      perGame: perGame.map((g) => {
        const wagered = g._sum.wagerLamports || 0n;
        const paidOut = g._sum.payoutLamports || 0n;
        return {
          game: g.game,
          betCount: g._count._all,
          wageredLamports: wagered.toString(),
          paidOutLamports: paidOut.toString(),
          profitLamports: (wagered - paidOut).toString(),
        };
      }),
      crashRound: crashEngine.getPublicState(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/users
 * Every user's balance — this is exactly "how much is owed and to
 * whom": each row is a liability sitting in the house wallet.
 */
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { balanceLamports: 'desc' },
      take: 200,
      select: { id: true, walletAddress: true, displayName: true, balanceLamports: true, chatBanned: true, createdAt: true },
    });
    res.json({
      users: users.map((u) => ({
        userId: u.id,
        walletAddress: u.walletAddress,
        displayName: u.displayName,
        balanceLamports: u.balanceLamports.toString(),
        chatBanned: u.chatBanned,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/users/:id/chat-ban
 * POST /api/admin/users/:id/chat-unban
 * Silences (or restores) a player in chat. Doesn't touch their
 * balance or ability to place bets — chat-only.
 */
router.post('/users/:id/chat-ban', async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { chatBanned: true },
      select: { id: true, walletAddress: true, chatBanned: true },
    });
    res.json({ userId: user.id, walletAddress: user.walletAddress, chatBanned: user.chatBanned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/users/:id/chat-unban', async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { chatBanned: false },
      select: { id: true, walletAddress: true, chatBanned: true },
    });
    res.json({ userId: user.id, walletAddress: user.walletAddress, chatBanned: user.chatBanned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/admin/bets/recent
 * Latest bets across all games for a live activity feed.
 */
router.get('/bets/recent', async (req, res) => {
  try {
    const bets = await prisma.bet.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { walletAddress: true } } },
    });
    res.json({
      bets: bets.map((b) => ({
        id: b.id,
        game: b.game,
        wagerLamports: b.wagerLamports.toString(),
        payoutLamports: b.payoutLamports.toString(),
        won: b.won,
        walletAddress: b.user.walletAddress,
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/sweeps
 * History of profit sweeps already sent to PROFIT_WALLET_ADDRESS.
 */
router.get('/sweeps', async (req, res) => {
  try {
    const sweeps = await prisma.profitSweep.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({
      sweeps: sweeps.map((s) => ({
        id: s.id,
        amountLamports: s.amountLamports.toString(),
        txSignature: s.txSignature,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
