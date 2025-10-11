/* server.mjs — smooth trending dynamics, full drop-in */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import * as BotModules from "./src/engine/botManager.js";
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
const chatHistory = [];
const MAX_CHAT = 120;

const {
  BotManager: TradingBotManager,
  PassiveMarketMakerBot,
  MomentumTraderBot,
  NewsReactorBot,
  NoiseTraderBot,
} = BotModules;

const engine = new MarketEngine();
const bots = new TradingBotManager({ market: engine, logger: console });

function publicPlayers() {
  return engine.getPublicRoster();
}

function emitYou(socket) {
  const player = engine.getPlayer(socket.id);
  if (player) {
    socket.emit("you", {
      position: Number((player.position ?? 0).toFixed(2)),
      pnl: Number((player.pnl || 0).toFixed(2)),
      avgCost: player.avgPrice,
    });
  }
}

function emitOrders(socket) {
  const orders = engine.getPlayerOrders(socket.id);
  socket.emit("openOrders", orders);
}

function broadcastRoster() {
  io.emit("playerList", publicPlayers());
}

function broadcastBook(levels = 18) {
  const bookView = engine.getOrderBookView(levels);
  if (bookView) {
    io.emit("orderBook", bookView);
  }
}

function broadcastPriceSnapshot() {
  const snapshot = engine.getSnapshot();
  io.emit("priceUpdate", {
    t: Date.now(),
    price: snapshot.price,
    fair: snapshot.fairValue,
    priceMode: snapshot.priceMode,
  });
}

function notifyParticipants(ids = []) {
  const unique = new Set(ids.filter(Boolean));
  for (const id of unique) {
    const client = io.sockets.sockets.get(id);
    if (client) {
      emitYou(client);
      emitOrders(client);
    }
  }
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Let the client know the phase & roster (client stays on name screen until it submits)
  socket.emit("phase", gameActive ? "running" : "lobby");
  socket.emit("playerList", publicPlayers());
  socket.emit("priceMode", engine.priceMode);
  socket.emit("orderBook", engine.getOrderBookView(18));
  socket.emit("chatHistory", chatHistory);

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
        paused,
        orders: engine.getPlayerOrders(socket.id),
      });
    }
    if (player) {
      emitYou(socket);
      emitOrders(socket);
    }
  });

  socket.on("disconnect", () => {
    engine.removePlayer(socket.id);
    broadcastRoster();
    broadcastBook();
  });

  // Trades (only if running & not paused). Clamp exposure to [-5, +5]
  socket.on("trade", (dir) => {
    if (!gameActive || paused) return;
    const result = engine.processTrade(socket.id, dir);
    if (!result?.filled) return;

    const { side: tradeSide, qty } = result;
    const execPrice = result.fills?.at(-1)?.price ?? result.price ?? engine.currentPrice;

    socket.emit("tradeMarker", { t: Date.now(), side: tradeSide, px: execPrice, qty });
    emitYou(socket);

    const participants = [socket.id, ...(result.fills ?? []).map((f) => f.ownerId)];
    notifyParticipants(participants);
    broadcastRoster();
    broadcastPriceSnapshot();
    broadcastBook();
  });

  socket.on("submitOrder", (order, ack) => {
    if (!gameActive || paused) {
      ack?.({ ok: false, reason: "not-active" });
      return;
    }
    const result = engine.submitOrder(socket.id, order);
    if (!result?.ok) {
      ack?.(result ?? { ok: false, reason: "unknown" });
      return;
    }

    emitYou(socket);
    emitOrders(socket);

    const participants = [socket.id, ...(result.fills ?? []).map((f) => f.ownerId)];
    notifyParticipants(participants);
    broadcastRoster();
    broadcastPriceSnapshot();
    broadcastBook();

    ack?.({
      ok: true,
      type: result.type,
      filled: result.filled,
      price: result.price,
      resting: result.resting,
      side: result.side,
    });
  });

  socket.on("cancelOrders", (ids, ack) => {
    const canceled = engine.cancelOrders(socket.id, Array.isArray(ids) ? ids : undefined);
    if (canceled.length) {
      emitOrders(socket);
      broadcastBook();
    }
    ack?.({ ok: true, canceled });
  });

  socket.on("chatMessage", (payload, ack) => {
    const text = String(payload?.text ?? "").trim();
    if (!text) {
      ack?.({ ok: false, reason: "empty" });
      return;
    }
    const player = engine.getPlayer(socket.id);
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: player?.name ?? "Player",
      text: text.slice(0, 240),
      t: Date.now(),
    };
    chatHistory.push(message);
    while (chatHistory.length > MAX_CHAT) chatHistory.shift();
    io.emit("chatMessage", message);
    ack?.({ ok: true });
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
    broadcastPriceSnapshot();
    broadcastBook();
    io.emit("phase", "running");

    for (const [, sock] of io.sockets.sockets) {
      emitYou(sock);
      emitOrders(sock);
    }

    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!gameActive || paused) return;

      const state = engine.stepTick();
      bots.tick(state);

      broadcastPriceSnapshot();
      broadcastBook();

      for (const [, sock] of io.sockets.sockets) {
        emitYou(sock);
        emitOrders(sock);
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
    broadcastBook();
    broadcastPriceSnapshot();
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
    broadcastPriceSnapshot();
    broadcastBook();
  });

});

/* ---------- Start ---------- */
let tickTimer = null;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});
