import { DEFAULT_ENGINE_CONFIG, DEFAULT_PRODUCT } from "./constants.js";
import { DEFAULT_ORDER_BOOK_CONFIG, OrderBook } from "./orderBook.js";
import { averagePrice, clamp, gaussianRandom } from "./utils.js";

export class MarketEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.bookConfig = { ...DEFAULT_ORDER_BOOK_CONFIG, ...(this.config.orderBook ?? {}) };
    this.orderBook = new OrderBook(this.bookConfig);
    this.priceMode = this.config.defaultPriceMode;
    this.depthMetrics = this._computeDepthMetrics();
    this.lastSweepPressure = 0;
    this.lastSweepMeta = null;
    this.tradeTape = [];
    this.cancelLog = [];
    this.newsEvents = [];
    this.reset();
  }

  reset() {
    this.players = new Map();
    this.tickCount = 0;
    this.product = { ...DEFAULT_PRODUCT };
    this.fairValue = this.product.startPrice;
    this.fairTarget = this.product.startPrice;
    this.currentPrice = this.product.startPrice;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.newsImpulse = 0;
    this.orderFlow = 0;
    this.depthMetrics = this._computeDepthMetrics();
    this.lastSweepPressure = 0;
    this.lastSweepMeta = null;
    this.tradeTape = [];
    this.cancelLog = [];
    this.newsEvents = [];
    this.orderBook.reset(this.currentPrice);
  }

  startRound({ startPrice, productName } = {}) {
    const price = Number.isFinite(+startPrice) ? +startPrice : this.config.startPrice ?? DEFAULT_PRODUCT.startPrice;
    this.product = {
      name: productName || DEFAULT_PRODUCT.name,
      startPrice: price,
    };
    this.fairValue = price;
    this.fairTarget = price;
    this.currentPrice = price;
    this.priceVelocity = 0;
    this.lastTradeAt = 0;
    this.lastFlowAt = 0;
    this.tickCount = 0;
    this.newsImpulse = 0;
    this.orderFlow = 0;
    this.depthMetrics = this._computeDepthMetrics();
    this.lastSweepPressure = 0;
    this.lastSweepMeta = null;
    if (!this.priceMode) this.priceMode = this.config.defaultPriceMode;
    this.tradeTape = [];
    this.cancelLog = [];
    this.newsEvents = [];
    this.orderBook.reset(price);
  }

  getSnapshot() {
    return {
      productName: this.product.name,
      fairValue: this.fairValue,
      fairTarget: this.fairTarget,
      price: this.currentPrice,
      priceVelocity: this.priceVelocity,
      tickCount: this.tickCount,
      priceMode: this.priceMode,
      newsImpulse: this.newsImpulse,
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
    const metrics = this._computeDepthMetrics(levels, view);
    this.depthMetrics = metrics;
    return { bids: view.bids ?? [], asks: view.asks ?? [], bestBid: view.bestBid, bestAsk: view.bestAsk, metrics };
  }

  _computeDepthMetrics(levels = 8, precomputed) {
    const view = precomputed ?? this.orderBook.getBookLevels(levels);
    if (!view) {
      return {
        imbalance: 0,
        weightedImbalance: 0,
        topBid: 0,
        topAsk: 0,
        liquidityScore: 1,
        sweepableBid: 0,
        sweepableAsk: 0,
      };
    }
    const bids = view.bids ?? [];
    const asks = view.asks ?? [];
    const totalBid = bids.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    const totalAsk = asks.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    let weightedBid = 0;
    let weightedAsk = 0;
    for (let i = 0; i < Math.max(bids.length, asks.length); i += 1) {
      const weight = 1 / (1 + i);
      if (bids[i]) weightedBid += Number(bids[i].size || 0) * weight;
      if (asks[i]) weightedAsk += Number(asks[i].size || 0) * weight;
    }
    const topBid = bids[0]?.size ?? 0;
    const topAsk = asks[0]?.size ?? 0;
    const baseDepth = this.bookConfig?.baseDepth ?? 1;
    const liquidityScore = clamp(
      (baseDepth * 0.5) / Math.max(0.1, (topBid + topAsk) / 2),
      0.5,
      this.config.thinBookBoostCap,
    );

    const sweepableBid = bids.at(-1)?.cumulative ?? 0;
    const sweepableAsk = asks.at(-1)?.cumulative ?? 0;

    return {
      bids,
      asks,
      imbalance: totalBid + totalAsk > 1e-9 ? (totalBid - totalAsk) / (totalBid + totalAsk) : 0,
      weightedImbalance: weightedBid + weightedAsk > 1e-9 ? (weightedBid - weightedAsk) / (weightedBid + weightedAsk) : 0,
      topBid,
      topAsk,
      liquidityScore: 1 + (this.config.thinBookBoost - 1) * liquidityScore,
      sweepableBid,
      sweepableAsk,
    };
  }

  getBookAnalytics() {
    return this.orderBook?.bookStates ?? [];
  }

  getImbalance(levels = 5) {
    const metrics = this._computeDepthMetrics(levels);
    this.depthMetrics = metrics;
    return metrics.imbalance;
  }

  recordTrade(event) {
    if (!event) return;
    const entry = {
      t: event.t ?? Date.now(),
      price: Number(event.price ?? this.currentPrice ?? 0),
      size: Math.abs(Number(event.size ?? 0)),
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

  getNewsEvents({ lookbackMs = 300_000 } = {}) {
    const cutoff = Date.now() - lookbackMs;
    return this.newsEvents.filter((evt) => evt.t >= cutoff);
  }

  setPriceMode(mode) {
    const normalized = mode === "orderflow" ? "orderflow" : "news";
    this.priceMode = normalized;
    this.orderFlow = 0;
    this.newsImpulse = 0;
    if (this.priceMode === "orderflow") {
      this.orderBook.reset(this.currentPrice);
    }
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
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
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

  _lotSize() {
    return Math.max(0.0001, this.config.tradeLotSize ?? 1);
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
    const mix = this.config.flowMix ?? {};
    const market = clamp(Number(mix.market ?? 0.5), 0, 1);
    return { market, limit: 1 - market };
  }

  _sampleAmbientQty() {
    const cfg = this.config.ambientFlow ?? {};
    const mean = cfg.meanQty ?? 1;
    const sigma = Math.max(0, cfg.sigmaQty ?? 0);
    const raw = gaussianRandom() * sigma + mean;
    return Math.max(cfg.minQty ?? 0.25, raw);
  }

  _sampleAmbientLimitPrice(side) {
    const cfg = this.config.ambientFlow ?? {};
    const tick = this.bookConfig?.tickSize ?? this.orderBook?.tickSize ?? 0.5;
    const bestBid = this.orderBook.bestBid();
    const bestAsk = this.orderBook.bestAsk();
    const refPrice = this.orderBook.lastPrice() ?? this.currentPrice;
    const maxLevels = Math.max(1, cfg.maxLevelsAway ?? 3);
    const offset = Math.round(Math.random() * maxLevels);
    let target = refPrice;
    if (side === "BUY") {
      target = (bestBid?.price ?? refPrice) - offset * tick;
    } else {
      target = (bestAsk?.price ?? refPrice) + offset * tick;
    }
    if (cfg.anchorToFair && Number.isFinite(this.fairValue)) {
      target = (target + this.fairValue) / 2;
    }
    const snapped =
      this.orderBook?.snapPrice?.(target) ??
      Math.max(tick, Math.round(target / tick) * tick);
    return snapped;
  }

  _executeAmbientOrder({ type, side }) {
    const lotSize = this._lotSize();
    const qty = this._sampleAmbientQty();
    const size = qty * lotSize;
    if (type === "market") {
      const result = this.orderBook.executeMarketOrder(side, size);
      if (result.filled <= 1e-8) return false;
      this._handleCounterpartyFills(result.fills, side, lotSize);
      this._recordTradeEvents(result.fills, side, lotSize, null);
      if (result.fills?.length) {
        this.currentPrice = result.fills.at(-1).price ?? result.avgPrice ?? this.currentPrice;
      } else if (result.avgPrice) {
        this.currentPrice = result.avgPrice;
      }
      this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
      this._syncOrderBookEvents();
      const executedUnits = result.filled / lotSize;
      const signed = side === "BUY" ? executedUnits : -executedUnits;
      this.orderFlow = clamp(this.orderFlow + signed, -50, 50);
      return true;
    }

    const price = this._sampleAmbientLimitPrice(side);
    const outcome = this.orderBook.placeLimitOrder({
      side,
      price,
      size,
      ownerId: "__ambient__",
    });
    if (outcome.filled > 0) {
      this._handleCounterpartyFills(outcome.fills, side, lotSize);
      this._recordTradeEvents(outcome.fills, side, lotSize, null);
      if (outcome.fills?.length) {
        this.currentPrice = outcome.fills.at(-1).price ?? outcome.avgPrice ?? this.currentPrice;
      }
      const executedUnits = outcome.filled / lotSize;
      const signed = side === "BUY" ? executedUnits : -executedUnits;
      this.orderFlow = clamp(this.orderFlow + signed, -50, 50);
    }
    if (outcome.avgPrice) {
      this.currentPrice = outcome.avgPrice;
    }
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    this._syncOrderBookEvents();
    return Boolean(outcome.filled || outcome.resting);
  }

  _maybeInjectAmbientFlow() {
    const cfg = this.config.ambientFlow ?? {};
    if (!cfg.enabled || this.priceMode !== "orderflow") return;
    if (this.tickCount < 2) return;
    const now = Date.now();
    if (!this.lastTradeAt) {
      this.lastTradeAt = now;
      return;
    }
    const sinceFlow = now - (this.lastFlowAt || 0);
    const minInterval = cfg.minIntervalMs ?? 0;
    const maxInterval = Math.max(minInterval, cfg.maxIntervalMs ?? minInterval);
    const interval = minInterval + Math.random() * Math.max(0, maxInterval - minInterval);
    if (sinceFlow < interval) return;

    const idleGap = now - (this.lastTradeAt || 0);
    if (idleGap < (cfg.idleThresholdMs ?? 0) && Math.random() < 0.6) return;

    const weights = this._flowMixWeights();
    const type = Math.random() < weights.market ? "market" : "limit";
    const side = Math.random() < 0.5 ? "BUY" : "SELL";
    const executed = this._executeAmbientOrder({ type, side });
    if (executed) {
      this.lastFlowAt = now;
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
    return this.executeMarketOrderForPlayer({ id, side, quantity });
  }

  executeMarketOrderForPlayer({ id, side, quantity }) {
    const player = this.players.get(id);
    if (!player) return null;

    const normalized = side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : null;
    if (!normalized) return null;

    const lotSize = this._lotSize();
    const capacity = this._capacityForSide(player, normalized);
    const requested = Number.isFinite(+quantity) ? Math.abs(+quantity) : 0;
    const qty = Math.min(capacity, requested || 1);
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
    const beforeDepth = this.orderBook.getBookLevels(12);
    const result = this.orderBook.executeMarketOrder(normalized, totalLots);
    if (result.filled <= 1e-8) {
      return { filled: false, player, reason: "no-liquidity" };
    }

    const executedUnits = result.filled / lotSize;
    const signed = normalized === "BUY" ? executedUnits : -executedUnits;
    const actual = this._applyExecution(player, signed, result.avgPrice ?? this.currentPrice);

    this._handleCounterpartyFills(result.fills, normalized, lotSize);
    this._recordTradeEvents(result.fills, normalized, lotSize, id);

    if (result.fills?.length) {
      this.currentPrice = this.orderBook.lastPrice() ?? result.fills.at(-1).price ?? result.avgPrice ?? this.currentPrice;
    } else if (result.avgPrice) {
      this.currentPrice = result.avgPrice;
    }

    const regenScale = this._registerSweep({
      side: normalized,
      fills: result.fills,
      filled: result.filled,
      lotSize,
      beforeDepth,
    });

    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue, regenScale });
    this.depthMetrics = this._computeDepthMetrics(12);
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    this._syncOrderBookEvents();
    this._syncOrderBookEvents();

    this.orderFlow += actual;
    this.orderFlow = clamp(this.orderFlow, -50, 50);

    return {
      filled: true,
      player,
      side: normalized,
      qty: actual,
      price: result.avgPrice ?? this.currentPrice,
      fills: result.fills ?? [],
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
      return { ok: Boolean(result?.filled), ...result, type };
    }

    const qty = Number.isFinite(+order?.quantity) ? Math.abs(+order.quantity) : 0;
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

    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });

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
    return results;
  }

  pushNews(input) {
    let change = 0;
    let sentiment = 0;
    let intensity = 0;
    let halfLifeSec = 120;
    let symbols = [this.product?.symbol || this.product?.name || "INDEX"];
    let text = "";

    if (typeof input === "object" && input !== null) {
      change = Number.isFinite(+input.delta) ? +input.delta : 0;
      sentiment = Number.isFinite(+input.sentiment) ? clamp(+input.sentiment, -1, 1) : Math.sign(change);
      intensity = Number.isFinite(+input.intensity) ? Math.max(0, +input.intensity) : Math.abs(change);
      halfLifeSec = Number.isFinite(+input.halfLifeSec) ? Math.max(1, +input.halfLifeSec) : halfLifeSec;
      if (Array.isArray(input.symbols) && input.symbols.length) symbols = input.symbols;
      text = String(input.text ?? "");
    } else {
      change = Number.isFinite(+input) ? +input : 0;
      sentiment = Math.sign(change);
      intensity = Math.abs(change);
    }

    this.fairTarget = Math.max(0.01, this.fairTarget + change);
    if (change !== 0 || intensity > 0) {
      const impulse = clamp(
        Math.sign(change || sentiment) * Math.sqrt(Math.abs(change || intensity)) * this.config.newsImpulseFactor,
        -this.config.newsImpulseCap,
        this.config.newsImpulseCap,
      );
      this.newsImpulse = clamp(this.newsImpulse + impulse, -this.config.newsImpulseCap, this.config.newsImpulseCap);
    }

    const event = {
      t: Date.now(),
      text,
      delta: change,
      sentiment,
      intensity,
      halfLifeSec,
      symbols,
    };
    this.newsEvents.push(event);
    if (this.newsEvents.length > 400) this.newsEvents.splice(0, this.newsEvents.length - 400);
    return this.fairTarget;
  }

  stepTick() {
    const previousPrice = this.currentPrice;
    this.stepFair();
    if (this.priceMode === "news") {
      this.stepPriceNews();
    } else {
      this.stepOrderBook();
    }
    this.recomputePnLAll();
    this.tickCount += 1;
    const snapshot = this.getSnapshot();
    snapshot.previousPrice = previousPrice;
    snapshot.priceChange = snapshot.price - previousPrice;
    return snapshot;
  }

  stepFair() {
    const { fairSmooth, fairMaxStepPct } = this.config;
    const diff = this.fairTarget - this.fairValue;
    const step = clamp(
      diff * fairSmooth,
      -Math.abs(this.fairValue) * fairMaxStepPct,
      Math.abs(this.fairValue) * fairMaxStepPct,
    );
    this.fairValue = Math.max(0.01, this.fairValue + step);
  }

  stepPriceNews() {
    const {
      priceAcceleration,
      priceDamping,
      velocityCapPct,
      noisePct,
      turbulenceNoisePct,
      newsImpulseDecay,
      orderFlowImpact,
      orderFlowDecay,
      orderFlowFairPull,
    } = this.config;

    const diff = this.fairValue - this.currentPrice;
    const depth = this._computeDepthMetrics(10);
    this.depthMetrics = depth;

    let velocity = (1 - priceDamping) * this.priceVelocity;
    let extraNoiseFactor = 1;

    if (this.priceMode === "orderflow") {
      const flow = this.orderFlow;
      velocity += orderFlowImpact * flow + orderFlowFairPull * diff;
      extraNoiseFactor += Math.min(3, Math.abs(flow) * 0.15);
      this.orderFlow *= orderFlowDecay;
      this.newsImpulse *= newsImpulseDecay;
    } else {
      const imbalanceKick = clamp(
        depth.weightedImbalance * (depth.liquidityScore ?? 1) * this.config.depthImbalanceImpact,
        -this.config.depthImbalanceImpactCap,
        this.config.depthImbalanceImpactCap,
      );
      const sweepKick = clamp(
        this.lastSweepPressure * this.config.sweepImpactFactor,
        -this.config.sweepImpactCap,
        this.config.sweepImpactCap,
      );
      velocity += priceAcceleration * diff + this.newsImpulse + imbalanceKick + sweepKick;
      extraNoiseFactor += Math.min(3, Math.abs(this.newsImpulse) * 0.12);
      this.newsImpulse *= newsImpulseDecay;
      this.orderFlow *= 0.4;
    }

    this.lastSweepPressure *= this.config.sweepImpactDecay;
    const noiseTerm = gaussianRandom() * (this.currentPrice * (noisePct + turbulenceNoisePct * extraNoiseFactor));
    this.priceVelocity = velocity + noiseTerm;

    const maxVel = Math.abs(this.currentPrice) * velocityCapPct * (1 + Math.min(2, extraNoiseFactor * 0.35));
    this.priceVelocity = clamp(this.priceVelocity, -maxVel, maxVel);
    this.currentPrice = Math.max(0.01, this.currentPrice + this.priceVelocity);
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    this.depthMetrics = this._computeDepthMetrics(10);
    this._syncOrderBookEvents();
  }
 
  stepOrderBook() {
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    this._syncOrderBookEvents();
    this.newsImpulse *= this.config.newsImpulseDecay;
    const decay = this.priceMode === "orderflow" ? this.config.orderFlowDecay : 0.4;
    this.orderFlow *= decay;
    this._maybeInjectAmbientFlow();
    this.priceVelocity = 0;
    const lastTrade = this.orderBook.lastTradePrice;
    if (Number.isFinite(lastTrade)) {
      this.currentPrice = lastTrade;
    }
    this.lastSweepPressure *= this.config.sweepImpactDecay;
    this.depthMetrics = this._computeDepthMetrics(10);
  }

  _registerSweep({ side, fills = [], filled, lotSize, beforeDepth }) {
    const units = filled / (lotSize || 1);
    const uniquePrices = new Set(fills.map((f) => f.price));
    const levelsCrossed = uniquePrices.size || 1;
    const sign = side === "BUY" ? 1 : -1;
    const opposingLevels = side === "BUY" ? beforeDepth?.asks ?? [] : beforeDepth?.bids ?? [];
    const opposingDepth = opposingLevels.reduce((sum, lvl) => sum + Number(lvl?.size || 0), 0);
    const sweepFraction = opposingDepth > 0 ? clamp(filled / opposingDepth, 0, 1.2) : 1;
    const pressure = sign * units * (0.25 + sweepFraction * 0.75) * (levelsCrossed > 1 ? 1.2 : 1);
    this.lastSweepPressure = pressure;
    this.lastSweepMeta = { side, units, sweepFraction, levelsCrossed };
    return clamp(1 - sweepFraction * this.config.sweepRegenDampen, 0.2, 1);
  }
}
