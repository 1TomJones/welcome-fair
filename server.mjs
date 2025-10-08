import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use("/assets", express.static(path.join(__dirname, "public/assets")));
app.get("/healthz", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;

// ===== GAME STATE =====
let players = {};
let gameActive = false;
let paused = false;
let fairValue = 100;
let productName = "Demo Asset";
let priceSeries = [];
let tickInterval = null;

// ===== SOCKET HANDLING =====
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("join", (name) => {
    if (gameActive) {
      socket.emit("waitingForRestart");
      return;
    }
    players[socket.id] = {
      name,
      position: 0,
      pnl: 0,
      avgPx: null,
    };
    io.emit("playerList", Object.values(players));
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerList", Object.values(players));
  });

  // === TRADING ===
  socket.on("trade", (dir) => {
    if (!gameActive || paused) return;
    const p = players[socket.id];
    if (!p) return;

    const before = p.position;
    const delta = dir === "BUY" ? 1 : -1;
    const next = Math.max(-5, Math.min(5, before + delta));
    if (next === before) return;

    // avg price calc
    if ((before <= 0 && next > 0) || (before >= 0 && next < 0)) {
      p.avgPx = fairValue;
    } else if ((before >= 0 && next > before) || (before <= 0 && next < before)) {
      p.avgPx =
        (p.avgPx * Math.abs(before) + fairValue * Math.abs(next - before)) /
        Math.abs(next);
    }

    p.position = next;
    p.pnl = (fairValue - (p.avgPx || fairValue)) * p.position;

    socket.emit("tradeMarker", { t: Date.now(), side: dir, px: fairValue });
    const side = next > 0 ? "long" : next < 0 ? "short" : null;
    socket.emit("avgUpdate", { avgPx: side ? p.avgPx : null, side });
    io.emit("playerList", Object.values(players));
  });

  // === ADMIN ===
  socket.on("startGame", ({ startPrice, product }) => {
    if (gameActive) return;
    fairValue = parseFloat(startPrice) || 100;
    productName = product || "Demo Asset";
    priceSeries = [{ t: Date.now(), p: fairValue }];
    gameActive = true;
    paused = false;
    io.emit("gameStarted", { fairValue, productName });
    tickInterval = setInterval(priceTick, 1000 / 4); // 4x faster ticks
  });

  socket.on("pauseGame", () => {
    paused = !paused;
    io.emit("paused", paused);
  });

  socket.on("restartGame", () => {
    resetGame();
  });

  socket.on("pushNews", (headline) => {
    io.emit("news", headline);
  });
});

// ====== PRICE UPDATE LOGIC ======
function priceTick() {
  if (!gameActive || paused) return;
  // random drift small
  const drift = (Math.random() - 0.5) * 0.6;
  fairValue = Math.max(10, fairValue + drift);
  priceSeries.push({ t: Date.now(), p: fairValue });
  io.emit("priceUpdate", { t: Date.now(), price: fairValue, fair: fairValue });
}

function resetGame() {
  clearInterval(tickInterval);
  gameActive = false;
  paused = false;
  priceSeries = [];
  fairValue = 100;
  io.emit("gameReset");
  players = {};
  io.emit("playerList", []);
}

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
