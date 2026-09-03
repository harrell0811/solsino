import { useEffect, useMemo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';

// WalletMultiButton reads browser-only wallet state (installed wallets, connection
// status), so its initial render differs between server and client. Loading it with
// ssr: false skips server rendering for this component and avoids the hydration
// mismatch error.
const WalletMultiButton = dynamic(
  () =>
    import('@solana/wallet-adapter-react-ui').then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import { io } from 'socket.io-client';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import CoinflipGame from '../components/CoinflipGame';
import MinesGame from '../components/MinesGame';
import CrashGame from '../components/CrashGame';
import SlotMachine from '../components/SlotMachine';
import ChatPanel from '../components/ChatPanel';
import BetTicker from '../components/BetTicker';
import ProfilePanel from '../components/ProfilePanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function Home() {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [user, setUser] = useState(null); // { userId, balanceLamports }
  const [socket, setSocket] = useState(null);
  const [depositAmount, setDepositAmount] = useState('0.1');
  const [withdrawAmount, setWithdrawAmount] = useState('0.05');
  const [txStatus, setTxStatus] = useState(null);
  const [activeGame, setActiveGame] = useState('coinflip');
  const [showProfile, setShowProfile] = useState(false);

  // Connect (or create) the backend user record whenever the wallet connects
  useEffect(() => {
    if (!connected || !publicKey) {
      setUser(null);
      return;
    }
    api
      .connectUser(publicKey.toString())
      .then(setUser)
      .catch((err) => setTxStatus({ type: 'error', message: err.message }));
  }, [connected, publicKey]);

  // Socket connection is independent of wallet state — chat/ticker work for spectators too
  useEffect(() => {
    const s = io(API_URL);
    setSocket(s);
    return () => s.disconnect();
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!user?.userId) return;
    const fresh = await api.getUser(user.userId);
    setUser(fresh);
  }, [user?.userId]);

  function handleBalanceChange(newBalanceLamports) {
    setUser((u) => (u ? { ...u, balanceLamports: newBalanceLamports } : u));
  }

  async function handleDeposit() {
    if (!user || !publicKey) return;
    setTxStatus({ type: 'pending', message: 'Building transaction…' });
    try {
      const { depositAddress, memo } = await api.depositInfo(user.userId);
      const lamports = Number(solToLamports(depositAmount));

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(depositAddress),
          lamports,
        }),
        createMemoInstruction(memo, [publicKey])
      );

      const signature = await sendTransaction(tx, connection);
      setTxStatus({ type: 'pending', message: 'Confirming on-chain…' });
      await connection.confirmTransaction(signature, 'confirmed');

      setTxStatus({
        type: 'success',
        message: 'Deposit sent — balance updates within ~10s once the watcher picks it up.',
      });

      // Poll a couple of times since the backend watcher runs on its own interval
      setTimeout(refreshBalance, 8000);
      setTimeout(refreshBalance, 15000);
    } catch (err) {
      setTxStatus({ type: 'error', message: err.message });
    }
  }

  async function handleWithdraw() {
    if (!user) return;
    setTxStatus({ type: 'pending', message: 'Requesting withdrawal…' });
    try {
      const res = await api.withdraw(user.userId, solToLamports(withdrawAmount));
      setTxStatus({ type: 'success', message: `Withdrawal sent — signature ${res.signature.slice(0, 12)}…` });
      refreshBalance();
    } catch (err) {
      setTxStatus({ type: 'error', message: err.message });
    }
  }

  const balanceSol = useMemo(
    () => (user ? lamportsToSol(user.balanceLamports) : '0.0000'),
    [user]
  );

  return (
    <div style={{ minHeight: '100vh', padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <Head>
        <title>Solsino</title>
        <meta name="description" content="Solsino — a Solana devnet casino: coinflip, mines, and crash." />
      </Head>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 32,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              background: 'linear-gradient(120deg, #9945ff, #14f195)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Solsino
          </h1>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>devnet</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {user && (
            <div className="mono panel" style={{ padding: '8px 14px', fontSize: 14 }}>
              {balanceSol} <span style={{ color: 'var(--text-muted)' }}>SOL</span>
            </div>
          )}
          {user && (
            <button className="btn" onClick={() => setShowProfile(true)}>
              {user.displayName || `${user.walletAddress.slice(0, 4)}…${user.walletAddress.slice(-4)}`}
            </button>
          )}
          <WalletMultiButton />
        </div>
      </header>

      {showProfile && user && (
        <ProfilePanel
          userId={user.userId}
          walletAddress={user.walletAddress}
          displayName={user.displayName}
          onProfileUpdate={(displayName) => setUser((u) => (u ? { ...u, displayName } : u))}
          onClose={() => setShowProfile(false)}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        <div>
          {connected && (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 24 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                    Deposit (SOL)
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button className="btn btn-positive" onClick={handleDeposit}>
                      Deposit
                    </button>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
                    Withdraw (SOL)
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button className="btn" onClick={handleWithdraw}>
                      Withdraw
                    </button>
                  </div>
                </div>
              </div>
              {txStatus && (
                <p
                  className="mono"
                  style={{
                    marginTop: 12,
                    marginBottom: 0,
                    fontSize: 12,
                    color:
                      txStatus.type === 'error'
                        ? 'var(--negative)'
                        : txStatus.type === 'success'
                        ? 'var(--positive)'
                        : 'var(--text-muted)',
                  }}
                >
                  {txStatus.message}
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              className={`btn ${activeGame === 'coinflip' ? 'btn-brand' : ''}`}
              onClick={() => setActiveGame('coinflip')}
            >
              Coinflip
            </button>
            <button
              className={`btn ${activeGame === 'mines' ? 'btn-brand' : ''}`}
              onClick={() => setActiveGame('mines')}
            >
              Mines
            </button>
            <button
              className={`btn ${activeGame === 'crash' ? 'btn-brand' : ''}`}
              onClick={() => setActiveGame('crash')}
            >
              Crash
            </button>
            <button
              className={`btn ${activeGame === 'slots' ? 'btn-brand' : ''}`}
              onClick={() => setActiveGame('slots')}
            >
              Slots
            </button>
          </div>

          {activeGame === 'coinflip' && (
            <CoinflipGame
              userId={user?.userId}
              balanceLamports={user?.balanceLamports}
              onBalanceChange={handleBalanceChange}
            />
          )}
          {activeGame === 'mines' && (
            <MinesGame
              userId={user?.userId}
              balanceLamports={user?.balanceLamports}
              onBalanceChange={handleBalanceChange}
            />
          )}
          {activeGame === 'crash' && (
            <CrashGame
              userId={user?.userId}
              balanceLamports={user?.balanceLamports}
              socket={socket}
              onBalanceChange={handleBalanceChange}
            />
          )}
          {activeGame === 'slots' && (
            <SlotMachine
              userId={user?.userId}
              balanceLamports={user?.balanceLamports}
              onBalanceChange={handleBalanceChange}
            />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <BetTicker socket={socket} />
          <ChatPanel socket={socket} username={publicKey ? publicKey.toString().slice(0, 6) : null} />
        </div>
      </div>
    </div>
  );
}
