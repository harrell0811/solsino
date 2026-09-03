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

module.exports = router;
