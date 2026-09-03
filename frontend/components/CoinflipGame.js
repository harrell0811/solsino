import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';
import { sound } from '../lib/sound';

const FLIP_DURATION_MS = 900;

/**
 * Stake-style streak coinflip: place a wager and a first guess, then
 * after each correct flip choose to cash out at the current
 * multiplier or push your luck on another flip. One wrong guess
 * busts the whole wager. `phase` drives which controls are shown:
 *  - 'idle'    — no active round, wager/choice are editable
 *  - 'flipping'— waiting on a request + coin animation
 *  - 'active'  — round is live, player can flip again or cash out
 */
export default function CoinflipGame({ userId, balanceLamports, onBalanceChange }) {
  const [wager, setWager] = useState('0.01');
  const [choice, setChoice] = useState('heads');
  const [phase, setPhase] = useState('idle');
  const [roundId, setRoundId] = useState(null);
  const [streak, setStreak] = useState(0);
  const [multiplier, setMultiplier] = useState(null);
  const [currentCashout, setCurrentCashout] = useState(null);
  const [flipOutcome, setFlipOutcome] = useState(null);
  const [lastResult, setLastResult] = useState(null); // { won, outcome, cashedOut, payoutLamports }
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);

  const flipping = phase === 'flipping';
  const active = phase === 'active';
  const locked = flipping || active; // wager/first-choice can't change mid-round

  function play(fn) {
    if (!muted) fn();
  }

  async function animateFlip() {
    setFlipOutcome(null);
    await new Promise((resolve) => setTimeout(resolve, FLIP_DURATION_MS));
  }

  async function startRound() {
    if (!userId || locked) return;
    setError(null);
    setLastResult(null);
    setPhase('flipping');
    try {
      const res = await api.startCoinflip(userId, solToLamports(wager), choice);
      await animateFlip();
      setFlipOutcome(res.outcome);
      onBalanceChange(res.newBalanceLamports);

      if (res.busted) {
        play(sound.lose);
        setLastResult({ won: false, outcome: res.outcome });
        setPhase('idle');
        return;
      }

      play(sound.smallWin);
      setRoundId(res.roundId);
      setStreak(res.streak);
      setMultiplier(res.multiplier);
      setCurrentCashout(res.currentCashoutLamports);
      setPhase('active');
    } catch (err) {
      setError(err.message);
      setPhase('idle');
    }
  }

  async function flipAgain() {
    if (!active) return;
    setError(null);
    setPhase('flipping');
    try {
      const res = await api.flipCoinflip(userId, roundId, choice);
      await animateFlip();
      setFlipOutcome(res.outcome);

      if (res.busted) {
        play(sound.lose);
        setLastResult({ won: false, outcome: res.outcome });
        setRoundId(null);
        setStreak(0);
        setMultiplier(null);
        setCurrentCashout(null);
        setPhase('idle');
        return;
      }

      play(res.streak >= 4 ? sound.bigWin : sound.smallWin);
      setStreak(res.streak);
      setMultiplier(res.multiplier);
      setCurrentCashout(res.currentCashoutLamports);
      setPhase('active');
    } catch (err) {
      setError(err.message);
      setPhase('active');
    }
  }

  async function cashOut() {
    if (!active) return;
    setError(null);
    try {
      const res = await api.cashoutCoinflip(userId, roundId);
      play(streak >= 4 ? sound.bigWin : sound.smallWin);
      setLastResult({ won: true, cashedOut: true, payoutLamports: res.payoutLamports, streak: res.streak });
      onBalanceChange(res.newBalanceLamports);
      setRoundId(null);
      setStreak(0);
      setMultiplier(null);
      setCurrentCashout(null);
      setPhase('idle');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Coinflip</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            94% RTP
          </span>
          <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setMuted((m) => !m)}>
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', margin: '24px 0' }}>
        <div className="coin-scene">
          <div
            className={`coin ${flipping ? 'coin-flipping' : ''}`}
            style={{
              transform:
                !flipping && flipOutcome
                  ? `rotateY(${flipOutcome === 'tails' ? 180 : 0}deg)`
                  : undefined,
            }}
          >
            <div className="coin-face coin-face-heads">H</div>
            <div className="coin-face coin-face-tails">T</div>
          </div>
        </div>
      </div>

      {active && (
        <div className="coinflip-streak-banner">
          <div>
            Streak <strong>{streak}</strong> · {multiplier}x
          </div>
          <div className="mono">Cash out: {lamportsToSol(currentCashout)} SOL</div>
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
            disabled={locked}
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8 }}>
            <QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={locked} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          className={`btn ${choice === 'heads' ? 'btn-brand' : ''}`}
          style={{ flex: 1 }}
          disabled={flipping}
          onClick={() => setChoice('heads')}
        >
          Heads
        </button>
        <button
          className={`btn ${choice === 'tails' ? 'btn-brand' : ''}`}
          style={{ flex: 1 }}
          disabled={flipping}
          onClick={() => setChoice('tails')}
        >
          Tails
        </button>
      </div>

      {!active ? (
        <button
          className="btn btn-brand"
          style={{ width: '100%', marginTop: 16, padding: '12px' }}
          disabled={!userId || flipping}
          onClick={startRound}
        >
          {flipping ? 'Flipping…' : userId ? 'Place bet' : 'Connect wallet to play'}
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="btn btn-brand"
            style={{ flex: 1, padding: '12px' }}
            disabled={flipping}
            onClick={flipAgain}
          >
            {flipping ? 'Flipping…' : `Flip again (${choice})`}
          </button>
          <button
            className="btn btn-positive"
            style={{ flex: 1, padding: '12px' }}
            disabled={flipping}
            onClick={cashOut}
          >
            Cash out
          </button>
        </div>
      )}

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}

      {lastResult && phase === 'idle' && (
        <div
          className="mono"
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 6,
            background: lastResult.won ? 'var(--positive-dim)' : 'var(--negative-dim)',
            border: `1px solid ${lastResult.won ? 'var(--positive)' : 'var(--negative)'}`,
            fontSize: 13,
          }}
        >
          {lastResult.cashedOut ? (
            <div>
              Cashed out after a {lastResult.streak}-streak — won {lamportsToSol(lastResult.payoutLamports)} SOL
            </div>
          ) : (
            <div>
              Landed on <strong>{lastResult.outcome}</strong> — busted the streak
            </div>
          )}
        </div>
      )}
    </div>
  );
}
