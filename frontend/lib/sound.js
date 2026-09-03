/**
 * Tiny synthesized sound effects using the Web Audio API directly —
 * no audio files to host or license. Each function fires a short
 * envelope-shaped tone or chord. Safe to call even if the browser
 * blocks audio before a user gesture (wrapped in try/catch).
 */

let ctx = null;
function getCtx() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq, duration = 0.12, type = 'sine', gain = 0.15, delay = 0 }) {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const startAt = audioCtx.currentTime + delay;
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(gain, startAt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  } catch {
    // ignore — audio is a nice-to-have, never block gameplay on it
  }
}

export const sound = {
  reelTick: () => tone({ freq: 320, duration: 0.05, type: 'square', gain: 0.08 }),
  reelStop: () => tone({ freq: 180, duration: 0.09, type: 'triangle', gain: 0.12 }),
  smallWin: () => {
    [523, 659, 784].forEach((freq, i) => tone({ freq, duration: 0.15, delay: i * 0.06, gain: 0.12 }));
  },
  bigWin: () => {
    [523, 659, 784, 988, 1318].forEach((freq, i) =>
      tone({ freq, duration: 0.25, delay: i * 0.08, gain: 0.15, type: 'triangle' })
    );
  },
  bonusFanfare: () => {
    [392, 523, 659, 784, 1046, 784, 1046].forEach((freq, i) =>
      tone({ freq, duration: 0.2, delay: i * 0.1, gain: 0.14, type: 'sawtooth' })
    );
  },
  lose: () => tone({ freq: 140, duration: 0.2, type: 'sine', gain: 0.08 }),
};
