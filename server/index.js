require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const coinflipRoutes = require('./routes/coinflip');
const seedRoutes = require('./routes/seeds');
const walletRoutes = require('./routes/wallet');
const minesRoutes = require('./routes/mines');
const userRoutes = require('./routes/user');
const crashRoutes = require('./routes/crash');
const slotsRoutes = require('./routes/slots');
const adminRoutes = require('./routes/admin');
const crashEngine = require('./crashEngine');
const { startDepositWatcher } = require('./depositWatcher');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/games/coinflip', coinflipRoutes);
app.use('/api/seeds', seedRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/games/mines', minesRoutes);
app.use('/api/games/crash', crashRoutes);
app.use('/api/games/slots', slotsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const prisma = new PrismaClient();

// Running totals for the "total bets" ticker (swap for a Redis
// counter once you have multiple server instances)
let totalBetsCount = 0;
let totalWageredLamports = 0n;

crashEngine.init(io);

io.on('connection', (socket) => {
  socket.emit('stats', {
    totalBets: totalBetsCount,
    totalWageredLamports: totalWageredLamports.toString(),
  });
  // Late joiners get the current round's phase/multiplier immediately,
  // separate from the phase-transition events below, which only fire
  // on actual transitions.
  socket.emit('crash:state', crashEngine.getPublicState());

  socket.on('chat:message', async ({ userId, username, message }) => {
    if (!message || message.length > 300) return;

    // Anonymous / not-yet-connected spectators can still chat under
    // whatever name the client sent — there's no account to check.
    if (!userId) {
      io.emit('chat:message', { userId: null, username: username || 'anon', message, at: Date.now() });
      return;
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, walletAddress: true, chatBanned: true },
      });

      if (!user) return;
      if (user.chatBanned) {
        socket.emit('chat:error', { message: 'You have been banned from chat.' });
        return;
      }

      // Authoritative name comes from the account, not whatever the client
      // sent — otherwise anyone could type any display name into the
      // socket payload and impersonate another player in chat.
      const resolvedUsername = user.displayName || user.walletAddress.slice(0, 6);
      io.emit('chat:message', { userId, username: resolvedUsername, message, at: Date.now() });
    } catch (err) {
      console.error('chat:message error:', err);
    }
  });
});

/**
 * Call this from each game route after a bet resolves so the live
 * feed and total-bets ticker update in real time for everyone.
 */
function broadcastBet(bet) {
  totalBetsCount += 1;
  totalWageredLamports += BigInt(bet.wagerLamports);
  io.emit('bet:new', bet);
  io.emit('stats', {
    totalBets: totalBetsCount,
    totalWageredLamports: totalWageredLamports.toString(),
  });
}

const betEvents = require('./events');
betEvents.on('bet', broadcastBet);

module.exports = { app, server, io, broadcastBet };

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  startDepositWatcher();
}
