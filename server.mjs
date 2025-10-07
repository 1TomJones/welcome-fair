// server/server.cjs
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// serve client
app.use(express.static(path.join(__dirname, "..", "client")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 4000;

// -------------------- GAME STATE --------------------
const state = {
  phase: "lobby",            // "lobby" | "running" | "ended"
  price: 100,
  fair: 100,
  tick: 0,
  players: {},               // id -> { id, name, position, avgCost, realized, pnl }
  newsIndex: 0,
  newsItems: [
    { text: "Strong sales trend supports fair value", drift: +0.10 },
    { text: "Supply concerns ease; fair value normalizes", drift: -0.05 },
    { text: "New product rumored; fair value lifts", drift: +0.12 },
    { text: "Profit-taking; fair value slips slightly", drift: -0.08 },
    { text: "Analyst upgrade boosts fair value", drift: +0.15 },
  ],
};

// helper: recompute PnL for one player
function recomputePnl(player) {
  const unreal = (state.price - player.avgCost) * player.position;
  player.pnl = player.realized + unreal;
}

// helper: broadcast game snapshot
function broadcastGame() {
  const snapshot = {
    phase: state.phase,
    tick: state.tick,
    price: state.price,
    fair: state.fair,
    news: state.newsItems[state.newsIndex]?.text || "",
    players: Object.fromEntries(
      Object.entries(state.players).map(([id, p]) => [
        id,
        { id, name: p.name, position: p.position, pnl: p.pnl }
      ])
    ),
  };
  io.emit("gameState", snapshot);
}

// -------------------- SOCKET IO --------------------
io.on("connection", (socket) => {
  console.log("[client] connected", socket.id);

  // send lobby snapshot / current phase on connect
  socket.emit("phase", state.phase);
  emitLobby();

  socket.on("join", (name) => {
    const player = state.players[socket.id] || {
      id: socket.id,
      name: String(name || "Player"),
      position: 0,
      avgCost: 0,
      realized: 0,
      pnl: 0,
    };
    state.players[socket.id] = player;
    emitLobby();
    if (state.phase !== "lobby") {
      // if joining late, send immediate game snapshot
      socket.emit("gameState", {
        phase: state.phase,
        tick: state.tick,
        price: state.price,
        fair: state.fair,
        news: state.newsItems[state.newsIndex]?.text || "",
        players: Object.fromEntries(
          Object.entries(state.players).map(([id, p]) => [
            id,
            { id, name: p.name, position: p.position, pnl: p.pnl }
          ])
        ),
      });
    }
  });

  socket.on("trade", (side) => {
    // side: +1 = buy 1 share, -1 = sell 1 share
    if (state.phase !== "running") return;
    const p = state.players[socket.id];
    if (!p) return;

    // position cap [-5, 5]
    const nextPos = p.position + side;
    if (nextPos > 5 || nextPos < -5) return;

    // fill at current price (market)
    const px = state.price;

    // If same-direction add, adjust avgCost
    if (p.position === 0) {
      p.position = side;
      p.avgCost = px;
    } else if (Math.sign(p.position) === Math.sign(side)) {
      // adding to same side
      const newPos = p.position + side;
      p.avgCost = (p.avgCost * Math.abs(p.position) + px * Math.abs(side)) / Math.abs(newPos);
      p.position = newPos;
    } else {
      // reducing or flipping
      const qty = Math.min(Math.abs(side), Math.abs(p.position)); // it's 1 anyway
      const realized = (px - p.avgCost) * (p.position > 0 ? qty : -qty);
      p.realized += realized;

      const after = p.position + side;
      if (after === 0) {
        p.position = 0;
        p.avgCost = 0;
      } else {
        // flipped; new avgCost becomes fill price
        p.position = after;
        p.avgCost = px;
      }
    }

    recomputePnl(p);
    broadcastGame();
  });

  socket.on("disconnect", () => {
    console.log("[client] disconnect", socket.id);
    delete state.players[socket.id];
    emitLobby();
  });
});

// Admin start
io.of("/").adapter.on("create-room", () => {});
io.of("/").adapter.on("join-room", () => {});

function emitLobby() {
  const list = Object.values(state.players).map(p => ({
    id: p.id, name: p.name, position: p.position, pnl: p.pnl
  }));
  io.emit("playerList", list);
}

io.on("connection", (socket) => {
  socket.on("startGame", () => {
    if (state.phase === "running") return;
    startGameLoop();
  });
});

function startGameLoop() {
  state.phase = "running";
  state.tick = 0;
  state.price = 100;
  state.fair = 100;
  state.newsIndex = 0;

  // reset players’ PnL/positions
  for (const p of Object.values(state.players)) {
    p.position = 0;
    p.avgCost = 0;
    p.realized = 0;
    p.pnl = 0;
  }

  broadcastGame();

  // Main game loop
  if (state._interval) clearInterval(state._interval);
  state._interval = setInterval(() => {
    if (state.phase !== "running") return;
    state.tick += 1;

    // every 10s, change fair via news
    if (state.tick % 10 === 0) {
      state.newsIndex = (state.newsIndex + 1) % state.newsItems.length;
      const d = state.newsItems[state.newsIndex].drift;
      state.fair += d * 10; // move fair a bit
    }

    // drift price toward fair + some noise
    const toward = (state.fair - state.price) * 0.08;
    const noise = (Math.random() - 0.5) * 0.6;
    state.price = Math.max(1, state.price + toward + noise);

    // recompute PnL for all
    for (const p of Object.values(state.players)) {
      recomputePnl(p);
    }

    broadcastGame();
  }, 1000);
}

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
