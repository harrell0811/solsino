import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { adminApi, lamportsToSol } from '../lib/api';

const STORAGE_KEY = 'solsino_admin_key';

function Kpi({ label, value, sub, color }) {
  return (
    <div className="panel">
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 24, fontWeight: 700, marginTop: 6, color: color || 'var(--text)' }}>
        {value}
      </div>
      {sub && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const [adminKey, setAdminKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [recentBets, setRecentBets] = useState([]);
  const [sweeps, setSweeps] = useState([]);
  const [error, setError] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState(null);
  const [banningUserId, setBanningUserId] = useState(null);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored) setAdminKey(stored);
  }, []);

  const loadAll = useCallback(
    async (key) => {
      try {
        const [s, u, b, sw] = await Promise.all([
          adminApi.stats(key),
          adminApi.users(key),
          adminApi.recentBets(key),
          adminApi.sweeps(key),
        ]);
        setStats(s);
        setUsers(u.users);
        setRecentBets(b.bets);
        setSweeps(sw.sweeps);
        setError(null);
      } catch (err) {
        setError(err.message);
        if (err.message.toLowerCase().includes('unauthorized')) {
          window.localStorage.removeItem(STORAGE_KEY);
          setAdminKey('');
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!adminKey) return;
    loadAll(adminKey);
    const id = setInterval(() => loadAll(adminKey), 15000);
    return () => clearInterval(id);
  }, [adminKey, loadAll]);

  function handleLogin(e) {
    e.preventDefault();
    if (!keyInput.trim()) return;
    window.localStorage.setItem(STORAGE_KEY, keyInput.trim());
    setAdminKey(keyInput.trim());
  }

  async function handleSweep() {
    if (!confirm('Sweep unswept house profit to the profit wallet now?')) return;
    setSweeping(true);
    setSweepResult(null);
    try {
      const res = await adminApi.sweepProfits(adminKey);
      setSweepResult(res);
      loadAll(adminKey);
    } catch (err) {
      setSweepResult({ error: err.message });
    } finally {
      setSweeping(false);
    }
  }

  async function handleToggleChatBan(user) {
    setBanningUserId(user.userId);
    try {
      if (user.chatBanned) {
        await adminApi.chatUnban(adminKey, user.userId);
      } else {
        await adminApi.chatBan(adminKey, user.userId);
      }
      await loadAll(adminKey);
    } catch (err) {
      setError(err.message);
    } finally {
      setBanningUserId(null);
    }
  }

  if (!adminKey) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Head>
          <title>Solsino admin</title>
        </Head>
        <form onSubmit={handleLogin} className="panel" style={{ width: 340 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Solsino admin</h2>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
            Admin key
          </label>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            style={{ width: '100%' }}
            placeholder="ADMIN_API_KEY"
            autoFocus
          />
          <button className="btn btn-brand" type="submit" style={{ width: '100%', marginTop: 16, padding: '12px' }}>
            Enter
          </button>
          {error && (
            <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginTop: 12 }}>
              {error}
            </p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <Head>
        <title>Solsino admin</title>
      </Head>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Solsino admin</h1>
        <button
          className="btn"
          onClick={() => {
            window.localStorage.removeItem(STORAGE_KEY);
            setAdminKey('');
          }}
        >
          Log out
        </button>
      </header>

      {error && (
        <p className="mono" style={{ color: 'var(--negative)', fontSize: 13, marginBottom: 16 }}>
          {error}
        </p>
      )}

      {stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
            <Kpi label="Gross house profit" value={`${lamportsToSol(stats.grossProfitLamports)} SOL`} color="var(--positive)" />
            <Kpi label="Unswept profit" value={`${lamportsToSol(stats.unsweptProfitLamports)} SOL`} />
            <Kpi label="Already swept" value={`${lamportsToSol(stats.totalSweptLamports)} SOL`} />
            <Kpi
              label="House wallet balance"
              value={stats.houseBalanceLamports ? `${lamportsToSol(stats.houseBalanceLamports)} SOL` : 'RPC unavailable'}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            <Kpi label="Owed to users" value={`${lamportsToSol(stats.totalOwedToUsersLamports)} SOL`} color="var(--negative)" />
            <Kpi label="Total wagered" value={`${lamportsToSol(stats.totalWageredLamports)} SOL`} />
            <Kpi label="Total paid out" value={`${lamportsToSol(stats.totalPaidOutLamports)} SOL`} />
            <Kpi label="Players / bets" value={`${stats.userCount} / ${stats.betCount}`} />
          </div>

          <div className="panel" style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Profit sweep</h2>
              <button className="btn btn-positive" onClick={handleSweep} disabled={sweeping}>
                {sweeping ? 'Sweeping…' : 'Sweep profits now'}
              </button>
            </div>
            {sweepResult && (
              <p className="mono" style={{ fontSize: 12, marginTop: 12, color: sweepResult.error ? 'var(--negative)' : 'var(--positive)' }}>
                {sweepResult.error
                  ? sweepResult.error
                  : sweepResult.swept === '0'
                  ? sweepResult.reason
                  : `Swept ${lamportsToSol(sweepResult.swept)} SOL — tx ${sweepResult.signature?.slice(0, 16)}…`}
              </p>
            )}
            {sweeps.length > 0 && (
              <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {sweeps.slice(0, 5).map((s) => (
                  <div key={s.id} className="mono" style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text-muted)' }}>
                    <span>{new Date(s.createdAt).toLocaleString()}</span>
                    <span>{lamportsToSol(s.amountLamports)} SOL</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel" style={{ marginBottom: 24 }}>
            <h2 style={{ margin: 0, fontSize: 16, marginBottom: 12 }}>Per-game breakdown</h2>
            <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '6px 0' }}>Game</th>
                  <th>Bets</th>
                  <th>Wagered</th>
                  <th>Paid out</th>
                  <th>Profit</th>
                </tr>
              </thead>
              <tbody>
                {stats.perGame.map((g) => (
                  <tr key={g.game} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 0', textTransform: 'capitalize' }}>{g.game}</td>
                    <td>{g.betCount}</td>
                    <td>{lamportsToSol(g.wageredLamports)} SOL</td>
                    <td>{lamportsToSol(g.paidOutLamports)} SOL</td>
                    <td style={{ color: Number(g.profitLamports) >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                      {lamportsToSol(g.profitLamports)} SOL
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div className="panel">
              <h2 style={{ margin: 0, fontSize: 16, marginBottom: 12 }}>Owed to users</h2>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="mono" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '6px 0' }}>Wallet</th>
                      <th>Balance owed</th>
                      <th>Chat</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.userId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 0' }}>
                          {u.displayName || `${u.walletAddress.slice(0, 6)}…${u.walletAddress.slice(-4)}`}
                        </td>
                        <td>{lamportsToSol(u.balanceLamports)} SOL</td>
                        <td style={{ color: u.chatBanned ? 'var(--negative)' : 'var(--positive)' }}>
                          {u.chatBanned ? 'Banned' : 'OK'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className={`btn ${u.chatBanned ? 'btn-positive' : 'btn-negative'}`}
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            disabled={banningUserId === u.userId}
                            onClick={() => handleToggleChatBan(u)}
                          >
                            {banningUserId === u.userId ? '…' : u.chatBanned ? 'Unban' : 'Ban'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel">
              <h2 style={{ margin: 0, fontSize: 16, marginBottom: 12 }}>Recent bets</h2>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {recentBets.map((b) => (
                  <div
                    key={b.id}
                    className="mono"
                    style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>
                      {b.game} · {b.walletAddress.slice(0, 6)}…
                    </span>
                    <span style={{ color: b.won ? 'var(--positive)' : 'var(--negative)' }}>
                      {b.won ? '+' : '-'}
                      {lamportsToSol(b.won ? b.payoutLamports : b.wagerLamports)} SOL
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
