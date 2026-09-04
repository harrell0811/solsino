const crypto = require('crypto');
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { getResults } = require('../provablyFair');
const betEvents = require('../events');

const router = express.Router();
const prisma = new PrismaClient();
const games = new Map();
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function cardAt(seedPair, nonce, offset) {
  const value = getResults(seedPair.serverSeed, seedPair.clientSeed, nonce + offset, 1)[0];
  const i = Math.min(51, Math.floor(value * 52));
  return { rank: RANKS[i % 13], suit: SUITS[Math.floor(i / 13)] };
}
function score(cards) {
  let total = 0; let aces = 0;
  cards.forEach((c) => { if (c.rank === 'A') { total += 11; aces++; } else total += ['K', 'Q', 'J'].includes(c.rank) ? 10 : Number(c.rank); });
  while (total > 21 && aces--) total -= 10;
  return total;
}
function publicGame(game, revealDealer = false) {
  return { gameId: game.id, playerCards: game.player, dealerCards: revealDealer ? game.dealer : [game.dealer[0], { rank: '?', suit: '' }], playerScore: score(game.player), dealerScore: revealDealer ? score(game.dealer) : null, complete: game.complete, outcome: game.outcome, payoutLamports: game.payoutLamports };
}
async function settle(game, outcome) {
  if (game.complete) return;
  game.complete = true; game.outcome = outcome;
  const payout = outcome === 'win' ? game.wager * 2n : outcome === 'blackjack' ? (game.wager * 5n) / 2n : outcome === 'push' ? game.wager : 0n;
  game.payoutLamports = payout.toString();
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: game.userId }, data: { balanceLamports: { increment: payout } } });
    await tx.bet.update({ where: { id: game.betId }, data: { payoutLamports: payout, won: payout > game.wager, result: { player: game.player, dealer: game.dealer, outcome } } });
    return user;
  });
  game.newBalanceLamports = updated.balanceLamports.toString();
  betEvents.emit('bet', { game: 'blackjack', wagerLamports: game.wager.toString(), payoutLamports: payout.toString(), won: payout > game.wager });
}

router.post('/deal', async (req, res) => {
  const { userId, wagerLamports } = req.body;
  try {
    const wager = BigInt(wagerLamports);
    if (wager <= 0n) throw new Error('wager must be positive');
    const game = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.balanceLamports < wager) throw new Error('insufficient devnet balance');
      const seedPair = await tx.seedPair.findFirst({ where: { userId, active: true } });
      if (!seedPair) throw new Error('no active seed pair');
      const id = crypto.randomUUID(); const player = [cardAt(seedPair, seedPair.nonce, 0), cardAt(seedPair, seedPair.nonce, 2)]; const dealer = [cardAt(seedPair, seedPair.nonce, 1), cardAt(seedPair, seedPair.nonce, 3)];
      const updated = await tx.user.update({ where: { id: userId }, data: { balanceLamports: { decrement: wager } } });
      const bet = await tx.bet.create({ data: { userId, seedPairId: seedPair.id, nonce: seedPair.nonce, game: 'blackjack', wagerLamports: wager, payoutLamports: 0n, choice: {}, result: { status: 'in_progress' }, won: false } });
      await tx.seedPair.update({ where: { id: seedPair.id }, data: { nonce: { increment: 20 } } });
      return { id, userId, wager, betId: bet.id, seedPair, drawNonce: seedPair.nonce, player, dealer, nextCard: 4, complete: false, newBalanceLamports: updated.balanceLamports.toString() };
    });
    games.set(game.id, game);
    if (score(game.player) === 21) await settle(game, 'blackjack');
    res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports || game.newBalanceLamports });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/hit', async (req, res) => {
  const game = games.get(req.body.gameId);
  try {
    if (!game || game.userId !== req.body.userId || game.complete) throw new Error('game is not available');
    game.player.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++));
    if (score(game.player) > 21) await settle(game, 'bust');
    res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/stand', async (req, res) => {
  const game = games.get(req.body.gameId);
  try {
    if (!game || game.userId !== req.body.userId || game.complete) throw new Error('game is not available');
    while (score(game.dealer) < 17) game.dealer.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++));
    const playerScore = score(game.player); const dealerScore = score(game.dealer);
    await settle(game, dealerScore > 21 || playerScore > dealerScore ? 'win' : playerScore === dealerScore ? 'push' : 'lose');
    res.json({ ...publicGame(game, true), newBalanceLamports: game.newBalanceLamports });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
