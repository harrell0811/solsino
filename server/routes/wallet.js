const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { loadHouseKeypair, getHouseBalanceLamports, sendSol, PROFIT_WALLET_ADDRESS } = require('../solana');
const { requireAdmin } = require('../adminAuth');

const prisma = new PrismaClient();
const WITHDRAWAL_FEE_LAMPORTS = 5000n; // covers Solana network fee on the house's send

/**
 * GET /api/wallet/deposit-info?userId=...
 * Tells the frontend where to send SOL and what memo to attach.
 * The frontend's "Deposit" button should build a transaction with
 * a SystemProgram.transfer to this address PLUS a Memo instruction
 * containing the returned `memo` value.
 */
router.get('/deposit-info', async (req, res) => {
  const { userId } = req.query;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: 'user not found' });

  const houseKeypair = loadHouseKeypair();
  res.json({
    depositAddress: houseKeypair.publicKey.toString(),
    memo: userId, // MUST be attached to the deposit transaction
    note: 'Deposits without this memo cannot be auto-credited and will require manual support.',
  });
});

/**
 * POST /api/wallet/withdraw
 * body: { userId, amountLamports }
 * Debits the user's internal balance FIRST (so a crashed/slow send
 * can't be double-spent), then sends SOL from the house wallet to
 * the user's registered walletAddress.
 */
router.post('/withdraw', async (req, res) => {
  const { userId, amountLamports } = req.body;
  const amount = BigInt(amountLamports);

  if (amount <= 0n) {
    return res.status(400).json({ error: 'amount must be positive' });
  }

  try {
    const { user, txRecordId } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('user not found');

      const totalDebit = amount + WITHDRAWAL_FEE_LAMPORTS;
      if (user.balanceLamports < totalDebit) {
        throw new Error('insufficient balance (amount + network fee)');
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: { balanceLamports: { decrement: totalDebit } },
      });

      // Placeholder signature until the on-chain send completes below;
      // updated to the real signature right after.
      const placeholder = `pending-${userId}-${Date.now()}`;
      const record = await tx.transaction.create({
        data: {
          txSignature: placeholder,
          amountLamports: amount,
          status: 'pending',
          withdrawUserId: userId,
        },
      });

      return { user: updated, txRecordId: record.id };
    });

    let signature;
    try {
      signature = await sendSol(user.walletAddress, amount);
    } catch (sendErr) {
      // On-chain send failed after debit — refund the user and mark failed.
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { balanceLamports: { increment: amount + WITHDRAWAL_FEE_LAMPORTS } },
        }),
        prisma.transaction.update({
          where: { id: txRecordId },
          data: { status: 'failed' },
        }),
      ]);
      throw new Error(`withdrawal send failed, balance refunded: ${sendErr.message}`);
    }

    await prisma.transaction.update({
      where: { id: txRecordId },
      data: { txSignature: signature, status: 'confirmed' },
    });

    res.json({ signature, amountLamports: amount.toString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/wallet/sweep-profits
 * Admin-only — gated by requireAdmin below since it moves real
 * money. Computes accumulated house edge revenue (sum of wager -
 * payout across all bets, minus what's already been swept) and
 * sends everything above a safety buffer to PROFIT_WALLET_ADDRESS.
 * The buffer must always cover every user's current balance, since
 * all funds sit in one house wallet.
 */
router.post('/sweep-profits', requireAdmin, async (req, res) => {
  try {
    const betAgg = await prisma.bet.aggregate({
      _sum: { wagerLamports: true, payoutLamports: true },
    });
    const totalWagered = betAgg._sum.wagerLamports || 0n;
    const totalPaidOut = betAgg._sum.payoutLamports || 0n;
    const grossEdgeRevenue = totalWagered - totalPaidOut;

    const sweptAgg = await prisma.profitSweep.aggregate({
      _sum: { amountLamports: true },
    });
    const alreadySwept = sweptAgg._sum.amountLamports || 0n;

    const unsweptProfit = grossEdgeRevenue - alreadySwept;
    if (unsweptProfit <= 0n) {
      return res.json({ swept: '0', reason: 'no unswept profit available' });
    }

    // Never sweep below what's owed to users.
    const userBalanceAgg = await prisma.user.aggregate({
      _sum: { balanceLamports: true },
    });
    const totalUserLiability = userBalanceAgg._sum.balanceLamports || 0n;

    const houseBalance = BigInt(await getHouseBalanceLamports());
    const safetyBuffer = totalUserLiability + 10_000_000n; // + 0.01 SOL tx-fee cushion
    const sweepable = houseBalance - safetyBuffer;

    const amountToSweep = sweepable < unsweptProfit ? sweepable : unsweptProfit;
    if (amountToSweep <= 0n) {
      return res.json({ swept: '0', reason: 'house wallet balance too low to sweep safely right now' });
    }

    const signature = await sendSol(PROFIT_WALLET_ADDRESS.toString(), amountToSweep);

    await prisma.profitSweep.create({
      data: { amountLamports: amountToSweep, txSignature: signature },
    });

    res.json({ swept: amountToSweep.toString(), signature, destination: PROFIT_WALLET_ADDRESS.toString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
