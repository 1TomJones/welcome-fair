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
    let placed = 0;

    for (let i = 0; i < ordersPerTick; i += 1) {
      const side = Math.random() < buyProbability ? "BUY" : "SELL";
      const quantity = this.sampleSize();

      const range = Math.max(0, limitRangePct);
      const shouldCross = Math.random() < crossProbability;
      const rangeBounds =
        side === "BUY"
          ? shouldCross
            ? [currentPrice, currentPrice * (1 + range)]
            : [currentPrice * (1 - range), currentPrice]
          : shouldCross
          ? [currentPrice * (1 - range), currentPrice]
          : [currentPrice, currentPrice * (1 + range)];
      const [minPrice, maxPrice] = rangeBounds;
      const sampledPrice = minPrice + Math.random() * (maxPrice - minPrice);
      let roundedPrice = Number.isFinite(tick)
        ? roundToTick(sampledPrice, tick)
        : sampledPrice;
      if (side === "BUY") {
        if (shouldCross && roundedPrice < currentPrice) {
          roundedPrice = Number.isFinite(tick)
            ? Math.ceil(currentPrice / tick) * tick
            : currentPrice;
        }
        if (!shouldCross && roundedPrice > currentPrice) {
          roundedPrice = Number.isFinite(tick)
            ? Math.floor(currentPrice / tick) * tick
            : currentPrice;
        }
      } else {
        if (shouldCross && roundedPrice > currentPrice) {
          roundedPrice = Number.isFinite(tick)
            ? Math.floor(currentPrice / tick) * tick
            : currentPrice;
        }
        if (!shouldCross && roundedPrice < currentPrice) {
          roundedPrice = Number.isFinite(tick)
            ? Math.ceil(currentPrice / tick) * tick
            : currentPrice;
        }
      }
      if (!Number.isFinite(roundedPrice)) continue;
      if (side === "BUY") {
        const wantsToCross = roundedPrice >= currentPrice;
        const canFill = Number.isFinite(bestAsk) && bestAsk <= roundedPrice;
        if (wantsToCross && shouldCross && canFill) {
          this.execute({ side, quantity });
          placed += 1;
          continue;
        }
      } else {
        const wantsToCross = roundedPrice <= currentPrice;
        const canFill = Number.isFinite(bestBid) && bestBid >= roundedPrice;
        if (wantsToCross && shouldCross && canFill) {
          this.execute({ side, quantity });
          placed += 1;
          continue;
        }
      }
      this.submitOrder({ type: "limit", side, price: roundedPrice, quantity });
      placed += 1;
    }

    this.setRegime("single-random");
    return {
      regime: this.currentRegime,
      ordersPerTick,
      buyProbability,
      limitRangePct,
      crossProbability,
      placed,
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
