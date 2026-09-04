import { useEffect, useRef, useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';
import { sound } from '../lib/sound';

const CHART_WIDTH = 500;
const CHART_HEIGHT = 220;

export default function CrashGame({ userId, balanceLamports, socket, onBalanceChange }) {
  const [wager, setWager] = useState('0.01');
  const [live, setLive] = useState({
    phase: 'waiting',
    multiplier: 1,
    roundId: null,
    serverSeedHash: null,
    playerCount: 0,
    recentCrashes: [],
  });
  const [myBet, setMyBet] = useState(null); // { wagerLamports, cashedOut, payoutLamports, multiplier }
  const [history, setHistory] = useState([]); // [{t, m}]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [justCrashed, setJustCrashed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [, forceTick] = useState(0);
  const roundStartRef = useRef(null);
  const maxMultiplierRef = useRef(2);
  const seenRoundRef = useRef(null);
  const myBetRef = useRef(null);
  const lastCountdownTickRef = useRef(null);

  function play(fn) {
    if (!muted) fn();
  }

  useEffect(() => {
    myBetRef.current = myBet;
  }, [myBet]);

  // Round-start time is authoritative from the server (runningStartedAt),
  // not just "whenever my socket happened to be connected when the round
  // began" — otherwise a client that (re)connects mid-round never learns
  // when t=0 was, and every tick's elapsed time computes as 0, pinning
  // the rocket to the left edge for the rest of the round.
  function syncRoundStart(state) {
    if (state.phase === 'running' && state.runningStartedAt) {
      roundStartRef.current = state.runningStartedAt;
    }
  }

  // If we join mid-round, history starts empty and would otherwise stay
  // empty until the next tick broadcast (up to ~100ms, but on a slow
  // connection or right after a reconnect, that gap is what shows the
  // rocket stuck instead of on the curve). Seed it immediately from
  // whatever state we just received so there's always a valid point.
  function seedMidRoundHistory(state) {
    if (state.phase !== 'running' || !roundStartRef.current) return;
    setHistory((h) => {
      if (h.length > 0) return h;
      const t = Math.max(0, Date.now() - roundStartRef.current);
      return [
        { t: 0, m: 1 },
        { t, m: state.multiplier },
      ];
    });
  }

  function resetForNewRound(state) {
    if (seenRoundRef.current !== state.roundId) {
      seenRoundRef.current = state.roundId;
      setMyBet(null);
      setHistory([]);
      maxMultiplierRef.current = 2;
      roundStartRef.current = null;
    }
  }

  // Bootstrap current round state on mount
  useEffect(() => {
    api.crashState().then((state) => {
      setLive(state);
      resetForNewRound(state);
      syncRoundStart(state);
      seedMidRoundHistory(state);
    }).catch(() => {});
  }, []);

  // Re-render every 500ms during the waiting phase so the countdown
  // actually counts down instead of only updating on socket events.
  useEffect(() => {
    if (live.phase !== 'waiting') return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [live.phase]);

  useEffect(() => {
    if (!socket) return;

    function onState(state) {
      setLive(state);
      resetForNewRound(state);
      syncRoundStart(state);
      seedMidRoundHistory(state);
    }
    function onWaiting(state) {
      setLive(state);
      resetForNewRound(state);
      setJustCrashed(false);
    }
    function onRunning(state) {
      setLive(state);
      roundStartRef.current = state.runningStartedAt || Date.now();
      setHistory([{ t: 0, m: 1 }]);
      play(sound.liftoff);
    }
    function onTick(state) {
      setLive(state);
      syncRoundStart(state);
      if (state.multiplier > maxMultiplierRef.current) maxMultiplierRef.current = state.multiplier;
      seedMidRoundHistory(state);
      const t = roundStartRef.current ? Date.now() - roundStartRef.current : 0;
      setHistory((h) => [...h, { t, m: state.multiplier }]);
    }
    function onCrashed(state) {
      setLive(state);
      setJustCrashed(true);
      setTimeout(() => setJustCrashed(false), 500);
      if (myBetRef.current && !myBetRef.current.cashedOut) {
        play(sound.lose);
      } else {
        play(sound.bust);
      }
    }

    socket.on('crash:state', onState);
    socket.on('crash:waiting', onWaiting);
    socket.on('crash:running', onRunning);
    socket.on('crash:tick', onTick);
    socket.on('crash:crashed', onCrashed);
    return () => {
      socket.off('crash:state', onState);
      socket.off('crash:waiting', onWaiting);
      socket.off('crash:running', onRunning);
      socket.off('crash:tick', onTick);
      socket.off('crash:crashed', onCrashed);
    };
  }, [socket, muted]);

  // A short beep on each of the last 3 seconds of the betting countdown.
  // Guarded by lastCountdownTickRef so it fires once per second, not
  // once per 500ms re-render.
  useEffect(() => {
    if (live.phase !== 'waiting' || !live.phaseEndsAt) return;
    const secondsLeft = Math.max(0, Math.ceil((live.phaseEndsAt - Date.now()) / 1000));
    if (secondsLeft <= 3 && secondsLeft >= 1 && lastCountdownTickRef.current !== secondsLeft) {
      lastCountdownTickRef.current = secondsLeft;
      play(sound.countdownTick);
    }
  });

  async function placeBet() {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.crashBet(userId, solToLamports(wager));
      setMyBet({ wagerLamports: solToLamports(wager), cashedOut: false });
      onBalanceChange(res.newBalanceLamports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function cashout() {
    if (!myBet || myBet.cashedOut) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.crashCashout(userId);
      setMyBet((b) => ({ ...b, cashedOut: true, payoutLamports: res.payoutLamports, multiplier: res.multiplier }));
      onBalanceChange(res.newBalanceLamports);
      play(res.multiplier >= 5 ? sound.bigWin : sound.smallWin);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const phase = live.phase;
  const multiplier = live.multiplier || 1;
  const secondsLeft = live.phaseEndsAt ? Math.max(0, Math.ceil((live.phaseEndsAt - Date.now()) / 1000)) : null;

  // Build an auto-scaling SVG path from the tick history
  const maxM = Math.max(maxMultiplierRef.current, multiplier) * 1.15;
  const lastT = history.length ? history[history.length - 1].t : 1;
  const points = history.map((p) => {
    const x = lastT > 0 ? (p.t / lastT) * CHART_WIDTH : 0;
    const y = CHART_HEIGHT - (Math.log(p.m) / Math.log(Math.max(maxM, 1.01))) * CHART_HEIGHT;
    return `${x.toFixed(1)},${Math.max(0, y).toFixed(1)}`;
  });
  const pathD = points.length > 1 ? `M ${points.join(' L ')}` : '';
  const lastPoint = points.length ? points[points.length - 1].split(',').map(Number) : [0, CHART_HEIGHT];

  const canBet = phase === 'waiting' && !myBet;
  const canCashout = phase === 'running' && myBet && !myBet.cashedOut;

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Crash</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {live.playerCount || 0} in this round
          </span>
          <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => setMuted((m) => !m)}>
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      {live.recentCrashes?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {live.recentCrashes.map((m, i) => (
            <span
              key={i}
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 7px',
                borderRadius: 4,
                color: m >= 2 ? 'var(--positive)' : 'var(--negative)',
                background: m >= 2 ? 'var(--positive-dim)' : 'var(--negative-dim)',
              }}
            >
              {m.toFixed(2)}x
            </span>
          ))}
        </div>
      )}

      <div className={`crash-stage ${justCrashed ? 'crash-flash' : ''}`} style={{ marginTop: 16 }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none">
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke={phase === 'crashed' ? 'var(--negative)' : 'var(--positive)'}
              strokeWidth="3"
            />
          )}
        </svg>

        {phase === 'running' && points.length > 0 && (
          <span
            className="crash-rocket"
            style={{ position: 'absolute', left: lastPoint[0], top: lastPoint[1], transform: 'translate(-50%, -50%) rotate(45deg)' }}
          >
            🚀
          </span>
        )}
        {phase === 'crashed' && (
          <span
            className="crash-rocket crash-boom"
            style={{ position: 'absolute', left: lastPoint[0], top: lastPoint[1], transform: 'translate(-50%, -50%)' }}
          >
            💥
          </span>
        )}

        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            pointerEvents: 'none',
          }}
        >
          {phase === 'waiting' && (
            <>
              <div className="mono" style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                Next round in
              </div>
              <div className="mono crash-multiplier">{secondsLeft ?? '-'}s</div>
              {live.serverSeedHash && (
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, maxWidth: 300, textAlign: 'center', wordBreak: 'break-all' }}>
                  seed hash: {live.serverSeedHash.slice(0, 20)}…
                </div>
              )}
            </>
          )}
          {phase === 'running' && (
            <div className="mono crash-multiplier crash-live">{multiplier.toFixed(2)}x</div>
          )}
          {phase === 'crashed' && (
            <div className="mono crash-multiplier crash-dead">{multiplier.toFixed(2)}x</div>
          )}
        </div>
      </div>

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
            disabled={!canBet}
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8 }}>
            <QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={!canBet} />
          </div>
        </div>
      </div>

      {canBet && (
        <button
          className="btn btn-brand"
          style={{ width: '100%', marginTop: 16, padding: '12px' }}
          disabled={!userId || loading}
          onClick={placeBet}
        >
          {userId ? 'Place bet for next round' : 'Connect wallet to play'}
        </button>
      )}

      {phase !== 'waiting' && !myBet && (
        <div className="mono" style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          Betting opens when this round ends
        </div>
      )}

      {myBet && !myBet.cashedOut && phase === 'waiting' && (
        <div className="mono" style={{ marginTop: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
          Bet placed — waiting for round to start
        </div>
      )}

      {canCashout && (
        <button
          className="btn btn-positive"
          style={{ width: '100%', marginTop: 16, padding: '12px' }}
          disabled={loading}
          onClick={cashout}
        >
          Cash out at {multiplier.toFixed(2)}x
        </button>
      )}

      {myBet?.cashedOut && (
        <p className="mono" style={{ color: 'var(--positive)', fontSize: 13, marginTop: 12 }}>
          Cashed out at {myBet.multiplier?.toFixed(2)}x — {lamportsToSol(myBet.payoutLamports)} SOL
        </p>
      )}

      {myBet && !myBet.cashedOut && phase === 'crashed' && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          Round crashed at {multiplier.toFixed(2)}x — bet lost.
        </p>
      )}

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}
    </div>
  );
}