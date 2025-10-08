/* server.mjs — smooth trending dynamics, full drop-in */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

/* ---------- Bootstrapping / Static ---------- */
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

/* ---------- Game State ---------- */
let players = {};                   // id -> {name, position, avgPx, pnl}
let gameActive = false;
let paused = false;

let productName  = "Demo Asset";

/* Price & “fair” */
let fairValue    = 100;             // visible fair used for drift target
let fairTarget   = 100;             // where fair intends to go (news moves this instantly)
let currentPrice = 100;             // traded/visible price
let priceVel     = 0;               // small velocity for second-order feel

/* ---------- Ticks & Dynamics ---------- */
const TICK_MS                = 250;   // 4 Hz heartbeat
const PLAYERLIST_EVERY_N     = 2;     // leaderboard cadence
let tickCount                = 0;

// Fair eases toward fairTarget each tick (no step)
const FAIR_SMOOTH            = 0.12;  // fraction of (target - fair) per tick
const FAIR_MAX_STEP_PCT      = 0.010; // cap: +/-1% of current fair per tick

// Price dynamics: velocity toward fair + damping + noise (second-order)
const KP                     = 0.020; // acceleration gain toward fair
const DAMP                   = 0.15;  // velocity damping per tick
const VEL_CAP_PCT            = 0.004; // max |velocity| per tick as % of price
const NOISE_PCT              = 0.0015;// random jitter as % of price

/* ---------- Helpers ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// very light Gaussian-ish noise (Box–Muller)
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

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

/* ----- Smoother dynamics ----- */
// Fair eases toward its target; prevents immediate gaps
function stepFair() {
  const diff = fairTarget - fairValue;
  const step = clamp(
    diff * FAIR_SMOOTH,
    -Math.abs(fairValue) * FAIR_MAX_STEP_PCT,
     Math.abs(fairValue) * FAIR_MAX_STEP_PCT
  );
  fairValue = Math.max(0.01, fairValue + step);
}

// Second-order price: velocity toward fair + damping + noise
function stepPrice() {
  stepFair(); // update fair first for this tick

  const diff = fairValue - currentPrice;
  // acceleration toward fair + noise, with damping
  priceVel = (1 - DAMP) * priceVel
           + KP * diff
           + gauss() * (currentPrice * NOISE_PCT);

  // cap velocity magnitude per tick
  const maxVel = Math.abs(currentPrice) * VEL_CAP_PCT;
  priceVel = clamp(priceVel, -maxVel, maxVel);

  // integrate velocity
  currentPrice = Math.max(0.01, currentPrice + priceVel);
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Let the client know the phase & roster (client stays on name screen until it submits)
  socket.emit("phase", gameActive ? "running" : "lobby");
  socket.emit("playerList", publicPlayers());

  socket.on("join", (name, ack) => {
    const nm = String(name||"Player").trim() || "Player";
    // allow late join anytime; position starts flat
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

    // avg price logic (based on currentPrice)
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

    fairValue    = isFinite(+startPrice) ? +startPrice : 100;
    fairTarget   = fairValue;  // target = fair at start
    currentPrice = fairValue;  // seed traded price at start
    priceVel     = 0;          // reset momentum
    productName  = String(product||"Demo Asset");

    gameActive = true;
    paused = false;

    io.emit("gameStarted", { fairValue, productName, paused, price: currentPrice });
    io.emit("phase", "running");

    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!gameActive || paused) return;

      // smoother trending dynamics
      stepPrice();

      // PnL refresh
      recomputePnLAll();

      // broadcast price + fair
      io.emit("priceUpdate", { t: Date.now(), price: currentPrice, fair: fairValue });

      // push each player their own live stats (pos/pnl/avg)
      for (const [id, sock] of io.sockets.sockets) {
        const p = players[id];
        if (p) sock.emit("you", {
          position: p.position|0,
          pnl: +(p.pnl||0),
          avgCost: p.avgPx ?? 0
        });
      }

      // roster update (reduced cadence)
      tickCount++;
      if (tickCount % PLAYERLIST_EVERY_N === 0) broadcastRoster();

    }, TICK_MS);
  });

  // Pause / Resume (toggle)
  socket.on("pauseGame", () => {
    if (!gameActive) return;
    paused = !paused;
    io.emit("paused", paused);
  });

  // Restart -> clears everything and returns to lobby; everyone re-enters name
  socket.on("restartGame", () => {
    clearInterval(tickTimer);
    tickTimer = null;
    gameActive = false;
    paused = false;

    productName  = "Demo Asset";
    fairValue    = 100;
    fairTarget   = 100;
    currentPrice = 100;
    priceVel     = 0;

    players = {};
    io.emit("gameReset");          // clients go back to join screen
    io.emit("playerList", []);     // empty roster
    io.emit("phase", "lobby");
  });

  // Admin-only news with delta (positive or negative)
  socket.on("pushNews", ({ text, delta } = {}) => {
    if (!gameActive) return;
    const d = isFinite(+delta) ? +delta : 0;

    // Move the TARGET fair instantly; visible fair eases toward it (no snap)
    fairTarget = Math.max(0.01, fairTarget + d);

    io.emit("news", { text: String(text||""), delta: d, t: Date.now() });
  });

});

/* ---------- Start ---------- */
let tickTimer = null;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});
