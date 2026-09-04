import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';

export default function LimboGame({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.01');
  const [target, setTarget] = useState('2.00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null); // { won, rollMultiplier, targetMultiplier, payoutLamports }
  const [history, setHistory] = useState([]); // most recent rolls, newest first

  const winChance = Math.min(100, Math.max(0, 96 / Math.max(Number(target) || 1, 1.01))).toFixed(2);

  async function placeBet() {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.betLimbo(userId, solToLamports(wager), Number(target));
      setLastResult(res);
      setHistory((h) => [{ roll: res.rollMultiplier, won: res.won }, ...h.slice(0, 9)]);
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel">
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Limbo</h2>

      <div
        style={{
          marginTop: 20,
          padding: '32px 16px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--surface-raised)',
          textAlign: 'center',
        }}
      >
        {lastResult ? (
          <>
            <div
              className="mono"
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: lastResult.won ? 'var(--positive)' : 'var(--negative)',
              }}
            >
              {lastResult.rollMultiplier}x
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
              needed {lastResult.targetMultiplier}x — {lastResult.won ? 'win' : 'miss'}
            </div>
          </>
        ) : (
          <div className="mono" style={{ fontSize: 40, fontWeight: 700, color: 'var(--text-muted)' }}>
            —
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {history.map((h, i) => (
            <span
              key={i}
              className="mono"
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 999,
                background: h.won ? 'var(--positive-dim)' : 'var(--negative-dim)',
                color: h.won ? 'var(--positive)' : 'var(--negative)',
              }}
            >
              {h.roll}x
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
            Wager (SOL)
          </label>
          <input
            type="number"
            min="0"
            step="0.001"
            value={wager}
            onChange={(e) => setWager(e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8 }}>
            <QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={loading} />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
            Target multiplier
          </label>
          <input
            type="number"
            min="1.01"
            step="0.01"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
            Win chance ≈ {winChance}%
          </div>
        </div>
      </div>

      <button
        className="btn btn-brand"
        style={{ width: '100%', marginTop: 16, padding: '12px' }}
        disabled={!userId || loading}
        onClick={placeBet}
      >
        {userId ? (loading ? 'Rolling…' : 'Bet') : 'Connect wallet to play'}
      </button>

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
