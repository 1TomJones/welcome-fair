import { StrategyBot } from "./base.js";
import { clamp } from "../engine/utils.js";

const TWO_MINUTES = 120_000;
const DEFAULT_TICK_MS = 250;

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
    this.layeredQuotes = { BUY: new Set(), SELL: new Set() };
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const now = context.now;
    for (const [id, info] of this.restingOrders.entries()) {
      if (now - info.placedAt >= this.quoteLife) {
        this.cancelOrder(id);
      }
    }

    const tick = context.tickSize ?? 0.5;
    const top = context.topOfBook;
    const price = midPrice(top, context.snapshot.price);
    const volSigma = context.metrics?.vol?.sigma ?? 0;
    const inventory = player.position ?? 0;
    const imbalance = context.metrics?.imbalance ?? 0;
    const volPerTick = volSigma / Math.max(tick, 1e-6);

    const spreadBp = this.config.quote?.targetSpreadBp ?? 4;
    const minTicks = this.config.quote?.minEdgeTicks ?? 1;
    let spreadTicks = Math.max(minTicks, basisPointsToTicks(spreadBp, price, tick));
    const widenFactor = this.config.volAwareness?.widenFactorPerATR ?? 0.6;
    spreadTicks += Math.round(volSigma * widenFactor / Math.max(tick, 1e-6));

    const skewPerUnit = this.config.inventory?.skewPerUnitTick ?? 0.002;
    const targetInventory = this.config.inventory?.target ?? 0;
    const skewTicks = clamp(Math.round((inventory - targetInventory) * skewPerUnit / Math.max(tick, 1e-6)), -6, 6);

    const layers = Math.max(1, this.execution.layers ?? 2);
    const sizeAdj = clamp(1 + volPerTick * 0.01, 0.6, 1.8);
    const baseQty = this.config.quote?.size ?? this.config.child?.size ?? { mean: 4, sigma: 1.5 };

    const bidTicks = spreadTicks + Math.max(0, skewTicks);
    const askTicks = spreadTicks + Math.max(0, -skewTicks);

    const bidBase = Math.max(tick, price - bidTicks * tick);
    const askBase = Math.max(bidBase + tick, price + askTicks * tick);

    const flipVol = this.execution.flipVolSigma ?? 3;
    const flipImb = this.execution.flipImbalance ?? 0.75;
    if (Math.abs(imbalance) >= flipImb || volSigma >= flipVol) {
      const side = imbalance >= 0 ? "BUY" : "SELL";
      const qty = this.sampleSize(1.5 * sizeAdj);
      this.cancelAll();
      this.setRegime("flip-market");
      const aggressivePrice = side === "BUY" ? top?.bestAsk ?? askBase : top?.bestBid ?? bidBase;
      this.placeOrder(side, aggressivePrice, qty);
      return { regime: this.currentRegime, side, qty, reason: "vol-imbalance" };
    }

    const targetLayers = [];
    const book = { bids: top?.bids ?? [], asks: top?.asks ?? [] };
    for (let i = 0; i < layers; i += 1) {
      const depthBoost = Math.min(i, 3) * (this.execution.style === "aggressive" ? 0.5 : 1);
      const offset = spreadTicks + i + depthBoost + Math.max(0, volPerTick * 0.05);
      const depthScale = clamp(((book.bids[i]?.size ?? book.asks[i]?.size ?? 1) / 10), 0.5, 3);
      const qty = this.sampleSize(sizeAdj * depthScale * (1 - i * 0.1));
      targetLayers.push({
        bid: Math.max(tick, bidBase - offset * tick),
        ask: Math.max(tick, askBase + offset * tick),
        qty,
      });
    }

    this.maintainLayered("BUY", targetLayers.map((l) => ({ price: l.bid, qty: l.qty })), tick);
    this.maintainLayered("SELL", targetLayers.map((l) => ({ price: l.ask, qty: l.qty })), tick);
    this.setRegime("two-sided");
    return { regime: this.currentRegime, layers: targetLayers.length, spreadTicks, sizeAdj };
  }

  maintainLayered(side, targets, tick) {
    const existing = [...this.restingOrders.entries()].filter(([, info]) => info.side === side);
    const keepIds = new Set();
    for (const target of targets) {
      const rounded = Math.max(tick, Math.round(target.price / tick) * tick);
      const match = existing.find(([, info]) => Math.abs(info.price - rounded) <= tick * 0.6 && !keepIds.has(info.order?.id));
      if (match) {
        keepIds.add(match[0]);
        continue;
      }
      const response = this.submitOrder({ type: "limit", side, price: rounded, quantity: target.qty });
      if (response?.resting?.id) keepIds.add(response.resting.id);
    }
    const now = Date.now();
    for (const [id, info] of existing) {
      if (!keepIds.has(id) && now - info.placedAt >= (this.execution.cancelReplaceMs ?? 600)) {
        this.cancelOrder(id);
      }
    }
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
    const volSigma = context.metrics?.vol?.sigma ?? 0;

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
      this.placeOrder("BUY", Math.max(tick, bidPrice + tick), this.sampleSize());
    } else if (direction < 0) {
      this.cancelOrder([...this.restingOrders.keys()].find((id) => this.restingOrders.get(id)?.side === "BUY"));
      this.setRegime("join-ask");
      this.placeOrder("SELL", Math.max(tick, askPrice - tick), this.sampleSize());
    } else {
      this.setRegime("make");
      this.placeOrder("BUY", bidPrice, this.sampleSize());
      this.placeOrder("SELL", askPrice, this.sampleSize());
    }
    const flipVol = this.execution.flipVolSigma ?? 3;
    if (volSigma >= flipVol) {
      const urgentSide = imbalance >= 0 ? "BUY" : "SELL";
      this.setRegime("momentum-hit");
      this.placeOrder(urgentSide, urgentSide === "BUY" ? top?.bestAsk ?? price : top?.bestBid ?? price, this.sampleSize(1.2));
    }
    return { price, regime: this.currentRegime, volSigma };
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
    const top = context.topOfBook;
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

    const qty = Math.min(remaining, Math.max(1, desired, this.sampleSize()));
    if (mode === "aggressive") {
      const response = this.placeOrder(this.parent.side, this.parent.side === "BUY" ? top?.bestAsk ?? context.snapshot.price : top?.bestBid ?? context.snapshot.price, qty);
      if (response?.filled) this.parent.executed += response.filled;
      this.setRegime("hit");
      return { qty, mode };
    }
    const price = this.parent.side === "BUY" ? top?.bestBid ?? context.snapshot.price : top?.bestAsk ?? context.snapshot.price;
    const response = this.placeOrder(this.parent.side, price, qty);
    if (response?.filled) this.parent.executed += response.filled;
    this.setRegime("join");
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
    const px = side === "BUY" ? context.topOfBook?.bestAsk ?? context.snapshot.price : context.topOfBook?.bestBid ?? context.snapshot.price;
    const response = this.placeOrder(side, px, qty);
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
    const response = this.placeOrder(side, context.topOfBook?.midPrice ?? price, qty);
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
    const response = this.placeOrder(side, context.topOfBook?.midPrice ?? context.snapshot.price, qty);
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
    const response = this.placeOrder(side, context.topOfBook?.midPrice ?? context.snapshot.price, qty);
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
    const response = this.placeOrder(side, context.topOfBook?.midPrice ?? reference ?? price, qty);
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
    const response = this.placeOrder(side, context.topOfBook?.midPrice ?? price, qty);
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

class RandomFlowBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "Rnd-Flow" });
    this.ordersPerDecision = 5;
    this.execution.marketBias = 0.6;
    this.latency = { mean: 1000, jitter: 50, ...(opts?.config?.latencyMs ?? {}) };
    this.minDecisionMs = 900;
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const top = context.topOfBook;
    const mid = top?.midPrice ?? context.snapshot.price ?? 100;
    const tick = context.tickSize ?? 0.5;
    const snap = (price) =>
      this.market?.orderBook?.snapPrice?.(price) ??
      Math.max(tick, Math.round(price / tick) * tick);

    const results = [];
    for (let i = 0; i < this.ordersPerDecision; i += 1) {
      const side = Math.random() < 0.5 ? "BUY" : "SELL";
      const useMarket = Math.random() < this.execution.marketBias;
      const qty = this.sampleSize();

      if (useMarket) {
        const res = this.execute({ side, quantity: qty });
        results.push({ side, type: "market", filled: res?.filled ?? false });
        continue;
      }

      const pctAway = Math.pow(Math.random(), 0.3) * 0.01; // skew toward edge of 1%
      const offset = Math.max(tick, mid * pctAway);
      const price = side === "BUY" ? snap(Math.max(tick, mid - offset)) : snap(mid + offset);
      const res = this.submitOrder({ type: "limit", side, price, quantity: qty });
      results.push({ side, type: "limit", price, resting: Boolean(res?.resting) });
    }

    this.setRegime("random-flow");
    return { placed: results.length, results };
  }
}

class FlowPulseBot extends StrategyBot {
  constructor(opts) {
    super({ ...opts, type: "FlowPulse" });
    this.flowBuffer = 0;
    this.smoothedDemand = 0;
  }

  marketShare() {
    const mix = this.config?.mix?.market ?? this.config?.marketShare ?? 0.6;
    return clamp(mix, 0, 1);
  }

  smoothingFactor() {
    return clamp(this.config?.smoothing ?? 0.35, 0.05, 1);
  }

  permittedQuantity(position, side, desired) {
    const target = side === "BUY" ? position + desired : position - desired;
    const clamped = this.clampPosition(target);
    return Math.max(0, Math.abs(clamped - position));
  }

  ladderContext(context) {
    const tick = Math.max(
      context?.tickSize ?? this.market?.bookConfig?.tickSize ?? this.market?.orderBook?.tickSize ?? 0.5,
      1e-6,
    );
    const snap = this.market?.orderBook?.snapPrice?.bind(this.market.orderBook)
      ?? ((price) => Math.max(tick, Math.round(price / tick) * tick));
    const mid = Number.isFinite(context?.price) ? context.price : this.market?.currentPrice ?? tick;
    const top = context?.topOfBook ?? {};
    const bestBid = snap(Number.isFinite(top.bestBid) ? top.bestBid : mid - tick);
    const bestAsk = snap(Math.max(Number.isFinite(top.bestAsk) ? top.bestAsk : mid + tick, bestBid + tick));
    const levels = Math.max(1, this.config?.priceLevels ?? this.config?.levels ?? 10);
    const maxDistance = Math.max(1, this.config?.maxDistanceTicks ?? levels);
    const count = Math.min(levels, maxDistance);
    const bidLevels = [];
    const askLevels = [];
    for (let i = 0; i < count; i += 1) {
      bidLevels.push(snap(bestBid - i * tick));
      askLevels.push(snap(bestAsk + i * tick));
    }
    return { tick, snap, bidLevels, askLevels };
  }

  sampleLevelIndex(levelCount) {
    if (levelCount <= 1) return 0;
    const power = Math.max(1, this.config?.levelWeightPower ?? 1.6);
    const minWeight = Math.max(0.05, this.config?.levelMinWeight ?? 0.25);
    const weights = [];
    let total = 0;
    for (let i = 0; i < levelCount; i += 1) {
      const weight = Math.max(minWeight, (i + 1) ** power);
      weights.push(weight);
      total += weight;
    }
    if (!Number.isFinite(total) || total <= 0) return 0;
    let draw = Math.random() * total;
    for (let i = 0; i < weights.length; i += 1) {
      draw -= weights[i];
      if (draw <= 0) return i;
    }
    return levelCount - 1;
  }

  pickRestingPrice(side, context) {
    const ladder = this.ladderContext(context ?? {});
    const levels = side === "BUY" ? ladder.bidLevels : ladder.askLevels;
    if (!levels.length) return ladder.snap(ladder.tick);
    const idx = clamp(this.sampleLevelIndex(levels.length), 0, levels.length - 1);
    return ladder.snap(levels[idx]);
  }

  submitMarket(side, quantity) {
    const response = this.market.submitOrder(this.id, { type: "market", side, quantity });
    this.handleOrderResponse(response, { type: "market", side, quantity });
    return response;
  }

  decide(context) {
    const player = this.ensureSeat();
    if (!player) return null;
    const now = context?.now ?? Date.now();
    const deltaMs = Math.max(1, context?.deltaMs ?? DEFAULT_TICK_MS);
    const playerCount = this.market?.players?.size ?? context?.playerCount ?? 0;
    const targetPerSec = (this.config?.baseVolumePerSec ?? 5) + playerCount;
    const targetPerTick = targetPerSec * (deltaMs / 1000);
    const alpha = this.smoothingFactor();
    this.smoothedDemand = this.smoothedDemand * (1 - alpha) + targetPerTick * alpha;
    this.flowBuffer += this.smoothedDemand;

    const actions = [];
    let guard = 0;
    while (this.flowBuffer >= 1 && guard < 32) {
      guard += 1;
      const qty = Math.max(1, Math.min(Math.round(this.flowBuffer), this.sampleSize(this.config?.sizeMultiplier ?? 1)));
      const side = Math.random() < 0.5 ? "BUY" : "SELL";
      const allowed = this.permittedQuantity(player.position ?? 0, side, qty);
      this.flowBuffer -= qty;
      if (allowed <= 0) continue;

      const useMarket = Math.random() < this.marketShare();
      if (useMarket) {
        const res = this.submitMarket(side, allowed);
        actions.push({ type: "market", side, filled: res?.filled ?? 0 });
      } else {
        const price = this.pickRestingPrice(side, context);
        const res = this.submitOrder({ type: "limit", side, price, quantity: allowed });
        actions.push({ type: "limit", side, price, resting: Boolean(res?.resting) });
      }
    }

    this.setRegime(actions.length ? "flow-pulse" : "priming");
    return {
      t: now,
      targetPerSec,
      perTick: targetPerTick,
      smoothed: this.smoothedDemand,
      buffer: this.flowBuffer,
      placed: actions.length,
    };
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
  "Rnd-Flow": RandomFlowBot,
  "Edu-Spoof": SpoofingBot,
  FlowPulse: FlowPulseBot,
};

export function createBotFromConfig(config, deps) {
  const Ctor = BOT_BUILDERS[config?.botType];
  if (!Ctor) {
    throw new Error(`Unknown bot type: ${config?.botType}`);
  }
  return new Ctor({ id: config.id, name: config.name, config, market: deps.market, logger: deps.logger });
}
