// server.mjs
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// --- resolve __dirname in ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- app / server / socket ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // Render sits behind a proxy; allow any origin for now
});

// --- where the client lives ---
const pubDir = path.join(__dirname, "public");
console.log("[server] public dir =", pubDir, fs.existsSync(pubDir) ? "(exists)" : "(MISSING)");

// --- health and root routes (explicit) ---
app.get("/health", (req, res) => res.type("text/plain").send("OK"));

// serve static first
app.use(express.static(pubDir));

// ensure / and /admin.html respond even if static misses
app.get("/", (req, res) => {
  const idx = path.join(pubDir, "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send("index.html not found in /public");
});

app.get("/admin.html", (req, res) => {
  const admin = path.join(pubDir, "admin.html");
  if (fs.existsSync(admin)) res.sendFile(admin);
  else res.status(404).send("admin.html not found in /public");
});

// -------------------
// Minimal game state (same as before; keep it simple so site boots)
// -------------------
const state = {
  running: false,
  t: 0,
  fair: 100,
  players: new Map(), // id -> {name, position, pnl}
};

function tick() {
  if (!state.running) return;
  // tiny random walk
  state.t += 1;
  state.fair = +(state.fair + (Math.random() - 0.5) * 0.2).toFixed(2);
  // update PnL for each player
  for (const [id, p] of state.players) {
    p.pnl = +(p.position * (state.fair - 100)).toFixed(2);
  }
  io.emit("priceUpdate", {
    t: state.t,
    fair: state.fair,
    players: Object.fromEntries(state.players),
  });
}

setInterval(tick, 500); // broadcast 2/s

io.on("connection", (socket) => {
  console.log("[client] connected", socket.id);
  state.players.set(socket.id, { name: "Player", position: 0, pnl: 0 });

  // initial push
  socket.emit("priceUpdate", {
    t: state.t,
    fair: state.fair,
    players: Object.fromEntries(state.players),
  });

  socket.on("join", (name) => {
    const p = state.players.get(socket.id);
    if (p) p.name = (name || "Player").toString().slice(0, 24);
    io.emit("playerList", Object.fromEntries(state.players));
  });

  socket.on("startGame", () => {
    state.running = true;
    io.emit("gameState", { running: true });
  });

  socket.on("buy", () => {
    const p = state.players.get(socket.id);
    if (!p) return;
    p.position = Math.min(5, p.position + 1);
  });

  socket.on("sell", () => {
    const p = state.players.get(socket.id);
    if (!p) return;
    p.position = Math.max(-5, p.position - 1);
  });

  socket.on("disconnect", () => {
    console.log("[client] disconnected", socket.id);
    state.players.delete(socket.id);
    io.emit("playerList", Object.fromEntries(state.players));
  });
});

// --- start ---
const PORT = process.env.PORT || 4000; // Render injects PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});



