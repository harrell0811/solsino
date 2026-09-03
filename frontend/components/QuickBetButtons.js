import { lamportsToSol } from '../lib/api';

const BASE_BET_SOL = 0.01;

/**
 * Quick-set buttons next to a wager input:
 *  - 1/2: halves whatever's currently in the wager field
 *  - 2x: doubles whatever's currently in the wager field
 *  - Max: fills in the player's full available balance
 *  - Reset: resets to the base bet size (BASE_BET_SOL)
 * All are clamped to the current balance (when known) so they can
 * never suggest a wager the player can't actually afford.
 */
export default function QuickBetButtons({ wager, setWager, balanceLamports, disabled }) {
  const balanceSol = balanceLamports != null ? Number(lamportsToSol(balanceLamports)) : null;

  function clamp(value) {
    if (balanceSol == null) return value;
    return Math.min(value, balanceSol);
  }

  function half() {
    const current = Number(wager) || 0;
    setWager(clamp(current > 0 ? current / 2 : BASE_BET_SOL).toString());
  }

  function double() {
    const current = Number(wager) || 0;
    setWager(clamp(current > 0 ? current * 2 : BASE_BET_SOL).toString());
  }

  function max() {
    if (balanceSol == null) return;
    setWager(balanceSol.toString());
  }

  function reset() {
    setWager(clamp(BASE_BET_SOL).toString());
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button type="button" className="btn" disabled={disabled} onClick={half} style={{ flex: 1, fontSize: 12 }}>
        1/2
      </button>
      <button type="button" className="btn" disabled={disabled} onClick={double} style={{ flex: 1, fontSize: 12 }}>
        2x
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled || balanceSol == null}
        onClick={max}
        style={{ flex: 1, fontSize: 12 }}
      >
        Max
      </button>
      <button type="button" className="btn" disabled={disabled} onClick={reset} style={{ flex: 1, fontSize: 12 }}>
        Reset
      </button>
    </div>
  );
}
