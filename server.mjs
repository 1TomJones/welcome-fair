/* server.mjs — smooth trending dynamics, full drop-in */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import {
  BotManager,
  PassiveMarketMakerBot,
  MomentumTraderBot,
  NewsReactorBot,
  NoiseTraderBot,
} from "./src/engine/botManager.js";
import { MarketEngine } from "./src/engine/marketEngine.js";

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
let gameActive = false;
let paused = false;

const engine = new MarketEngine();
const bots = new BotManager({ market: engine, logger: console });

function publicPlayers() {
  return engine.getPublicRoster();
}

function emitYou(socket) {
  const player = engine.getPlayer(socket.id);
  if (player) {
    socket.emit("you", {
      position: player.position|0,
      pnl: +(player.pnl || 0),
      avgCost: player.avgPrice,
    });
  }
}

function broadcastRoster() {
  io.emit("playerList", publicPlayers());
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Let the client know the phase & roster (client stays on name screen until it submits)
  socket.emit("phase", gameActive ? "running" : "lobby");
  socket.emit("playerList", publicPlayers());
  socket.emit("priceMode", engine.priceMode);

  socket.on("join", (name, ack) => {
    const nm = String(name||"Player").trim() || "Player";
    const player = engine.registerPlayer(socket.id, nm);
    broadcastRoster();

    if (ack) {
      ack({
        ok: true,
        phase: gameActive ? "running" : "lobby",
        productName: engine.getSnapshot().productName,
        fairValue: engine.fairValue,
        price: engine.currentPrice,
        paused
      });
    }
    if (player) emitYou(socket);
  });

  socket.on("disconnect", () => {
    engine.removePlayer(socket.id);
    broadcastRoster();
  });

  // Trades (only if running & not paused). Clamp exposure to [-5, +5]
  socket.on("trade", (dir) => {
    if (!gameActive || paused) return;
    const result = engine.processTrade(socket.id, dir);
    if (!result?.filled) return;

    const { player, side: tradeSide } = result;
    const next = player.position;
    const side = next > 0 ? "long" : next < 0 ? "short" : null;

    socket.emit("tradeMarker", { t: Date.now(), side: tradeSide, px: engine.currentPrice });
    socket.emit("avgUpdate", { avgPx: side ? player.avgPrice : null, side });
    emitYou(socket);
    broadcastRoster();
  });

  /* ----- Admin controls ----- */

  // Start new round (from lobby)
  socket.on("startGame", ({ startPrice, product } = {}) => {
    if (gameActive) return;

    engine.startRound({ startPrice, productName: product });
    engine.setPriceMode(engine.priceMode || engine.config.defaultPriceMode);
    bots.clear();
    [
      new PassiveMarketMakerBot({ id: "mm-core", market: engine }),
      new MomentumTraderBot({ id: "momenta", market: engine }),
      new NewsReactorBot({ id: "headline", market: engine }),
      new NoiseTraderBot({ id: "noise", market: engine }),
    ].forEach((bot) => bots.registerBot(bot));

    gameActive = true;
    paused = false;

    const snapshot = engine.getSnapshot();
    io.emit("gameStarted", {
      fairValue: snapshot.fairValue,
      productName: snapshot.productName,
      paused,
      price: snapshot.price,
      priceMode: snapshot.priceMode,
    });
    io.emit("priceMode", snapshot.priceMode);
    io.emit("phase", "running");

    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!gameActive || paused) return;

      const state = engine.stepTick();
      bots.tick(state);

      io.emit("priceUpdate", { t: Date.now(), price: state.price, fair: state.fairValue, priceMode: state.priceMode });

      for (const [, sock] of io.sockets.sockets) {
        emitYou(sock);
      }

      if (state.tickCount % engine.config.leaderboardInterval === 0) broadcastRoster();

    }, engine.config.tickMs);
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

    engine.reset();
    bots.clear();
    io.emit("gameReset");          // clients go back to join screen
    io.emit("playerList", []);     // empty roster
    io.emit("phase", "lobby");
    io.emit("priceMode", engine.priceMode);
  });

  // Admin-only news with delta (positive or negative)
  socket.on("pushNews", ({ text, delta } = {}) => {
    if (!gameActive) return;
    const d = isFinite(+delta) ? +delta : 0;

    engine.pushNews(d);

    io.emit("news", { text: String(text||""), delta: d, t: Date.now() });
  });

  socket.on("setPriceMode", ({ mode } = {}) => {
    const updated = engine.setPriceMode(mode);
    io.emit("priceMode", updated);
  });

});

/* ---------- Start ---------- */
let tickTimer = null;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});
