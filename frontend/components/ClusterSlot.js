import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';
import { sound } from '../lib/sound';

const COLS = 6;
const ROWS = 5;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cluster-pays cascading slot: no paylines — 5+ same symbols touching
 * (up/down/left/right) anywhere on the grid win. Winning tiles clear,
 * everything above tumbles down, fresh symbols drop in from the top,
 * and it re-evaluates — chaining wins with a multiplier that climbs
 * each tumble (1x → 2x → 3x → 5x → 8x → 13x → 21x) until nothing
 * clears anymore.
 */
export default function ClusterSlot({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.02');
  const [grid, setGrid] = useState(() => emptyGrid());
  const [litCells, setLitCells] = useState(new Set());
  const [multiplier, setMultiplier] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [muted, setMuted] = useState(false);

  function play(fn) {
    if (!muted) fn();
  }

  function emptyGrid() {
    return Array.from({ length: COLS }, () => Array.from({ length: ROWS }, () => '✦'));
  }

  async function playStep(step, isFirst) {
    setGrid(step.grid);
    if (isFirst) {
      setLitCells(new Set());
      setMultiplier(1);
      await wait(250);
      return;
    }
    // step.clusters describes what JUST cleared to produce this grid —
    // light those cells briefly before they're already gone from view,
    // so flash the PREVIOUS grid's winning cells, then reveal the tumble.
  }

  async function runSpin() {
    if (!userId || loading) return;
    setLoading(true);
    setError(null);
    setFinalResult(null);
    setLitCells(new Set());
    setMultiplier(1);

    try {
      const res = await api.spinClusterSlot(userId, solToLamports(wager));
      const steps = res.steps;

      // steps[0] is the initial grid (no clusters yet).
      setGrid(steps[0].grid);
      await wait(300);

      for (let i = 1; i < steps.length; i++) {
        const prevGrid = steps[i - 1].grid;
        const { clusters, multiplier: mult, grid: nextGrid } = steps[i];

        // Highlight the winning cells on the CURRENT (pre-tumble) grid.
        const cellKeys = new Set();
        clusters.forEach((c) => c.cells.forEach(([col, row]) => cellKeys.add(`${col},${row}`)));
        setGrid(prevGrid);
        setLitCells(cellKeys);
        setMultiplier(mult);
        play(cellKeys.size > 8 ? sound.bigWin : sound.smallWin);
        await wait(550);

        // Tumble: clear, drop, refill.
        setLitCells(new Set());
        setGrid(nextGrid);
        play(sound.reelStop);
        await wait(450);
      }

      const totalPayout = BigInt(res.totalPayoutLamports);
      if (totalPayout === 0n) play(sound.lose);
      else if (res.tumbles >= 4) play(sound.bonusFanfare);

      setFinalResult(res);
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel cluster-slot">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Neon Cascade</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {multiplier > 1 && <span className="mono cluster-mult-badge">{multiplier}x</span>}
          <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setMuted((m) => !m)}>
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      <div className="cluster-stage">
        <div className="cluster-mascot cluster-mascot-left">🦊</div>

        <div className="cluster-grid">
          {grid.map((col, colIdx) => (
            <div key={colIdx} className="cluster-col">
              {col.map((emoji, rowIdx) => {
                const isLit = litCells.has(`${colIdx},${rowIdx}`);
                return (
                  <div key={rowIdx} className={`cluster-cell ${isLit ? 'cluster-cell-lit' : ''}`}>
                    {emoji}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cluster-mascot cluster-mascot-right">🐱</div>
      </div>

      <div className="cluster-mult-trail">
        {[1, 2, 3, 5, 8, 13, 21].map((m) => (
          <span key={m} className={`cluster-mult-step ${multiplier >= m ? 'cluster-mult-step-active' : ''}`}>
            {m}x
          </span>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
          Bet (SOL)
        </label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={wager}
          onChange={(e) => setWager(e.target.value)}
          disabled={loading}
          style={{ width: '100%' }}
        />
        <div style={{ marginTop: 8 }}>
          <QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={loading} />
        </div>
      </div>

      <button
        className="btn btn-brand"
        style={{ width: '100%', marginTop: 16, padding: '12px' }}
        disabled={!userId || loading}
        onClick={runSpin}
      >
        {loading ? 'Cascading…' : userId ? 'Spin' : 'Connect wallet to play'}
      </button>

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}

      {finalResult && !loading && (
        <div
          className="mono"
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 6,
            background: finalResult.totalPayoutLamports !== '0' ? 'var(--positive-dim)' : 'var(--negative-dim)',
            border: `1px solid ${finalResult.totalPayoutLamports !== '0' ? 'var(--positive)' : 'var(--negative)'}`,
            fontSize: 13,
          }}
        >
          {finalResult.totalPayoutLamports !== '0'
            ? `Won ${lamportsToSol(finalResult.totalPayoutLamports)} SOL over ${finalResult.tumbles} tumble${
                finalResult.tumbles === 1 ? '' : 's'
              }`
            : 'No clusters this spin'}
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
        6×5 grid · 5+ touching symbols anywhere = a cluster win · wins tumble and re-chain with a climbing multiplier
      </p>
    </div>
  );
}
