# Crypto Casino — Backend Vertical Slice

This is a working slice of the platform: **provably-fair engine + Coinflip
game + live chat/bet-feed socket layer**, on a custodial-balance model with
Solana as the settlement chain. Everything else (Mines, Keno, the actual
wallet connect + deposit/withdraw flow, and the Next.js frontend) extends
this same pattern.

## Why these choices

- **Custodial balances**: bets need to resolve instantly (no on-chain
  confirmation delay per click), so users deposit SOL/SPL tokens once,
  play against an internal DB balance, and withdraw on demand. This is
  what Stake/Rollbit-style sites do. It means *you* are responsible for
  hot-wallet security and, in most jurisdictions, a money-transmitter /
  gaming license — get legal advice before taking real deposits.
- **Provably fair (commit-reveal)**: `server/provablyFair.js` — a fresh
  server seed is hashed and shown to the player before any bets (the
  "commit"), bets are resolved via `HMAC(serverSeed, clientSeed:nonce)`,
  and the raw server seed is only revealed when the player rotates seeds.
  Anyone can then re-hash it and recompute every bet to prove nothing was
  altered. This is the same scheme used industry-wide, so players who've
  used other crypto casinos will recognize it.
- **Solana**: chosen per your answer — low fees make small deposits and
  withdrawals practical. `@solana/web3.js` is wired into `package.json`;
  the actual watch-for-deposit / send-withdrawal logic isn't built yet
  (see Next steps).

## Setup

```bash
npm install
# set DATABASE_URL in a .env file (Postgres)
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

## API so far

- `POST /api/seeds/rotate` — commit a new server seed, reveal the old one
- `POST /api/games/coinflip` — place a coinflip bet
- `GET /api/wallet/deposit-info?userId=...` — get the house deposit
  address + the memo a user's deposit transaction must include
- `POST /api/wallet/withdraw` — debit balance, send SOL to the user's
  registered wallet address
- `POST /api/wallet/sweep-profits` — send accumulated house edge
  revenue to the profit wallet (put real auth on this before deploying)
- Socket.io events: `chat:message` (in/out), `bet:new`, `stats`

## Deposits, withdrawals & house profit

**Model:** one house hot wallet holds all user funds (custodial). Users
deposit by sending SOL to that single address **with a memo containing
their userId** — `server/depositWatcher.js` polls the house wallet's
transaction history every 10s, matches memos to users, and credits
`balanceLamports`. The unique constraint on `Transaction.txSignature`
guarantees a deposit is never credited twice even across repeated polls.

Your frontend's deposit flow needs to build a transaction with *two*
instructions: a `SystemProgram.transfer` to the returned
`depositAddress`, and an SPL Memo instruction carrying the returned
`memo` value, before asking the user's wallet to sign it.

**Withdrawals** debit the internal balance first, then send on-chain —
if the send fails, the balance is automatically refunded and the
`Transaction` is marked `failed` rather than left in a stuck state.

**House profit routing:** every bet already records `wagerLamports` and
`payoutLamports` (see `routes/coinflip.js`), so the house's edge revenue
on any bet is simply the difference. `POST /api/wallet/sweep-profits`
sums that difference across all bets, subtracts whatever's already been
swept (tracked in the `ProfitSweep` table), and sends the result to:

```
BpWUJke7bm1dvizMAZD4EDMjn7PruAuuAVNJBqxWTAVg
```

It will **never** sweep below the sum of every user's current balance
— that safety buffer is recalculated on every sweep so the house
wallet can always cover withdrawals. Run this on a schedule (e.g. an
hourly cron hitting the endpoint) once you've added auth to it.

⚠️ **Before this touches real money:** put this behind admin auth, run
it on devnet first, get a security review of `solana.js` and
`wallet.js` specifically (they're the only files that move real SOL),
and keep `HOUSE_WALLET_SECRET_KEY` in a proper secrets manager — this
one key can drain every user's balance if it leaks.

## Next steps (in build order)

1. **Mines & Keno**: same pattern as `routes/coinflip.js` — pull the
   active seed pair, call `getResults()` from `provablyFair.js` for
   N tiles/numbers instead of one coinflip, compute payout by
   remaining-tiles/matched-numbers odds.
2. **Frontend**: Next.js + `@solana/wallet-adapter-react` for the
   connect button, game boards, chat panel, deposit flow (memo tx),
   and a "Verify" modal that re-implements `verifyBet()` client-side.
3. **Total bets / live feed UI**: subscribe to the `bet:new` and `stats`
   socket events already emitted by the server.
4. **Admin auth** on `/api/wallet/sweep-profits` before it's exposed
   anywhere near production.
