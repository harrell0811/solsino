import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';

const LEVELS = 9;
const DIFFICULTIES = {
  easy: { tiles: 4, label: 'Easy (1 dragon)' },
  medium: { tiles: 3, label: 'Medium (1 dragon)' },
  hard: { tiles: 2, label: 'Hard (1 dragon)' },
  expert: { tiles: 3, label: 'Expert (2 dragons)' },
  master: { tiles: 4, label: 'Master (3 dragons)' },
};

export default function DragonTowerGame({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.01');
  const [difficulty, setDifficulty] = useState('medium');
  const [round, setRound] = useState(null);
  // round: { roundId, tilesPerLevel, level, picks: [{level, tile, safe}], busted, cashedOut, multiplier }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function startRound() {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.startDragonTower(userId, solToLamports(wager), difficulty);
      setRound({
        roundId: res.roundId,
        tilesPerLevel: res.tilesPerLevel,
        level: 0,
        picks: [],
        busted: false,
        cashedOut: false,
        multiplier: null,
      });
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function pick(tile) {
    if (!round || round.busted || round.cashedOut) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.revealDragonTower(userId, round.roundId, tile);
      if (res.hitDragon) {
        setRound({
          ...round,
          busted: true,
          picks: [...round.picks, { level: round.level, tile, safe: false, safeTiles: res.safeTiles }],
        });
      } else {
        setRound({
          ...round,
          level: res.level,
          multiplier: res.multiplier,
          reachedTop: res.reachedTop,
          picks: [...round.picks, { level: round.level, tile, safe: true }],
        });
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
      const res = await api.cashoutDragonTower(userId, round.roundId);
      setRound({ ...round, cashedOut: true, payout: res.payoutLamports });
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inRound = round && !round.busted && !round.cashedOut && !round.reachedTop;
  const pickForLevel = (level) => round?.picks.find((p) => p.level === level);

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🐉 Dragon Tower</h2>
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
                Difficulty
              </label>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} style={{ width: '100%' }}>
                {Object.entries(DIFFICULTIES).map(([key, d]) => (
                  <option key={key} value={key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            className="btn btn-brand"
            style={{ width: '100%', marginTop: 16, padding: '12px' }}
            disabled={!userId || loading}
            onClick={startRound}
          >
            {userId ? 'Start climb' : 'Connect wallet to play'}
          </button>
        </>
      )}

      {round && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 6, marginTop: 20 }}>
            {Array.from({ length: LEVELS }).map((_, level) => {
              const pick_ = pickForLevel(level);
              const isCurrentLevel = level === round.level && inRound;
              const isPastLevel = level < round.level || (pick_ && !pick_.safe);
              const isFutureLevel = level > round.level && !(pick_ && !pick_.safe);

              return (
                <div
                  key={level}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${round.tilesPerLevel}, 1fr)`,
                    gap: 6,
                    opacity: isFutureLevel && !isCurrentLevel ? 0.4 : 1,
                  }}
                >
                  {Array.from({ length: round.tilesPerLevel }).map((_, tile) => {
                    const wasPicked = pick_?.tile === tile;
                    const revealedAsSafe = wasPicked && pick_.safe;
                    const revealedAsDragon = wasPicked && !pick_.safe;
                    const showAsDragonHint = pick_ && !pick_.safe && pick_.safeTiles?.includes(tile);

                    return (
                      <button
                        key={tile}
                        className="btn tile"
                        disabled={!isCurrentLevel || loading}
                        onClick={() => pick(tile)}
                        style={{
                          aspectRatio: '1.4',
                          padding: 0,
                          fontSize: 16,
                          background: revealedAsDragon
                            ? 'var(--negative-dim)'
                            : revealedAsSafe
                            ? 'var(--positive-dim)'
                            : showAsDragonHint
                            ? 'var(--positive-dim)'
                            : 'var(--surface-raised)',
                          borderColor: revealedAsDragon
                            ? 'var(--negative)'
                            : revealedAsSafe || showAsDragonHint
                            ? 'var(--positive)'
                            : undefined,
                        }}
                      >
                        {revealedAsDragon ? '🐉' : revealedAsSafe ? '🥚' : showAsDragonHint ? '🥚' : ''}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {inRound && round.level > 0 && (
            <button
              className="btn btn-positive"
              style={{ width: '100%', marginTop: 16, padding: '12px' }}
              disabled={loading}
              onClick={cashout}
            >
              Cash out
            </button>
          )}

          {(round.busted || round.cashedOut || round.reachedTop) && (
            <button
              className="btn"
              style={{ width: '100%', marginTop: 16, padding: '12px' }}
              onClick={() => setRound(null)}
            >
              Play again
            </button>
          )}

          {round.reachedTop && !round.cashedOut && (
            <button
              className="btn btn-positive"
              style={{ width: '100%', marginTop: 16, padding: '12px' }}
              disabled={loading}
              onClick={cashout}
            >
              Claim top-of-tower payout
            </button>
          )}

          {round.cashedOut && (
            <p className="mono" style={{ color: 'var(--positive)', fontSize: 13, marginTop: 12 }}>
              Cashed out: {lamportsToSol(round.payout)} SOL
            </p>
          )}
          {round.busted && (
            <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
              Hit a dragon — round over.
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
