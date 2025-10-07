// server.mjs
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Free Render sits behind a proxy; wide open CORS is fine for now
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ---- pick the static directory (prefer ./client, else ./public) ----
let pubDir = path.join(__dirname, "client");
if (!fs.existsSync(pubDir)) {
  pubDir = path.join(__dirname, "public");
}
console.log("[server] static dir:", pubDir, fs.existsSync(pubDir) ? "(exists)" : "(MISSING)");

// ---- health + basic routes ----
app.get("/health", (req, res) => res.type("text/plain").send("OK"));

// serve static files
app.use(express.static(pubDir));

// root & admin fallbacks (if middleware above doesn’t catch)
app.get("/", (req, res) => {
  const idx = path.join(pubDir, "index.html");
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send("index.html not found in static dir");
});

app.get("/admin", (req, res) => {
  // allow both /admin and /admin.html
  const a = path.join(pubDir, "admin.html");
  if (fs.existsSync(a)) res.sendFile(a);
  else res.status(404).send("admin.html not found in static dir");
});

// -------------------
// Minimal game state
// -------------------
const state = {
  running: false,
  t: 0,
  fair: 100,
  players: new Map(), // id -> {name, position, pnl}
};

function tick() {
  if (!state.running) return;
  state.t += 1;
  state.fair = +(state.fair + (Math.random() - 0.5) * 0.2).toFixed(2);
  for (const [, p] of state.players) {
    p.pnl = +(p.position * (state.fair - 100)).toFixed(2);
  }
  io.emit("priceUpdate", {
    t: state.t,
    fair: state.fair,
    players: Object.fromEntries(state.players),
  });
}
setInterval(tick, 500);

io.on("connection", (socket) => {
  console.log("[client] connected", socket.id);
  state.players.set(socket.id, { name: "Player", position: 0, pnl: 0 });

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
    if (p) p.position = Math.min(5, p.position + 1);
  });

  socket.on("sell", () => {
    const p = state.players.get(socket.id);
    if (p) p.position = Math.max(-5, p.position - 1);
  });

  socket.on("disconnect", () => {
    console.log("[client] disconnected", socket.id);
    state.players.delete(socket.id);
    io.emit("playerList", Object.fromEntries(state.players));
  });
});

const PORT = process.env.PORT || 4000; // Render injects its own PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});




