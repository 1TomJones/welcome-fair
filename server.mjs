import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// -------- paths / app ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// serve static client from /public
const pubDir = path.join(__dirname, "public");
app.use(express.static(pubDir));

// simple health
app.get("/health", (req, res) => res.type("text/plain").send("OK"));

// -------- http + sockets --------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

// ------ game state (minimal working loop) ------
const state = {
  phase: "lobby",
  price: 100,
  fair: 100,
  tick: 0,
  players: {}, // id -> { name, position, avgCost, realized, pnl }
  newsIndex: 0,
  newsItems: [
    { text: "Stronger outlook lifts fair value", drift: +0.12 },
    { text: "Profit taking cools momentum", drift: -0.06 },
    { text: "Upgrade: analysts raise targets", drift: +0.10 },
    { text: "Guidance trims near-term growth", drift: -0.07 }
  ]
};

function recomputePnl(p) {
  const unreal = (state.price - p.avgCost) * p.position;
  p.pnl = p.realized + unreal;
}
function snapshot() {
  return {
    phase: state.phase,
    tick: state.tick,
    price: state.price,
    fair: state.fair,
    news: state.newsItems[state.newsIndex]?.text || "",
    players: Object.fromEntries(Object.entries(state.players).map(([id,p]) => [
      id, { name: p.name, position: p.position, pnl: p.pnl }
    ]))
  };
}
function broadcast() { io.emit("gameState", snapshot()); }

// sockets
io.on("connection", socket => {
  console.log("[io] connect", socket.id);
  socket.data.joined = false;
  socket.data.lastTradeAt = 0;

  socket.emit("phase", state.phase);

  socket.on("join", (name, ack) => {
    if (socket.data.joined) { ack && ack({ ok:true, already:true }); return; }
    socket.data.joined = true;

    const player = state.players[socket.id] || {
      name: String(name || "Player"),
      position: 0, avgCost: 0, realized: 0, pnl: 0
    };
    state.players[socket.id] = player;

    ack && ack({ ok: true });
    io.emit("playerList", Object.values(state.players).map(p => ({
      name: p.name, position: p.position, pnl: p.pnl
    })));

    if (state.phase !== "lobby") socket.emit("gameState", snapshot());
  });

  socket.on("trade", side => {
    if (state.phase !== "running") return;
    const now = Date.now();
    if (now - socket.data.lastTradeAt < 120) return; // cooldown
    socket.data.lastTradeAt = now;

    const p = state.players[socket.id];
    if (!p) return;

    const next = p.position + (side > 0 ? 1 : -1);
    if (next > 5 || next < -5) return;

    const px = state.price;
    if (p.position === 0) {
      p.position = side > 0 ? 1 : -1;
      p.avgCost = px;
    } else if (Math.sign(p.position) === Math.sign(side)) {
      // add to same side
      const newPos = p.position + (side > 0 ? 1 : -1);
      p.avgCost = (p.avgCost * Math.abs(p.position) + px) / Math.abs(newPos);
      p.position = newPos;
    } else {
      // reduce/flip
      const realized = (px - p.avgCost) * (p.position > 0 ? 1 : -1);
      p.realized += realized;
      const after = p.position + (side > 0 ? 1 : -1);
      if (after === 0) { p.position = 0; p.avgCost = 0; }
      else { p.position = after; p.avgCost = px; }
    }
    recomputePnl(p);
    broadcast();
  });

  socket.on("startGame", () => {
    if (state.phase === "running") return;
    startLoop();
  });

  socket.on("disconnect", () => {
    delete state.players[socket.id];
    io.emit("playerList", Object.values(state.players).map(p => ({
      name: p.name, position: p.position, pnl: p.pnl
    })));
  });
});

function startLoop(){
  state.phase = "running";
  state.tick = 0;
  state.price = 100;
  state.fair = 100;
  state.newsIndex = 0;
  for (const p of Object.values(state.players)) {
    p.position = 0; p.avgCost = 0; p.realized = 0; p.pnl = 0;
  }
  if (state._timer) clearInterval(state._timer);

  state._timer = setInterval(() => {
    state.tick += 1;
    if (state.tick % 10 === 0) {
      state.newsIndex = (state.newsIndex + 1) % state.newsItems.length;
      state.fair += state.newsItems[state.newsIndex].drift * 10;
    }
    const toward = (state.fair - state.price) * 0.08;
    const noise  = (Math.random() - 0.5) * 0.6;
    state.price = Math.max(1, state.price + toward + noise);

    for (const p of Object.values(state.players)) recomputePnl(p);
    broadcast();
  }, 1000);

  broadcast();
}

// ---------- start ----------
const PORT = process.env.PORT || 4000; // Render sets PORT (must use it)
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log("Static dir:", pubDir);
});


