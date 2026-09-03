import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';

const GRID_SIZE = 25;

export default function MinesGame({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.01');
  const [mineCount, setMineCount] = useState(5);
  const [round, setRound] = useState(null); // { roundId, revealed: [], busted, cashedOut, multiplier }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function startRound() {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.startMines(userId, solToLamports(wager), mineCount);
      setRound({ roundId: res.roundId, revealed: [], busted: false, cashedOut: false, multiplier: null });
      // Wager is debited the instant the round starts on the backend —
      // reflect that immediately instead of leaving the displayed
      // balance stale until some unrelated refresh happens.
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function reveal(tile) {
    if (!round || round.busted || round.cashedOut) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.revealMines(userId, round.roundId, tile);
      if (res.hitMine) {
        setRound({ ...round, revealed: [...round.revealed, tile], busted: true, mineTiles: res.mineTiles });
      } else {
        setRound({ ...round, revealed: res.revealedTiles, multiplier: res.multiplier });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function cashout() {
    if (!round) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.cashoutMines(userId, round.roundId);
      setRound({ ...round, cashedOut: true, payout: res.payoutLamports });
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inRound = round && !round.busted && !round.cashedOut;

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Mines</h2>
        {round?.multiplier && (
          <span className="mono" style={{ fontSize: 13, color: 'var(--positive)' }}>
            {round.multiplier}x
          </span>
        )}
      </div>

      {!round && (
        <>
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
                Mines (1-24)
              </label>
              <input
                type="number"
                min="1"
                max="24"
                value={mineCount}
                onChange={(e) => setMineCount(parseInt(e.target.value, 10))}
                style={{ width: '100%' }}
              />
            </div>
          </div>
          <button
            className="btn btn-brand"
            style={{ width: '100%', marginTop: 16, padding: '12px' }}
            disabled={!userId || loading}
            onClick={startRound}
          >
            {userId ? 'Start round' : 'Connect wallet to play'}
          </button>
        </>
      )}

      {round && (
        <>
          <div
            className={round.busted ? 'mines-grid mines-grid-shake' : 'mines-grid'}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 6,
              marginTop: 20,
            }}
          >
            {Array.from({ length: GRID_SIZE }).map((_, i) => {
              const isRevealed = round.revealed.includes(i);
              const isMine = round.mineTiles?.includes(i);
              const showAsMine = round.busted && isMine;
              return (
                <button
                  key={i}
                  className={`btn tile ${isRevealed ? 'tile-pop' : ''} ${showAsMine ? 'tile-mine' : ''}`}
                  disabled={!inRound || isRevealed || loading}
                  onClick={() => reveal(i)}
                  style={{
                    aspectRatio: '1',
                    padding: 0,
                    fontSize: 18,
                    background: showAsMine
                      ? 'var(--negative-dim)'
                      : isRevealed
                      ? 'var(--positive-dim)'
                      : 'var(--surface-raised)',
                    borderColor: showAsMine ? 'var(--negative)' : isRevealed ? 'var(--positive)' : undefined,
                  }}
                >
                  {showAsMine ? '💣' : isRevealed ? '✓' : ''}
                </button>
              );
            })}
          </div>

          {inRound && round.revealed.length > 0 && (
            <button
              className="btn btn-positive"
              style={{ width: '100%', marginTop: 16, padding: '12px' }}
              disabled={loading}
              onClick={cashout}
            >
              Cash out
            </button>
          )}

          {(round.busted || round.cashedOut) && (
            <button
              className="btn"
              style={{ width: '100%', marginTop: 16, padding: '12px' }}
              onClick={() => setRound(null)}
            >
              Play again
            </button>
          )}

          {round.cashedOut && (
            <p className="mono" style={{ color: 'var(--positive)', fontSize: 13, marginTop: 12 }}>
              Cashed out: {lamportsToSol(round.payout)} SOL
            </p>
          )}
          {round.busted && (
            <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
              Hit a mine — round over.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}
