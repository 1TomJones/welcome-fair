import { DEFAULT_ENGINE_CONFIG, DEFAULT_PRODUCT } from "./constants.js";
import { averagePrice, clamp, gaussianRandom } from "./utils.js";

export class MarketEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
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
  }

  getSnapshot() {
    return {
      productName: this.product.name,
      fairValue: this.fairValue,
      fairTarget: this.fairTarget,
      price: this.currentPrice,
      tickCount: this.tickCount,
    };
  }

  registerPlayer(id, name) {
    if (!id) throw new Error("Player id is required");
    const player = {
      id,
      name,
      position: 0,
      avgPrice: null,
      pnl: 0,
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
    }));
  }

  updatePnl(player) {
    if (!player) return;
    const avg = player.avgPrice ?? this.currentPrice;
    player.pnl = (this.currentPrice - avg) * player.position;
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
    const nextPosition = clamp(
      player.position + delta,
      -this.config.maxPosition,
      this.config.maxPosition,
    );
    if (nextPosition === player.position) {
      return { filled: false, player };
    }

    const isCrossing = (player.position <= 0 && nextPosition > 0) ||
      (player.position >= 0 && nextPosition < 0);

    if (isCrossing || nextPosition === 0) {
      player.avgPrice = this.currentPrice;
    } else if (Math.sign(nextPosition) === Math.sign(player.position)) {
      const tradeQty = nextPosition - player.position;
      player.avgPrice = averagePrice({
        previousAvg: player.avgPrice,
        previousQty: player.position,
        tradePrice: this.currentPrice,
        tradeQty,
      });
    }

    player.position = nextPosition;
    this.updatePnl(player);

    return { filled: true, player, side: normalized };
  }

  pushNews(delta) {
    const change = Number.isFinite(+delta) ? +delta : 0;
    this.fairTarget = Math.max(0.01, this.fairTarget + change);
    return this.fairTarget;
  }

  stepTick() {
    this.stepFair();
    this.stepPrice();
    this.recomputePnLAll();
    this.tickCount += 1;
    return this.getSnapshot();
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

  stepPrice() {
    const { priceAcceleration, priceDamping, velocityCapPct, noisePct } = this.config;
    const diff = this.fairValue - this.currentPrice;
    this.priceVelocity = (1 - priceDamping) * this.priceVelocity +
      priceAcceleration * diff +
      gaussianRandom() * (this.currentPrice * noisePct);

    const maxVel = Math.abs(this.currentPrice) * velocityCapPct;
    this.priceVelocity = clamp(this.priceVelocity, -maxVel, maxVel);
    this.currentPrice = Math.max(0.01, this.currentPrice + this.priceVelocity);
  }
}
