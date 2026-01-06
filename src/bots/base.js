import { EventEmitter } from "events";
import { clamp } from "../engine/utils.js";

const DEFAULT_LATENCY = { mean: 150, jitter: 60 };
const DEFAULT_ORDER_SIZE = { mean: 3, sigma: 1 };
const DEFAULT_EXECUTION = {
  style: "passive",
  marketBias: 0.6,
  cancelReplaceMs: 650,
  layers: 2,
  randomness: 0.18,
  telemetryMs: 500,
  flipImbalance: 0.75,
  flipVolSigma: 3,
  cooldownMs: 5_000,
};

function randomNormal(mean, sigma) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2.0 * Math.log(u));
  const z0 = mag * Math.cos(2.0 * Math.PI * v);
  return mean + (sigma ?? 1) * z0;
}

function drawLatency(latency = DEFAULT_LATENCY) {
  const base = Number.isFinite(latency?.mean) ? latency.mean : DEFAULT_LATENCY.mean;
  const jitter = Number.isFinite(latency?.jitter) ? latency.jitter : DEFAULT_LATENCY.jitter;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(10, base + delta);
}

function drawOrderSize(size = DEFAULT_ORDER_SIZE) {
  if (!size) return 1;
  if (Number.isFinite(size.fixed)) return Math.max(0.01, size.fixed);
  const mean = Number.isFinite(size.mean) ? size.mean : DEFAULT_ORDER_SIZE.mean;
  const sigma = Number.isFinite(size.sigma) ? size.sigma : DEFAULT_ORDER_SIZE.sigma;
  const sample = randomNormal(mean, sigma);
  if (Number.isFinite(size.min)) {
    return Math.max(size.min, Math.max(0.01, sample));
  }
  return Math.max(0.01, sample);
}

function jitter(value, pct = 0.1) {
  const amplitude = Math.abs(value) * pct;
  return value + (Math.random() * 2 - 1) * amplitude;
}

const MAX_LOG = 120;

export class StrategyBot extends EventEmitter {
  constructor({ id, name, type, config = {}, market, logger }) {
    super();
    if (!id) throw new Error("Bot id is required");
    this.id = id;
    this.name = name || id;
    this.type = type || "generic";
    this.market = market;
    this.logger = logger ?? console;
    this.config = { ...config };
    this.inventoryCap = Number.isFinite(config?.inventory?.maxAbs)
      ? Math.max(1, Math.abs(config.inventory.maxAbs))
      : 200;
    this.riskCaps = {
      maxLoss: config?.risk?.maxLoss ?? null,
      maxDrawdown: config?.risk?.maxDrawdown ?? null,
      maxPosition: this.inventoryCap,
    };
    this.latency = { ...DEFAULT_LATENCY, ...(config?.latencyMs ?? {}) };
    this.quoteLife = Number.isFinite(config?.quoteLifeMs)
      ? Math.max(50, config.quoteLifeMs)
      : 1500;
    this.minDecisionMs = Number.isFinite(config?.minDecisionMs)
      ? Math.max(25, config.minDecisionMs)
      : 150;
    this.childOrderSize = config?.child?.size || config?.size || config?.orderSize || null;
    this.featureFlags = { ...config?.features };
    this.execution = { ...DEFAULT_EXECUTION, ...(config?.execution ?? {}) };
    this.restingOrders = new Map();
    this.lastDecisionAt = 0;
    this.timerMs = drawLatency(this.latency);
    this.status = "idle";
    this.currentRegime = "steady";
    this.metrics = {
      fills: 0,
      cancels: 0,
      cancelToFill: 0,
      participation: 0,
      lastDecision: null,
      avgQuoteLifeMs: 0,
      lastAction: null,
    };
    this.decisionLog = [];
    this.lastInventory = 0;
    this.totalVolume = 0;
    this.totalQuoted = 0;
    this.enabled = config?.enabled !== false;
    this.lastTelemetryAt = 0;
  }

  attach({ market, logger }) {
    if (market) this.market = market;
    if (logger) this.logger = logger;
  }

  ensureSeat() {
    if (!this.market) return null;
    const seat = this.market.getPlayer(this.id);
    if (seat) return seat;
    return this.market.registerPlayer(this.id, this.name, {
      isBot: true,
      meta: { strategy: this.type },
    });
  }

  currentPlayer() {
    if (!this.market) return null;
    return this.market.getPlayer(this.id);
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
  }

  setRegime(label) {
    this.currentRegime = label || "steady";
  }

  scheduleNextDecision() {
    const latency = drawLatency(this.latency);
    const randomSkew = jitter(1, this.execution.randomness ?? 0.1);
    this.timerMs = Math.max(this.minDecisionMs, latency * randomSkew);
  }

  tick(context) {
    if (!this.enabled) {
      this.status = "paused";
      return;
    }
    this.status = "active";
    this.timerMs -= context.deltaMs;
    if (this.timerMs > 0) return;

    this.timerMs = 0;
    try {
      const decision = this.decide(context) || null;
      if (decision) {
        this.metrics.lastDecision = Date.now();
        this.logDecision(decision);
        this.emitTelemetryIfNeeded(decision);
      }
    } catch (err) {
      this.logger.error?.(`[bot:${this.id}] decision error`, err);
      this.logDecision({ level: "error", message: err?.message || String(err) });
    } finally {
      this.scheduleNextDecision();
    }
  }

  emitTelemetryIfNeeded(lastDecision) {
    const now = Date.now();
    const cadence = this.execution.telemetryMs ?? 500;
    if (now - this.lastTelemetryAt < cadence) return;
    this.lastTelemetryAt = now;
    this.emit("telemetry", {
      type: "heartbeat",
      inventory: this.currentPlayer()?.position ?? 0,
      liveQuotes: Array.from(this.restingOrders.values()).map((o) => ({
        side: o.side,
        price: o.price,
        remaining: o.order?.remaining ?? 0,
      })),
      lastDecision,
      cancels: this.metrics.cancels,
      fills: this.metrics.fills,
    });
  }

  decide(_context) {
    return null;
  }

  clampPosition(target) {
    const player = this.currentPlayer();
    if (!player) return 0;
    const max = this.inventoryCap;
    return clamp(target, -max, max);
  }

  submitOrder(order) {
    if (!this.market) return null;
    const enriched = { ...order };
    if (!enriched.quantity && enriched.size) {
      enriched.quantity = enriched.size;
      delete enriched.size;
    }
    if (!Number.isFinite(enriched.quantity)) {
      enriched.quantity = drawOrderSize(this.childOrderSize);
    }
    enriched.quantity = Math.max(0.01, enriched.quantity);
    const response = this.market.submitOrder(this.id, enriched);
    this.handleOrderResponse(response, enriched);
    return response;
  }

  execute(order) {
    return this.submitOrder({ ...order, type: "market" });
  }

  cancelOrder(orderId) {
    if (!this.market || !orderId) return [];
    const canceled = this.market.cancelOrders(this.id, [orderId]);
    if (canceled?.length) {
      this.metrics.cancels += canceled.length;
      const info = this.restingOrders.get(orderId);
      if (info) {
        const life = Date.now() - info.placedAt;
        this.updateQuoteLife(life);
      }
      this.restingOrders.delete(orderId);
      this.emit("telemetry", { type: "cancel", orderId, canceled });
    }
    this.updateCancelToFill();
    return canceled;
  }

  cancelAll() {
    if (!this.market) return [];
    const canceled = this.market.cancelOrders(this.id);
    if (canceled?.length) {
      this.metrics.cancels += canceled.length;
      const now = Date.now();
      for (const entry of canceled) {
        const info = this.restingOrders.get(entry.id);
        if (info) {
          this.updateQuoteLife(now - info.placedAt);
        }
      }
      this.restingOrders.clear();
      this.emit("telemetry", { type: "cancel-all", count: canceled.length });
    }
    this.updateCancelToFill();
    return canceled;
  }

  updateCancelToFill() {
    const fills = Math.max(1, this.metrics.fills);
    this.metrics.cancelToFill = this.metrics.cancels / fills;
  }

  updateQuoteLife(lifeMs) {
    if (!Number.isFinite(lifeMs) || lifeMs <= 0) return;
    const count = Math.max(1, this.metrics.quoteCount ?? 0);
    const prev = this.metrics.avgQuoteLifeMs ?? 0;
    const next = prev + (lifeMs - prev) / count;
    this.metrics.avgQuoteLifeMs = next;
    this.metrics.quoteCount = count + 1;
  }

  handleOrderResponse(response, order) {
    if (!response) return;
    const now = Date.now();
    const fills = response.fills ?? [];
    if (fills.length) {
      this.metrics.fills += fills.length;
      const volume = fills.reduce((sum, fill) => sum + Math.abs(fill.size ?? 0), 0);
      this.totalVolume += volume;
      this.emit("telemetry", { type: "fill", fills, order });
    }

    if (response.resting) {
      this.restingOrders.set(response.resting.id, {
        order: response.resting,
        placedAt: now,
        side: response.resting.side,
        price: response.resting.price,
      });
      this.totalQuoted += response.resting.remaining ?? 0;
      this.emit("telemetry", { type: "rest", resting: response.resting, order });
    }

    if (response.resting?.remaining === 0) {
      this.restingOrders.delete(response.resting.id);
    }

    this.updateCancelToFill();
  }

  logDecision(event) {
    const entry = { t: Date.now(), ...event };
    this.decisionLog.push(entry);
    if (this.decisionLog.length > MAX_LOG) this.decisionLog.shift();
    this.emit("decision", entry);
  }

  sampleSize(multiplier = 1) {
    return Math.max(0.01, drawOrderSize(this.childOrderSize) * jitter(multiplier, this.execution.randomness ?? 0.05));
  }

  shouldUseMarket() {
    const baseBias = this.execution.marketBias ?? DEFAULT_EXECUTION.marketBias;
    const style = this.execution.style || "passive";
    const normalized =
      style === "balanced" ? "neutral" : style;
    const bias = clamp(
      normalized === "aggressive" ? baseBias + 0.2 : normalized === "neutral" ? baseBias : baseBias - 0.15,
      0.05,
      0.95,
    );
    return Math.random() < bias;
  }

  placeOrder(side, price, qty) {
    const useMarket = this.shouldUseMarket();
    if (useMarket) {
      return this.execute({ side, quantity: qty });
    }
    return this.submitOrder({ type: "limit", side, price, quantity: qty });
  }

  getTelemetry() {
    const player = this.currentPlayer();
    const inventory = player?.position ?? 0;
    const pnl = player?.pnl ?? 0;
    const cash = player?.cash ?? 0;
    const realized = player?.realized ?? 0;
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      regime: this.currentRegime,
      enabled: this.enabled,
      latency: this.latency,
      inventory,
      pnl,
      cash,
      realized,
      metrics: { ...this.metrics, totalVolume: this.totalVolume, totalQuoted: this.totalQuoted },
      decisionLog: [...this.decisionLog],
    };
  }
}

export function createBotId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}
