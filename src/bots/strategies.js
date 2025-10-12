import { StrategyBot } from "./base.js";
import { clamp } from "../engine/utils.js";

const TWO_MINUTES = 120_000;

function midPrice(top, fallback) {
  if (!top) return fallback;
  if (Number.isFinite(top.midPrice)) return top.midPrice;
  if (Number.isFinite(top.bestBid) && Number.isFinite(top.bestAsk)) {
    return (top.bestBid + top.bestAsk) / 2;
  }
  if (Number.isFinite(top.bestBid)) return top.bestBid;
  if (Number.isFinite(top.bestAsk)) return top.bestAsk;
  return fallback;
}

function basisPointsToTicks(bp, price, tick) {
  if (!Number.isFinite(bp) || bp <= 0) return 1;
  if (!Number.isFinite(price) || price <= 0) return 1;
  const pct = bp / 10_000;
  const move = price * pct;
  if (!Number.isFinite(tick) || tick <= 0) return Math.max(1, Math.round(move));
  return Math.max(1, Math.round(move / tick));
}

function computeVolume(trades) {
  return trades.reduce((sum, t) => sum + Math.abs(Number(t?.size || 0)), 0);
}

function movingAverage(history, length) {
  if (!history.length || length <= 0) return null;
  const slice = history.slice(-length);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / slice.length;
}

function movingStd(history, length) {
  if (!history.length || length <= 1) return 0;
  const slice = history.slice(-length);
  const mean = movingAverage(history, length);
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function lastTradeDirection(trades) {
  const last = trades?.slice(-1)[0];
  if (!last) return 0;
  return last.side === "BUY" ? 1 : last.side === "SELL" ? -1 : 0;
}

class MarketMakerCoreBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "MM-Core" });
    this.bidOrderId = null;
    this.askOrderId = null;
  }

  clearAgedQuotes(now) {
    for (const [id, info] of this.restingOrders.entries()) {
      if (now - info.placedAt >= this.quoteLife) {
        this.cancelOrder(id);
      }
    }
  }

  maintainQuote(side, price, qty, tick) {
    const rounded = Math.max(tick, Math.round(price / tick) * tick);
    const targetId = side === "BUY" ? this.bidOrderId : this.askOrderId;
    const existing = targetId ? this.restingOrders.get(targetId) : null;
    if (existing) {
      const diff = Math.abs(existing.price - rounded);
      if (diff > tick * 0.5) {
        this.cancelOrder(existing.order?.id || targetId);
      } else {
        return;
      }
    }
    const response = this.submitOrder({ type: "limit", side, price: rounded, quantity: qty });
    if (response?.resting) {
      if (side === "BUY") this.bidOrderId = response.resting.id;
      else this.askOrderId = response.resting.id;
    }
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const now = context.now;
    this.clearAgedQuotes(now);

    const tick = context.tickSize ?? 0.5;
    const top = context.topOfBook;
    const price = midPrice(top, context.snapshot.price);
    const volSigma = context.metrics?.vol?.sigma ?? 0;
    const inventory = player.position ?? 0;

    const spreadBp = this.config.quote?.targetSpreadBp ?? 4;
    const minTicks = this.config.quote?.minEdgeTicks ?? 1;
    let spreadTicks = Math.max(minTicks, basisPointsToTicks(spreadBp, price, tick));
    const widenFactor = this.config.volAwareness?.widenFactorPerATR ?? 0.6;
    spreadTicks += Math.round(volSigma * widenFactor / Math.max(tick, 1e-6));

    const skewPerUnit = this.config.inventory?.skewPerUnitTick ?? 0.002;
    const skewTicks = clamp(Math.round(inventory * skewPerUnit / Math.max(tick, 1e-6)), -6, 6);

    const baseQty = this.config.quote?.size ?? this.config.child?.size ?? { mean: 4, sigma: 1.5 };

    const bidTicks = spreadTicks + Math.max(0, skewTicks);
    const askTicks = spreadTicks + Math.max(0, -skewTicks);

    const bidPrice = Math.max(tick, price - bidTicks * tick);
    const askPrice = Math.max(bidPrice + tick, price + askTicks * tick);

    const imbalance = context.metrics?.imbalance ?? 0;
    if (Math.abs(imbalance) > 0.55) {
      const widen = Math.round(Math.abs(imbalance) * 2);
      if (imbalance > 0) {
        // more bid depth -> protect ask
        this.cancelOrder(this.askOrderId);
        this.maintainQuote("BUY", bidPrice - widen * tick, baseQty, tick);
      } else {
        this.cancelOrder(this.bidOrderId);
        this.maintainQuote("SELL", askPrice + widen * tick, baseQty, tick);
      }
      this.setRegime("imbalance");
      return { regime: this.currentRegime, action: "imbalance-adjust" };
    }

    this.setRegime("two-sided");
    const qty = baseQty;
    this.maintainQuote("BUY", bidPrice, qty, tick);
    this.maintainQuote("SELL", askPrice, qty, tick);
    return { regime: this.currentRegime, bidPrice, askPrice, qty };
  }
}

class HftQuoterBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "MM-HFT", config: { ...opts.config, quoteLifeMs: 400 } });
    this.lastAggression = 0;
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const tick = context.tickSize ?? 0.5;
    const top = context.topOfBook;
    const price = midPrice(top, context.snapshot.price);
    const trades = context.trades ?? [];
    const direction = lastTradeDirection(trades);
    const imbalance = context.metrics?.imbalance ?? 0;

    const spreadTicks = Math.max(1, basisPointsToTicks(2, price, tick));
    const bias = clamp(direction * 0.6 + imbalance * 0.4, -1.5, 1.5);
    const offset = Math.round(bias);

    const bidPrice = price - (spreadTicks - Math.min(0, offset)) * tick;
    const askPrice = price + (spreadTicks + Math.max(0, offset)) * tick;

    for (const [id, info] of this.restingOrders.entries()) {
      if (Date.now() - info.placedAt > this.quoteLife * 0.6) {
        this.cancelOrder(id);
      }
    }

    if (direction > 0) {
      this.cancelOrder([...this.restingOrders.keys()].find((id) => this.restingOrders.get(id)?.side === "SELL"));
      this.setRegime("join-bid");
      this.submitOrder({ type: "limit", side: "BUY", price: Math.max(tick, bidPrice + tick), quantity: { mean: 1.5, sigma: 0.5 } });
    } else if (direction < 0) {
      this.cancelOrder([...this.restingOrders.keys()].find((id) => this.restingOrders.get(id)?.side === "BUY"));
      this.setRegime("join-ask");
      this.submitOrder({ type: "limit", side: "SELL", price: Math.max(tick, askPrice - tick), quantity: { mean: 1.5, sigma: 0.5 } });
    } else {
      this.setRegime("make");
      this.submitOrder({ type: "limit", side: "BUY", price: bidPrice, quantity: { mean: 1.2, sigma: 0.4 } });
      this.submitOrder({ type: "limit", side: "SELL", price: askPrice, quantity: { mean: 1.2, sigma: 0.4 } });
    }
    return { price, regime: this.currentRegime };
  }
}

class IcebergProviderBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "MM-Iceberg" });
    this.clipRemaining = 0;
    this.activeSide = "BUY";
    this.refreshMs = 2_000;
    this.refreshTimer = 0;
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const tick = context.tickSize ?? 0.5;
    const top = context.topOfBook;
    const price = midPrice(top, context.snapshot.price);
    const inventory = player.position ?? 0;
    const targetClip = this.config.quote?.iceberg?.parent ?? this.config.quote?.size?.mean ?? 20;
    const display = this.config.quote?.iceberg?.display ?? 2;

    if (Math.abs(this.clipRemaining) <= 1e-6) {
      this.activeSide = inventory > 0 ? "SELL" : "BUY";
      this.clipRemaining = targetClip;
    }

    const desiredPrice = this.activeSide === "BUY" ? price - tick : price + tick;
    const outstanding = [...this.restingOrders.values()].filter((o) => o.side === this.activeSide);
    const displayed = outstanding.reduce((sum, o) => sum + (o.order?.remaining ?? 0), 0);
    const need = Math.max(0, this.clipRemaining - displayed);

    if (need <= display * 0.5) {
      this.setRegime("working");
      return { clipRemaining: this.clipRemaining };
    }

    const qty = Math.min(display, need);
    this.setRegime("iceberg");
    this.submitOrder({ type: "limit", side: this.activeSide, price: desiredPrice, quantity: qty });
    this.clipRemaining = Math.max(0, this.clipRemaining - qty);
    return { clipRemaining: this.clipRemaining, side: this.activeSide };
  }
}

class TwapExecutorBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Exec-TWAP" });
    this.parent = null;
  }

  ensureParent() {
    if (this.parent) return;
    const cfg = this.config.parentOrder ?? {};
    this.parent = {
      side: cfg.side === "sell" || cfg.side === "SELL" ? "SELL" : "BUY",
      quantity: Math.max(1, cfg.quantity ?? 100),
      deadline: Date.now() + (cfg.deadlineSec ?? 1800) * 1000,
      start: Date.now(),
      executed: 0,
    };
  }

  decide(context) {
    this.ensureSeat();
    this.ensureParent();
    if (!this.parent) return null;
    const now = context.now;
    const { side, quantity, start, deadline } = this.parent;
    const elapsed = now - start;
    const remainingTime = Math.max(1, deadline - now);
    const progress = clamp(elapsed / Math.max(1, deadline - start), 0, 1);
    const remainingQty = Math.max(0, quantity - this.parent.executed);
    if (remainingQty <= 0) {
      this.setEnabled(false);
      this.setRegime("done");
      return { complete: true };
    }

    const targetProg = progress;
    const executedFraction = this.parent.executed / quantity;
    const shortfall = Math.max(0, targetProg - executedFraction);
    if (shortfall <= 0.01 && remainingTime > 30_000) {
      this.setRegime("waiting");
      return { waiting: true };
    }

    const tradesVolume = computeVolume(context.trades ?? []);
    const participationCap = this.config.participationCapPct ?? 0.15;
    const targetQty = Math.min(remainingQty, Math.max(1, shortfall * quantity));
    const maxQty = Math.max(1, tradesVolume * participationCap);
    const childQty = Math.min(targetQty, maxQty);
    const response = this.execute({ side, quantity: childQty });
    if (response?.filled) {
      this.parent.executed += response.filled;
    }
    this.setRegime("slicing");
    return { childQty, remaining: quantity - this.parent.executed };
  }
}

class PovExecutorBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Exec-POV" });
    this.parent = null;
  }

  ensureParent() {
    if (this.parent) return;
    const cfg = this.config.parentOrder ?? {};
    this.parent = {
      side: cfg.side === "sell" || cfg.side === "SELL" ? "SELL" : "BUY",
      quantity: Math.max(1, cfg.quantity ?? 200),
      executed: 0,
      participation: this.config.participationCapPct ?? 0.2,
    };
  }

  decide(context) {
    this.ensureSeat();
    this.ensureParent();
    if (!this.parent) return null;
    const tradesVolume = Math.max(1, computeVolume(context.trades ?? []));
    const desired = tradesVolume * this.parent.participation;
    const remaining = Math.max(0, this.parent.quantity - this.parent.executed);
    if (remaining <= 0) {
      this.setEnabled(false);
      this.setRegime("done");
      return { complete: true };
    }

    const urgency = Math.min(1, remaining / (this.parent.quantity || 1));
    const aggression = this.config.aggression ?? { base: "passive" };
    let mode = aggression.base || "passive";
    if (urgency > 0.6) mode = "passive";
    if (urgency < 0.3) mode = "aggressive";

    const qty = Math.min(remaining, Math.max(1, desired));
    if (mode === "aggressive") {
      const response = this.execute({ side: this.parent.side, quantity: qty });
      if (response?.filled) this.parent.executed += response.filled;
      this.setRegime("hit" );
      return { qty, mode };
    }
    const top = context.topOfBook;
    const price = this.parent.side === "BUY" ? top?.bestBid ?? context.snapshot.price : top?.bestAsk ?? context.snapshot.price;
    const response = this.submitOrder({ type: "limit", side: this.parent.side, price, quantity: qty });
    if (response?.filled) this.parent.executed += response.filled;
    this.setRegime("join" );
    return { qty, mode };
  }
}

class DeskUnwindBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Exec-Desk" });
    this.inventoryTarget = this.config.startInventory ?? 500;
    this.position = this.inventoryTarget;
  }

  onRegister() {
    const seat = this.ensureSeat();
    if (seat) {
      seat.position = this.inventoryTarget;
      seat.avgPrice = this.market.currentPrice;
    }
  }

  decide(context) {
    this.ensureSeat();
    const player = this.currentPlayer();
    if (!player) return null;
    const inventory = player.position ?? 0;
    if (Math.abs(inventory) <= 1) {
      this.setEnabled(false);
      this.setRegime("flat");
      return { complete: true };
    }
    const side = inventory > 0 ? "SELL" : "BUY";
    const qty = Math.min(Math.abs(inventory), Math.max(5, Math.abs(inventory) * 0.2));
    const response = this.execute({ side, quantity: qty });
    this.setRegime("workdown");
    return { qty, side, remaining: player.position };
  }
}

class MomentumFundBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Dir-CTA" });
    this.history = [];
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const price = context.snapshot.price;
    this.history.push(price);
    if (this.history.length > 600) this.history.shift();
    const fast = movingAverage(this.history, this.config.fastWindow ?? 20);
    const slow = movingAverage(this.history, this.config.slowWindow ?? 80);
    if (!fast || !slow) return null;
    const signal = (fast - slow) / slow;
    const threshold = this.config.threshold ?? 0.001;
    if (Math.abs(signal) < threshold) {
      this.setRegime("flat");
      return { signal };
    }
    const side = signal > 0 ? "BUY" : "SELL";
    const qty = Math.max(1, Math.abs(signal) / threshold);
    const response = this.execute({ side, quantity: qty });
    this.setRegime(signal > 0 ? "trend-up" : "trend-down");
    return { signal, qty, side, filled: response?.filled };
  }
}

class MeanReversionBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Dir-MR" });
    this.history = [];
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const price = context.snapshot.price;
    this.history.push(price);
    if (this.history.length > 400) this.history.shift();
    const window = this.config.window ?? 60;
    if (this.history.length < window) return null;
    const mean = movingAverage(this.history, window);
    const std = movingStd(this.history, window) || 1;
    const z = (price - mean) / std;
    const band = this.config.zScoreEntry ?? 1.5;
    if (Math.abs(z) < band) {
      this.setRegime("waiting");
      return { z };
    }
    const side = z > 0 ? "SELL" : "BUY";
    const qty = Math.min(5, Math.abs(z));
    const priceLevel = side === "BUY" ? price - context.tickSize : price + context.tickSize;
    this.setRegime("fade");
    this.submitOrder({ type: "limit", side, price: priceLevel, quantity: qty });
    return { z, qty, side };
  }
}

class NewsDrivenFundBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Dir-News" });
    this.bias = 0;
    this.biasDecay = this.config.newsSensitivity?.halfLifeSec
      ? Math.exp(Math.log(0.5) / (this.config.newsSensitivity.halfLifeSec))
      : Math.exp(Math.log(0.5) / 90);
  }

  decide(context) {
    this.ensureSeat();
    const news = context.news ?? [];
    if (news.length) {
      const latest = news[news.length - 1];
      const beta = this.config.newsSensitivity?.beta ?? 0.6;
      this.bias += latest.sentiment * beta * (latest.intensity || 1);
    }
    this.bias *= this.biasDecay;
    if (Math.abs(this.bias) < 0.2) {
      this.setRegime("neutral");
      return { bias: this.bias };
    }
    const side = this.bias > 0 ? "BUY" : "SELL";
    const qty = Math.min(6, Math.abs(this.bias));
    const response = this.execute({ side, quantity: qty });
    this.setRegime(this.bias > 0 ? "bullish" : "bearish");
    return { bias: this.bias, side, qty, filled: response?.filled };
  }
}

class RebalancerBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Dir-Rebal" });
    this.nextRebalance = 0;
    this.targetWeights = this.config.targetWeight ?? 0;
    this.periodMs = (this.config.periodSec ?? 600) * 1000;
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const now = context.now;
    if (now < this.nextRebalance) {
      this.setRegime("waiting");
      return null;
    }
    this.nextRebalance = now + this.periodMs;
    const target = this.config.targetPosition ?? 0;
    const current = player.position ?? 0;
    const delta = target - current;
    if (Math.abs(delta) < 0.5) {
      this.setRegime("aligned");
      return { delta };
    }
    const side = delta > 0 ? "BUY" : "SELL";
    const qty = Math.abs(delta);
    const response = this.execute({ side, quantity: qty });
    this.setRegime("rebalance");
    return { side, qty, filled: response?.filled };
  }
}

class PairsArbBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "RV-Pairs" });
    this.spreadHistory = [];
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const price = context.snapshot.price;
    const reference = context.snapshot.fairValue ?? price;
    const spread = price - reference;
    this.spreadHistory.push(spread);
    if (this.spreadHistory.length > 600) this.spreadHistory.shift();
    const mean = movingAverage(this.spreadHistory, 200) ?? 0;
    const std = movingStd(this.spreadHistory, 200) || 1;
    const z = (spread - mean) / std;
    const entry = this.config.zScoreEntry ?? 2.0;
    if (Math.abs(z) < entry) {
      this.setRegime("flat");
      return { z };
    }
    const side = z > 0 ? "SELL" : "BUY";
    const qty = Math.min(5, Math.abs(z));
    const response = this.execute({ side, quantity: qty });
    this.setRegime("arb");
    return { z, qty, side, filled: response?.filled };
  }
}

class BasisArbBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "RV-Basis" });
    this.history = [];
  }

  decide(context) {
    this.ensureSeat();
    const price = context.snapshot.price;
    const fair = context.snapshot.fairValue ?? price;
    const diff = price - fair;
    this.history.push(diff);
    if (this.history.length > 400) this.history.shift();
    const avg = movingAverage(this.history, 200) ?? 0;
    const threshold = this.config.threshold ?? context.tickSize * 4;
    if (Math.abs(diff - avg) < threshold) {
      this.setRegime("watch");
      return { diff };
    }
    const side = diff > avg ? "SELL" : "BUY";
    const qty = Math.min(4, Math.abs(diff - avg) / Math.max(threshold, 1));
    this.setRegime("basis");
    const response = this.execute({ side, quantity: qty });
    return { diff, avg, side, qty, filled: response?.filled };
  }
}

class CurveArbBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "RV-Curve" });
  }

  decide(context) {
    // no additional maturities yet; stay idle
    this.setRegime("inactive");
    return null;
  }
}

class NoiseTrader extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Noisy" });
  }

  decide(context) {
    this.ensureSeat();
    if (Math.random() > 0.35) {
      this.setRegime("idle");
      return null;
    }
    const side = Math.random() > 0.5 ? "BUY" : "SELL";
    const qty = Math.random() * 2 + 0.5;
    const response = this.execute({ side, quantity: qty });
    this.setRegime("noise");
    return { side, qty, filled: response?.filled };
  }
}

class SpoofingBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Edu-Spoof" });
  }

  decide(context) {
    if (!this.featureFlags?.enabled) {
      this.setRegime("disabled");
      return null;
    }
    this.ensureSeat();
    const tick = context.tickSize ?? 0.5;
    const price = context.snapshot.price;
    const depth = 6 + Math.round(Math.random() * 4);
    const side = Math.random() > 0.5 ? "BUY" : "SELL";
    const spoofPrice = side === "BUY" ? price - depth * tick : price + depth * tick;
    this.submitOrder({ type: "limit", side, price: spoofPrice, quantity: 8 });
    this.setRegime("spoof");
    setTimeout(() => this.cancelAll(), 500);
    return { side, spoofPrice };
  }
}

export const BOT_BUILDERS = {
  "MM-Core": MarketMakerCoreBot,
  "MM-HFT": HftQuoterBot,
  "MM-Iceberg": IcebergProviderBot,
  "Exec-TWAP": TwapExecutorBot,
  "Exec-POV": PovExecutorBot,
  "Exec-Desk": DeskUnwindBot,
  "Dir-CTA": MomentumFundBot,
  "Dir-MR": MeanReversionBot,
  "Dir-News": NewsDrivenFundBot,
  "Dir-Rebal": RebalancerBot,
  "RV-Pairs": PairsArbBot,
  "RV-Basis": BasisArbBot,
  "RV-Curve": CurveArbBot,
  Noisy: NoiseTrader,
  "Edu-Spoof": SpoofingBot,
};

export function createBotFromConfig(config, deps) {
  const Ctor = BOT_BUILDERS[config?.botType];
  if (!Ctor) {
    throw new Error(`Unknown bot type: ${config?.botType}`);
  }
  return new Ctor({ id: config.id, name: config.name, config, market: deps.market, logger: deps.logger });
}

