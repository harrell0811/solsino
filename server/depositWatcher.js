/**
 * Deposit watcher.
 *
 * Polls the house wallet's recent transaction history for incoming
 * SOL transfers that include a memo (SPL Memo program) matching a
 * known userId. When found, credits that user's balance exactly
 * once (the unique constraint on Transaction.txSignature is what
 * prevents double-crediting on re-poll).
 *
 * Users are told (via /api/wallet/deposit-info) to send SOL to the
 * house address WITH a memo containing their userId. Most wallets
 * (Phantom, Solflare) support attaching a memo; your frontend should
 * build the transaction with the memo instruction included so users
 * don't have to do it manually.
 */

const { PrismaClient } = require('@prisma/client');
const { connection, loadHouseKeypair } = require('./solana');

const prisma = new PrismaClient();
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const POLL_INTERVAL_MS = 10_000;

function extractMemo(parsedTx) {
  const instructions = parsedTx?.transaction?.message?.instructions || [];
  const memoIx = instructions.find((ix) => ix.programId?.toString() === MEMO_PROGRAM_ID);
  return memoIx?.parsed || memoIx?.data || null;
}

function extractIncomingLamports(parsedTx, houseAddress) {
  // Compare pre/post balances for the house account to get net inflow,
  // which is robust to multi-instruction transactions.
  const accountKeys = parsedTx.transaction.message.accountKeys.map((k) =>
    (k.pubkey || k).toString()
  );
  const idx = accountKeys.indexOf(houseAddress);
  if (idx === -1) return 0n;

  const pre = BigInt(parsedTx.meta.preBalances[idx]);
  const post = BigInt(parsedTx.meta.postBalances[idx]);
  const delta = post - pre;
  return delta > 0n ? delta : 0n;
}

async function pollOnce() {
  const houseKeypair = loadHouseKeypair();
  const houseAddress = houseKeypair.publicKey.toString();

  const signatures = await connection.getSignaturesForAddress(
    houseKeypair.publicKey,
    { limit: 25 }
  );

  for (const sigInfo of signatures) {
    if (sigInfo.err) continue;

    // Skip if we've already recorded this signature
    const existing = await prisma.transaction.findUnique({
      where: { txSignature: sigInfo.signature },
    });
    if (existing) continue;

    const parsedTx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!parsedTx) continue;

    const lamportsIn = extractIncomingLamports(parsedTx, houseAddress);
    if (lamportsIn <= 0n) continue; // not a deposit (could be our own withdrawal tx)

    const memo = extractMemo(parsedTx);
    if (!memo) {
      console.warn(`Deposit ${sigInfo.signature} had no memo — recording as unattributed, will not retry`);
      await prisma.transaction.create({
        data: {
          txSignature: sigInfo.signature,
          amountLamports: lamportsIn,
          status: 'unattributed',
        },
      });
      continue;
    }

    const userId = memo.trim();
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.warn(`Deposit ${sigInfo.signature} memo "${userId}" did not match any user — recording as unattributed, will not retry`);
      await prisma.transaction.create({
        data: {
          txSignature: sigInfo.signature,
          amountLamports: lamportsIn,
          status: 'unattributed',
        },
      });
      continue;
    }

    await prisma.$transaction([
      prisma.transaction.create({
        data: {
          txSignature: sigInfo.signature,
          amountLamports: lamportsIn,
          status: 'confirmed',
          depositUserId: userId,
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { balanceLamports: { increment: lamportsIn } },
      }),
    ]);

    console.log(`Credited ${lamportsIn} lamports to user ${userId} (tx ${sigInfo.signature})`);
  }
}

function startDepositWatcher() {
  console.log(`Starting deposit watcher (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  pollOnce().catch((err) => console.error('deposit watcher error:', err));
  return setInterval(() => {
    pollOnce().catch((err) => console.error('deposit watcher error:', err));
  }, POLL_INTERVAL_MS);
}

module.exports = { startDepositWatcher, pollOnce };
