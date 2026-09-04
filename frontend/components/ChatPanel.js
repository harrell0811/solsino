import { useEffect, useRef, useState } from 'react';
import { api, lamportsToSol } from '../lib/api';

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Small hover card showing a chat participant's public stats. Fetches
 * lazily on first hover and caches per userId (via the statsCache ref
 * passed down from ChatPanel) so re-hovering the same name doesn't
 * refire the request every time.
 */
function UserStatsPopover({ userId, statsCache }) {
  const [stats, setStats] = useState(statsCache.current[userId] || null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!userId || stats) return;
    let cancelled = false;
    api
      .getPublicStats(userId)
      .then((res) => {
        if (cancelled) return;
        statsCache.current[userId] = res;
        setStats(res);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div
      className="panel"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 6,
        width: 200,
        padding: 12,
        zIndex: 20,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      {error && (
        <p className="mono" style={{ fontSize: 11, color: 'var(--negative)', margin: 0 }}>
          {error}
        </p>
      )}
      {!stats && !error && (
        <p className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
          Loading…
        </p>
      )}
      {stats && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{stats.displayName}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Wagered</span>
            <span className="mono">{lamportsToSol(stats.totalWageredLamports)} SOL</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Net profit</span>
            <span
              className="mono"
              style={{ color: Number(stats.netProfitLamports) >= 0 ? 'var(--positive)' : 'var(--negative)' }}
            >
              {Number(stats.netProfitLamports) >= 0 ? '+' : ''}
              {lamportsToSol(stats.netProfitLamports)} SOL
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-muted)' }}>Bets placed</span>
            <span className="mono">{stats.betCount}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--text-muted)' }}>Member since</span>
            <span className="mono">{formatDate(stats.memberSince)}</span>
          </div>
        </>
      )}
    </div>
  );
}

export default function ChatPanel({ socket, userId, username }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);
  const [hoveredUserId, setHoveredUserId] = useState(null);
  const scrollRef = useRef(null);
  const statsCache = useRef({});

  // Load recent history once on mount so the panel isn't empty on
  // every fresh page load — previously chat only ever showed messages
  // sent after you happened to be connected.
  useEffect(() => {
    api
      .getChatHistory()
      .then((res) => setMessages(res.messages))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return;
    function onMessage(msg) {
      setMessages((prev) => [...prev.slice(-49), msg]);
    }
    function onError(err) {
      setError(err.message);
    }
    socket.on('chat:message', onMessage);
    socket.on('chat:error', onError);
    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:error', onError);
    };
  }, [socket]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function send() {
    if (!input.trim() || !socket) return;
    setError(null);
    socket.emit('chat:message', { userId: userId || null, username: username || 'anon', message: input.trim() });
    setInput('');
  }

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', height: 320 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Chat</h2>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', marginTop: 12, marginBottom: 12 }}>
        {messages.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No messages yet.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ fontSize: 13, marginBottom: 6, lineHeight: 1.4 }}>
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <span
                className="mono"
                style={{ color: 'var(--brand)', cursor: m.userId ? 'pointer' : 'default' }}
                onMouseEnter={() => m.userId && setHoveredUserId(m.userId)}
                onMouseLeave={() => setHoveredUserId(null)}
              >
                {m.username || m.userId?.slice(0, 6) || 'anon'}
              </span>
              {hoveredUserId === m.userId && m.userId && (
                <UserStatsPopover userId={m.userId} statsCache={statsCache} />
              )}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>: </span>
            <span>{m.message}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Say something…"
          style={{ flex: 1, fontFamily: 'Inter, sans-serif' }}
          maxLength={300}
        />
        <button className="btn" onClick={send}>
          Send
        </button>
      </div>
      {error && (
        <p className="mono" style={{ fontSize: 11, color: 'var(--negative)', marginTop: 6, marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}