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
    const buyProbability = Number.isFinite(config.buyProbability) ? config.buyProbability : 0.5;
    const aggressiveProbability = Number.isFinite(config.aggressiveProbability)
      ? config.aggressiveProbability
      : 0.8;
    const currentPrice = Number.isFinite(context.price)
      ? context.price
      : Number.isFinite(context.snapshot?.price)
      ? context.snapshot.price
      : this.market?.currentPrice;
    if (!Number.isFinite(currentPrice)) {
      this.setRegime("awaiting-price");
      return { skipped: true, reason: "no-current-price" };
    }

    const tick = Number.isFinite(context.tickSize) ? context.tickSize : 0.25;
    const roundedLast = roundToTick(currentPrice, tick);
    const rangeConfig = config.kRange ?? {};
    const rangeMin = Array.isArray(rangeConfig)
      ? rangeConfig[0]
      : Number.isFinite(rangeConfig.min)
      ? rangeConfig.min
      : 0;
    const rangeMax = Array.isArray(rangeConfig)
      ? rangeConfig[1]
      : Number.isFinite(rangeConfig.max)
      ? rangeConfig.max
      : 4;
    const kMin = Math.max(0, Math.min(rangeMin ?? 0, rangeMax ?? 0));
    const kMax = Math.max(0, Math.max(rangeMin ?? 0, rangeMax ?? 0));
    const drawK = () => {
      const span = Math.max(0, Math.floor(kMax) - Math.floor(kMin));
      return Math.floor(kMin) + Math.floor(Math.random() * (span + 1));
    };
    const pickOffsetTicks = () => 1 + Math.floor(Math.random() * 3);
    const improveAtBestProbability = 0.2;

    const side = Math.random() < buyProbability ? "BUY" : "SELL";
    const isAggressive = Math.random() < aggressiveProbability;
    const quantity = this.sampleSize();
    let action = "limit";
    let price = null;
    let k = null;
    let mode = isAggressive ? "aggressive" : "passive";

    if (side === "BUY") {
      const hasSellOrders = bookAsks.length > 0 || Number.isFinite(bestAsk);
      if (isAggressive) {
        if (!hasSellOrders) {
          if (Number.isFinite(bestBid) && Math.random() < improveAtBestProbability) {
            price = roundToTick(bestBid, tick);
          } else if (Number.isFinite(bestBid)) {
            price = roundToTick(bestBid + tick, tick);
          } else {
            price = roundToTick(roundedLast - tick, tick);
          }
          action = "rebuild-book";
        } else {
          k = drawK();
          price = roundToTick(roundedLast + k * tick, tick);
          action = "marketable-limit";
        }
      } else {
        const offset = pickOffsetTicks();
        price = roundToTick(roundedLast - offset * tick, tick);
      }
    } else {
      const hasBuyOrders = bookBids.length > 0 || Number.isFinite(bestBid);
      if (isAggressive) {
        if (!hasBuyOrders) {
          if (Number.isFinite(bestAsk) && Math.random() < improveAtBestProbability) {
            price = roundToTick(bestAsk, tick);
          } else if (Number.isFinite(bestAsk)) {
            price = roundToTick(bestAsk - tick, tick);
          } else {
            price = roundToTick(roundedLast + tick, tick);
          }
          action = "rebuild-book";
        } else {
          k = drawK();
          price = roundToTick(roundedLast - k * tick, tick);
          action = "marketable-limit";
        }
      } else {
        const offset = pickOffsetTicks();
        price = roundToTick(roundedLast + offset * tick, tick);
      }
    }

    if (!Number.isFinite(price)) {
      this.setRegime("awaiting-price");
      return { skipped: true, reason: "invalid-price" };
    }

    this.submitOrder({ type: "limit", side, price, quantity });
    this.setRegime("single-random");
    return {
      regime: this.currentRegime,
      buyProbability,
      aggressiveProbability,
      kRange: { min: kMin, max: kMax },
      side,
      mode,
      price,
      k,
      action,
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
