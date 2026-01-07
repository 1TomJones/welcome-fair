import { DEFAULT_ENGINE_CONFIG, DEFAULT_PRODUCT } from "./constants.js";
import { DEFAULT_ORDER_BOOK_CONFIG, OrderBook } from "./orderBook.js";
import { averagePrice, clamp } from "./utils.js";

export class MarketEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.bookConfig = { ...DEFAULT_ORDER_BOOK_CONFIG, ...(this.config.orderBook ?? {}) };
    this.orderBook = new OrderBook(this.bookConfig);
    this.priceMode = "orderflow";
    this.flowPlayerId = "flow-scheduler";
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.reset();
  }

  reset() {
    this.players = new Map();
    this.tickCount = 0;
    this.product = { ...DEFAULT_PRODUCT };
    this.currentPrice = this.product.startPrice;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.orderFlow = 0;
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.orderBook.reset(this.currentPrice);
    this._resetBurstScheduler();
  }

  startRound({ startPrice, productName } = {}) {
    const price = Number.isFinite(+startPrice) ? +startPrice : this.config.startPrice ?? DEFAULT_PRODUCT.startPrice;
    this.product = {
      name: productName || DEFAULT_PRODUCT.name,
      startPrice: price,
    };
    this.currentPrice = price;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.tickCount = 0;
    this.orderFlow = 0;
    this.priceMode = "orderflow";
    this.tradeTape = [];
    this.cancelLog = [];
    this.tickActivity = this._createTickActivity();
    this.orderBook.reset(price);
    this._resetBurstScheduler();
  }

  getSnapshot() {
    return {
      productName: this.product.name,
      fairValue: this.currentPrice,
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
    const player = {
      id,
      name,
      position: 0,
      avgPrice: null,
      cash: 0,
      pnl: 0,
      isBot: Boolean(options.isBot),
      meta: options.meta ?? null,
      orders: new Map(),
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.orderBook.cancelAllForOwner(id);
    this.players.delete(id);
  }

  getPlayer(id) {
    return this.players.get(id) ?? null;
  }

  getPlayerOrders(id) {
    const player = this.players.get(id);
    if (!player) return [];
    const orders = Array.from(player.orders.values());
    return orders
      .map((ord) => ({
        id: ord.id,
        side: ord.side,
        price: ord.price,
        remaining: ord.remainingUnits,
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
      cancelCount: 0,
      replaceCount: 0,
    };
  }

  _getBurstConfig() {
    const defaults = DEFAULT_ENGINE_CONFIG.burst ?? {};
    const burst = this.config.burst ?? {};
    const minTicks = Math.max(1, Math.floor(burst.minTicks ?? defaults.minTicks ?? 1));
    const maxTicks = Math.max(minTicks, Math.floor(burst.maxTicks ?? defaults.maxTicks ?? minTicks));
    const minOrdersPerTick = Math.max(1, Math.floor(burst.minOrdersPerTick ?? defaults.minOrdersPerTick ?? 1));
    const maxOrdersPerTick = Math.max(
      minOrdersPerTick,
      Math.floor(burst.maxOrdersPerTick ?? defaults.maxOrdersPerTick ?? minOrdersPerTick)
    );
    const buyBias = clamp(Number(burst.buyBias ?? defaults.buyBias ?? 0.5), 0, 1);
    return { minTicks, maxTicks, minOrdersPerTick, maxOrdersPerTick, buyBias };
  }

  _randomInt(min, max) {
    if (max <= min) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _ensureFlowPlayer() {
    const existing = this.players.get(this.flowPlayerId);
    if (existing) return existing;
    return this.registerPlayer(this.flowPlayerId, "Flow Scheduler", { isBot: true, meta: { system: true } });
  }

  _resetFlowPlayer() {
    const player = this._ensureFlowPlayer();
    this.orderBook.cancelAllForOwner(player.id);
    player.position = 0;
    player.avgPrice = null;
    player.cash = 0;
    player.pnl = 0;
    player.orders.clear();
    return player;
  }

  _resetBurstScheduler() {
    const burst = this._getBurstConfig();
    this.flowState = "SILENCE";
    this.burstTicksRemaining = 0;
    this.silenceTicksRemaining = this._randomInt(burst.minTicks, burst.maxTicks);
    this.buyBias = burst.buyBias;
    this._resetFlowPlayer();
  }

  _stepBurstScheduler() {
    const burst = this._getBurstConfig();
    this.buyBias = burst.buyBias;
    this._ensureFlowPlayer();

    if (this.flowState === "BURST") {
      if (this.burstTicksRemaining <= 0) {
        this.flowState = "SILENCE";
        this.silenceTicksRemaining = this._randomInt(burst.minTicks, burst.maxTicks);
        return;
      }
      const ordersThisTick = this._randomInt(burst.minOrdersPerTick, burst.maxOrdersPerTick);
      for (let i = 0; i < ordersThisTick; i += 1) {
        const side = Math.random() < this.buyBias ? "BUY" : "SELL";
        this.processTrade(this.flowPlayerId, side, 1);
      }
      this.burstTicksRemaining -= 1;
      return;
    }

    if (this.silenceTicksRemaining <= 0) {
      this.flowState = "BURST";
      this.burstTicksRemaining = this._randomInt(burst.minTicks, burst.maxTicks);
      this._stepBurstScheduler();
      return;
    }

    this.silenceTicksRemaining -= 1;
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

  _capacityForSide(player, side) {
    const maxPos = this.config.maxPosition;
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

  _flowMixWeights() {
    return { market: 0, limit: 1 };
  }

  _sampleAmbientQty() {
    return 0;
  }

  _sampleAmbientLimitPrice(side) {
    return null;
  }

  _executeAmbientOrder({ type, side }) {
    return false;
  }

  _maybeInjectAmbientFlow() {
    return;
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
    };
    player.orders.set(entry.id, entry);
    return { ...entry };
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
    const maxPos = this.config.maxPosition;
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

  processTrade(id, side, quantity = 1) {
    const result = this.executeMarketOrderForPlayer({ id, side, quantity });
    if (result?.filled) {
      this.tickActivity.marketOrders += 1;
      this.tickActivity.marketVolume += Math.abs(result.qty ?? 0);
    }
    return result;
  }

  executeMarketOrderForPlayer({ id, side, quantity }) {
    const player = this.players.get(id);
    if (!player) return null;

    const normalized = side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : null;
    if (!normalized) return null;

    const lotSize = this._lotSize();
    const capacity = this._capacityForSide(player, normalized);
    const requestedLots = this._normalizeLots(quantity);
    const qty = Math.min(capacity, Math.max(1, requestedLots || 1));
    if (qty <= 0) {
      return { filled: false, player, reason: "position-limit" };
    }

    if (this.priceMode !== "orderflow") {
      const signed = normalized === "BUY" ? qty : -qty;
      const actual = this._applyExecution(player, signed, this.currentPrice);
      if (Math.abs(actual) <= 1e-9) {
        return { filled: false, player, reason: "position-limit" };
      }
      this.orderFlow += actual;
      this.orderFlow = clamp(this.orderFlow, -50, 50);
      return {
        filled: true,
        player,
        side: normalized,
        qty: actual,
        price: this.currentPrice,
        fills: [],
      };
    }

    const totalLots = qty * lotSize;
    const result = this.orderBook.executeMarketOrder(normalized, totalLots, { ownerId: id });
    const hasResting = Boolean(result.resting);
    if (result.filled <= 1e-8 && !hasResting) {
      return { filled: false, player, reason: "no-liquidity" };
    }

    const executedUnits = result.filled / lotSize;
    const signed = normalized === "BUY" ? executedUnits : -executedUnits;
    const actual = this._applyExecution(player, signed, result.avgPrice ?? this.currentPrice);

    this._handleCounterpartyFills(result.fills, normalized, lotSize);
    this._recordTradeEvents(result.fills, normalized, lotSize, id);

    if (result.fills?.length) {
      this.currentPrice = result.fills.at(-1).price ?? result.avgPrice ?? this.currentPrice;
    } else if (result.avgPrice) {
      this.currentPrice = result.avgPrice;
    }
    this.orderBook.tickMaintenance({ center: this.currentPrice });
    this._syncOrderBookEvents();

    this.orderFlow += actual;
    this.orderFlow = clamp(this.orderFlow, -50, 50);

    let resting = null;
    if (hasResting) {
      resting = this._recordRestingOrder(player, result.resting);
    }

    return {
      filled: Math.abs(actual) > 1e-9,
      player,
      side: normalized,
      qty: actual,
      price: result.avgPrice ?? this.currentPrice,
      fills: result.fills ?? [],
      resting,
    };
  }

  submitOrder(id, order) {
    const player = this.players.get(id);
    if (!player) return { ok: false, reason: "unknown-player" };

    const type = order?.type === "limit" ? "limit" : "market";
    const normalized = order?.side === "SELL" ? "SELL" : order?.side === "BUY" ? "BUY" : null;
    if (!normalized) return { ok: false, reason: "bad-side" };

    if (type === "market") {
      const result = this.executeMarketOrderForPlayer({ id, side: normalized, quantity: order?.quantity });
      if (result?.filled) {
        this.tickActivity.marketOrders += 1;
        this.tickActivity.marketVolume += Math.abs(result.qty ?? 0);
      }
      return { ok: Boolean(result?.filled || result?.resting), ...result, type };
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

    const lotSize = this._lotSize();
    const capacity = this._capacityForSide(player, normalized);
    const outstanding = this._outstandingUnits(player, normalized);
    const available = Math.max(0, capacity - outstanding);
    const effectiveQty = Math.min(qty, available);
    if (effectiveQty <= 0) {
      return { ok: false, reason: "position-limit" };
    }

    const outcome = this.orderBook.placeLimitOrder({
      side: normalized,
      price: priceNum,
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

    let resting = null;
    if (outcome.resting) {
      resting = this._recordRestingOrder(player, outcome.resting);
    }

    return {
      ok: true,
      type,
      side: normalized,
      filled: executedUnits,
      price: outcome.avgPrice ?? priceNum,
      resting,
      fills: outcome.fills ?? [],
    };
  }

  cancelOrders(id, orderIds) {
    const player = this.players.get(id);
    if (!player) return [];
    const lotSize = this._lotSize();
    const targets = Array.isArray(orderIds) && orderIds.length ? orderIds : Array.from(player.orders.keys());
    const results = [];
    for (const orderId of targets) {
      const res = this.orderBook.cancelOrder(orderId);
      if (!res) continue;
      player.orders.delete(orderId);
      this.recordCancel({ orderId: res.id, ownerId: id, size: res.remaining });
      results.push({
        id: res.id,
        side: res.side,
        price: res.price,
        remaining: res.remaining / lotSize,
      });
    }
    if (results.length) {
      this.tickActivity.cancelCount += results.length;
    }
    return results;
  }

  pushNews(_input) {
    return this.currentPrice;
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
    this._stepBurstScheduler();
    this.orderBook.tickMaintenance({ center: this.currentPrice });
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
      cancelCount: this.tickActivity.cancelCount || 0,
      replaceCount: this.tickActivity.replaceCount || 0,
      depthTop3: { bid: depthBid, ask: depthAsk },
    };
    this.tickActivity = this._createTickActivity();
    return metrics;
  }
}
