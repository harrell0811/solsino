import { useEffect, useState } from 'react';
import { api, lamportsToSol } from '../lib/api';

const TABS = ['Bets', 'Deposits', 'Withdrawals'];

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function StatusPill({ status }) {
  const color =
    status === 'confirmed' ? 'var(--positive)' : status === 'failed' ? 'var(--negative)' : 'var(--text-muted)';
  return (
    <span className="mono" style={{ fontSize: 11, color, textTransform: 'uppercase' }}>
      {status}
    </span>
  );
}

export default function ProfilePanel({ userId, walletAddress, displayName, onProfileUpdate, onClose }) {
  const [nameInput, setNameInput] = useState(displayName || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [tab, setTab] = useState('Bets');
  const [bets, setBets] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [totalWageredLamports, setTotalWageredLamports] = useState('0');
  const [betCount, setBetCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    setNameInput(displayName || '');
  }, [displayName]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    Promise.all([api.getUserBets(userId), api.getUserTransactions(userId)])
      .then(([betsRes, txRes]) => {
        if (cancelled) return;
        setBets(betsRes.bets);
        setDeposits(txRes.deposits);
        setWithdrawals(txRes.withdrawals);
        setTotalWageredLamports(txRes.totalWageredLamports);
        setBetCount(txRes.betCount);
      })
      .catch((err) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function saveProfile() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await api.updateProfile(userId, nameInput);
      onProfileUpdate?.(res.displayName);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '48px 16px',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Profile</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, wordBreak: 'break-all' }}>
          {walletAddress}
        </p>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
            Display name
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              maxLength={24}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Optional — shown instead of your wallet address"
              style={{ flex: 1 }}
            />
            <button className="btn btn-brand" disabled={saving} onClick={saveProfile}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {saved && (
            <p className="mono" style={{ fontSize: 12, color: 'var(--positive)', marginTop: 6 }}>
              Saved.
            </p>
          )}
          {saveError && (
            <p className="mono" style={{ fontSize: 12, color: 'var(--negative)', marginTop: 6 }}>
              {saveError}
            </p>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 24,
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total wagered</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
              {lamportsToSol(totalWageredLamports)} SOL
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total bets</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
              {betCount.toLocaleString()}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          {TABS.map((t) => (
            <button key={t} className={`btn ${tab === t ? 'btn-brand' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12 }}>
          {loading && (
            <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Loading…
            </p>
          )}
          {loadError && (
            <p className="mono" style={{ fontSize: 12, color: 'var(--negative)' }}>
              {loadError}
            </p>
          )}

          {!loading && !loadError && tab === 'Bets' && (
            <div>
              {bets.length === 0 && (
                <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No bets yet.
                </p>
              )}
              {bets.map((b) => (
                <div
                  key={b.id}
                  className="mono"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <span style={{ textTransform: 'capitalize', width: 70 }}>{b.game}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{formatDate(b.createdAt)}</span>
                  <span style={{ width: 90, textAlign: 'right' }}>{lamportsToSol(b.wagerLamports)} SOL</span>
                  <span
                    style={{
                      width: 50,
                      textAlign: 'right',
                      fontWeight: 600,
                      color: b.won ? 'var(--positive)' : 'var(--negative)',
                    }}
                  >
                    {b.won ? 'WIN' : 'LOSS'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!loading && !loadError && tab === 'Deposits' && (
            <div>
              {deposits.length === 0 && (
                <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No deposits yet.
                </p>
              )}
              {deposits.map((t) => (
                <div
                  key={t.id}
                  className="mono"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>{formatDate(t.createdAt)}</span>
                  <span>{lamportsToSol(t.amountLamports)} SOL</span>
                  <StatusPill status={t.status} />
                </div>
              ))}
            </div>
          )}

          {!loading && !loadError && tab === 'Withdrawals' && (
            <div>
              {withdrawals.length === 0 && (
                <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No withdrawals yet.
                </p>
              )}
              {withdrawals.map((t) => (
                <div
                  key={t.id}
                  className="mono"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>{formatDate(t.createdAt)}</span>
                  <span>{lamportsToSol(t.amountLamports)} SOL</span>
                  <StatusPill status={t.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
