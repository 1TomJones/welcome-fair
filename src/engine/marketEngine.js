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
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  getPlayer(id) {
    return this.players.get(id) ?? null;
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

  processTrade(id, side) {
    const player = this.players.get(id);
    if (!player) return null;

    const normalized = side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : null;
    if (!normalized) return null;

    const delta = normalized === "BUY" ? 1 : -1;
    const currentPosition = player.position;
    const requestedPosition = clamp(
      currentPosition + delta,
      -this.config.maxPosition,
      this.config.maxPosition,
    );
    if (requestedPosition === currentPosition) {
      return { filled: false, player };
    }

    const requestedQty = requestedPosition - currentPosition;
    const lotSize = Math.max(0.0001, this.config.tradeLotSize ?? 1);
    let executedQty = requestedQty;
    let fills = [];
    let fillPrice = this.currentPrice;

    if (this.priceMode === "orderflow") {
      const totalLots = Math.abs(requestedQty) * lotSize;
      const bookResult = this.orderBook.executeMarketOrder(normalized, totalLots);
      if (bookResult.filled <= 0) {
        return { filled: false, player, reason: "no-liquidity" };
      }
      executedQty = Math.sign(requestedQty) * (bookResult.filled / lotSize);
      fillPrice = bookResult.avgPrice ?? this.currentPrice;
      fills = bookResult.fills ?? [];
      this.currentPrice = bookResult.fills?.at(-1)?.price ?? fillPrice ?? this.currentPrice;
      this.orderBook.tickMaintenance({ center: this.currentPrice, fair: this.fairValue });
    } else {
      fillPrice = this.currentPrice;
      executedQty = requestedQty;
    }

    const nextPosition = clamp(currentPosition + executedQty, -this.config.maxPosition, this.config.maxPosition);
    const isCrossing = currentPosition !== 0 && Math.sign(nextPosition) !== Math.sign(currentPosition);

    player.cash -= executedQty * fillPrice;

    if (Math.abs(nextPosition) < 1e-6) {
      player.avgPrice = null;
    } else if (Math.abs(currentPosition) < 1e-6 || isCrossing) {
      player.avgPrice = fillPrice;
    } else if (Math.abs(nextPosition) > Math.abs(currentPosition)) {
      player.avgPrice = averagePrice({
        previousAvg: player.avgPrice,
        previousQty: currentPosition,
        tradePrice: fillPrice,
        tradeQty: executedQty,
      });
    }

    player.position = nextPosition;
    this.updatePnl(player);

    this.orderFlow += executedQty;
    this.orderFlow = clamp(this.orderFlow, -50, 50);

    return {
      filled: true,
      player,
      side: normalized,
      qty: executedQty,
      price: fillPrice,
      fills,
    };
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
    if (this.priceMode === "orderflow") {
      this.stepOrderBook();
    } else {
      this.stepPriceNews();
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
    this.priceVelocity = 0;
    const last = this.orderBook.lastPrice();
    if (Number.isFinite(last)) {
      this.currentPrice = last;
    }
  }
}
