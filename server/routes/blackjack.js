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
  const f = getResults(seedPair.serverSeed, seedPair.clientSeed, nonce + offset, 1)[0];
  const i = Math.min(51, Math.floor(f * 52));
  return { rank: RANKS[i % 13], suit: SUITS[Math.floor(i / 13)] };
}
function score(cards) {
  let total = 0; let aces = 0;
  for (const card of cards) { if (card.rank === 'A') { total += 11; aces++; } else total += ['K', 'Q', 'J'].includes(card.rank) ? 10 : Number(card.rank); }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
function activeHand(game) { return game.hands[game.activeHand]; }
function canDouble(game) { const hand = activeHand(game); return !game.complete && hand.cards.length === 2 && !hand.doubled; }
function canSplit(game) { const hand = activeHand(game); return !game.complete && game.hands.length === 1 && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank; }
function publicGame(game, revealDealer = false) {
  const hand = activeHand(game) || game.hands[0];
  return {
    gameId: game.id,
    playerCards: hand.cards,
    playerScore: score(hand.cards),
    hands: game.hands.map((h) => ({ cards: h.cards, score: score(h.cards), wagerLamports: h.wager.toString(), outcome: h.outcome })),
    activeHand: game.activeHand,
    dealerCards: revealDealer ? game.dealer : [game.dealer[0], { rank: '?', suit: '' }],
    dealerScore: revealDealer ? score(game.dealer) : null,
    canSplit: canSplit(game), canDouble: canDouble(game), canInsurance: !game.insuranceOffered && game.dealer[0].rank === 'A' && hand.cards.length === 2 && !game.complete,
    complete: game.complete, outcome: game.outcome, payoutLamports: game.payoutLamports,
  };
}
async function debit(game, amount) {
  const user = await prisma.user.update({ where: { id: game.userId }, data: { balanceLamports: { decrement: amount } } });
  game.newBalanceLamports = user.balanceLamports.toString();
}
async function settle(game) {
  if (game.complete) return;
  while (score(game.dealer) < 17) game.dealer.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++));
  const dealerScore = score(game.dealer); let payout = 0n;
  for (const hand of game.hands) {
    const playerScore = score(hand.cards);
    hand.outcome = playerScore > 21 ? 'bust' : dealerScore > 21 || playerScore > dealerScore ? 'win' : playerScore === dealerScore ? 'push' : 'lose';
    payout += hand.outcome === 'win' ? hand.wager * 2n : hand.outcome === 'push' ? hand.wager : 0n;
  }
  if (game.insurance && score(game.dealer) === 21) { payout += game.insurance * 3n; game.insuranceOutcome = 'win'; } else if (game.insurance) game.insuranceOutcome = 'lose';
  game.complete = true; game.payoutLamports = payout.toString(); game.outcome = game.hands.length > 1 ? 'resolved' : game.hands[0].outcome;
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: game.userId }, data: { balanceLamports: { increment: payout } } });
    await tx.bet.update({ where: { id: game.betId }, data: { payoutLamports: payout, won: payout > game.initialWager, result: { hands: game.hands.map((h) => ({ ...h, wager: h.wager.toString() })), dealer: game.dealer, insurance: game.insurance?.toString(), insuranceOutcome: game.insuranceOutcome } } });
    return user;
  });
  game.newBalanceLamports = updated.balanceLamports.toString();
  betEvents.emit('bet', { game: 'blackjack', wagerLamports: game.initialWager.toString(), payoutLamports: payout.toString(), won: payout > game.initialWager });
}
async function advance(game) {
  while (game.activeHand < game.hands.length && score(activeHand(game).cards) >= 21) { activeHand(game).outcome = score(activeHand(game).cards) === 21 ? 'stand' : 'bust'; game.activeHand++; }
  if (game.activeHand >= game.hands.length) await settle(game);
}

router.post('/deal', async (req, res) => {
  try {
    const wager = BigInt(req.body.wagerLamports); if (wager <= 0n) throw new Error('wager must be positive');
    const game = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.body.userId } }); if (!user || user.balanceLamports < wager) throw new Error('insufficient balance');
      const seedPair = await tx.seedPair.findFirst({ where: { userId: req.body.userId, active: true } }); if (!seedPair) throw new Error('no active seed pair');
      const player = [cardAt(seedPair, seedPair.nonce, 0), cardAt(seedPair, seedPair.nonce, 2)]; const dealer = [cardAt(seedPair, seedPair.nonce, 1), cardAt(seedPair, seedPair.nonce, 3)];
      const userAfter = await tx.user.update({ where: { id: user.id }, data: { balanceLamports: { decrement: wager } } });
      const bet = await tx.bet.create({ data: { userId: user.id, seedPairId: seedPair.id, nonce: seedPair.nonce, game: 'blackjack', wagerLamports: wager, payoutLamports: 0n, choice: {}, result: { status: 'in_progress' }, won: false } });
      await tx.seedPair.update({ where: { id: seedPair.id }, data: { nonce: { increment: 24 } } });
      return { id: crypto.randomUUID(), userId: user.id, betId: bet.id, seedPair, drawNonce: seedPair.nonce, initialWager: wager, hands: [{ cards: player, wager, doubled: false, outcome: null }], dealer, activeHand: 0, nextCard: 4, complete: false, insuranceOffered: false, newBalanceLamports: userAfter.balanceLamports.toString() };
    });
    games.set(game.id, game); if (score(game.hands[0].cards) === 21) await settle(game);
    res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/insurance', async (req, res) => {
  const game = games.get(req.body.gameId);
  try { if (!game || game.userId !== req.body.userId || !publicGame(game).canInsurance) throw new Error('insurance is not available'); const amount = game.initialWager / 2n; await debit(game, amount); game.insurance = amount; game.insuranceOffered = true; if (score(game.dealer) === 21) await settle(game); res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/hit', async (req, res) => {
  const game = games.get(req.body.gameId);
  try { if (!game || game.userId !== req.body.userId || game.complete) throw new Error('game is not available'); activeHand(game).cards.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++)); await advance(game); res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/double', async (req, res) => {
  const game = games.get(req.body.gameId);
  try { if (!game || game.userId !== req.body.userId || !canDouble(game)) throw new Error('double is not available'); const hand = activeHand(game); await debit(game, hand.wager); hand.wager *= 2n; hand.doubled = true; hand.cards.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++)); game.activeHand++; await advance(game); res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/split', async (req, res) => {
  const game = games.get(req.body.gameId);
  try { if (!game || game.userId !== req.body.userId || !canSplit(game)) throw new Error('split is not available'); const hand = activeHand(game); await debit(game, hand.wager); const second = hand.cards.pop(); hand.cards.push(cardAt(game.seedPair, game.drawNonce, game.nextCard++)); game.hands.push({ cards: [second, cardAt(game.seedPair, game.drawNonce, game.nextCard++)], wager: hand.wager, doubled: false, outcome: null }); res.json({ ...publicGame(game), newBalanceLamports: game.newBalanceLamports }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/stand', async (req, res) => {
  const game = games.get(req.body.gameId);
  try { if (!game || game.userId !== req.body.userId || game.complete) throw new Error('game is not available'); activeHand(game).outcome = 'stand'; game.activeHand++; await advance(game); res.json({ ...publicGame(game, game.complete), newBalanceLamports: game.newBalanceLamports }); } catch (err) { res.status(400).json({ error: err.message }); }
});
module.exports = router;
