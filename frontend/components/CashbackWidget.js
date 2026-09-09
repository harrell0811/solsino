import { useEffect, useState, useCallback } from 'react';
import { api, lamportsToSol } from '../lib/api';

/**
 * Small header pill showing accumulated cashback (10% of net losses
 * since the player's last claim). Polls periodically so it visibly
 * ticks up during a session without needing a page refresh.
 */
export default function CashbackWidget({ userId, onBalanceChange }) {
  const [pending, setPending] = useState('0');
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    if (!userId) return;
    api.cashbackStatus(userId).then((res) => setPending(res.pendingCashbackLamports)).catch(() => {});
  }, [userId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  async function claim() {
    if (!userId || claiming || pending === '0') return;
    setClaiming(true);
    setError(null);
    try {
      const res = await api.claimCashback(userId);
      onBalanceChange(res.newBalanceLamports);
      setPending('0');
    } catch (err) {
      setError(err.message);
    } finally {
      setClaiming(false);
    }
  }

  if (!userId) return null;
  const hasPending = pending !== '0';

  return (
    <button
      className="btn"
      onClick={claim}
      disabled={!hasPending || claiming}
      title={error || '10% of your net losses, back in your pocket'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderColor: hasPending ? 'var(--positive)' : undefined,
        color: hasPending ? 'var(--positive)' : undefined,
      }}
    >
      🎁 <span className="mono">{lamportsToSol(pending)} SOL</span>
      {hasPending && <span style={{ fontSize: 11 }}>{claiming ? 'Claiming…' : 'Claim'}</span>}
    </button>
  );
}
