const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
} = require('../provablyFair');

const prisma = new PrismaClient();

/**
 * POST /api/seeds/rotate
 * body: { userId, clientSeed? }
 *
 * Reveals the previous serverSeed (so past bets become verifiable),
 * then commits a fresh serverSeed (hash-only, shown to player) for
 * all future bets. Call this on signup and whenever the player asks
 * to rotate seeds.
 */
router.post('/rotate', async (req, res) => {
  const { userId, clientSeed } = req.body;

  const prevActive = await prisma.seedPair.findFirst({
    where: { userId, active: true },
  });

  if (prevActive) {
    await prisma.seedPair.update({
      where: { id: prevActive.id },
      data: { active: false, revealedAt: new Date() },
    });
  }

  const serverSeed = generateServerSeed();
  const serverSeedHash = hashServerSeed(serverSeed);
  const newClientSeed = clientSeed || generateClientSeed();

  const seedPair = await prisma.seedPair.create({
    data: {
      userId,
      serverSeed,
      serverSeedHash,
      clientSeed: newClientSeed,
      nonce: 0,
      active: true,
    },
  });

  res.json({
    // Never send serverSeed itself here — only the hash. serverSeed
    // is only revealed once this pair is rotated out.
    serverSeedHash: seedPair.serverSeedHash,
    clientSeed: seedPair.clientSeed,
    previousServerSeed: prevActive ? prevActive.serverSeed : null,
    previousServerSeedHash: prevActive ? prevActive.serverSeedHash : null,
  });
});

/**
 * GET /api/seeds/current?userId=
 * The active commitment for this user, viewable any time — not just
 * right after a rotate. This is what a "view my seed" panel reads.
 * serverSeed itself is never returned while a pair is still active,
 * only its hash (the commit); the plaintext is only ever shown once
 * it's rotated out, via /history below.
 */
router.get('/current', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const active = await prisma.seedPair.findFirst({ where: { userId, active: true } });
  if (!active) return res.status(404).json({ error: 'no active seed pair for this user' });

  res.json({
    serverSeedHash: active.serverSeedHash,
    clientSeed: active.clientSeed,
    nonce: active.nonce,
    createdAt: active.createdAt,
  });
});

/**
 * GET /api/seeds/history?userId=
 * Past, rotated-out seed pairs — these have already been revealed,
 * so serverSeed is safe to return here. Anyone can hash it and
 * confirm it matches serverSeedHash, then recompute any past bet's
 * outcome (see provablyFair.verifyBet) to independently prove
 * nothing was tampered with.
 */
router.get('/history', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const revealed = await prisma.seedPair.findMany({
    where: { userId, active: false },
    orderBy: { revealedAt: 'desc' },
    take: 20,
  });

  res.json({
    seedPairs: revealed.map((s) => ({
      serverSeed: s.serverSeed,
      serverSeedHash: s.serverSeedHash,
      clientSeed: s.clientSeed,
      finalNonce: s.nonce,
      createdAt: s.createdAt,
      revealedAt: s.revealedAt,
    })),
  });
});

module.exports = router;
