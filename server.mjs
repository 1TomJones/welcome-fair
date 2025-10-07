import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// serve static client
const pubDir = path.join(__dirname, "public");
console.log("[server] public dir =", pubDir, fs.existsSync(pubDir) ? "(exists)" : "(MISSING)");
app.use(express.static(pubDir));
app.get("/health", (req, res) => res.type("text/plain").send("OK"));
app.get("/", (req, res) => {
  const idx = path.join(pubDir, "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send("index.html not found");
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

/* ---------------- Game State ---------------- */

const TICK_MS = 250;                 // 4× faster than before
const BROADCAST_EVERY = 1;           // emit every tick (i.e., 4Hz). If heavy, set to 2 to emit every 2 ticks (~2Hz)
const DEFAULT_ROUND_SECONDS = 180;   // 3 minutes (tweak in admin Start input)
const NEWS_CADENCE_MS = 5000;        // every 5s a headline + fair drift

const state = {
  phase: "lobby",        // 'lobby' | 'running' | 'ended'
  price: 100,
  fair: 100,
  tick: 0,
  endsAt: 0,
  lastNewsAt: 0,
  newsIndex: -1,
  news: { text: "", sign: 0 },
  newsItems: [
    { text: "Solid data: fair value trending up",         sign: +1, dfair: +0.8 },
    { text: "Profit taking cools risk appetite",          sign: -1, dfair: -0.6 },
    { text: "Upgrade cycle continues; targets raised",    sign: +1, dfair: +0.7 },
    { text: "Cautious guidance trims near-term growth",   sign: -1, dfair: -0.5 },
    { text: "Flows balance: consolidation expected",      sign:  0, dfair:  0.0 }
  ],
  roundSeconds: DEFAULT_ROUND_SECONDS,
  players: {} // id -> { name, position, avgCost, realized, pnl }
};

function recomputePnl(p, price) {
  const unreal = (price - (p.avgCost || 0)) * (p.position || 0);
  p.pnl = (p.realized || 0) + unreal;
}

function timeLeftMs() {
  return Math.max(0, (state.endsAt || 0) - Date.now());
}

function snapshot() {
  // minimal payload at 4Hz
  const playersMin = {};
  for (const [id, p] of Object.entries(state.players)) {
    playersMin[id] = { name: p.name, position: p.position|0, pnl: +(p.pnl||0).toFixed(2) };
  }
  return {
    phase: state.phase,
    tick: state.tick,
    timeLeft: Math.ceil(timeLeftMs()/1000),
    price: +state.price.toFixed(2),
    fair: +state.fair.toFixed(2),
    news: state.news,            // {text, sign}
    players: playersMin
  };
}

function broadcast() { io.emit("gameState", snapshot()); }

function resetPlayers() {
  for (const p of Object.values(state.players)) {
    p.position = 0; p.avgCost = 0; p.realized = 0; p.pnl = 0;
  }
}

function stepPrice() {
  // drift toward fair + a bit of noise
  const toward = (state.fair - state.price) * 0.08;
  const noise  = (Math.random() - 0.5) * 0.8;   // slightly punchier at 4Hz
  state.price = Math.max(1, state.price + toward + noise);
  for (const p of Object.values(state.players)) recomputePnl(p, state.price);
}

function maybeNews(now) {
  if (now - state.lastNewsAt >= NEWS_CADENCE_MS) {
    state.newsIndex = (state.newsIndex + 1) % state.newsItems.length;
    const n = state.newsItems[state.newsIndex];
    state.fair += n.dfair;
    state.news = { text: n.text, sign: n.sign };
    state.lastNewsAt = now;
  }
}

/* ---------------- Sockets ---------------- */

io.on("connection", (socket) => {
  console.log("[io] connect", socket.id);
  socket.data.joined = false;
  socket.data.lastTradeAt = 0;

  // initial phase for client routing
  socket.emit("phase", state.phase);

  // send lobby roster (names) to admin dashboards
  function emitRoster() {
    const roster = Object.values(state.players).map(p => ({
      name: p.name, position: p.position|0, pnl: +(p.pnl||0).toFixed(2)
    }));
    io.emit("playerList", roster);
  }

  socket.on("join", (name, ack) => {
    if (!socket.data.joined) {
      socket.data.joined = true;
      state.players[socket.id] = state.players[socket.id] || {
        name: String(name || "Player"),
        position: 0, avgCost: 0, realized: 0, pnl: 0
      };
      recomputePnl(state.players[socket.id], state.price);
      emitRoster();
    }
    // Allow late-join: if game running, immediately send snapshot; client will show game view
    if (ack) ack({ ok: true, phase: state.phase });
    if (state.phase !== "lobby") socket.emit("gameState", snapshot());
  });

  socket.on("trade", (side) => {
    if (state.phase !== "running") return;
    const now = Date.now();
    if (now - socket.data.lastTradeAt < 120) return; // anti-spam
    socket.data.lastTradeAt = now;

    const p = state.players[socket.id]; if (!p) return;
    // max +/- 5
    const want = p.position + (side > 0 ? 1 : -1);
    if (want > 5 || want < -5) return;

    const px = state.price;
    if (p.position === 0) {
      p.position = (side > 0 ? 1 : -1);
      p.avgCost = px;
    } else if (Math.sign(p.position) === Math.sign(side)) {
      const newPos = p.position + (side > 0 ? 1 : -1);
      p.avgCost = (p.avgCost * Math.abs(p.position) + px) / Math.abs(newPos);
      p.position = newPos;
    } else {
      // reduce or flip
      const realized = (px - p.avgCost) * (p.position > 0 ? 1 : -1) * Math.min(1, Math.abs(1));
      p.realized += realized;
      const after = p.position + (side > 0 ? 1 : -1);
      if (after === 0) { p.position = 0; p.avgCost = 0; }
      else { p.position = after; p.avgCost = px; }
    }
    recomputePnl(p, state.price);
    // quick push (ok at 4Hz scale)
    broadcast();
  });

  // Admin controls
  socket.on("startGame", ({ seconds } = {}) => {
    // Anyone can call this for now; if you want a code, add a trivial check here
    state.roundSeconds = Math.max(30, Math.min(900, seconds || DEFAULT_ROUND_SECONDS));
    state.phase = "running";
    state.tick = 0;
    state.price = 100;
    state.fair = 100;
    state.newsIndex = -1;
    state.news = { text: "Session started", sign: 0 };
    state.lastNewsAt = 0;
    state.endsAt = Date.now() + state.roundSeconds * 1000;
    resetPlayers();
    if (state._timer) clearInterval(state._timer);
    let tickCountSinceBroadcast = 0;
    state._timer = setInterval(() => {
      state.tick++;
      stepPrice();
      maybeNews(Date.now());
      tickCountSinceBroadcast++;
      if (tickCountSinceBroadcast >= BROADCAST_EVERY) {
        tickCountSinceBroadcast = 0;
        broadcast();
      }
      if (timeLeftMs() <= 0) {
        clearInterval(state._timer); state._timer = null;
        state.phase = "ended";
        state.news = { text: "Round finished", sign: 0 };
        broadcast();
      }
    }, TICK_MS);

    // inform everyone (waiting room will switch to game)
    io.emit("phase", state.phase);
    broadcast();
  });

  socket.on("pushNews", ({ text, sign = 0, dfair = 0 } = {}) => {
    // Optional admin action; adjusts fair and headline
    state.fair += +dfair;
    state.news = { text: String(text || ""), sign: Math.sign(sign) };
    broadcast();
  });

  socket.on("disconnect", () => {
    delete state.players[socket.id];
    emitRoster();
  });
});

/* -------------- start -------------- */
const PORT = process.env.PORT || 4000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});





