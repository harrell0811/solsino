import { useState } from 'react';
import { api, solToLamports, lamportsToSol } from '../lib/api';
import QuickBetButtons from './QuickBetButtons';
import GameInfoBar from './GameInfoBar';
import { sound } from '../lib/sound';
// Mirrors SELECTION_FACTOR in server/routes/keno.js exactly — these are
// exact per-pick-count normalizing factors (solved via the real
// hypergeometric distribution) so every pick count lands at 95% RTP.
// This replaces a display-only bug where this file computed
// Math.max(0.35, (11 - picks.length) / 3) — the same broken formula
// that used to also drive the actual payout server-side, which
// produced real RTPs from 150% up to 352%. The backend is fixed now;
// this fixes the boost number shown to the player to match it.
const SELECTION_FACTOR = { 1: 3.8, 2: 1.9, 3: 1.2269, 4: 0.8659, 5: 0.6355, 6: 0.4756, 7: 0.3596, 8: 0.2735, 9: 0.2089, 10: 0.16 };
export default function KenoGame({ userId, balanceLamports, onBalanceChange, rtpInfo, onOpenFairness }) {
  const [picks, setPicks] = useState([]); const [wager, setWager] = useState('0.01'); const [result, setResult] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(null);
  const boardLocked = loading || Boolean(result);
  function toggle(n) { if (boardLocked) return; setPicks((p) => p.includes(n) ? p.filter((x) => x !== n) : p.length < 10 ? [...p, n] : p); }
  function clearBoard() { if (loading) return; setPicks([]); setResult(null); setError(null); }
  async function play() { if (!userId || !picks.length) return; setLoading(true); setError(null); setResult(null); try { sound.kenoDraw(); const res = await api.playKeno(userId, solToLamports(wager), picks); setTimeout(() => { setResult(res); onBalanceChange(res.newBalanceLamports); res.multiplier > 1 ? sound.bigWin() : res.multiplier === 1 ? sound.smallWin() : sound.lose(); }, 520); } catch (err) { setError(err.message); } finally { setTimeout(() => setLoading(false), 550); } }
  const boost = picks.length ? SELECTION_FACTOR[picks.length].toFixed(2) : '0.00';
  return <div className="panel keno-game"><GameInfoBar rtpInfo={rtpInfo} onOpenFairness={onOpenFairness} /><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 style={{ margin: 0, fontSize: 18 }}>Keno</h2><span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pick up to 10 numbers</span></div><div className="keno-boost">{picks.length ? `${picks.length} pick${picks.length === 1 ? '' : 's'} · ${boost}x multiplier boost` : 'Choose fewer numbers for a higher multiplier'}</div><div className={`keno-grid ${loading ? 'keno-drawing' : ''}`}>{Array.from({ length: 40 }, (_, i) => i + 1).map((n) => <button key={n} disabled={boardLocked} onClick={() => toggle(n)} className={`keno-number ${picks.includes(n) ? 'keno-picked' : ''} ${result?.drawn.includes(n) ? 'keno-drawn' : ''} ${result?.hits.includes(n) ? 'keno-hit' : ''}`}>{n}</button>)}</div>
    {result && <div className={`keno-result ${result.multiplier > 1 ? 'result-win' : 'result-lose'}`}>{result.hits.length} hit{result.hits.length === 1 ? '' : 's'} · {result.multiplier}x {Number(result.payoutLamports) > 0 && `· ${lamportsToSol(result.payoutLamports)} SOL`}</div>}
    <label className="field-label">Wager (SOL)</label><input type="number" min="0" step="0.001" value={wager} onChange={(e) => setWager(e.target.value)} style={{ width: '100%' }} /><div style={{ marginTop: 8 }}><QuickBetButtons wager={wager} setWager={setWager} balanceLamports={balanceLamports} disabled={loading} /></div><div className="keno-actions">{result ? (<><button className="btn" disabled={loading} onClick={clearBoard}>Clear board</button><button className="btn btn-brand" disabled={!userId || loading} onClick={play}>{loading ? 'Drawing…' : `Play again (${picks.length} number${picks.length === 1 ? '' : 's'})`}</button></>) : (<><button className="btn" disabled={loading || !picks.length} onClick={clearBoard}>Clear board</button><button className="btn btn-brand" disabled={!userId || !picks.length || loading} onClick={play}>{loading ? 'Drawing…' : `Draw ${picks.length || ''} number${picks.length === 1 ? '' : 's'}`}</button></>)}</div>{error && <p className="mono" style={{ color: 'var(--negative)', fontSize: 13 }}>{error}</p>}</div>;
}
