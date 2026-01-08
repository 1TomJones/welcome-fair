import { DEFAULT_ENGINE_CONFIG, DEFAULT_PRODUCT } from "./constants.js";
import { DEFAULT_ORDER_BOOK_CONFIG, OrderBook } from "./orderBook.js";
import { averagePrice, clamp } from "./utils.js";

export class MarketEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.bookConfig = { ...DEFAULT_ORDER_BOOK_CONFIG, ...(this.config.orderBook ?? {}) };
    this.orderBook = new OrderBook(this.bookConfig);
    this.priceMode = "orderflow";
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.pendingMarketOrders = this._createPendingMarketOrders();
    this.darkBook = this._createDarkBook();
    this.darkOrders = new Map();
    this.nextDarkOrderId = 1;
    this.reset();
  }

  reset() {
    this.players = new Map();
    this.tickCount = 0;
    this.product = { ...DEFAULT_PRODUCT };
    this.currentPrice = this.product.startPrice;
    this.fairValue = this.product.startPrice;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.orderFlow = 0;
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.pendingMarketOrders = this._createPendingMarketOrders();
    this.darkBook = this._createDarkBook();
    this.darkOrders = new Map();
    this.nextDarkOrderId = 1;
    this.orderBook.reset(this.currentPrice);
  }

  startRound({ startPrice, productName } = {}) {
    const price = Number.isFinite(+startPrice) ? +startPrice : this.config.startPrice ?? DEFAULT_PRODUCT.startPrice;
    this.product = {
      name: productName || DEFAULT_PRODUCT.name,
      startPrice: price,
    };
    this.currentPrice = price;
    this.fairValue = price;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.tickCount = 0;
    this.orderFlow = 0;
    this.priceMode = "orderflow";
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.pendingMarketOrders = this._createPendingMarketOrders();
    this.darkBook = this._createDarkBook();
    this.darkOrders = new Map();
    this.nextDarkOrderId = 1;
    this.orderBook.reset(price);
  }

  getSnapshot() {
    return {
      productName: this.product.name,
      fairValue: this.fairValue,
      price: this.currentPrice,
      priceVelocity: this.priceVelocity,
      tickCount: this.tickCount,
      priceMode: this.priceMode,
      orderFlow: this.orderFlow,
    };
  }

  getOrderBookView(levels = 12) {
    if (!this.orderBook) return null;
    return this.orderBook.getBookLevels(levels);
  }

  getDarkBookView(levels = 12) {
    const bids = this._darkLevelsToArray(this.darkBook.bids, { descending: true, levels });
    const asks = this._darkLevelsToArray(this.darkBook.asks, { descending: false, levels });
    const bestBid = bids.find((lvl) => Number(lvl?.size) > 0)?.price ?? null;
    const bestAsk = asks.find((lvl) => Number(lvl?.size) > 0)?.price ?? null;
    const spread = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? bestAsk - bestBid : null;
    const midPrice =
      Number.isFinite(bestBid) && Number.isFinite(bestAsk)
        ? (bestBid + bestAsk) / 2
        : Number.isFinite(bestBid)
          ? bestBid
          : Number.isFinite(bestAsk)
            ? bestAsk
            : null;
    return {
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      midPrice,
      lastPrice: this.currentPrice,
      tickSize: this.orderBook?.tickSize ?? this.bookConfig?.tickSize ?? null,
    };
  }

  getTopOfBook(levels = 1) {
    const snapshot = this.orderBook.getBookLevels(levels);
    if (!snapshot) return null;
    return {
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      spread: snapshot.spread,
      midPrice: snapshot.midPrice,
      bids: snapshot.bids,
      asks: snapshot.asks,
      lastPrice: this.currentPrice,
    };
  }

  getDepthSnapshot(levels = 10) {
    const view = this.orderBook.getBookLevels(levels);
    if (!view) return { bids: [], asks: [] };
    return { bids: view.bids ?? [], asks: view.asks ?? [], bestBid: view.bestBid, bestAsk: view.bestAsk };
  }

  getLevelDetail(price) {
    const detail = this.orderBook?.getLevelDetail?.(price);
    if (!detail) return null;
    const enrich = (sideDetail) => {
      if (!sideDetail) return null;
      const orders = (sideDetail.orders || []).map((ord) => {
        const player = ord.ownerId ? this.players.get(ord.ownerId) : null;
        return {
          ...ord,
          ownerName: player?.name || ord.ownerId || "unknown",
          isBot: Boolean(player?.isBot),
        };
      });
      return { ...sideDetail, orders };
    };
    return {
      ...detail,
      bid: enrich(detail.bid),
      ask: enrich(detail.ask),
    };
  }

  getBookAnalytics() {
    return this.orderBook?.bookStates ?? [];
  }

  getImbalance(levels = 5) {
    const { bids, asks } = this.getDepthSnapshot(levels);
    const bidVol = bids.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    const askVol = asks.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    if (bidVol + askVol <= 1e-9) return 0;
    return (bidVol - askVol) / (bidVol + askVol);
  }

  recordTrade(event) {
    if (!event) return;
    const entry = {
      t: event.t ?? Date.now(),
      price: Number(event.price ?? this.currentPrice ?? 0),
      size: Math.abs(Math.round(Number(event.size ?? 0))),
      side: event.side === "SELL" ? "SELL" : "BUY",
      takerId: event.takerId ?? null,
      makerIds: Array.isArray(event.makerIds) ? event.makerIds : [],
      symbol: event.symbol || this.product?.symbol || this.product?.name || "INDEX",
      type: event.type || "trade",
    };
    if (!Number.isFinite(entry.price) || !Number.isFinite(entry.size)) return;
    this.tradeTape.push(entry);
    if (this.tradeTape.length > 4000) this.tradeTape.splice(0, this.tradeTape.length - 4000);
    this.lastTradeAt = entry.t;
  }

  recordCancel(event) {
    if (!event) return;
    const entry = {
      t: event.t ?? Date.now(),
      orderId: event.orderId ?? null,
      ownerId: event.ownerId ?? null,
      size: Number(event.size ?? 0),
    };
    this.cancelLog.push(entry);
    if (this.cancelLog.length > 2000) this.cancelLog.splice(0, this.cancelLog.length - 2000);
  }

  getRecentTrades(lookbackMs = 60_000) {
    const cutoff = Date.now() - lookbackMs;
    return this.tradeTape.filter((t) => t.t >= cutoff);
  }

  getVolMetrics(windowMs = 60_000) {
    const trades = this.getRecentTrades(windowMs);
    if (!trades.length) {
      return { sigma: 0, mean: this.currentPrice, count: 0 };
    }
    const prices = trades.map((t) => t.price);
    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
    return { sigma: Math.sqrt(variance), mean, count: trades.length };
  }

  getNewsEvents(_opts = {}) {
    return [];
  }

  setPriceMode(mode) {
    this.priceMode = "orderflow";
    this.orderFlow = 0;
    this.orderBook.reset(this.currentPrice);
    return this.priceMode;
  }

  updateOrderBookConfig(patch = {}) {
    if (!patch || typeof patch !== "object") return;
    const icebergPatch = patch.iceberg ?? null;
    const mergedIceberg = icebergPatch
      ? { ...(this.bookConfig.iceberg ?? {}), ...icebergPatch }
      : this.bookConfig.iceberg;
    this.bookConfig = { ...this.bookConfig, ...patch, iceberg: mergedIceberg };
    this.orderBook.config = { ...this.orderBook.config, ...this.bookConfig, iceberg: mergedIceberg };
    if (Number.isFinite(this.bookConfig.tickSize)) {
      this.orderBook.tickSize = this.bookConfig.tickSize;
    }
    this.orderBook.tickMaintenance({ center: this.currentPrice });
    this._syncOrderBookEvents();
  }

  applyOrderBookPreset(name) {
    const preset = String(name || "").toLowerCase();
    let patch = null;
    if (preset === "thin-book") {
      patch = { queueDepthCap: 10, maxLevelSize: 50, refreshProbability: 0.08, refreshDelayMs: 3200 };
    } else if (preset === "iceberg-refresh") {
      patch = {
        refreshProbability: 0.32,
        refreshDelayMs: 1600,
        queueDepthCap: 32,
        iceberg: { enabled: true, displayFraction: 0.3, minClip: 0.6 },
      };
    } else if (preset === "sticky-book") {
      patch = { passiveDecay: 0.98, restingMaxAgeMs: 90_000, refreshProbability: 0.12, maxLevelSize: 120 };
    }
    if (!patch) return { ok: false, message: `Unknown order book preset: ${name}` };
    this.updateOrderBookConfig(patch);
    return { ok: true, preset };
  }

  registerPlayer(id, name, options = {}) {
    if (!id) throw new Error("Player id is required");
    const rawMaxPosition = options.maxPosition;
    const maxPosition =
      rawMaxPosition === Infinity ? Infinity : Number.isFinite(rawMaxPosition) ? Math.abs(rawMaxPosition) : undefined;
    const rawMaxLoss = options.maxLoss;
    const maxLoss = Number.isFinite(rawMaxLoss) ? Math.abs(rawMaxLoss) : undefined;
    const player = {
      id,
      name,
      position: 0,
      avgPrice: null,
      cash: 0,
      pnl: 0,
      isBot: Boolean(options.isBot),
      meta: options.meta ?? null,
      maxPosition,
      maxLoss,
      orders: new Map(),
      darkOrders: new Map(),
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.orderBook.cancelAllForOwner(id);
    this.cancelDarkOrders(id);
    this.players.delete(id);
  }

  getPlayer(id) {
    return this.players.get(id) ?? null;
  }

  getPlayerOrders(id) {
    const player = this.players.get(id);
    if (!player) return [];
    const litOrders = Array.from(player.orders.values());
    const darkOrders = Array.from(player.darkOrders.values());
    return [...litOrders, ...darkOrders]
      .map((ord) => ({
        id: ord.id,
        side: ord.side,
        price: ord.price,
        remaining: ord.remainingUnits,
        createdAt: ord.createdAt,
        type: ord.type ?? "lit",
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

  getPublicRoster() {
    return Array.from(this.players.values()).map((p) => ({
      name: p.name,
      position: p.position,
      pnl: p.pnl,
      avgCost: p.avgPrice ?? 0,
      isBot: Boolean(p.isBot),
    }));
  }

  updatePnl(player) {
    if (!player) return;
    player.pnl = player.cash + player.position * this.currentPrice;
  }

  recomputePnLAll() {
    for (const player of this.players.values()) {
      this.updatePnl(player);
    }
  }

  _createTickActivity() {
    return {
      marketOrders: 0,
      limitOrders: 0,
      marketVolume: 0,
      limitVolume: 0,
      marketBuyVolume: 0,
      marketSellVolume: 0,
      marketCrossVolume: 0,
      remainderToBookVolume: 0,
      cancelCount: 0,
      replaceCount: 0,
    };
  }

  _createPendingMarketOrders() {
    return {
      buys: [],
      sells: [],
    };
  }

  _createDarkBook() {
    return {
      bids: new Map(),
      asks: new Map(),
    };
  }

  _lotSize() {
    return Math.max(0.0001, this.config.tradeLotSize ?? 1);
  }

  _normalizeLots(qty) {
    const lots = Math.round(Math.abs(Number(qty) || 0));
    return Math.max(0, lots);
  }

  _outstandingUnits(player, side) {
    let total = 0;
    for (const order of player.orders.values()) {
      if (order.side === side) {
        total += order.remainingUnits;
      }
    }
    return total;
  }

  _outstandingDarkUnits(player, side) {
    let total = 0;
    for (const order of player.darkOrders.values()) {
      if (order.side === side) {
        total += order.remainingUnits;
      }
    }
    return total;
  }

  _lossLimitForPlayer(player) {
    const limit = player?.maxLoss ?? this.config.maxLoss;
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return Math.abs(limit);
  }

  _isLossLimitBreached(player) {
    const limit = this._lossLimitForPlayer(player);
    if (!limit) return false;
    return Number(player?.pnl ?? 0) <= -limit;
  }

  _capacityForSide(player, side) {
    const maxPos = player?.maxPosition != null ? player.maxPosition : this.config.maxPosition;
    if (side === "BUY") {
      return Math.max(0, maxPos - player.position);
    }
    return Math.max(0, player.position + maxPos);
  }

  _syncOrderBookEvents() {
    const events = this.orderBook?.consumeEvents?.() ?? [];
    if (!events.length) return;
    const lotSize = this._lotSize();
    for (const evt of events) {
      const player = evt.ownerId ? this.players.get(evt.ownerId) : null;
      if (!player) continue;
      if (evt.type === "expired" || evt.type === "cancelled") {
        if (evt.type === "cancelled" && !player.orders.has(evt.orderId)) continue;
        player.orders.delete(evt.orderId);
        this.recordCancel({ orderId: evt.orderId, ownerId: evt.ownerId, size: evt.remaining });
        continue;
      }
      if (evt.type === "refresh" || evt.type === "resize") {
        const entry = player.orders.get(evt.orderId);
        if (!entry) continue;
        entry.remainingUnits = Math.max(0, (evt.remaining ?? 0) / lotSize);
        player.orders.set(entry.id, entry);
      }
    }
  }

  _recordRestingOrder(player, order) {
    if (!order) return null;
    const lotSize = this._lotSize();
    const entry = {
      id: order.id,
      side: order.side,
      price: order.price,
      remainingUnits: order.remaining / lotSize,
      createdAt: order.createdAt,
      type: "lit",
    };
    player.orders.set(entry.id, entry);
    return { ...entry };
  }

  _recordDarkOrder(player, order) {
    if (!order) return null;
    const entry = {
      id: order.id,
      side: order.side,
      price: order.price,
      remainingUnits: order.remaining,
      createdAt: order.createdAt,
      type: "dark",
    };
    player.darkOrders.set(entry.id, entry);
    return { ...entry };
  }

  _darkSideMap(side) {
    return side === "BUY" ? this.darkBook.bids : this.darkBook.asks;
  }

  _darkLevelKey(price) {
    return price.toFixed(6);
  }

  _getDarkLevel(side, price) {
    const map = this._darkSideMap(side);
    return map.get(this._darkLevelKey(price)) ?? null;
  }

  _ensureDarkLevel(side, price) {
    const map = this._darkSideMap(side);
    const key = this._darkLevelKey(price);
    let level = map.get(key);
    if (!level) {
      level = { side, price, orders: [], totalVolume: 0 };
      map.set(key, level);
    }
    return level;
  }

  _darkLevelsToArray(map, { descending = false, levels = 12 } = {}) {
    const sorted = Array.from(map.values()).sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
    const result = [];
    for (const level of sorted) {
      const size = Number(level.totalVolume ?? 0);
      if (size <= 1e-9) continue;
      result.push({ price: level.price, size });
      if (result.length >= levels) break;
    }
    return result;
  }

  _detachDarkOrder(orderId) {
    const order = this.darkOrders.get(orderId);
    if (!order) return null;
    const level = this._getDarkLevel(order.side, order.price);
    if (level) {
      const idx = level.orders.findIndex((entry) => entry.id === orderId);
      if (idx >= 0) {
        const [entry] = level.orders.splice(idx, 1);
        level.totalVolume = Math.max(0, level.totalVolume - entry.remaining);
      }
      if (!level.orders.length || level.totalVolume <= 1e-9) {
        this._darkSideMap(order.side).delete(this._darkLevelKey(order.price));
      }
    }
    this.darkOrders.delete(orderId);
    const owner = order.ownerId ? this.players.get(order.ownerId) : null;
    if (owner) {
      owner.darkOrders.delete(orderId);
    }
    return order;
  }

  _addDarkOrder({ side, price, size, ownerId }) {
    const quantized = Math.max(0, Math.round(size));
    if (quantized <= 0) return null;
    const order = {
      id: `d${this.nextDarkOrderId++}`,
      ownerId,
      side,
      price,
      remaining: quantized,
      createdAt: Date.now(),
    };
    const level = this._ensureDarkLevel(side, price);
    level.orders.push(order);
    level.totalVolume += order.remaining;
    this.darkOrders.set(order.id, order);
    const player = ownerId ? this.players.get(ownerId) : null;
    if (player) {
      this._recordDarkOrder(player, order);
    }
    return order;
  }

  _matchDarkOrder(player, side, price, qty) {
    const oppositeSide = side === "BUY" ? "SELL" : "BUY";
    const level = this._getDarkLevel(oppositeSide, price);
    if (!level || !level.orders.length) {
      return { filled: 0, remaining: qty, fills: [] };
    }

    const fills = [];
    let remaining = qty;
    const lotSize = this._lotSize();
    while (remaining > 1e-9 && level.orders.length) {
      const makerOrder = level.orders[0];
      const maker = makerOrder?.ownerId ? this.players.get(makerOrder.ownerId) : null;
      if (!maker || makerOrder.remaining <= 1e-9) {
        this._detachDarkOrder(makerOrder.id);
        continue;
      }
      if (this._isLossLimitBreached(maker)) {
        this._detachDarkOrder(makerOrder.id);
        continue;
      }
      const takerCap = this._capacityForSide(player, side);
      const makerCap = this._capacityForSide(maker, makerOrder.side);
      const execQty = Math.min(remaining, makerOrder.remaining, takerCap, makerCap);
      if (execQty <= 1e-9) break;

      const signed = side === "BUY" ? execQty : -execQty;
      const actualTaker = this._applyExecution(player, signed, price);
      const actualMaker = this._applyExecution(maker, -signed, price);
      const filled = Math.min(Math.abs(actualTaker), Math.abs(actualMaker));
      if (filled <= 1e-9) break;

      makerOrder.remaining = Math.max(0, makerOrder.remaining - filled);
      level.totalVolume = Math.max(0, level.totalVolume - filled);
      remaining = Math.max(0, remaining - filled);
      const makerEntry = maker.darkOrders.get(makerOrder.id);
      if (makerEntry) {
        makerEntry.remainingUnits = Math.max(0, makerEntry.remainingUnits - filled);
        if (makerEntry.remainingUnits <= 1e-9) {
          maker.darkOrders.delete(makerOrder.id);
        } else {
          maker.darkOrders.set(makerEntry.id, makerEntry);
        }
      }
      if (makerOrder.remaining <= 1e-9) {
        this._detachDarkOrder(makerOrder.id);
      }

      fills.push({
        ownerId: makerOrder.ownerId,
        orderId: makerOrder.id,
        size: filled * lotSize,
        price,
      });
      this.recordTrade({
        price,
        size: filled,
        side,
        takerId: player.id,
        makerIds: makerOrder.ownerId ? [makerOrder.ownerId] : [],
        type: "dark",
      });
    }

    if (!level.orders.length || level.totalVolume <= 1e-9) {
      this._darkSideMap(oppositeSide).delete(this._darkLevelKey(price));
    }

    return { filled: qty - remaining, remaining, fills };
  }

  _reduceOutstandingOrder(player, orderId, filledLots) {
    if (!orderId || !player) return;
    const entry = player.orders.get(orderId);
    if (!entry) return;
    const lotSize = this._lotSize();
    const filledUnits = filledLots / lotSize;
    entry.remainingUnits = Math.max(0, entry.remainingUnits - filledUnits);
    if (entry.remainingUnits <= 1e-6) {
      player.orders.delete(orderId);
    } else {
      player.orders.set(orderId, entry);
    }
  }

  _applyExecution(player, signedQty, price) {
    const maxPos = player?.maxPosition != null ? player.maxPosition : this.config.maxPosition;
    const prev = player.position;
    const next = clamp(prev + signedQty, -maxPos, maxPos);
    const actual = next - prev;
    if (Math.abs(actual) <= 1e-9) return 0;

    player.cash -= actual * price;
    const isCrossing = prev !== 0 && Math.sign(prev) !== Math.sign(next);

    if (Math.abs(next) < 1e-6) {
      player.avgPrice = null;
    } else if (Math.abs(prev) < 1e-6 || isCrossing) {
      player.avgPrice = price;
    } else if (Math.sign(prev) === Math.sign(next)) {
      if (Math.abs(next) > Math.abs(prev)) {
        player.avgPrice = averagePrice({
          previousAvg: player.avgPrice,
          previousQty: prev,
          tradePrice: price,
          tradeQty: actual,
        });
      }
    }

    player.position = next;
    this.updatePnl(player);
    return actual;
  }

  _recordMarketExecution(side, volume, { remainder = false, trackCross = true } = {}) {
    const executed = Math.abs(Number(volume) || 0);
    if (executed <= 1e-9) return;
    if (side === "BUY") {
      this.tickActivity.marketBuyVolume += executed;
    } else {
      this.tickActivity.marketSellVolume += executed;
    }
    if (remainder) {
      this.tickActivity.remainderToBookVolume += executed;
    } else if (trackCross) {
      this.tickActivity.marketCrossVolume += executed;
    }
  }

  _handleCounterpartyFills(fills, takerSide, lotSize) {
    if (!fills?.length) return;
    const makerSide = takerSide === "BUY" ? "SELL" : "BUY";
    for (const fill of fills) {
      if (!fill?.ownerId || !fill.size) continue;
      const maker = this.players.get(fill.ownerId);
      if (!maker) continue;
      const units = fill.size / lotSize;
      if (units <= 0) continue;
      const signed = makerSide === "BUY" ? units : -units;
      const actual = this._applyExecution(maker, signed, fill.price);
      if (Math.abs(actual) > 1e-9) {
        this._reduceOutstandingOrder(maker, fill.orderId, Math.abs(actual) * lotSize);
      }
    }
  }

  _recordTradeEvents(fills, takerSide, lotSize, takerId) {
    if (!fills?.length) return;
    for (const fill of fills) {
      const sizeLots = Number(fill.size || 0);
      if (sizeLots <= 0) continue;
      const units = sizeLots / lotSize;
      this.recordTrade({
        price: fill.price,
        size: units,
        side: takerSide,
        takerId,
        makerIds: fill.ownerId ? [fill.ownerId] : [],
        type: "match",
      });
    }
  }

  _processQueuedMarketOrders() {
    const executions = this.orderBook.drainMarketQueue();
    if (!executions.length) return [];
    const lotSize = this._lotSize();
    for (const exec of executions) {
      const player = exec.ownerId ? this.players.get(exec.ownerId) : null;
      if (!player) continue;
      if (this._isLossLimitBreached(player)) continue;
      const executedUnits = exec.filled / lotSize;
      if (executedUnits <= 0) continue;
      const signed = exec.side === "BUY" ? executedUnits : -executedUnits;
      const actual = this._applyExecution(player, signed, exec.avgPrice ?? this.currentPrice);
      this._recordMarketExecution(exec.side, actual, { remainder: true });
      if (Math.abs(actual) > 1e-9) {
        this.orderFlow += actual;
        this.orderFlow = clamp(this.orderFlow, -50, 50);
      }
      if (exec.fills?.length) {
        this._handleCounterpartyFills(exec.fills, exec.side, lotSize);
        this._recordTradeEvents(exec.fills, exec.side, lotSize, exec.ownerId);
        this.currentPrice = exec.fills.at(-1).price ?? exec.avgPrice ?? this.currentPrice;
      } else if (exec.avgPrice) {
        this.currentPrice = exec.avgPrice;
      }
    }
    this.orderBook.tickMaintenance({ center: this.currentPrice });
    return executions;
  }

  _enqueueMarketOrder(player, side, qty) {
    if (!player || qty <= 0) return null;
    const entry = {
      ownerId: player.id,
      side,
      remaining: qty,
      createdAt: Date.now(),
    };
    if (side === "BUY") {
      this.pendingMarketOrders.buys.push(entry);
    } else {
      this.pendingMarketOrders.sells.push(entry);
    }
    this.tickActivity.marketOrders += 1;
    this.tickActivity.marketVolume += Math.abs(qty);
    return entry;
  }

  _executeMarketOrderAgainstBook(player, side, qty) {
    if (!player || qty <= 0) return null;
    if (this._isLossLimitBreached(player)) return null;
    const capacity = this._capacityForSide(player, side);
    const effectiveQty = Math.min(qty, capacity);
    if (effectiveQty <= 1e-9) return null;
    const lotSize = this._lotSize();
    const totalLots = effectiveQty * lotSize;
    const result = this.orderBook.executeMarketOrder(side, totalLots, {
      ownerId: player.id,
      restOnNoLiquidity: true,
    });
    const hasQueued = Boolean(result.queued);
    if (result.filled <= 1e-8 && !hasQueued) return null;

    const executedUnits = result.filled / lotSize;
    const signed = side === "BUY" ? executedUnits : -executedUnits;
    const actual = this._applyExecution(player, signed, result.avgPrice ?? this.currentPrice);
    this._recordMarketExecution(side, actual, { remainder: true });

    if (result.fills?.length) {
      this._handleCounterpartyFills(result.fills, side, lotSize);
      this._recordTradeEvents(result.fills, side, lotSize, player.id);
      this.currentPrice = result.fills.at(-1).price ?? result.avgPrice ?? this.currentPrice;
    } else if (result.avgPrice) {
      this.currentPrice = result.avgPrice;
    }

    if (result.fills?.length || result.avgPrice) {
      this.orderBook.tickMaintenance({ center: this.currentPrice });
    }

    this._syncOrderBookEvents();

    if (Math.abs(actual) > 1e-9) {
      this.orderFlow += actual;
      this.orderFlow = clamp(this.orderFlow, -50, 50);
    }

    return {
      filled: Math.abs(actual),
      qty: actual,
      price: result.avgPrice ?? this.currentPrice,
      fills: result.fills ?? [],
      queued: result.queued ?? null,
    };
  }

  _matchPendingMarketOrders() {
    const pendingBuys = this.pendingMarketOrders.buys;
    const pendingSells = this.pendingMarketOrders.sells;
    if (!pendingBuys.length && !pendingSells.length) return;

    const crossPrice = Number.isFinite(this.orderBook.lastTradePrice)
      ? this.orderBook.lastTradePrice
      : this.currentPrice;
    let buyIndex = 0;
    let sellIndex = 0;
    let crossedAny = false;

    while (buyIndex < pendingBuys.length && sellIndex < pendingSells.length) {
      const buy = pendingBuys[buyIndex];
      const sell = pendingSells[sellIndex];
      const buyer = buy?.ownerId ? this.players.get(buy.ownerId) : null;
      const seller = sell?.ownerId ? this.players.get(sell.ownerId) : null;

      if (!buyer || buy.remaining <= 1e-9) {
        buyIndex += 1;
        continue;
      }
      if (!seller || sell.remaining <= 1e-9) {
        sellIndex += 1;
        continue;
      }
      if (this._isLossLimitBreached(buyer)) {
        buy.remaining = 0;
        buyIndex += 1;
        continue;
      }
      if (this._isLossLimitBreached(seller)) {
        sell.remaining = 0;
        sellIndex += 1;
        continue;
      }

      const buyCapacity = this._capacityForSide(buyer, "BUY");
      const sellCapacity = this._capacityForSide(seller, "SELL");
      const execQty = Math.min(buy.remaining, sell.remaining, buyCapacity, sellCapacity);
      if (execQty <= 1e-9) {
        if (buyCapacity <= 1e-9) buyIndex += 1;
        if (sellCapacity <= 1e-9) sellIndex += 1;
        continue;
      }

      const buyFilled = Math.abs(this._applyExecution(buyer, execQty, crossPrice));
      const sellFilled = Math.abs(this._applyExecution(seller, -execQty, crossPrice));
      const filled = Math.min(buyFilled, sellFilled);
      if (filled <= 1e-9) {
        if (buyFilled <= 1e-9) buyIndex += 1;
        if (sellFilled <= 1e-9) sellIndex += 1;
        continue;
      }

      buy.remaining = Math.max(0, buy.remaining - filled);
      sell.remaining = Math.max(0, sell.remaining - filled);
      if (buy.remaining <= 1e-9) buyIndex += 1;
      if (sell.remaining <= 1e-9) sellIndex += 1;
      crossedAny = true;

      this._recordMarketExecution("BUY", filled, { trackCross: true });
      this._recordMarketExecution("SELL", filled, { trackCross: false });
      this.recordTrade({
        price: crossPrice,
        size: filled,
        side: "BUY",
        takerId: buyer.id,
        makerIds: seller.id ? [seller.id] : [],
        type: "cross",
      });
    }

    if (crossedAny) {
      this.currentPrice = crossPrice;
      this.orderBook.lastTradePrice = crossPrice;
    }

    for (const entry of pendingBuys) {
      if (entry.remaining <= 1e-9) continue;
      const player = entry.ownerId ? this.players.get(entry.ownerId) : null;
      if (!player) continue;
      this._executeMarketOrderAgainstBook(player, "BUY", entry.remaining);
    }

    for (const entry of pendingSells) {
      if (entry.remaining <= 1e-9) continue;
      const player = entry.ownerId ? this.players.get(entry.ownerId) : null;
      if (!player) continue;
      this._executeMarketOrderAgainstBook(player, "SELL", entry.remaining);
    }

    this.pendingMarketOrders = this._createPendingMarketOrders();
  }

  processTrade(id, side, quantity = 1) {
    return this.executeMarketOrderForPlayer({ id, side, quantity });
  }

  executeMarketOrderForPlayer({ id, side, quantity }) {
    const player = this.players.get(id);
    if (!player) return null;
    if (this._isLossLimitBreached(player)) {
      return { filled: false, player, reason: "loss-limit" };
    }

    const normalized = side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : null;
    if (!normalized) return null;

    const capacity = this._capacityForSide(player, normalized);
    const requestedLots = this._normalizeLots(quantity);
    const qty = Math.min(capacity, Math.max(1, requestedLots || 1));
    if (qty <= 0) {
      return { filled: false, player, reason: "position-limit" };
    }

    if (this.priceMode !== "orderflow") {
      this.tickActivity.marketOrders += 1;
      this.tickActivity.marketVolume += qty;
      const signed = normalized === "BUY" ? qty : -qty;
      const actual = this._applyExecution(player, signed, this.currentPrice);
      if (Math.abs(actual) <= 1e-9) {
        return { filled: false, player, reason: "position-limit" };
      }
      this.orderFlow += actual;
      this.orderFlow = clamp(this.orderFlow, -50, 50);
      this._recordMarketExecution(normalized, actual);
      return {
        filled: true,
        player,
        side: normalized,
        qty: actual,
        price: this.currentPrice,
        fills: [],
      };
    }

    this._enqueueMarketOrder(player, normalized, qty);
    return {
      filled: 0,
      player,
      side: normalized,
      qty: 0,
      price: this.currentPrice,
      fills: [],
      queued: true,
    };
  }

  submitOrder(id, order) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: "unknown-player" };
    if (this._isLossLimitBreached(player)) return { ok: false, reason: "loss-limit" };

    const type = order?.type === "dark" ? "dark" : order?.type === "limit" ? "limit" : "market";
    const normalized = order?.side === "SELL" ? "SELL" : order?.side === "BUY" ? "BUY" : null;
    if (!normalized) return { ok: false, reason: "bad-side" };

    if (type === "market") {
      const result = this.executeMarketOrderForPlayer({ id, side: normalized, quantity: order?.quantity });
      const filledUnits = Number(result?.filled ?? 0);
      return { ok: filledUnits > 1e-9 || Boolean(result?.queued), ...result, type };
    }

    const requestedLots = this._normalizeLots(order?.quantity);
    const qty = Math.max(0, requestedLots);
    if (qty <= 0) {
      return { ok: false, reason: "bad-quantity" };
    }

    const priceNum = Number(order?.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return { ok: false, reason: "bad-price" };
    }
    const snappedPrice = this.orderBook?.snapPrice?.(priceNum) ?? priceNum;
    if (type === "dark") {
      const capacity = this._capacityForSide(player, normalized);
      const outstanding = this._outstandingUnits(player, normalized) + this._outstandingDarkUnits(player, normalized);
      const available = Math.max(0, capacity - outstanding);
      const effectiveQty = Math.min(qty, available);
      if (effectiveQty <= 0) {
        return { ok: false, reason: "position-limit" };
      }
      const match = this._matchDarkOrder(player, normalized, snappedPrice, effectiveQty);
      const executedUnits = match.filled;
      let resting = null;
      if (match.remaining > 1e-9) {
        const newOrder = this._addDarkOrder({
          side: normalized,
          price: snappedPrice,
          size: match.remaining,
          ownerId: id,
        });
        resting = newOrder ? this._recordDarkOrder(player, newOrder) : null;
      }
      return {
        ok: true,
        type,
        side: normalized,
        filled: executedUnits,
        price: snappedPrice,
        resting,
        fills: match.fills ?? [],
      };
    }

    const lotSize = this._lotSize();
    const capacity = this._capacityForSide(player, normalized);
    const outstanding = this._outstandingUnits(player, normalized) + this._outstandingDarkUnits(player, normalized);
    const available = Math.max(0, capacity - outstanding);
    const effectiveQty = Math.min(qty, available);
    if (effectiveQty <= 0) {
      return { ok: false, reason: "position-limit" };
    }

    const outcome = this.orderBook.placeLimitOrder({
      side: normalized,
      price: snappedPrice,
      size: effectiveQty * lotSize,
      ownerId: id,
    });

    let executedUnits = 0;
    if (outcome.filled > 0) {
      executedUnits = outcome.filled / lotSize;
      const signed = normalized === "BUY" ? executedUnits : -executedUnits;
      const actual = this._applyExecution(player, signed, outcome.avgPrice ?? priceNum);
      executedUnits = Math.abs(actual);
      this.orderFlow += actual;
      this.orderFlow = clamp(this.orderFlow, -50, 50);
      this._handleCounterpartyFills(outcome.fills, normalized, lotSize);
      this._recordTradeEvents(outcome.fills, normalized, lotSize, id);
      if (outcome.fills?.length) {
        this.currentPrice = outcome.fills.at(-1).price ?? outcome.avgPrice ?? this.currentPrice;
      }
    }

    this.tickActivity.limitOrders += 1;
    this.tickActivity.limitVolume += executedUnits > 0 ? executedUnits : effectiveQty;

    this.orderBook.tickMaintenance({ center: this.currentPrice });
    this._processQueuedMarketOrders();
    this._syncOrderBookEvents();

    let resting = null;
    if (outcome.resting) {
      resting = this._recordRestingOrder(player, outcome.resting);
    }

    return {
      ok: true,
      type,
      side: normalized,
      filled: executedUnits,
      price: outcome.avgPrice ?? snappedPrice,
      resting,
      fills: outcome.fills ?? [],
    };
  }

  cancelOrders(id, orderIds) {
    const player = this.players.get(id);
    if (!player) return [];
    const lotSize = this._lotSize();
    const targets = Array.isArray(orderIds) && orderIds.length
      ? orderIds
      : [...player.orders.keys(), ...player.darkOrders.keys()];
    const results = [];
    for (const orderId of targets) {
      if (player.orders.has(orderId)) {
        const res = this.orderBook.cancelOrder(orderId);
        if (!res) continue;
        player.orders.delete(orderId);
        this.recordCancel({ orderId: res.id, ownerId: id, size: res.remaining });
        results.push({
          id: res.id,
          side: res.side,
          price: res.price,
          remaining: res.remaining / lotSize,
          type: "lit",
        });
        continue;
      }
      if (player.darkOrders.has(orderId)) {
        const removed = this._detachDarkOrder(orderId);
        if (!removed) continue;
        results.push({
          id: removed.id,
          side: removed.side,
          price: removed.price,
          remaining: removed.remaining,
          type: "dark",
        });
        this.recordCancel({ orderId: removed.id, ownerId: removed.ownerId, size: removed.remaining });
      }
    }
    if (results.length) {
      this.tickActivity.cancelCount += results.length;
    }
    return results;
  }

  cancelDarkOrders(id, orderIds) {
    const player = this.players.get(id);
    if (!player) return [];
    const targets = Array.isArray(orderIds) && orderIds.length ? orderIds : Array.from(player.darkOrders.keys());
    const results = [];
    for (const orderId of targets) {
      if (!player.darkOrders.has(orderId)) continue;
      const removed = this._detachDarkOrder(orderId);
      if (!removed) continue;
      results.push({
        id: removed.id,
        side: removed.side,
        price: removed.price,
        remaining: removed.remaining,
        type: "dark",
      });
      this.recordCancel({ orderId: removed.id, ownerId: removed.ownerId, size: removed.remaining });
    }
    if (results.length) {
      this.tickActivity.cancelCount += results.length;
    }
    return results;
  }

  closeAllForPlayer(id) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: "unknown-player", canceled: [], flatten: null };

    const canceled = this.cancelOrders(id);
    const position = Number(player.position || 0);
    let flatten = null;
    if (Math.abs(position) > 1e-9) {
      const side = position > 0 ? "SELL" : "BUY";
      flatten = this.executeMarketOrderForPlayer({ id, side, quantity: Math.abs(position) });
    }
    return { ok: true, canceled, flatten };
  }

  pushNews(_input) {
    const delta = Number(_input?.delta);
    if (Number.isFinite(delta) && delta !== 0) {
      if (!Number.isFinite(this.fairValue)) {
        this.fairValue = Number.isFinite(this.currentPrice) ? this.currentPrice : 0;
      }
      this.fairValue += delta;
    }
    return this.fairValue;
  }

  getPlayerConstraints() {
    return {
      maxPosition: this.config.maxPosition,
      maxLoss: this.config.maxLoss ?? null,
    };
  }

  setPlayerConstraints({ maxPosition, maxLoss } = {}) {
    if (Number.isFinite(maxPosition)) {
      this.config.maxPosition = Math.max(0, Math.abs(maxPosition));
    }
    if (maxLoss === null) {
      this.config.maxLoss = null;
    } else if (Number.isFinite(maxLoss)) {
      this.config.maxLoss = Math.max(0, Math.abs(maxLoss));
    }
    return this.getPlayerConstraints();
  }

  stepTick() {
    const previousPrice = this.currentPrice;
    this.stepOrderBook();
    this.recomputePnLAll();
    this.tickCount += 1;
    const snapshot = this.getSnapshot();
    snapshot.previousPrice = previousPrice;
    snapshot.priceChange = snapshot.price - previousPrice;
    snapshot.metrics = this.collectTickMetrics();
    return snapshot;
  }

  stepOrderBook() {
    this._matchPendingMarketOrders();
    this.orderBook.tickMaintenance({ center: this.currentPrice });
    this._processQueuedMarketOrders();
    this._syncOrderBookEvents();
    const decay = this.config.orderFlowDecay ?? 0.4;
    this.orderFlow *= decay;
    this.priceVelocity = 0;
    const lastTrade = this.orderBook.lastTradePrice;
    if (Number.isFinite(lastTrade)) {
      this.currentPrice = lastTrade;
    }
  }

  collectTickMetrics() {
    const view = this.getOrderBookView(3) || {};
    const bids = Array.isArray(view.bids) ? view.bids.slice(0, 3) : [];
    const asks = Array.isArray(view.asks) ? view.asks.slice(0, 3) : [];
    const sumSizes = (levels) => levels.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    const depthBid = sumSizes(bids);
    const depthAsk = sumSizes(asks);
    const marketOrders = this.tickActivity.marketOrders || 0;
    const limitOrders = this.tickActivity.limitOrders || 0;
    const totalOrders = marketOrders + limitOrders;
    const marketShare = totalOrders > 0 ? marketOrders / totalOrders : 0;
    const marketBuyVolume = this.tickActivity.marketBuyVolume || 0;
    const marketSellVolume = this.tickActivity.marketSellVolume || 0;
    const marketVolumeTotal = marketBuyVolume + marketSellVolume;
    const marketImbalance = marketVolumeTotal > 0 ? (marketBuyVolume - marketSellVolume) / marketVolumeTotal : 0;
    const metrics = {
      t: Date.now(),
      tick: this.tickCount,
      spread: Number(view.spread ?? 0),
      bestBid: view.bestBid ?? null,
      bestAsk: view.bestAsk ?? null,
      marketOrders,
      limitOrders,
      marketShare,
      marketVolume: this.tickActivity.marketVolume || 0,
      limitVolume: this.tickActivity.limitVolume || 0,
      marketBuyVolume,
      marketSellVolume,
      marketCrossVolume: this.tickActivity.marketCrossVolume || 0,
      remainderToBookVolume: this.tickActivity.remainderToBookVolume || 0,
      marketImbalance,
      cancelCount: this.tickActivity.cancelCount || 0,
      replaceCount: this.tickActivity.replaceCount || 0,
      depthTop3: { bid: depthBid, ask: depthAsk },
    };
    this.tickActivity = this._createTickActivity();
    return metrics;
  }
}
