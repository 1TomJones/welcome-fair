import { clamp } from "./utils.js";

export const DEFAULT_ORDER_BOOK_CONFIG = {
  tickSize: 0.5,
  levelsPerSide: 25,
  baseDepth: 8,
  depthFalloff: 0.16,
  regenRate: 0.55,
  excessDecay: 0.4,
  passiveDecay: 0.96,
  minVolume: 0.1,
  maxVolume: 80,
  randomJitter: 0.18,
  driftTowardFair: 0.12,
};

function snap(price, tick) {
  const snapped = Math.round(price / tick) * tick;
  return Math.max(tick, +snapped.toFixed(6));
}

function baselineVolume(levelIndex, { baseDepth, depthFalloff, minVolume, maxVolume }) {
  const vol = baseDepth * Math.exp(-depthFalloff * (levelIndex - 1));
  return clamp(vol, minVolume, maxVolume);
}

export class OrderBook {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ORDER_BOOK_CONFIG, ...config };
    this.tickSize = this.config.tickSize;
    this.reset(100);
  }

  reset(midPrice) {
    this.midPrice = snap(midPrice ?? 100, this.tickSize);
    this.lastTradePrice = this.midPrice;
    this.bids = [];
    this.asks = [];
    this.levelLookup = new Map();
    this.seedBaseline(this.midPrice);
  }

  seedBaseline(centerPrice) {
    this.bids.length = 0;
    this.asks.length = 0;
    this.levelLookup.clear();
    const mid = snap(centerPrice, this.tickSize);
    const cfg = this.config;
    for (let i = 1; i <= cfg.levelsPerSide; i += 1) {
      const vol = baselineVolume(i, cfg);
      const jitter = 1 + (Math.random() - 0.5) * cfg.randomJitter;
      const askPx = snap(mid + i * this.tickSize, this.tickSize);
      const bidPx = snap(mid - i * this.tickSize, this.tickSize);
      if (bidPx >= this.tickSize) {
        this._setLevel("bid", bidPx, clamp(vol * jitter, cfg.minVolume, cfg.maxVolume));
      }
      this._setLevel("ask", askPx, clamp(vol * jitter, cfg.minVolume, cfg.maxVolume));
    }
    this.sortLevels();
  }

  _key(side, price) {
    return `${side}:${price.toFixed(6)}`;
  }

  _setLevel(side, price, size) {
    const arr = side === "bid" ? this.bids : this.asks;
    const key = this._key(side, price);
    let level = this.levelLookup.get(key);
    if (!level) {
      level = { side, price, size: 0 };
      this.levelLookup.set(key, level);
      arr.push(level);
    }
    level.size = size;
    return level;
  }

  _getLevel(side, price) {
    return this.levelLookup.get(this._key(side, price)) ?? null;
  }

  _removeLevel(side, price) {
    const key = this._key(side, price);
    const level = this.levelLookup.get(key);
    if (!level) return;
    const arr = side === "bid" ? this.bids : this.asks;
    const idx = arr.indexOf(level);
    if (idx >= 0) arr.splice(idx, 1);
    this.levelLookup.delete(key);
  }

  sortLevels() {
    this.bids.sort((a, b) => b.price - a.price);
    this.asks.sort((a, b) => a.price - b.price);
  }

  bestBid() {
    while (this.bids.length && this.bids[0].size <= this.config.minVolume * 0.25) {
      this._removeLevel("bid", this.bids[0].price);
    }
    return this.bids[0] ?? null;
  }

  bestAsk() {
    while (this.asks.length && this.asks[0].size <= this.config.minVolume * 0.25) {
      this._removeLevel("ask", this.asks[0].price);
    }
    return this.asks[0] ?? null;
  }

  lastPrice() {
    return this.lastTradePrice ?? this.midPrice;
  }

  tickMaintenance({ center, fair } = {}) {
    const cfg = this.config;
    const targetCenter = center ?? this.lastPrice();
    this.midPrice = snap(targetCenter, this.tickSize);
    if (fair && Number.isFinite(fair)) {
      const fairSnap = snap(fair, this.tickSize);
      const drift = clamp(fairSnap - this.midPrice, -this.tickSize, this.tickSize) * cfg.driftTowardFair;
      this.midPrice = snap(this.midPrice + drift, this.tickSize);
    }

    // passive decay of existing size
    for (const level of [...this.bids, ...this.asks]) {
      level.size *= cfg.passiveDecay;
    }

    // ensure baseline volumes exist around current mid
    const targetBidPrices = new Set();
    const targetAskPrices = new Set();
    for (let i = 1; i <= cfg.levelsPerSide; i += 1) {
      const baseVol = baselineVolume(i, cfg);
      const jitter = 1 + (Math.random() - 0.5) * cfg.randomJitter;
      const askPx = snap(this.midPrice + i * this.tickSize, this.tickSize);
      const bidPx = snap(this.midPrice - i * this.tickSize, this.tickSize);
      const desired = clamp(baseVol * jitter, cfg.minVolume, cfg.maxVolume);

      if (bidPx >= this.tickSize) {
        targetBidPrices.add(bidPx);
        this._approachVolume("bid", bidPx, desired);
      }
      targetAskPrices.add(askPx);
      this._approachVolume("ask", askPx, desired);
    }

    // trim stray levels outside target range or tiny
    this.bids = this.bids.filter((level) => {
      const keep = targetBidPrices.has(level.price) && level.size > cfg.minVolume * 0.2;
      if (!keep) this.levelLookup.delete(this._key("bid", level.price));
      return keep;
    });
    this.asks = this.asks.filter((level) => {
      const keep = targetAskPrices.has(level.price) && level.size > cfg.minVolume * 0.2;
      if (!keep) this.levelLookup.delete(this._key("ask", level.price));
      return keep;
    });

    this.sortLevels();
  }

  _approachVolume(side, price, desired) {
    const cfg = this.config;
    let level = this._getLevel(side, price);
    if (!level) {
      level = this._setLevel(side, price, 0);
    }
    const diff = desired - level.size;
    if (diff > 0) {
      level.size += diff * cfg.regenRate;
    } else {
      level.size += diff * cfg.excessDecay;
    }
    level.size = clamp(level.size, 0, cfg.maxVolume);
  }

  executeMarketOrder(side, quantity) {
    const filledLots = [];
    const takeSide = side === "BUY" ? "ask" : "bid";
    let remaining = Math.max(0, quantity);
    if (!remaining) {
      return { filled: 0, avgPrice: null, remaining: 0, fills: [] };
    }

    while (remaining > 0) {
      const level = takeSide === "ask" ? this.bestAsk() : this.bestBid();
      if (!level) break;
      const take = Math.min(remaining, level.size);
      if (take <= 0) break;
      level.size -= take;
      remaining -= take;
      filledLots.push({ price: level.price, size: take });
      if (level.size <= this.config.minVolume * 0.2) {
        this._removeLevel(takeSide, level.price);
      }
    }

    const filled = quantity - remaining;
    if (filled <= 0) {
      return { filled: 0, avgPrice: null, remaining: quantity, fills: [] };
    }

    const totalNotional = filledLots.reduce((sum, lot) => sum + lot.price * lot.size, 0);
    const avgPrice = totalNotional / filled;
    this.lastTradePrice = filledLots[filledLots.length - 1].price;

    // mark mid based on surviving bests
    const bestBid = this.bestBid();
    const bestAsk = this.bestAsk();
    if (bestBid && bestAsk) {
      this.midPrice = (bestBid.price + bestAsk.price) / 2;
    } else {
      this.midPrice = this.lastTradePrice ?? this.midPrice;
    }

    return {
      filled,
      avgPrice,
      remaining,
      fills: filledLots,
      side,
    };
  }

  getBookLevels(levels = 10) {
    const takeLevels = Math.max(1, levels);
    const bids = [];
    const asks = [];
    let runBid = 0;
    let runAsk = 0;
    for (const level of this.bids.slice(0, takeLevels)) {
      runBid += level.size;
      bids.push({ price: level.price, size: level.size, cumulative: runBid });
    }
    for (const level of this.asks.slice(0, takeLevels)) {
      runAsk += level.size;
      asks.push({ price: level.price, size: level.size, cumulative: runAsk });
    }
    const bestBid = this.bestBid();
    const bestAsk = this.bestAsk();
    const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : 0;
    return {
      bids,
      asks,
      spread,
      lastPrice: this.lastPrice(),
      midPrice: this.midPrice,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
    };
  }
}
