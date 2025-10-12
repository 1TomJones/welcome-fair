import { DEFAULT_ENGINE_CONFIG, DEFAULT_PRODUCT } from "./constants.js";
import { DEFAULT_ORDER_BOOK_CONFIG, OrderBook } from "./orderBook.js";
import { averagePrice, clamp, gaussianRandom } from "./utils.js";

export class MarketEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.bookConfig = { ...DEFAULT_ORDER_BOOK_CONFIG, ...(this.config.orderBook ?? {}) };
    this.orderBook = new OrderBook(this.bookConfig);
    this.priceMode = this.config.defaultPriceMode;
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
    this.newsImpulse = 0;
    this.orderFlow = 0;
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
    this.tickCount = 0;
    this.newsImpulse = 0;
    this.orderFlow = 0;
    if (!this.priceMode) this.priceMode = this.config.defaultPriceMode;
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
    const result = this.orderBook.executeMarketOrder(normalized, totalLots);
    if (result.filled <= 1e-8) {
      return { filled: false, player, reason: "no-liquidity" };
    }

    const executedUnits = result.filled / lotSize;
    const signed = normalized === "BUY" ? executedUnits : -executedUnits;
    const actual = this._applyExecution(player, signed, result.avgPrice ?? this.currentPrice);

    this._handleCounterpartyFills(result.fills, normalized, lotSize);

    if (result.fills?.length) {
      this.currentPrice = result.fills.at(-1).price ?? result.avgPrice ?? this.currentPrice;
    } else if (result.avgPrice) {
      this.currentPrice = result.avgPrice;
    }
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });

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
      results.push({
        id: res.id,
        side: res.side,
        price: res.price,
        remaining: res.remaining / lotSize,
      });
    }
    return results;
  }

  pushNews(delta) {
    const change = Number.isFinite(+delta) ? +delta : 0;
    this.fairTarget = Math.max(0.01, this.fairTarget + change);
    if (change !== 0) {
      const impulse = clamp(
        Math.sign(change) * Math.sqrt(Math.abs(change)) * this.config.newsImpulseFactor,
        -this.config.newsImpulseCap,
        this.config.newsImpulseCap,
      );
      this.newsImpulse = clamp(this.newsImpulse + impulse, -this.config.newsImpulseCap, this.config.newsImpulseCap);
    }
    return this.fairTarget;
  }

  stepTick() {
    const previousPrice = this.currentPrice;
    this.stepFair();
    this.stepOrderBook();
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

    let velocity = (1 - priceDamping) * this.priceVelocity;
    let extraNoiseFactor = 1;

    if (this.priceMode === "orderflow") {
      const flow = this.orderFlow;
      velocity += orderFlowImpact * flow + orderFlowFairPull * diff;
      extraNoiseFactor += Math.min(3, Math.abs(flow) * 0.15);
      this.orderFlow *= orderFlowDecay;
      this.newsImpulse *= newsImpulseDecay;
    } else {
      velocity += priceAcceleration * diff + this.newsImpulse;
      extraNoiseFactor += Math.min(3, Math.abs(this.newsImpulse) * 0.12);
      this.newsImpulse *= newsImpulseDecay;
      this.orderFlow *= 0.4;
    }

    const noiseTerm = gaussianRandom() * (this.currentPrice * (noisePct + turbulenceNoisePct * extraNoiseFactor));
    this.priceVelocity = velocity + noiseTerm;

    const maxVel = Math.abs(this.currentPrice) * velocityCapPct * (1 + Math.min(2, extraNoiseFactor * 0.35));
    this.priceVelocity = clamp(this.priceVelocity, -maxVel, maxVel);
    this.currentPrice = Math.max(0.01, this.currentPrice + this.priceVelocity);
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
  }
 
  stepOrderBook() {
    this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    this.newsImpulse *= this.config.newsImpulseDecay;
    const decay = this.priceMode === "orderflow" ? this.config.orderFlowDecay : 0.4;
    this.orderFlow *= decay;
    this.priceVelocity = 0;
    const lastTrade = this.orderBook.lastTradePrice;
    if (Number.isFinite(lastTrade)) {
      this.currentPrice = lastTrade;
    }
  }
}
