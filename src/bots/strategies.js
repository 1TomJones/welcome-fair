import { StrategyBot } from "./base.js";

function roundToTick(price, tick) {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(tick) || tick <= 0) return price;
  return Math.round(price / tick) * tick;
}

class SingleRandomBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Single-Random" });
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;

    const topOfBook = context?.topOfBook ?? {};
    const bookBids = Array.isArray(topOfBook?.bids) ? topOfBook.bids : [];
    const bookAsks = Array.isArray(topOfBook?.asks) ? topOfBook.asks : [];
    const bestBid = Number.isFinite(topOfBook?.bestBid)
      ? topOfBook.bestBid
      : Number.isFinite(context?.bestBid)
      ? context.bestBid
      : Number.isFinite(context?.snapshot?.bestBid)
      ? context.snapshot.bestBid
      : null;
    const bestAsk = Number.isFinite(topOfBook?.bestAsk)
      ? topOfBook.bestAsk
      : Number.isFinite(context?.bestAsk)
      ? context.bestAsk
      : Number.isFinite(context?.snapshot?.bestAsk)
      ? context.snapshot.bestAsk
      : null;

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
    const limitRangePct = Number.isFinite(randomConfig.limitRangePct)
      ? randomConfig.limitRangePct
      : Number.isFinite(config.limitRangePct)
      ? config.limitRangePct
      : 0.01;
    const crossProbability = Number.isFinite(randomConfig.crossProbability)
      ? randomConfig.crossProbability
      : Number.isFinite(config.crossProbability)
      ? config.crossProbability
      : 1;
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
    const hasSameSideVolume = (side, price) => {
      if (!Number.isFinite(price)) return false;
      const isBidSide = side === "BUY";
      const sourceLevels = isBidSide ? bookBids : bookAsks;
      const level = sourceLevels.find((lvl) => lvl?.price === price);
      if (!level) return false;
      const volume = Number(level.size ?? 0);
      return volume > 1e-8;
    };
    const crossesOpposing = (side, price) => {
      if (!Number.isFinite(price)) return false;
      if (side === "BUY") return Number.isFinite(bestAsk) && price >= bestAsk;
      return Number.isFinite(bestBid) && price <= bestBid;
    };
    const pickPriceLevel = (levels, predicate) => {
      const filtered = levels.filter((lvl) => predicate(lvl?.price));
      const candidates = (filtered.length ? filtered : levels).slice(0, 4).filter((lvl) => Number.isFinite(lvl?.price));
      if (!candidates.length) return null;
      const choice = candidates[Math.floor(Math.random() * candidates.length)];
      return choice?.price ?? null;
    };
    let placed = 0;
    const orderDecisions = [];

    for (let i = 0; i < ordersPerTick; i += 1) {
      const side = Math.random() < buyProbability ? "BUY" : "SELL";
      const quantity = this.sampleSize();

      const shouldCross = Math.random() < crossProbability;
      const directionLevels = shouldCross ? bookAsks : bookBids;
      const priceLevel = pickPriceLevel(
        directionLevels,
        shouldCross ? (price) => price > currentPrice : (price) => price < currentPrice,
      );
      let roundedPrice = Number.isFinite(priceLevel)
        ? priceLevel
        : Number.isFinite(tick)
        ? roundToTick(currentPrice, tick)
        : currentPrice;
      if (!Number.isFinite(roundedPrice)) continue;

      let adjustedPrice = roundedPrice;
      if (hasSameSideVolume(side, adjustedPrice)) {
        const prices = directionLevels
          .map((lvl) => lvl?.price)
          .filter((price) => Number.isFinite(price));
        let index = prices.findIndex((price) => price === adjustedPrice);
        while (index >= 0 && hasSameSideVolume(side, adjustedPrice) && !crossesOpposing(side, adjustedPrice)) {
          index += 1;
          if (index >= prices.length) break;
          adjustedPrice = prices[index];
        }
      }

      if (side === "BUY") {
        const wantsToCross = adjustedPrice >= currentPrice;
        const canFill = Number.isFinite(bestAsk) && bestAsk <= adjustedPrice;
        if (wantsToCross && shouldCross && canFill) {
          this.execute({ side, quantity });
          placed += 1;
          orderDecisions.push({ side, shouldCross, price: adjustedPrice, action: "execute" });
          continue;
        }
      } else {
        const wantsToCross = adjustedPrice <= currentPrice;
        const canFill = Number.isFinite(bestBid) && bestBid >= adjustedPrice;
        if (wantsToCross && shouldCross && canFill) {
          this.execute({ side, quantity });
          placed += 1;
          orderDecisions.push({ side, shouldCross, price: adjustedPrice, action: "execute" });
          continue;
        }
      }
      this.submitOrder({ type: "limit", side, price: adjustedPrice, quantity });
      placed += 1;
      orderDecisions.push({ side, shouldCross, price: adjustedPrice, action: "limit" });
    }

    this.setRegime("single-random");
    return {
      regime: this.currentRegime,
      ordersPerTick,
      buyProbability,
      limitRangePct,
      crossProbability,
      placed,
      orderDecisions,
    };
  }
}

const BOT_BUILDERS = {
  "Single-Random": SingleRandomBot,
};

export function createBotFromConfig(config, deps) {
  const Ctor = BOT_BUILDERS[config?.botType];
  if (!Ctor) {
    throw new Error(`Unknown bot type: ${config?.botType}`);
  }
  return new Ctor({ ...deps, id: config.id, name: config.name, config });
}
