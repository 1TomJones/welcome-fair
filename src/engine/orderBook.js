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

function bookSideForOrder(side) {
  return side === "BUY" ? "bid" : "ask";
}

function passiveSide(side) {
  return side === "BUY" ? "ask" : "bid";
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
    this.orders = new Map();
    this.ownerOrders = new Map();
    this.nextOrderId = 1;
    this.seedBaseline(this.midPrice);
  }

  seedBaseline(centerPrice) {
    this.bids.length = 0;
    this.asks.length = 0;
    this.levelLookup.clear();
    const mid = snap(centerPrice, this.tickSize);
    const cfg = this.config;
    for (let i = 1; i <= cfg.levelsPerSide; i += 1) {
      const base = clamp(baselineVolume(i, cfg), cfg.minVolume, cfg.maxVolume);
      const jitter = 1 + (Math.random() - 0.5) * cfg.randomJitter;
      const askPx = snap(mid + i * this.tickSize, this.tickSize);
      const bidPx = snap(mid - i * this.tickSize, this.tickSize);
      if (bidPx >= this.tickSize) {
        this._setBaseline("bid", bidPx, base * jitter);
      }
      this._setBaseline("ask", askPx, base * jitter);
    }
    this.sortLevels();
  }

  _levelKey(side, price) {
    return `${side}:${price.toFixed(6)}`;
  }

  _ensureLevel(side, price) {
    const arr = side === "bid" ? this.bids : this.asks;
    const key = this._levelKey(side, price);
    let level = this.levelLookup.get(key);
    if (!level) {
      level = { side, price, base: 0, manualOrders: [], manualVolume: 0 };
      this.levelLookup.set(key, level);
      arr.push(level);
    }
    return level;
  }

  _setBaseline(side, price, size) {
    const level = this._ensureLevel(side, price);
    level.base = clamp(size, 0, this.config.maxVolume);
    return level;
  }

  _getLevel(side, price) {
    return this.levelLookup.get(this._levelKey(side, price)) ?? null;
  }

  _removeLevel(side, price) {
    const key = this._levelKey(side, price);
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

  _totalVolume(level) {
    if (!level) return 0;
    return (level.base ?? 0) + (level.manualVolume ?? 0);
  }

  bestBid() {
    while (this.bids.length) {
      const level = this.bids[0];
      if (this._totalVolume(level) > this.config.minVolume * 0.25) break;
      if (level.manualOrders.length === 0) {
        this._removeLevel("bid", level.price);
      } else {
        level.base = 0;
        break;
      }
    }
    return this.bids[0] ?? null;
  }

  bestAsk() {
    while (this.asks.length) {
      const level = this.asks[0];
      if (this._totalVolume(level) > this.config.minVolume * 0.25) break;
      if (level.manualOrders.length === 0) {
        this._removeLevel("ask", level.price);
      } else {
        level.base = 0;
        break;
      }
    }
    return this.asks[0] ?? null;
  }

  lastPrice() {
    return this.lastTradePrice ?? this.midPrice;
  }

  tickMaintenance({ center, fair, regenScale = 1 } = {}) {
    const cfg = this.config;
    const regenFactor = clamp(regenScale ?? 1, 0, 1);
    const targetCenter = center ?? this.lastPrice();
    this.midPrice = snap(targetCenter, this.tickSize);
    if (fair && Number.isFinite(fair)) {
      const fairSnap = snap(fair, this.tickSize);
      const drift = clamp(fairSnap - this.midPrice, -this.tickSize, this.tickSize) * cfg.driftTowardFair;
      this.midPrice = snap(this.midPrice + drift, this.tickSize);
    }

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
        this._approachBaseline("bid", bidPx, desired, regenFactor);
      }
      targetAskPrices.add(askPx);
      this._approachBaseline("ask", askPx, desired, regenFactor);
    }

    this.bids = this.bids.filter((level) => {
      const keepBaseline = targetBidPrices.has(level.price);
      if (!keepBaseline && level.manualOrders.length === 0) {
        this.levelLookup.delete(this._levelKey("bid", level.price));
        return false;
      }
      return true;
    });

    this.asks = this.asks.filter((level) => {
      const keepBaseline = targetAskPrices.has(level.price);
      if (!keepBaseline && level.manualOrders.length === 0) {
        this.levelLookup.delete(this._levelKey("ask", level.price));
        return false;
      }
      return true;
    });

    this.sortLevels();
  }

  _approachBaseline(side, price, desired, regenFactor = 1) {
    const cfg = this.config;
    const level = this._ensureLevel(side, price);
    const diff = desired - level.base;
    if (diff > 0) {
      level.base += diff * cfg.regenRate * regenFactor;
    } else {
      level.base += diff * cfg.excessDecay * regenFactor;
    }
    level.base = clamp(level.base, 0, cfg.maxVolume);
  }

  _finalizeOrder(order) {
    if (!order) return;
    this.orders.delete(order.id);
    const set = this.ownerOrders.get(order.ownerId);
    if (set) {
      set.delete(order.id);
      if (set.size === 0) {
        this.ownerOrders.delete(order.ownerId);
      }
    }
  }

  _attachManualOrder(level, order) {
    level.manualOrders.push(order);
    level.manualVolume += order.remaining;
    level.manualOrders.sort((a, b) => a.createdAt - b.createdAt);
  }

  _detachManualOrder(level, orderId) {
    const idx = level.manualOrders.findIndex((ord) => ord.id === orderId);
    if (idx >= 0) {
      const [ord] = level.manualOrders.splice(idx, 1);
      level.manualVolume = Math.max(0, level.manualVolume - ord.remaining);
      return ord;
    }
    return null;
  }

  _syncMidAfterTrade() {
    const bestBid = this.bestBid();
    const bestAsk = this.bestAsk();
    if (bestBid && bestAsk) {
      this.midPrice = (bestBid.price + bestAsk.price) / 2;
    } else if (bestBid) {
      this.midPrice = bestBid.price;
    } else if (bestAsk) {
      this.midPrice = bestAsk.price;
    }
    if (this.lastTradePrice != null) {
      this.midPrice = snap(this.midPrice ?? this.lastTradePrice, this.tickSize);
    }
  }

  _createManualOrder({ side, price, size, ownerId }) {
    const order = {
      id: `o${this.nextOrderId++}`,
      ownerId,
      side,
      price,
      remaining: size,
      createdAt: Date.now(),
    };
    this.orders.set(order.id, order);
    if (!this.ownerOrders.has(ownerId)) {
      this.ownerOrders.set(ownerId, new Set());
    }
    this.ownerOrders.get(ownerId).add(order.id);
    return order;
  }

  _addManualOrder({ side, price, size, ownerId }) {
    if (size <= 0) return null;
    const bookSide = bookSideForOrder(side);
    const snapped = snap(price, this.tickSize);
    const level = this._ensureLevel(bookSide, snapped);
    const order = this._createManualOrder({ side, price: snapped, size, ownerId });
    this._attachManualOrder(level, order);
    this.sortLevels();
    return order;
  }

  executeMarketOrder(side, quantity, { limitPrice = null } = {}) {
    const filledLots = [];
    const takeSide = passiveSide(side);
    let remaining = Math.max(0, quantity);
    if (remaining <= 0) {
      return { filled: 0, avgPrice: null, remaining: 0, fills: [], side };
    }

    const limitCheck = (price) => {
      if (limitPrice == null) return true;
      return side === "BUY" ? price <= limitPrice + 1e-9 : price >= limitPrice - 1e-9;
    };

    let totalNotional = 0;

    while (remaining > 1e-8) {
      const level = takeSide === "ask" ? this.bestAsk() : this.bestBid();
      if (!level) break;
      if (!limitCheck(level.price)) break;

      let takenThisLevel = 0;

      for (const order of [...level.manualOrders]) {
        if (remaining <= 1e-8) break;
        const take = Math.min(remaining, order.remaining);
        if (take <= 0) continue;
        order.remaining -= take;
        level.manualVolume = Math.max(0, level.manualVolume - take);
        remaining -= take;
        takenThisLevel += take;
        totalNotional += take * level.price;
        filledLots.push({ price: level.price, size: take, ownerId: order.ownerId, orderId: order.id });
        if (order.remaining <= 1e-8) {
          this._finalizeOrder(order);
          this._detachManualOrder(level, order.id);
        }
      }

      if (remaining <= 1e-8) {
        this.lastTradePrice = level.price;
        break;
      }

      const baseAvail = Math.max(0, level.base);
      if (baseAvail > 1e-8) {
        const takeBase = Math.min(remaining, baseAvail);
        if (takeBase > 0) {
          level.base -= takeBase;
          remaining -= takeBase;
          takenThisLevel += takeBase;
          totalNotional += takeBase * level.price;
          filledLots.push({ price: level.price, size: takeBase, ownerId: null, orderId: null });
        }
      }

      if (takenThisLevel > 0) {
        this.lastTradePrice = level.price;
      }

      if (this._totalVolume(level) <= this.config.minVolume * 0.05 && level.manualOrders.length === 0) {
        this._removeLevel(level.side, level.price);
      }
    }

    const filled = quantity - remaining;
    if (filled <= 1e-8) {
      return { filled: 0, avgPrice: null, remaining: quantity, fills: [], side };
    }

    const avgPrice = totalNotional / filled;
    this._syncMidAfterTrade();

    return {
      filled,
      avgPrice,
      remaining,
      fills: filledLots,
      side,
    };
  }

  placeLimitOrder({ side, price, size, ownerId }) {
    const snapped = snap(price, this.tickSize);
    const qty = Math.max(0, size);
    if (qty <= 0) {
      return { filled: 0, avgPrice: null, remaining: 0, fills: [], side, resting: null };
    }

    const cross = this.executeMarketOrder(side, qty, { limitPrice: snapped });
    let resting = null;
    let remaining = cross.remaining;

    if (remaining > 1e-8) {
      resting = this._addManualOrder({ side, price: snapped, size: remaining, ownerId });
      remaining = 0;
    }

    return {
      side,
      filled: cross.filled,
      avgPrice: cross.avgPrice,
      fills: cross.fills,
      resting,
      remaining,
    };
  }

  cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const level = this._getLevel(bookSideForOrder(order.side), order.price);
    if (level) {
      this._detachManualOrder(level, orderId);
      if (this._totalVolume(level) <= this.config.minVolume * 0.05 && level.manualOrders.length === 0) {
        this._removeLevel(level.side, level.price);
      }
    }
    this._finalizeOrder(order);
    return { ...order };
  }

  cancelAllForOwner(ownerId) {
    const ids = Array.from(this.ownerOrders.get(ownerId) ?? []);
    const results = [];
    for (const id of ids) {
      const res = this.cancelOrder(id);
      if (res) results.push(res);
    }
    return results;
  }

  getOrdersForOwner(ownerId) {
    const ids = Array.from(this.ownerOrders.get(ownerId) ?? []);
    return ids
      .map((id) => this.orders.get(id))
      .filter(Boolean)
      .map((ord) => ({
        id: ord.id,
        side: ord.side,
        price: ord.price,
        remaining: ord.remaining,
        createdAt: ord.createdAt,
      }))
      .sort((a, b) => {
        if (a.side !== b.side) return a.side === "BUY" ? -1 : 1;
        if (a.side === "BUY") {
          if (a.price !== b.price) return b.price - a.price;
        } else if (a.price !== b.price) {
          return a.price - b.price;
        }
        return a.createdAt - b.createdAt;
      });
  }

  getBookLevels(levels = 10) {
    const takeLevels = Math.max(1, levels);
    const bids = [];
    const asks = [];
    let runBid = 0;
    let runAsk = 0;

    for (const level of this.bids.slice(0, takeLevels)) {
      const total = this._totalVolume(level);
      if (total <= 1e-8) continue;
      runBid += total;
      bids.push({
        price: level.price,
        size: total,
        manual: level.manualVolume,
        cumulative: runBid,
      });
    }

    for (const level of this.asks.slice(0, takeLevels)) {
      const total = this._totalVolume(level);
      if (total <= 1e-8) continue;
      runAsk += total;
      asks.push({
        price: level.price,
        size: total,
        manual: level.manualVolume,
        cumulative: runAsk,
      });
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
