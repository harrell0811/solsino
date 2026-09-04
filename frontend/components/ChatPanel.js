import { useEffect, useRef, useState } from 'react';

export default function ChatPanel({ socket, userId, username }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

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
            <span className="mono" style={{ color: 'var(--brand)' }}>
              {m.username || m.userId?.slice(0, 6) || 'anon'}
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
