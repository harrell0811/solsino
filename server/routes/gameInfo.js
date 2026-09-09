const express = require('express');
const router = express.Router();

/**
 * GET /api/games/rtp
 *
 * Every number here has been verified against the actual game logic
 * (either the exact HOUSE_EDGE constant baked into that game's payout
 * math, or — for slots/cluster-slot/keno, where the real RTP isn't a
 * simple constant — a Monte Carlo simulation or exact combinatorial
 * calculation of the real code). This is deliberately NOT just each
 * route file's own comment restated: while building this, two of
 * those comments turned out to be wrong (cluster-slot's pay table
 * actually simulated to ~49% RTP despite a "94%" comment, and keno's
 * old selectionBoost() formula produced RTPs from 150% up to 352%
 * depending on pick count) — so treat this file as the audited
 * figure, and re-verify here (not just in a comment) any time a
 * payout table changes.
 */
const RTP_INFO = {
  coinflip: { rtp: 94, exact: true, note: null },
  mines: { rtp: 97, exact: true, note: null },
  crash: { rtp: 96, exact: true, note: null },
  limbo: { rtp: 96, exact: true, note: null },
  dragontower: { rtp: 97, exact: true, note: null },
  slots: { rtp: 95, exact: false, note: 'verified by simulation — varies slightly by session due to the bonus round' },
  cluster_slot: { rtp: 94.5, exact: false, note: 'verified by simulation — varies slightly by session due to cascading wins' },
  keno: { rtp: 95, exact: true, note: 'same for every pick count (1-10) — exact, via hypergeometric calculation' },
  blackjack: { rtp: 97, exact: false, note: 'approximate — depends on how close to basic strategy you play; this assumes solid basic strategy' },
};

router.get('/rtp', (req, res) => {
  res.json(RTP_INFO);
});

module.exports = router;
