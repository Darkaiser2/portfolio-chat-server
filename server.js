const express  = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: {
    origin: [
      'https://darkaiser2.github.io',
      /^http:\/\/localhost(:\d+)?$/
    ],
    methods: ['GET', 'POST']
  }
});

const PORT       = process.env.PORT || 3000;
const MAX_HISTORY = 50;
const history    = [];   // in-memory message log
let   userCount  = 0;

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, users: userCount }));

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomHandle() {
  const suffix = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `GHOST_${suffix}`;
}

function broadcast(event, data) {
  io.emit(event, data);
}

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  userCount++;
  socket.username   = randomHandle();
  socket.lastMsg    = 0;   // rate-limit timestamp

  // Send history and assigned username to the new connection
  socket.emit('history', history);
  socket.emit('assigned_username', socket.username);

  // Notify everyone of updated count and join event
  broadcast('user_count', userCount);
  broadcast('sys_msg', { text: `${socket.username} connected`, ts: Date.now() });

  // ── Rename ──
  socket.on('set_username', (raw) => {
    if (typeof raw !== 'string') return;
    const name = raw.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 16).toUpperCase();
    if (name.length < 2) return;
    const old = socket.username;
    socket.username = name;
    socket.emit('assigned_username', name);
    broadcast('sys_msg', { text: `${old} → ${name}`, ts: Date.now() });
  });

  // ── Message ──
  socket.on('message', (raw) => {
    if (typeof raw !== 'string') return;

    // Simple rate limit: 1 message per 500 ms
    const now = Date.now();
    if (now - socket.lastMsg < 500) return;
    socket.lastMsg = now;

    const text = raw.trim().substring(0, 200);
    if (!text) return;

    const msg = { user: socket.username, text, ts: now };
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    broadcast('message', msg);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    userCount = Math.max(0, userCount - 1);
    broadcast('user_count', userCount);
    broadcast('sys_msg', { text: `${socket.username} disconnected`, ts: Date.now() });
  });
});

httpServer.listen(PORT, () =>
  console.log(`[chat-server] Listening on port ${PORT}`)
);
