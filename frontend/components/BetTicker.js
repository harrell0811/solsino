import { useEffect, useState } from 'react';
import { lamportsToSol } from '../lib/api';

export default function BetTicker({ socket }) {
  const [stats, setStats] = useState({ totalBets: 0, totalWageredLamports: '0' });
  const [recentBets, setRecentBets] = useState([]);

  useEffect(() => {
    if (!socket) return;
    function onStats(s) {
      setStats(s);
    }
    function onBet(bet) {
      setRecentBets((prev) => [bet, ...prev.slice(0, 9)]);
    }
    socket.on('stats', onStats);
    socket.on('bet:new', onBet);
    return () => {
      socket.off('stats', onStats);
      socket.off('bet:new', onBet);
    };
  }, [socket]);

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total bets</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
            {stats.totalBets.toLocaleString()}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total wagered</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
            {lamportsToSol(stats.totalWageredLamports)} SOL
          </div>
        </div>
      </div>

      {recentBets.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          {recentBets.map((bet, i) => {
            // Multiplier isn't sent as its own field (each game computes
            // it differently), but payout / wager gives the same number
            // for every game, win or lose, without the server needing to
            // agree on a shared "multiplier" concept.
            const wager = Number(bet.wagerLamports || 0);
            const payout = Number(bet.payoutLamports || 0);
            const multiplier = bet.won && wager > 0 ? payout / wager : null;

            return (
              <div
                key={i}
                className="mono"
                style={{
                  fontSize: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 0',
                  color: 'var(--text-muted)',
                }}
              >
                <span style={{ textTransform: 'capitalize' }}>{bet.game}</span>
                <span>{lamportsToSol(bet.wagerLamports)} SOL</span>
                {bet.won ? (
                  <span style={{ fontWeight: 600, color: 'var(--positive)', textAlign: 'right' }}>
                    +{lamportsToSol(bet.payoutLamports)} SOL
                    {multiplier !== null && (
                      <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontWeight: 400 }}>
                        {multiplier.toFixed(2)}x
                      </span>
                    )}
                  </span>
                ) : (
                  <span style={{ fontWeight: 600, color: 'var(--negative)' }}>LOSS</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
