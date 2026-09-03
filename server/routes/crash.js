const express = require('express');
const router = express.Router();
const crashEngine = require('../crashEngine');

/**
 * GET /api/games/crash/state
 * Lets a freshly-loaded page catch up on the current round without
 * waiting for the next socket tick.
 */
router.get('/state', (req, res) => {
  res.json(crashEngine.getPublicState());
});

/**
 * POST /api/games/crash/bet
 * body: { userId, wagerLamports }
 * Only accepted while the round is in its waiting/betting phase.
 */
router.post('/bet', async (req, res) => {
  const { userId, wagerLamports } = req.body;
  try {
    const result = await crashEngine.placeBet(userId, wagerLamports);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/games/crash/cashout
 * body: { userId }
 * Locks in a payout at whatever multiplier is showing right now.
 */
router.post('/cashout', async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await crashEngine.cashout(userId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
