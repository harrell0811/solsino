/**
 * Small bar every game renders at its top: an RTP badge and a
 * "Provably Fair" button. RTP figures come from the backend
 * (/api/games/rtp, fetched once in pages/index.js) rather than being
 * hardcoded per-component, so there's exactly one place to update if
 * a payout table ever changes and exactly one place that could go
 * stale — not nine.
 */
export default function GameInfoBar({ rtpInfo, onOpenFairness }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
      }}
    >
      {rtpInfo && (
        <span
          className="mono"
          title={rtpInfo.note || undefined}
          style={{
            fontSize: 11,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
          }}
        >
          {rtpInfo.exact ? '' : '~'}
          {rtpInfo.rtp}% RTP
        </span>
      )}
      <button className="btn" style={{ fontSize: 11, padding: '4px 10px' }} onClick={onOpenFairness}>
        🎲 Provably Fair
      </button>
    </div>
  );
}
