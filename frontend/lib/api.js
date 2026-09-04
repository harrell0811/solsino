const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function adminRequest(path, adminKey, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

export const api = {
  connectUser: (walletAddress) =>
    request('/api/user/connect', {
      method: 'POST',
      body: JSON.stringify({ walletAddress }),
    }),

  getUser: (userId) => request(`/api/user/${userId}`),

  updateProfile: (userId, displayName) =>
    request(`/api/user/${userId}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),

  getUserBets: (userId) => request(`/api/user/${userId}/bets`),

  getUserTransactions: (userId) => request(`/api/user/${userId}/transactions`),

  getPublicStats: (userId) => request(`/api/user/${userId}/public-stats`),

  getChatHistory: () => request('/api/chat/recent'),

  getCurrentSeed: (userId) => request(`/api/seeds/current?userId=${userId}`),

  getSeedHistory: (userId) => request(`/api/seeds/history?userId=${userId}`),

  rotateSeed: (userId, clientSeed) =>
    request('/api/seeds/rotate', {
      method: 'POST',
      body: JSON.stringify({ userId, clientSeed }),
    }),

  depositInfo: (userId) => request(`/api/wallet/deposit-info?userId=${userId}`),

  withdraw: (userId, amountLamports) =>
    request('/api/wallet/withdraw', {
      method: 'POST',
      body: JSON.stringify({ userId, amountLamports }),
    }),

  startCoinflip: (userId, wagerLamports, choice) =>
    request('/api/games/coinflip/start', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports, choice }),
    }),

  flipCoinflip: (userId, roundId, choice) =>
    request('/api/games/coinflip/flip', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId, choice }),
    }),

  cashoutCoinflip: (userId, roundId) =>
    request('/api/games/coinflip/cashout', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId }),
    }),

  startMines: (userId, wagerLamports, mineCount) =>
    request('/api/games/mines/start', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports, mineCount }),
    }),

  revealMines: (userId, roundId, tile) =>
    request('/api/games/mines/reveal', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId, tile }),
    }),

  cashoutMines: (userId, roundId) =>
    request('/api/games/mines/cashout', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId }),
    }),

  betLimbo: (userId, wagerLamports, targetMultiplier) =>
    request('/api/games/limbo/bet', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports, targetMultiplier }),
    }),

  startDragonTower: (userId, wagerLamports, difficulty) =>
    request('/api/games/dragontower/start', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports, difficulty }),
    }),

  revealDragonTower: (userId, roundId, tile) =>
    request('/api/games/dragontower/reveal', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId, tile }),
    }),

  cashoutDragonTower: (userId, roundId) =>
    request('/api/games/dragontower/cashout', {
      method: 'POST',
      body: JSON.stringify({ userId, roundId }),
    }),

  crashState: () => request('/api/games/crash/state'),

  crashBet: (userId, wagerLamports) =>
    request('/api/games/crash/bet', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports }),
    }),

  crashCashout: (userId) =>
    request('/api/games/crash/cashout', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  spinSlots: (userId, wagerLamports) =>
    request('/api/games/slots/spin', {
      method: 'POST',
      body: JSON.stringify({ userId, wagerLamports }),
    }),

  dealBlackjack: (userId, wagerLamports) =>
    request('/api/games/blackjack/deal', { method: 'POST', body: JSON.stringify({ userId, wagerLamports }) }),
  hitBlackjack: (userId, gameId) =>
    request('/api/games/blackjack/hit', { method: 'POST', body: JSON.stringify({ userId, gameId }) }),
  standBlackjack: (userId, gameId) =>
    request('/api/games/blackjack/stand', { method: 'POST', body: JSON.stringify({ userId, gameId }) }),
  playKeno: (userId, wagerLamports, picks) =>
    request('/api/games/keno/play', { method: 'POST', body: JSON.stringify({ userId, wagerLamports, picks }) }),
};

export const adminApi = {
  stats: (adminKey) => adminRequest('/api/admin/stats', adminKey),
  users: (adminKey) => adminRequest('/api/admin/users', adminKey),
  recentBets: (adminKey) => adminRequest('/api/admin/bets/recent', adminKey),
  sweeps: (adminKey) => adminRequest('/api/admin/sweeps', adminKey),
  sweepProfits: (adminKey) =>
    adminRequest('/api/wallet/sweep-profits', adminKey, { method: 'POST' }),
  chatBan: (adminKey, userId) =>
    adminRequest(`/api/admin/users/${userId}/chat-ban`, adminKey, { method: 'POST' }),
  chatUnban: (adminKey, userId) =>
    adminRequest(`/api/admin/users/${userId}/chat-unban`, adminKey, { method: 'POST' }),
};

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function solToLamports(sol) {
  return Math.floor(Number(sol) * LAMPORTS_PER_SOL).toString();
}

export function lamportsToSol(lamports) {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}
