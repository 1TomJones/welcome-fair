/* server.mjs — smooth trending dynamics, full drop-in */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { BotManager } from "./src/engine/botManager.js";
import { MarketEngine } from "./src/engine/marketEngine.js";
import { TickMetricsLogger } from "./src/engine/metricsLogger.js";

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
let tickTimer = null;
const chatHistory = [];
const MAX_CHAT = 120;
const newsSeries = {
  active: false,
  entries: [],
  minDelayMs: 15000,
  maxDelayMs: 45000,
  timeout: null,
  index: 0,
};

const engine = new MarketEngine();
const bots = new BotManager({ market: engine, logger: console });
const metricsLogger = new TickMetricsLogger({
  maxEntries: 4000,
  filePath: process.env.METRICS_LOG_PATH || path.join(__dirname, "logs", "tick-metrics.log"),
  rotateEvery: 20000,
});

bots.on("summary", (payload) => io.emit("botSummary", payload));
bots.on("decision", (payload) => io.emit("botDecision", payload));
bots.on("telemetry", (payload) => io.emit("botTelemetry", payload));

function restartTickTimer() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!gameActive || paused) return;

    const state = engine.stepTick();
    bots.tick(state);

    if (state?.metrics) {
      const entry = metricsLogger.record({ ...state.metrics, mode: engine.priceMode });
      if (entry) io.emit("tickMetrics", entry);
    }

    broadcastPriceSnapshot();
    broadcastBook();

    for (const [, sock] of io.sockets.sockets) {
      emitYou(sock);
      emitOrders(sock);
    }

    if (state.tickCount % engine.config.leaderboardInterval === 0) broadcastRoster();
  }, engine.config.tickMs);
}

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

function normalizeNewsEntry(entry = {}) {
  const delta = Number(entry?.delta);
  const sentimentRaw = Number(entry?.sentiment);
  const intensityRaw = Number(entry?.intensity);
  const halfLifeRaw = Number(entry?.halfLifeSec);
  return {
    text: String(entry?.text || ""),
    delta: Number.isFinite(delta) ? delta : 0,
    sentiment: Number.isFinite(sentimentRaw) ? sentimentRaw : Math.sign(delta || 0),
    intensity: Number.isFinite(intensityRaw) ? Math.max(0, intensityRaw) : Math.abs(delta || 0),
    halfLifeSec: Number.isFinite(halfLifeRaw) ? Math.max(1, halfLifeRaw) : 180,
  };
}

function applyNewsPayload(entry) {
  const payload = normalizeNewsEntry(entry);
  engine.pushNews(payload);
  io.emit("news", { ...payload, t: Date.now() });
}

function clearNewsSeriesTimer() {
  if (newsSeries.timeout) {
    clearTimeout(newsSeries.timeout);
    newsSeries.timeout = null;
  }
}

function nextSeriesDelay() {
  const min = Math.max(1000, newsSeries.minDelayMs || 1000);
  const max = Math.max(min, newsSeries.maxDelayMs || min);
  if (max === min) return min;
  return Math.floor(min + Math.random() * (max - min));
}

function scheduleNextNews() {
  clearNewsSeriesTimer();
  if (!newsSeries.active) return;
  if (!gameActive || paused) return;
  if (!newsSeries.entries.length) return;
  const delay = nextSeriesDelay();
  newsSeries.timeout = setTimeout(() => {
    if (!newsSeries.active) return;
    if (!gameActive || paused) {
      scheduleNextNews();
      return;
    }
    const entry = newsSeries.entries[newsSeries.index] || newsSeries.entries[0];
    newsSeries.index = (newsSeries.index + 1) % newsSeries.entries.length;
    applyNewsPayload(entry);
    scheduleNextNews();
  }, delay);
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

/* ---------- Admin API ---------- */
app.get("/api/bots", (_req, res) => {
  res.json(bots.getSummary());
});

app.get("/api/metrics", (_req, res) => {
  res.json({ ok: true, entries: metricsLogger.latest(360) });
});

app.get("/api/bots/:id", (req, res) => {
  const detail = bots.getDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ ok: false, message: "bot-not-found" });
    return;
  }
  res.json({ ok: true, bot: detail });
});

app.get("/api/admin/book", (req, res) => {
  const levels = Number.isFinite(+req.query.levels) ? Math.max(1, +req.query.levels) : 28;
  const book = engine.getOrderBookView(levels);
  res.json({ ok: true, book });
});

app.get("/api/admin/constraints", (_req, res) => {
  res.json({ ok: true, constraints: engine.getPlayerConstraints() });
});

app.patch("/api/admin/constraints", (req, res) => {
  const payload = req.body || {};
  const maxPosition = payload.maxPosition;
  const maxLoss = payload.maxLoss;
  const constraints = engine.setPlayerConstraints({ maxPosition, maxLoss });
  res.json({ ok: true, constraints });
});

app.get("/api/admin/tick", (_req, res) => {
  const tickMs = Number(engine.config.tickMs ?? 250);
  const ticksPerSecond = tickMs > 0 ? Number((1000 / tickMs).toFixed(2)) : null;
  res.json({ ok: true, tick: { tickMs, ticksPerSecond } });
});

app.patch("/api/admin/tick", (req, res) => {
  const payload = req.body || {};
  let tickMs = null;
  if (Number.isFinite(payload.tickMs)) {
    tickMs = Number(payload.tickMs);
  } else if (Number.isFinite(payload.ticksPerSecond)) {
    const tps = Number(payload.ticksPerSecond);
    tickMs = tps > 0 ? 1000 / tps : null;
  }
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    res.status(400).json({ ok: false, message: "invalid-tick-rate" });
    return;
  }
  const clamped = Math.max(20, Math.round(tickMs));
  engine.config.tickMs = clamped;
  if (gameActive) {
    restartTickTimer();
  }
  const ticksPerSecond = Number((1000 / clamped).toFixed(2));
  res.json({ ok: true, tick: { tickMs: clamped, ticksPerSecond } });
});

app.post("/api/bots/reload", (req, res) => {
  const payload = req.body;
  if (Array.isArray(payload?.configs) && payload.configs.length) {
    bots.loadConfig(payload.configs);
    res.json({ ok: true, source: "custom" });
    return;
  }
  bots.loadDefaultBots();
  res.json({ ok: true, source: "default" });
});

app.patch("/api/bots/:id", (req, res) => {
  const ok = bots.applyPatch(req.params.id, req.body || {});
  if (!ok) {
    res.status(404).json({ ok: false, message: "bot-not-found" });
    return;
  }
  res.json({ ok: true, bot: bots.getDetail(req.params.id) });
});

app.post("/api/bots/:id/toggle", (req, res) => {
  const enabled = req.body?.enabled !== false;
  const ok = bots.toggleBot(req.params.id, enabled);
  if (!ok) {
    res.status(404).json({ ok: false, message: "bot-not-found" });
    return;
  }
  res.json({ ok: true, bot: bots.getDetail(req.params.id) });
});

app.post("/api/scenarios/:name", (req, res) => {
  const result = bots.runScenario(req.params.name);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/book/levels/:price", (req, res) => {
  const price = Number(req.params.price);
  if (!Number.isFinite(price)) {
    res.status(400).json({ ok: false, message: "bad-price" });
    return;
  }
  const detail = engine.getLevelDetail(price);
  res.json({ ok: true, detail });
});

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // Let the client know the phase & roster (client stays on name screen until it submits)
  socket.emit("phase", gameActive ? "running" : "lobby");
  socket.emit("playerList", publicPlayers());
  socket.emit("priceMode", engine.priceMode);
  socket.emit("orderBook", engine.getOrderBookView(18));
  socket.emit("chatHistory", chatHistory);
  socket.emit("botSummary", bots.getSummary());

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
      queued: result.queued ?? null,
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

  socket.on("cancelAll", (ack) => {
    const result = engine.closeAllForPlayer(socket.id);
    if (!result?.ok) {
      ack?.(result ?? { ok: false, reason: "unknown" });
      return;
    }

    emitYou(socket);
    emitOrders(socket);
    broadcastBook();

    const fills = result.flatten?.fills ?? [];
    const executedQty = Math.abs(Number(result.flatten?.qty ?? 0));
    if (fills.length) {
      notifyParticipants([socket.id, ...fills.map((fill) => fill.ownerId)]);
    }
    if (fills.length || executedQty > 0) {
      broadcastRoster();
      broadcastPriceSnapshot();
    }

    ack?.({ ok: true, canceled: result.canceled, flatten: result.flatten });
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
  socket.on("startGame", ({ startPrice, product, bots: customBots } = {}) => {
    if (gameActive) return;

    engine.startRound({ startPrice, productName: product });
    engine.setPriceMode(engine.priceMode || engine.config.defaultPriceMode);
    if (Array.isArray(customBots) && customBots.length) {
      bots.loadConfig(customBots);
    } else {
      bots.loadDefaultBots();
    }
    bots.tick(engine.getSnapshot());

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

    if (newsSeries.active) {
      scheduleNextNews();
    }

    restartTickTimer();
  });

  // Pause / Resume (toggle)
  socket.on("pauseGame", () => {
    if (!gameActive) return;
    paused = !paused;
    io.emit("paused", paused);
    if (paused) {
      clearNewsSeriesTimer();
    } else if (newsSeries.active) {
      scheduleNextNews();
    }
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
    clearNewsSeriesTimer();
  });

  // Admin-only news with sentiment/intensity
  socket.on("pushNews", ({ text, delta, sentiment, intensity, halfLifeSec } = {}) => {
    if (!gameActive) return;
    applyNewsPayload({ text, delta, sentiment, intensity, halfLifeSec });
  });

  socket.on("startNewsSeries", ({ entries, minDelaySec, maxDelaySec } = {}, ack) => {
    if (!Array.isArray(entries) || !entries.length) {
      ack?.({ ok: false, message: "No series entries provided." });
      return;
    }
    const normalized = entries.map((entry) => normalizeNewsEntry(entry));
    const minDelay = Number(minDelaySec);
    const maxDelay = Number(maxDelaySec);
    if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay) || minDelay <= 0 || maxDelay <= 0) {
      ack?.({ ok: false, message: "Invalid delay settings." });
      return;
    }
    newsSeries.entries = normalized;
    newsSeries.index = 0;
    newsSeries.minDelayMs = minDelay * 1000;
    newsSeries.maxDelayMs = maxDelay * 1000;
    newsSeries.active = true;
    if (gameActive && !paused) {
      scheduleNextNews();
    }
    ack?.({ ok: true, message: "Series armed for random drops." });
  });

  socket.on("stopNewsSeries", (_payload, ack) => {
    newsSeries.active = false;
    clearNewsSeriesTimer();
    ack?.({ ok: true, message: "Series stopped." });
  });

  socket.on("setPriceMode", ({ mode } = {}) => {
    const updated = engine.setPriceMode(mode);
    io.emit("priceMode", updated);
    broadcastPriceSnapshot();
    broadcastBook();
  });

});

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Admin UI: /admin.html`);
});
