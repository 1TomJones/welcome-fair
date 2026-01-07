import { StrategyBot } from "./base.js";

function roundToTick(price, tick) {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(tick) || tick <= 0) return price;
  return Math.round(price / tick) * tick;
}

class MarketMakerBookBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "MM-Book" });
    this.anchorPrice = null;
    this.lastQuotedAnchor = null;
    this.lastRefillAt = 0;
    this.refillIntervalMs = Number.isFinite(this.config?.refillMs) ? Math.max(250, this.config.refillMs) : 5_000;
    this.walkTicksPerSecond = Number.isFinite(this.config?.walkTicksPerSecond)
      ? Math.max(0.5, this.config.walkTicksPerSecond)
      : 2;
    this.levelPercents = Array.isArray(this.config?.levelPercents)
      ? this.config.levelPercents
      : Array.from({ length: 10 }, (_, idx) => 10 - idx);
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const tick = Number.isFinite(context.tickSize) ? context.tickSize : 1;
    const fairValue = Number.isFinite(context.fairValue) ? context.fairValue : this.fallbackMidPrice(context);
    if (!Number.isFinite(fairValue)) {
      this.setRegime("awaiting-fair");
      return { skipped: true, reason: "no-fair-value" };
    }

    const now = Number.isFinite(context.now) ? context.now : Date.now();
    const deltaMs = Number.isFinite(context.deltaMs) ? context.deltaMs : 0;
    if (!Number.isFinite(this.anchorPrice)) {
      this.anchorPrice = fairValue;
      this.lastRefillAt = now - this.refillIntervalMs;
    }

    this.anchorPrice = this.walkAnchor(this.anchorPrice, fairValue, tick, deltaMs);
    const roundedAnchor = roundToTick(this.anchorPrice, tick);
    const shouldRebuild = !Number.isFinite(this.lastQuotedAnchor) || Math.abs(roundedAnchor - this.lastQuotedAnchor) >= tick / 2;
    if (shouldRebuild) {
      this.lastQuotedAnchor = roundedAnchor;
    }

    const targets = this.buildTargets(roundedAnchor, tick);
    const targetKeys = new Set(targets.map((target) => target.levelKey));

    for (const [id, info] of this.restingOrders.entries()) {
      const key = info.levelKey ?? `${info.side}:${roundToTick(info.price, tick)}`;
      if (!targetKeys.has(key) || shouldRebuild) {
        this.cancelOrder(id);
      }
    }

    const levelVolume = new Map();
    for (const info of this.restingOrders.values()) {
      const price = roundToTick(info.price, tick);
      const key = info.levelKey ?? `${info.side}:${price}`;
      const remaining = Number.isFinite(info.remaining) ? info.remaining : 0;
      levelVolume.set(key, (levelVolume.get(key) || 0) + remaining);
    }

    const canRefill = shouldRebuild || now - this.lastRefillAt >= this.refillIntervalMs;
    const currentPrice = Number.isFinite(context.price)
      ? context.price
      : Number.isFinite(context.snapshot?.price)
      ? context.snapshot.price
      : this.market?.currentPrice;

    let placed = 0;
    if (canRefill) {
      for (const target of targets) {
        const key = target.levelKey;
        const existing = levelVolume.get(key) || 0;
        const missing = Math.max(0, target.maxVolume - existing);
        if (missing <= 0) continue;
        if (!this.canRefillAtLevel(target.side, target.price, currentPrice)) continue;
        const qty = Math.max(1, Math.round(missing));
        this.submitOrder({
          type: "limit",
          side: target.side,
          price: target.price,
          quantity: qty,
          levelKey: target.levelKey,
        });
        placed += 1;
      }
      this.lastRefillAt = now;
    }

    this.setRegime("ladder");
    return {
      regime: this.currentRegime,
      anchor: roundedAnchor,
      fairValue,
      levels: targets.length,
      refilled: canRefill,
      placed,
    };
  }

  walkAnchor(anchor, fairValue, tick, deltaMs) {
    if (!Number.isFinite(anchor)) return fairValue;
    if (!Number.isFinite(tick) || tick <= 0) return fairValue;
    const diff = fairValue - anchor;
    if (Math.abs(diff) < 1e-9) return anchor;
    const maxTicks = this.walkTicksPerSecond * (deltaMs / 1000);
    if (maxTicks <= 0) return anchor;
    const maxMove = maxTicks * tick;
    const move = Math.min(Math.abs(diff), maxMove) * Math.sign(diff);
    return anchor + move;
  }

  buildTargets(anchor, tick) {
    const targets = [];
    const quarterOffsets = [0, 0.25, 0.5, 0.75];
    for (const [levelIndex, pct] of this.levelPercents.entries()) {
      const pctValue = Number(pct);
      if (!Number.isFinite(pctValue) || pctValue <= 0) continue;
      const offset = pctValue / 100;
      const maxVolume = Math.max(1, Math.round(pctValue));
      const bidBase = roundToTick(anchor * (1 - offset), tick);
      const askBase = roundToTick(anchor * (1 + offset), tick);
      quarterOffsets.forEach((shift, shiftIndex) => {
        const bidPrice = roundToTick(bidBase - shift, tick);
        targets.push({
          side: "BUY",
          price: bidPrice,
          maxVolume,
          levelKey: `BUY:${bidPrice}:${levelIndex}:${shiftIndex}`,
        });
        const askPrice = roundToTick(askBase + shift, tick);
        targets.push({
          side: "SELL",
          price: askPrice,
          maxVolume,
          levelKey: `SELL:${askPrice}:${levelIndex}:${shiftIndex}`,
        });
      });
    }
    return targets;
  }

  canRefillAtLevel(side, price, currentPrice) {
    if (!Number.isFinite(currentPrice)) return true;
    if (side === "BUY") return price < currentPrice;
    if (side === "SELL") return price > currentPrice;
    return false;
  }
}

class RandomBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Random-Bot" });
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;

    const config = this.config ?? {};
    const randomConfig = config.random ?? {};
    const ordersPerTick = Number.isFinite(randomConfig.ordersPerTick)
      ? randomConfig.ordersPerTick
      : Number.isFinite(config.ordersPerTick)
      ? config.ordersPerTick
      : 5;
    const buyProbability = Number.isFinite(randomConfig.buyProbability)
      ? randomConfig.buyProbability
      : Number.isFinite(config.buyProbability)
      ? config.buyProbability
      : 0.5;
    const marketProbability = Number.isFinite(randomConfig.marketProbability)
      ? randomConfig.marketProbability
      : Number.isFinite(config.marketProbability)
      ? config.marketProbability
      : 0.7;
    const limitRangePct = Number.isFinite(randomConfig.limitRangePct)
      ? randomConfig.limitRangePct
      : Number.isFinite(config.limitRangePct)
      ? config.limitRangePct
      : 0.01;
    const currentPrice = Number.isFinite(context.price)
      ? context.price
      : Number.isFinite(context.snapshot?.price)
      ? context.snapshot.price
      : this.market?.currentPrice;
    if (!Number.isFinite(currentPrice)) {
      this.setRegime("awaiting-price");
      return { skipped: true, reason: "no-current-price" };
    }

    const tick = Number.isFinite(context.tickSize) ? context.tickSize : null;
    let placed = 0;

    for (let i = 0; i < ordersPerTick; i += 1) {
      const side = Math.random() < buyProbability ? "BUY" : "SELL";
      const useMarket = Math.random() < marketProbability;
      const quantity = this.sampleSize();

      if (useMarket) {
        this.execute({ side, quantity });
        placed += 1;
        continue;
      }

      const range = Math.max(0, limitRangePct);
      const minPrice = side === "BUY" ? currentPrice * (1 - range) : currentPrice;
      const maxPrice = side === "BUY" ? currentPrice : currentPrice * (1 + range);
      const price = minPrice + Math.random() * (maxPrice - minPrice);
      const roundedPrice = Number.isFinite(tick) ? roundToTick(price, tick) : price;
      if (!Number.isFinite(roundedPrice)) continue;
      this.submitOrder({ type: "limit", side, price: roundedPrice, quantity });
      placed += 1;
    }

    this.setRegime("random");
    return {
      regime: this.currentRegime,
      ordersPerTick,
      buyProbability,
      marketProbability,
      limitRangePct,
      placed,
    };
  }
}

const BOT_BUILDERS = {
  "MM-Book": MarketMakerBookBot,
  "Random-Bot": RandomBot,
};

export function createBotFromConfig(config, deps) {
  const Ctor = BOT_BUILDERS[config?.botType];
  if (!Ctor) {
    throw new Error(`Unknown bot type: ${config?.botType}`);
  }
  return new Ctor({ ...deps, id: config.id, name: config.name, config });
}
