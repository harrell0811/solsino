import { useEffect, useState } from 'react';
import { api } from '../lib/api';

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

export default function FairnessPanel({ userId, onClose }) {
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [clientSeedInput, setClientSeedInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState(null);
  const [justRevealed, setJustRevealed] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  async function loadCurrent() {
    setLoading(true);
    setError(null);
    try {
      const cur = await api.getCurrentSeed(userId);
      setCurrent(cur);
      setClientSeedInput(cur.clientSeed);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!userId) return;
    loadCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function loadHistory() {
    setShowHistory(true);
    try {
      const res = await api.getSeedHistory(userId);
      setHistory(res.seedPairs);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRotate() {
    setRotating(true);
    setError(null);
    setJustRevealed(null);
    try {
      const res = await api.rotateSeed(userId, clientSeedInput.trim() || undefined);
      setJustRevealed({
        serverSeed: res.previousServerSeed,
        serverSeedHash: res.previousServerSeedHash,
      });
      await loadCurrent();
      if (showHistory) await loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setRotating(false);
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
        style={{ width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🎲 Provably fair</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          Coinflip, Mines, and Slots all use this same seed pair. Before you bet, the server
          commits to a secret <em>server seed</em> by showing you only its hash — it can't change
          that seed afterward without the hash no longer matching. Combined with your{' '}
          <em>client seed</em> and a per-bet nonce, every outcome is fully determined in advance
          and independently verifiable. (Crash uses its own separate per-round hash, shown at the
          top of the Crash board.)
        </p>

        {error && (
          <p className="mono" style={{ fontSize: 12, color: 'var(--negative)', marginTop: 8 }}>
            {error}
          </p>
        )}

        {loading && (
          <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            Loading…
          </p>
        )}

        {!loading && current && (
          <div style={{ marginTop: 16 }}>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Active server seed hash (commit) — nonce {current.nonce}
            </label>
            <div
              className="mono"
              style={{
                fontSize: 12,
                wordBreak: 'break-all',
                background: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
              }}
            >
              {current.serverSeedHash}
            </div>

            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', margin: '16px 0 6px' }}>
              Client seed
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={clientSeedInput}
                onChange={(e) => setClientSeedInput(e.target.value)}
                style={{ flex: 1 }}
                className="mono"
              />
              <button className="btn" onClick={() => setClientSeedInput(randomHex())}>
                Randomize
              </button>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Changing your client seed (or just clicking Randomize) rotates in a brand new server
              seed for future bets, and reveals the current one below so you can verify every bet
              made under it.
            </p>

            <button
              className="btn btn-brand"
              style={{ marginTop: 10, width: '100%' }}
              disabled={rotating}
              onClick={handleRotate}
            >
              {rotating ? 'Rotating…' : 'Save client seed & rotate'}
            </button>

            {justRevealed && (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--positive-dim)',
                  border: '1px solid var(--positive)',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--positive)', fontWeight: 600, marginBottom: 6 }}>
                  Previous seed revealed
                </div>
                <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', marginBottom: 4 }}>
                  seed: {justRevealed.serverSeed}
                </div>
                <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                  hash: {justRevealed.serverSeedHash}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          {!showHistory ? (
            <button className="btn" onClick={loadHistory}>
              View past revealed seeds
            </button>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Past revealed seeds</div>
              {history.length === 0 && (
                <p className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  None yet — rotate your seed at least once to build history.
                </p>
              )}
              {history.map((s, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    padding: '10px 0',
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
                    {formatDate(s.createdAt)} → revealed {formatDate(s.revealedAt)} · final nonce {s.finalNonce}
                  </div>
                  <div className="mono" style={{ wordBreak: 'break-all' }}>seed: {s.serverSeed}</div>
                  <div className="mono" style={{ wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                    hash: {s.serverSeedHash}
                  </div>
                  <div className="mono" style={{ wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                    client seed: {s.clientSeed}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
