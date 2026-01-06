import { clamp } from "./utils.js";

export const DEFAULT_ORDER_BOOK_CONFIG = {
  tickSize: 0.5,
  levelsPerSide: 25,
  baseDepth: 8,
  depthFalloff: 0.16,
  regenRate: 0.55,
  excessDecay: 0.4,
  passiveDecay: 0.96,
  minVolume: 1,
  maxVolume: 80,
  randomJitter: 0.18,
  driftTowardFair: 0.12,
  queueDepthCap: 32,
  maxLevelSize: 140,
  refreshProbability: 0.14,
  refreshDelayMs: 2400,
  restingHalfLifeSec: 120,
  restingMaxAgeMs: 60_000,
  analyticsDepth: 8,
  iceberg: {
    enabled: true,
    minParent: 6,
    displayFraction: 0.35,
    minClip: 0.5,
  },
};

function snap(price, tick) {
  const snapped = Math.round(price / tick) * tick;
  return Math.max(tick, +snapped.toFixed(6));
}

function baselineVolume(levelIndex, { baseDepth, depthFalloff, minVolume, maxVolume }) {
  const vol = baseDepth * Math.exp(-depthFalloff * (levelIndex - 1));
  const clamped = clamp(vol, minVolume, maxVolume);
  return Math.max(minVolume, Math.round(clamped));
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
    this.bookStates = [];
    this.orderEvents = [];
    this.lastMaintenanceAt = Date.now();
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
    const capacity = Number.isFinite(this.config.maxLevelSize)
      ? Math.max(0, this.config.maxLevelSize - (level.manualVolume ?? 0))
      : this.config.maxVolume;
    const desired = clamp(size, 0, Math.min(this.config.maxVolume, capacity));
    level.base = Math.max(this.config.minVolume, Math.round(desired));
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

  _levelCapacity(level) {
    if (!level) return 0;
    const cap = Number.isFinite(this.config.maxLevelSize) ? this.config.maxLevelSize : Infinity;
    if (!Number.isFinite(cap)) return Infinity;
    return Math.max(0, cap - this._totalVolume(level));
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

  _ageRestingLiquidity(now = Date.now()) {
    const cfg = this.config;
    const halfLifeMs = Math.max(1, (cfg.restingHalfLifeSec ?? 0) * 1000);
    const maxAge = cfg.restingMaxAgeMs ?? Infinity;
    for (const side of ["bid", "ask"]) {
      const levels = side === "bid" ? this.bids : this.asks;
      for (const level of levels) {
        const survivors = [];
        let manualVolume = 0;
        for (const order of level.manualOrders) {
          const prevRemaining = order.remaining;
          const age = now - (order.createdAt ?? now);
          let remaining = order.remaining;
          if (halfLifeMs > 0 && age > halfLifeMs * 0.5) {
            const decayFactor = Math.pow(cfg.passiveDecay ?? 1, age / halfLifeMs);
            remaining = Math.max(0, Math.round(remaining * decayFactor));
          }
          const expired = age > maxAge || remaining <= cfg.minVolume * 0.02;
          if (expired) {
            order.remaining = 0;
            this._finalizeOrder(order, "expired");
            continue;
          }
          order.remaining = remaining;

          const refreshWindow =
            order.hiddenRemaining > 1e-8 &&
            (order.remaining <= cfg.minVolume * 0.06 || now >= (order.nextRefreshAt ?? 0));
          const refreshed = refreshWindow ? this._refreshRestingOrder(level, order, { now }) : false;
          if (!refreshed && refreshWindow) {
            order.nextRefreshAt = now + (cfg.refreshDelayMs ?? 0);
            if (!this.orders.has(order.id)) continue;
          }
          if (!refreshed && Math.abs(prevRemaining - order.remaining) > cfg.minVolume * 0.01 && order.ownerId) {
            this.orderEvents.push({
              type: "resize",
              orderId: order.id,
              ownerId: order.ownerId,
              remaining: order.remaining,
              price: order.price,
              side: order.side,
              t: now,
            });
          }
          survivors.push(order);
          manualVolume += order.remaining;
        }
        survivors.sort((a, b) => a.createdAt - b.createdAt);
        level.manualOrders = survivors;
        level.manualVolume = manualVolume;
      }
    }
  }

  tickMaintenance({ center, fair } = {}) {
    const now = Date.now();
    this._ageRestingLiquidity(now);

    const cfg = this.config;
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
        this._approachBaseline("bid", bidPx, desired);
      }
      targetAskPrices.add(askPx);
      this._approachBaseline("ask", askPx, desired);
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
    this._recordBookState(now, cfg.analyticsDepth);
  }

  _approachBaseline(side, price, desired) {
    const cfg = this.config;
    const level = this._ensureLevel(side, price);
    const diff = desired - level.base;
    if (diff > 0) {
      level.base += diff * cfg.regenRate;
    } else {
      level.base += diff * cfg.excessDecay;
    }
    const capacity = Number.isFinite(cfg.maxLevelSize)
      ? Math.max(0, cfg.maxLevelSize - (level.manualVolume ?? 0))
      : cfg.maxVolume;
    const bounded = clamp(level.base, 0, Math.min(cfg.maxVolume, capacity));
    level.base = Math.max(cfg.minVolume, Math.round(bounded));
  }

  _finalizeOrder(order, reason = null) {
    if (!order) return;
    this.orders.delete(order.id);
    const set = this.ownerOrders.get(order.ownerId);
    if (set) {
      set.delete(order.id);
      if (set.size === 0) {
        this.ownerOrders.delete(order.ownerId);
      }
    }
    if (order.ownerId && reason) {
      this.orderEvents.push({
        type: reason,
        orderId: order.id,
        ownerId: order.ownerId,
        remaining: order.remaining ?? 0,
        price: order.price,
        side: order.side,
        t: Date.now(),
      });
    }
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

  _refreshRestingOrder(level, order, { now = Date.now(), force = false } = {}) {
    if (!order || order.hiddenRemaining <= 1e-8) return false;
    if (!force && now < (order.nextRefreshAt ?? 0)) return false;
    if (!force && Math.random() > (this.config.refreshProbability ?? 0)) return false;

    const existingIdx = level.manualOrders.findIndex((ord) => ord.id === order.id);
    if (existingIdx >= 0) {
      level.manualOrders.splice(existingIdx, 1);
      level.manualVolume = Math.max(0, level.manualVolume - order.remaining);
    }

    const desired = clamp(
      order.displayTarget ?? order.remaining,
      this.config.iceberg?.minClip ?? this.config.minVolume,
      order.hiddenRemaining,
    );
    const capacity = (this._levelCapacity(level) ?? Infinity) + order.remaining;
    const clip = Math.max(this.config.minVolume, Math.round(Math.min(desired, capacity)));
    if (clip <= this.config.minVolume * 0.02) return false;

    order.remaining = clip;
    order.hiddenRemaining = Math.max(0, order.hiddenRemaining - clip);
    order.createdAt = now;
    order.nextRefreshAt = now + (this.config.refreshDelayMs ?? 0);
    const enqueued = this._enqueueOrder(level, order);
    if (!enqueued) {
      this._finalizeOrder(order, "expired");
      return false;
    }
    if (order.ownerId) {
      this.orderEvents.push({
        type: "refresh",
        orderId: order.id,
        ownerId: order.ownerId,
        remaining: order.remaining,
        price: order.price,
        side: order.side,
        t: now,
      });
    }
    return enqueued;
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

  _splitIceberg(size) {
    const ice = this.config.iceberg ?? {};
    if (!ice.enabled || size < (ice.minParent ?? Infinity)) {
      const quantized = Math.max(this.config.minVolume, Math.round(size));
      return { display: quantized, hidden: 0, displayTarget: quantized };
    }
    const display = Math.max(
      ice.minClip ?? this.config.minVolume,
      Math.round(size * (ice.displayFraction ?? 1)),
    );
    const hidden = Math.max(0, Math.round(size - display));
    return { display, hidden, displayTarget: display };
  }

  _enqueueOrder(level, order) {
    if (level.manualOrders.length >= (this.config.queueDepthCap ?? Infinity)) return false;
    level.manualOrders.push(order);
    level.manualOrders.sort((a, b) => a.createdAt - b.createdAt);
    level.manualVolume += order.remaining;
    return true;
  }

  _createManualOrder({ side, price, size, ownerId }) {
    const { display, hidden, displayTarget } = this._splitIceberg(size);
    const order = {
      id: `o${this.nextOrderId++}`,
      ownerId,
      side,
      price,
      remaining: display,
      hiddenRemaining: hidden,
      displayTarget,
      createdAt: Date.now(),
      nextRefreshAt: Date.now() + (this.config.refreshDelayMs ?? 0),
    };
    this.orders.set(order.id, order);
    if (!this.ownerOrders.has(ownerId)) {
      this.ownerOrders.set(ownerId, new Set());
    }
    this.ownerOrders.get(ownerId).add(order.id);
    return order;
  }

  _addManualOrder({ side, price, size, ownerId }) {
    const quantized = Math.max(this.config.minVolume, Math.round(size));
    if (quantized <= 0) return null;
    const bookSide = bookSideForOrder(side);
    const snapped = snap(price, this.tickSize);
    const level = this._ensureLevel(bookSide, snapped);
    if (level.manualOrders.length >= (this.config.queueDepthCap ?? Infinity)) return null;

    const capacity = this._levelCapacity(level);
    const acceptSize = Math.min(quantized, capacity);
    if (acceptSize <= this.config.minVolume * 0.02) return null;

    const order = this._createManualOrder({ side, price: snapped, size: acceptSize, ownerId });
    if (!this._enqueueOrder(level, order)) return null;
    this.sortLevels();
    return order;
  }

  executeMarketOrder(side, quantity, { limitPrice = null } = {}) {
    const filledLots = [];
    const takeSide = passiveSide(side);
    let remaining = Math.max(0, quantity);
    const now = Date.now();
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
          const detached = this._detachManualOrder(level, order.id) ?? order;
          const refreshed = this._refreshRestingOrder(level, detached, { now, force: true });
          if (!refreshed) {
            this._finalizeOrder(detached);
          }
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
    this._recordBookState(now, this.config.analyticsDepth);

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
    const now = Date.now();
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

    this._recordBookState(now, this.config.analyticsDepth);

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
    this._finalizeOrder(order, "cancelled");
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

  _recordBookState(t = Date.now(), depth = this.config.analyticsDepth ?? 8) {
    const view = this.getBookLevels(depth);
    this.bookStates.push({
      t,
      bestBid: view.bestBid,
      bestAsk: view.bestAsk,
      spread: view.spread,
      mid: view.midPrice,
      last: view.lastPrice,
      bids: view.bids,
      asks: view.asks,
    });
    if (this.bookStates.length > 400) {
      this.bookStates.splice(0, this.bookStates.length - 400);
    }
  }

  consumeEvents() {
    const out = this.orderEvents ?? [];
    this.orderEvents = [];
    return out;
  }

  snapPrice(price) {
    return snap(price, this.tickSize);
  }
}
