const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const HISTORY_LIMIT = 50;

/**
 * GET /api/chat/recent
 * Returns the most recent messages, oldest first (ready to drop
 * straight into the chat panel's message list on page load). Only
 * messages tied to a real account are ever persisted — see the
 * chat:message socket handler in server/index.js — so every row here
 * has a joined user to resolve the display name from.
 */
router.get('/recent', async (req, res) => {
  try {
    const rows = await prisma.chatMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      include: { user: { select: { displayName: true, walletAddress: true } } },
    });

    const messages = rows
      .reverse()
      .map((row) => ({
        userId: row.userId,
        username: row.user.displayName || row.user.walletAddress.slice(0, 6),
        message: row.message,
        at: row.createdAt.getTime(),
      }));

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
