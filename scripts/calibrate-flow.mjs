#!/usr/bin/env node
import { io } from "socket.io-client";

const url = process.env.SIM_URL || "http://localhost:10000";
const durationMs = Number(process.env.DURATION_MS || 15000);
const name = process.env.CAL_USER || `Calibrator-${Math.random().toString(36).slice(2, 6)}`;

const stats = {
  marketOrders: 0,
  limitOrders: 0,
  fills: 0,
  cancels: 0,
  marketVolume: 0,
  limitVolume: 0,
  lastSpread: null,
  spreads: [],
  marketShares: [],
};

let baselinePrice = 100;
let runMarketInterval = null;
let runLimitInterval = null;
let cancelInterval = null;
const openOrders = new Set();

const socket = io(url, { transports: ["websocket"] });

function randomSide() {
  return Math.random() > 0.5 ? "BUY" : "SELL";
}

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

function placeMarket() {
  const side = randomSide();
  socket.emit("submitOrder", { type: "market", side, quantity: 1 }, (res) => {
    if (!res?.ok) return;
    stats.marketOrders += 1;
    stats.marketVolume += Math.abs(res.qty ?? 0);
    if (res.filled) stats.fills += 1;
  });
}

function placeLimit() {
  const side = randomSide();
  const direction = side === "BUY" ? -1 : 1;
  const price = clamp(baselinePrice + direction * (Math.random() * 1.2 + 0.2), 0.01, baselinePrice * 5);
  socket.emit("submitOrder", { type: "limit", side, price, quantity: 2 }, (res) => {
    if (!res?.ok) return;
    stats.limitOrders += 1;
    stats.limitVolume += Math.abs(res.filled || 0) || 2;
    if (res.filled) stats.fills += 1;
    if (res.resting?.id) openOrders.add(res.resting.id);
  });
}

function cancelOrders() {
  if (!openOrders.size) return;
  const ids = Array.from(openOrders);
  socket.emit("cancelOrders", ids, (res) => {
    const canceled = res?.canceled || [];
    stats.cancels += canceled.length;
    canceled.forEach((c) => openOrders.delete(c.id));
  });
}

function stop() {
  clearInterval(runMarketInterval);
  clearInterval(runLimitInterval);
  clearInterval(cancelInterval);
  cancelOrders();
  const avgSpread =
    stats.spreads.length === 0 ? 0 : stats.spreads.reduce((s, v) => s + v, 0) / stats.spreads.length;
  const avgMarketShare =
    stats.marketShares.length === 0 ? 0 : stats.marketShares.reduce((s, v) => s + v, 0) / stats.marketShares.length;
  console.log(JSON.stringify({
    url,
    durationMs,
    marketOrders: stats.marketOrders,
    limitOrders: stats.limitOrders,
    cancels: stats.cancels,
    fills: stats.fills,
    marketVolume: Number(stats.marketVolume.toFixed(3)),
    limitVolume: Number(stats.limitVolume.toFixed(3)),
    avgSpread: Number(avgSpread.toFixed(4)),
    avgMarketShare: Number(avgMarketShare.toFixed(4)),
    samples: stats.spreads.length,
  }, null, 2));
  socket.disconnect();
  process.exit(0);
}

socket.on("connect", () => {
  socket.emit("join", name, (ack) => {
    if (ack?.price) baselinePrice = ack.price;
    runMarketInterval = setInterval(placeMarket, 500);
    runLimitInterval = setInterval(placeLimit, 750);
    cancelInterval = setInterval(cancelOrders, 4000);
    setTimeout(stop, durationMs);
  });
});

socket.on("orderBook", (book) => {
  if (typeof book?.midPrice === "number") {
    baselinePrice = book.midPrice;
  }
});

socket.on("tickMetrics", (m) => {
  if (typeof m?.spread === "number") stats.spreads.push(m.spread);
  if (typeof m?.marketShare === "number") stats.marketShares.push(m.marketShare);
});

socket.on("disconnect", () => {
  stop();
});
