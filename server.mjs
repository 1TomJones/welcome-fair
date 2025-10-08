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
let productName = "Demo Asset";
let tickTimer = null;
const TICK_MS = 250;                // heartbeat so chart advances in time (price is flat unless admin moves it)

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
function heartbeat() {
  if (!gameActive) return;
  // No random drift; price == fairValue unless admin pushes news
  io.emit("priceUpdate", { t: Date.now(), price: fairValue, fair: fairValue });
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Tell client which phase we are in
  socket.emit("phase", gameActive ? "running" : "lobby");

  socket.on("join", (name, ack) => {
    // During running rounds, we require re-login at next restart (your requirement)
    if (gameActive) {
      if (ack) ack({ ok: false, reason: "in_progress" });
      socket.emit("waitingForRestart");
      return;
    }
    const nm = String(name||"Player").trim() || "Player";
    players[socket.id] = { name: nm, position: 0, avgPx: null, pnl: 0 };
    broadcastRoster();
    if (ack) ack({ ok: true, phase: "lobby" });
  });

  socket.on("disconnect", () => {
    if (players[socket.id]) {
      delete players[socket.id];
      broadcastRoster();
    }
  });

  // Trades (only if running & not paused). We clamp to [-5, +5]
  socket.on("trade", (dir) => {
    if (!gameActive || paused) return;
    const p = players[socket.id];
    if (!p) return;

    const before = p.position|0;
    const delta  = dir === "BUY" ? 1 : -1;
    const next   = Math.max(-5, Math.min(5, before + delta));
    if (next === before) return;

    // avg price logic
    if ((before <= 0 && next > 0) || (before >= 0 && next < 0)) {
      // crossing zero => reset average
      p.avgPx = fairValue;
    } else if ((before >= 0 && next > before) || (before <= 0 && next < before)) {
      // adding in same direction => running average
      p.avgPx = ( (p.avgPx ?? fairValue) * Math.abs(before) + fairValue * Math.abs(next - before) ) / Math.abs(next);
    } else {
      // reducing exposure: keep avg; at zero we would have reset above
    }

    p.position = next;
    p.pnl = (fairValue - (p.avgPx ?? fairValue)) * p.position;

    // Confirm to that player only: marker + avg line update
    const side = next > 0 ? "long" : next < 0 ? "short" : null;
    socket.emit("tradeMarker", { t: Date.now(), side: delta>0?"BUY":"SELL", px: fairValue });
    socket.emit("avgUpdate", { avgPx: side ? p.avgPx : null, side });

    // Leaderboard refresh
    broadcastRoster();
  });

  /* ----- Admin controls ----- */

  // Start new round (from lobby)
  socket.on("startGame", ({ startPrice, product } = {}) => {
    if (gameActive) return;
    fairValue   = isFinite(+startPrice) ? +startPrice : 100;
    productName = String(product||"Demo Asset");

    gameActive = true;
    paused = false;

    io.emit("gameStarted", { fairValue, productName });
    io.emit("phase", "running");

    // Start heartbeat timer for chart time
    clearInterval(tickTimer);
    tickTimer = setInterval(heartbeat, TICK_MS);
  });

  // Pause / Resume (toggle)
  socket.on("pauseGame", () => {
    if (!gameActive) return;
    paused = !paused;
    io.emit("paused", paused);
  });

  // Restart -> clears everything and returns to lobby, forcing re-join
  socket.on("restartGame", () => {
    clearInterval(tickTimer);
    tickTimer = null;
    gameActive = false;
    paused = false;
    fairValue = 100;
    players = {};
    io.emit("gameReset");          // clients reload or return to join
    io.emit("playerList", []);     // empty roster
    io.emit("phase", "lobby");
  });

  // Admin-only news with delta (positive or negative)
  socket.on("pushNews", ({ text, delta } = {}) => {
    if (!gameActive) return;
    const d = isFinite(+delta) ? +delta : 0;
    fairValue = Math.max(0.01, fairValue + d); // prevent negative/zero

    io.emit("news", { text: String(text||""), delta: d, t: Date.now() });
    // Immediately broadcast price move
    io.emit("priceUpdate", { t: Date.now(), price: fairValue, fair: fairValue });
    // Recompute PnL for leaderboard
    for (const p of Object.values(players)) {
      p.pnl = (fairValue - (p.avgPx ?? fairValue)) * p.position;
    }
    broadcastRoster();
  });

});

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});
