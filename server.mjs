import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "public/assets")));
app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;

/* ---------- State ---------- */
let players = {};                   // id -> {name, position, avgPx, pnl}
let gameActive = false;
let paused = false;
let fairValue = 100;
let currentPrice = 100;             // NEW: actual traded/visible price drifts around fair
let productName = "Demo Asset";

let tickTimer = null;
const TICK_MS = 250;                // 4Hz heartbeat
const MEAN_REVERSION = 0.04;              // gentle pull toward fair each tick
const MAX_PCT_MOVE_PER_TICK = 0.003;      // cap move to ~0.3% per tick
const PLAYERLIST_EVERY_N = 2;             // send leaderboard every 2 ticks (2 Hz)
let tickCount = 0;

/* ---------- Helpers ---------- */
function publicPlayers() {
  return Object.values(players).map(p => ({
    name: p.name,
    position: p.position|0,
    pnl: +(p.pnl||0),
    avgCost: +(p.avgPx||0)
  }));
}
function broadcastRoster() {
  io.emit("playerList", publicPlayers());
}
function recomputePnLAll() {
  for (const p of Object.values(players)) {
    p.pnl = (currentPrice - (p.avgPx ?? currentPrice)) * p.position;
  }
}
function emitYou(socket) {
  const p = players[socket.id];
  if (p) socket.emit("you", {
    position: p.position|0,
    pnl: +(p.pnl||0),
    avgCost: p.avgPx ?? 0
  });
}

/* Mean-reverting price process around fairValue with noise.
   - Gentle pull toward fair (reversion)
   - Small noise ~ ±0.2% per tick
   - Naturally oscillates roughly within ±2% band over time */
function stepPrice() {
  // Gentle pull toward fair, capped per tick, plus small noise
  const diff = fairValue - currentPrice;
  const targetMove = MEAN_REVERSION * diff;
  const maxMove = Math.abs(currentPrice) * MAX_PCT_MOVE_PER_TICK;
  const pull = Math.max(-maxMove, Math.min(maxMove, targetMove));

  // Noise ~ ±0.12% of price per tick to keep it alive but not jittery
  const noise = (Math.random() - 0.5) * (currentPrice * 0.0012);

  currentPrice = Math.max(0.01, currentPrice + pull + noise);
}


/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Tell client current phase + roster (but client stays on name screen until join submit)
  socket.emit("phase", gameActive ? "running" : "lobby");
  socket.emit("playerList", publicPlayers());

  socket.on("join", (name, ack) => {
    const nm = String(name||"Player").trim() || "Player";
    // Allow late join anytime (your requirement); position starts flat.
    players[socket.id] = { name: nm, position: 0, avgPx: null, pnl: 0 };
    broadcastRoster();

    if (ack) {
      ack({
        ok: true,
        phase: gameActive ? "running" : "lobby",
        productName,
        fairValue,
        price: currentPrice,
        paused
      });
    }
    // immediately send the player's own snapshot
    emitYou(socket);
  });

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      delete players[socket.id];
      broadcastRoster();
    }
  });

  // Trades (only if running & not paused). Clamp exposure to [-5, +5]
  socket.on("trade", (dir) => {
    if (!gameActive || paused) return;
    const p = players[socket.id];
    if (!p) return;

    const before = p.position|0;
    const delta  = dir === "BUY" ? 1 : -1;
    const next   = Math.max(-5, Math.min(5, before + delta));
    if (next === before) return;

    // avg price logic (based on currentPrice, not fair)
    if ((before <= 0 && next > 0) || (before >= 0 && next < 0)) {
      // crossing zero => reset average
      p.avgPx = currentPrice;
    } else if ((before >= 0 && next > before) || (before <= 0 && next < before)) {
      // adding in same direction => running average
      p.avgPx = ( (p.avgPx ?? currentPrice) * Math.abs(before) + currentPrice * Math.abs(next - before) ) / Math.abs(next);
    } // reducing exposure keeps avg; at zero we reset above

    p.position = next;
    p.pnl = (currentPrice - (p.avgPx ?? currentPrice)) * p.position;

    // Confirm to that player only: marker + avg line update + you snapshot
    const side = next > 0 ? "long" : next < 0 ? "short" : null;
    socket.emit("tradeMarker", { t: Date.now(), side: delta>0?"BUY":"SELL", px: currentPrice });
    socket.emit("avgUpdate",  { avgPx: side ? p.avgPx : null, side });
    emitYou(socket);

    // Leaderboard refresh
    broadcastRoster();
  });

  /* ----- Admin controls ----- */

  // Start new round (from lobby)
  socket.on("startGame", ({ startPrice, product } = {}) => {
    if (gameActive) return;

    fairValue   = isFinite(+startPrice) ? +startPrice : 100;
    currentPrice = fairValue; // seed traded price at start
    productName = String(product||"Demo Asset");

    gameActive = true;
    paused = false;

    io.emit("gameStarted", { fairValue, productName, paused, price: currentPrice });
    io.emit("phase", "running");

    clearInterval(tickTimer);
   tickTimer = setInterval(() => {
  if (!gameActive || paused) return;

  tickCount++;           // <--- NEW
  stepPrice();
  recomputePnLAll();

  // Broadcast price to everyone
  io.emit("priceUpdate", { t: Date.now(), price: currentPrice, fair: fairValue });

  // Push each player their own stats
  for (const [id, sock] of io.sockets.sockets) {
    const p = players[id];
    if (p) {
      sock.emit("you", {
        position: p.position | 0,
        pnl: +(p.pnl || 0),
        avgCost: p.avgPx ?? 0
      });
    }
  }

  // 🔁 NEW: update leaderboard every 2 ticks (2 Hz) so admin sees live PnL
  if (tickCount % PLAYERLIST_EVERY_N === 0) {
    io.emit("playerList", publicPlayers());
  }

}, TICK_MS);
});

  // Pause / Resume (toggle)
  socket.on("pauseGame", () => {
    if (!gameActive) return;
    paused = !paused;
    io.emit("paused", paused);
  });

  // Restart -> clears everything and returns to lobby; everyone must re-join (enter name again)
  socket.on("restartGame", () => {
    clearInterval(tickTimer);
    tickTimer = null;
    gameActive = false;
    paused = false;
    fairValue = 100;
    currentPrice = 100;
    players = {};
    io.emit("gameReset");          // clients go back to join screen
    io.emit("playerList", []);     // empty roster
    io.emit("phase", "lobby");
  });

  // Admin-only news with delta (positive or negative)
  socket.on("pushNews", ({ text, delta } = {}) => {
    if (!gameActive) return;
    const d = isFinite(+delta) ? +delta : 0;
    // move FAIR instantly by Δ, but PRICE trends gradually via heartbeat
    fairValue = Math.max(0.01, fairValue + d);

    io.emit("news", { text: String(text||""), delta: d, t: Date.now() });
    // don't snap price; heartbeat will pull price toward new fair with noise
    // recompute PnL vs currentPrice (not fair) happens every tick already
  });

});

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});

