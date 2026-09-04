import { useState, useRef } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';
import { sound } from '../lib/sound';

const ALL_EMOJI = ['⚡', '🚀', '🌙', '💎', '🔥', '7️⃣', '⭐', '🎰'];
const COL_START_STAGGER_MS = 160; // delay before each successive column starts rolling
const COL_ROLL_MS = 480; // how long a column keeps rolling once started, before it can stop
const COL_STOP_STAGGER_MS = 150; // delay between each successive column stopping
const SYMBOL_CYCLE_MS = 70; // how often a rolling column's symbols change
const POST_REVEAL_PAUSE_MS = 700;

function randomGrid() {
  return Array.from({ length: 5 }, () =>
    Array.from({ length: 3 }, () => ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)])
  );
}

function randomColumn() {
  return Array.from({ length: 3 }, () => ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function SlotMachine({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.02');
  const [grid, setGrid] = useState(randomGrid());
  const [spinningCols, setSpinningCols] = useState([false, false, false, false, false]);
  const [litLines, setLitLines] = useState([]); // payline indices to highlight
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [statusText, setStatusText] = useState(null);
  const [bonusActive, setBonusActive] = useState(false);
  const [bonusSpinsLeft, setBonusSpinsLeft] = useState(0);
  const [bonusTotal, setBonusTotal] = useState(0n);
  const [finalResult, setFinalResult] = useState(null);
  const [celebrate, setCelebrate] = useState(false);
  const [muted, setMuted] = useState(false);
  const tickIntervalRef = useRef(null);
  const cycleIntervalsRef = useRef([null, null, null, null, null]);

  // Autobet
  const [autobetSpins, setAutobetSpins] = useState('10');
  const [autobetRunning, setAutobetRunning] = useState(false);
  const [autobetRemaining, setAutobetRemaining] = useState(0);
  const autobetStopRef = useRef(false);

  function play(fn) {
    if (!muted) fn();
  }

  function clearCycle(col) {
    if (cycleIntervalsRef.current[col]) {
      clearInterval(cycleIntervalsRef.current[col]);
      cycleIntervalsRef.current[col] = null;
    }
  }

  /**
   * Rolls the reels down column by column: each column starts
   * spinning a beat after the one before it (rather than all five
   * starting together), cycles random symbols while it spins so it
   * actually looks like it's rolling, then — once every column has
   * had a chance to spin — stops left to right revealing the real
   * result, same staggered order as it started.
   */
  async function revealSpin(spinData) {
    setLitLines([]);
    let suspenseTriggered = false;

    tickIntervalRef.current = setInterval(() => play(sound.reelTick), 90);

    for (let col = 0; col < 5; col++) {
      setSpinningCols((s) => {
        const next = [...s];
        next[col] = true;
        return next;
      });
      cycleIntervalsRef.current[col] = setInterval(() => {
        setGrid((g) => {
          const next = g.map((c) => [...c]);
          next[col] = randomColumn();
          return next;
        });
      }, SYMBOL_CYCLE_MS);
      await wait(COL_START_STAGGER_MS);
    }

    await wait(COL_ROLL_MS);

    for (let col = 0; col < 5; col++) {
      clearCycle(col);
      setGrid((g) => {
        const next = g.map((c) => [...c]);
        next[col] = spinData.grid[col];
        return next;
      });
      setSpinningCols((s) => {
        const next = [...s];
        next[col] = false;
        return next;
      });
      play(sound.reelStop);
      // When two bonus symbols have landed, hold the remaining reels a
      // little longer. It creates a real anticipation beat without ever
      // changing the server-provided outcome.
      const landedBonusSymbols = spinData.grid
        .slice(0, col + 1)
        .flat()
        .filter((symbol) => symbol === '🎰').length;
      if (landedBonusSymbols >= 2 && col < 4) {
        suspenseTriggered = true;
        setStatusText('TWO BONUS SYMBOLS — HOLD ON…');
        play(sound.nearWin);
        await wait(900 + (4 - col) * 220);
      }
      await wait(COL_STOP_STAGGER_MS);
    }

    clearInterval(tickIntervalRef.current);
    if (suspenseTriggered && !spinData.lineResults.length) {
      // A soft release sound makes the near-miss feel theatrical while the
      // result panel still truthfully reports the actual payout.
      play(sound.suspenseRelease);
    }

    if (spinData.lineResults.length > 0) {
      setLitLines(spinData.lineResults.map((r) => r.line));
      const payout = BigInt(spinData.payoutLamports);
      const wagerLamports = BigInt(solToLamports(wager));
      if (payout > wagerLamports * 5n) play(sound.bigWin);
      else play(sound.smallWin);
    }

    await wait(POST_REVEAL_PAUSE_MS);
    if (suspenseTriggered) setStatusText(null);
  }

  /** Runs one spin end to end. Returns true on success, false on error
   *  (used by autobet to know when to stop). */
  async function handleSpin() {
    if (!userId || loading) return false;
    setLoading(true);
    setError(null);
    setFinalResult(null);
    setBonusActive(false);
    setBonusTotal(0n);
    setCelebrate(false);

    try {
      const res = await api.spinSlots(userId, solToLamports(wager));
      const [base, ...bonusSpins] = res.spins;

      setStatusText(null);
      await revealSpin(base);

      if (res.bonusTriggered) {
        setBonusActive(true);
        setBonusSpinsLeft(bonusSpins.length);
        setStatusText(`BONUS! ${bonusSpins.length} FREE SPINS`);
        play(sound.bonusFanfare);
        await wait(1100);

        let running = 0n;
        for (let i = 0; i < bonusSpins.length; i++) {
          const spin = bonusSpins[i];
          setBonusSpinsLeft((n) => n - 1);
          setStatusText(`FREE SPIN ${i + 1}/${bonusSpins.length} · ${spin.stickyWilds || 0} STICKY WILDS`);
          await revealSpin(spin);
          running += BigInt(spin.payoutLamports);
          setBonusTotal(running);
        }
        setBonusActive(false);
        setStatusText(null);
      }

      const totalPayout = BigInt(res.totalPayoutLamports);
      const wagerLamports = BigInt(solToLamports(wager));

      if (totalPayout === 0n) {
        play(sound.lose);
      } else if (totalPayout >= wagerLamports * 15n) {
        setCelebrate(true);
        play(sound.bigWin);
      }

      setFinalResult(res);
      onBalanceChange(res.newBalanceLamports);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function startAutobet() {
    if (!userId || loading || autobetRunning) return;
    const total = parseInt(autobetSpins, 10);
    if (!Number.isFinite(total) || total <= 0) {
      setError('Enter a number of autobet spins greater than 0');
      return;
    }

    autobetStopRef.current = false;
    setAutobetRunning(true);
    setAutobetRemaining(total);

    for (let i = 0; i < total; i++) {
      if (autobetStopRef.current) break;
      setAutobetRemaining(total - i);
      const ok = await handleSpin();
      if (!ok) break;
    }

    setAutobetRemaining(0);
    setAutobetRunning(false);
  }

  function stopAutobet() {
    autobetStopRef.current = true;
  }

  const anySpinning = spinningCols.some(Boolean);
  const controlsLocked = loading || autobetRunning;

  return (
    <div className="panel slot-machine">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Solsino Slots</h2>
        <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setMuted((m) => !m)}>
          {muted ? '🔇' : '🔊'}
        </button>
      </div>

      {statusText && <div className="slot-bonus-banner">{statusText}</div>}

      <div className={`slot-reel-frame ${celebrate ? 'slot-celebrate' : ''}`}>
        <div className="slot-grid">
          {grid.map((col, colIdx) => (
            <div key={colIdx} className={`slot-col ${spinningCols[colIdx] ? 'slot-col-spinning' : ''}`}>
              {col.map((emoji, rowIdx) => {
                const isLit = litLines.some((lineIdx) => {
                  const lines = [
                    [1, 1, 1, 1, 1],
                    [0, 0, 0, 0, 0],
                    [2, 2, 2, 2, 2],
                    [0, 1, 2, 1, 0],
                    [2, 1, 0, 1, 2],
                  ];
                  return lines[lineIdx][colIdx] === rowIdx;
                });
                return (
                  <div key={rowIdx} className={`slot-cell ${isLit ? 'slot-cell-lit' : ''} ${bonusActive && emoji === '⭐' ? 'slot-cell-sticky' : ''}`}>
                    {emoji}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {celebrate && (
          <div className="slot-confetti">
            {Array.from({ length: 24 }).map((_, i) => (
              <span
                key={i}
                className="slot-confetti-piece"
                style={{
                  left: `${(i * 37) % 100}%`,
                  animationDelay: `${(i % 8) * 0.08}s`,
                  fontSize: 12 + (i % 3) * 6,
                }}
              >
                {['💎', '⭐', '🚀', '🔥'][i % 4]}
              </span>
            ))}
          </div>
        )}
      </div>

      {bonusActive && (
        <p className="mono" style={{ fontSize: 12, color: 'var(--brand)', marginTop: 8 }}>
          {bonusSpinsLeft} free spins left · running total {lamportsToSol(bonusTotal.toString())} SOL
        </p>
      )}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
          Total bet (SOL) — split across 5 lines
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={wager}
            onChange={(e) => setWager(e.target.value)}
            disabled={controlsLocked || anySpinning}
            style={{ flex: 1 }}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={controlsLocked} />
        </div>
      </div>

      <button
        className="btn btn-brand"
        style={{ width: '100%', marginTop: 16, padding: '12px' }}
        disabled={!userId || controlsLocked}
        onClick={handleSpin}
      >
        {loading ? 'Spinning…' : userId ? 'Spin' : 'Connect wallet to play'}
      </button>

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
          Autobet spins
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number"
            min="1"
            step="1"
            value={autobetSpins}
            onChange={(e) => setAutobetSpins(e.target.value)}
            disabled={autobetRunning || loading}
            style={{ flex: 1 }}
          />
          <button
            className={`btn ${autobetRunning ? 'btn-negative' : ''}`}
            style={{ flex: 1 }}
            disabled={!userId || (!autobetRunning && loading)}
            onClick={autobetRunning ? stopAutobet : startAutobet}
          >
            {autobetRunning ? `Stop (${autobetRemaining} left)` : 'Start Autobet'}
          </button>
        </div>
      </div>

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
            ? `Won ${lamportsToSol(finalResult.totalPayoutLamports)} SOL${
                finalResult.bonusTriggered ? ' (including bonus)' : ''
              }`
            : 'No win this spin'}
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
        5 reels · 5 paylines · ⭐ wild substitutes for any symbol · 🎰 3+ anywhere triggers free spins (2x payouts)
      </p>
    </div>
  );
}
