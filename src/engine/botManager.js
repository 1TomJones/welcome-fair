import { EventEmitter } from "events";
import { createBotFromConfig } from "../bots/strategies.js";
import { loadDefaultBotConfigs } from "../bots/presets.js";

export class BotManager extends EventEmitter {
  constructor({ market, logger = console } = {}) {
    super();
    this.market = market;
    this.logger = logger;
    this.bots = new Map();
    this.configs = [];
    this.patchedConfigs = new Map();
    this.summaryIntervalMs = 1_000;
    this.lastSummaryAt = 0;
    this.lastTickAt = Date.now();
  }

  loadDefaultBots() {
    this.loadConfig(loadDefaultBotConfigs());
  }

  loadConfig(configs = []) {
    this.clear();
    this.configs = Array.isArray(configs) ? configs.map((cfg) => ({ ...cfg })) : [];
    for (const cfg of this.configs) {
      try {
        const patched = this.patchedConfigs.get(cfg.id);
        const effectiveConfig = patched ? this.mergeConfig(cfg, patched) : cfg;
        const bot = createBotFromConfig(effectiveConfig, { market: this.market, logger: this.logger });
        this._register(bot);
      } catch (err) {
        this.logger.error?.("bot init failed", err);
      }
    }
  }

  clear() {
    this.bots.clear();
  }

  clearPatchedConfigs() {
    this.patchedConfigs.clear();
  }

  reloadStoredConfigs() {
    if (!this.configs.length) return;
    const configs = this.configs.map((cfg) => ({ ...cfg }));
    this.loadConfig(configs);
  }

  mergeConfig(base = {}, patch = {}) {
    const merged = { ...base, ...patch };
    const mergeNested = (key) => {
      if (base?.[key] || patch?.[key]) {
        merged[key] = { ...(base?.[key] ?? {}), ...(patch?.[key] ?? {}) };
      }
    };
    mergeNested("random");
    mergeNested("child");
    mergeNested("latencyMs");
    mergeNested("execution");
    mergeNested("risk");
    mergeNested("inventory");
    mergeNested("features");
    return merged;
  }

  _register(bot) {
    this.bots.set(bot.id, bot);
    bot.on("telemetry", (payload) => this.emit("telemetry", { botId: bot.id, ...payload }));
    bot.on("decision", (payload) => this.emit("decision", { botId: bot.id, ...payload }));
  }

  tick(snapshot = null) {
    const now = Date.now();
    const configuredDelta = this.market?.config?.tickMs;
    const deltaMs = Math.max(1, snapshot?.deltaMs ?? configuredDelta ?? now - this.lastTickAt);
    this.lastTickAt = now;
    const topOfBook = this.market?.getTopOfBook?.(12);
    const trades = this.market?.getRecentTrades?.(10_000) ?? [];
    const vol = this.market?.getVolMetrics?.(60_000) ?? { sigma: 0, mean: 0, count: 0 };
    const imbalance = this.market?.getImbalance?.(6) ?? 0;
    const baseSnapshot = snapshot ?? this.market?.getSnapshot?.() ?? {};
    const context = {
      ...baseSnapshot,
      now,
      deltaMs,
      topOfBook,
      trades,
      metrics: { ...baseSnapshot.metrics, vol, imbalance },
      tickSize: this.market?.bookConfig?.tickSize ?? this.market?.orderBook?.tickSize,
      playerCount: this.market?.players?.size ?? 0,
    };

    for (const bot of this.bots.values()) {
      bot.tick(context);
    }

    if (now - this.lastSummaryAt >= this.summaryIntervalMs) {
      this.lastSummaryAt = now;
      this.emit("summary", this.getSummary());
    }
  }

  getSummary() {
    const bots = Array.from(this.bots.values()).map((bot) => {
      const { decisionLog, ...rest } = bot.getTelemetry();
      return rest;
    });
    return { bots };
  }

  getDetail(id) {
    const bot = this.bots.get(id);
    if (!bot) return null;
    const detail = bot.getTelemetry();
    return { ...detail, config: bot.config };
  }

  enforceRisk() {
    return false;
  }

  toggleBot(id, enabled = true) {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.setEnabled(enabled);
    bot.config.enabled = enabled;
    this.patchedConfigs.set(id, { ...bot.config });
    return true;
  }

  applyPatch(id, patch = {}) {
    const bot = this.bots.get(id);
    if (!bot || typeof patch !== "object") return false;
    bot.config = this.mergeConfig(bot.config, patch);
    if (patch.enabled !== undefined) bot.setEnabled(patch.enabled !== false);
    if (patch.latencyMs) {
      bot.latency = { ...bot.latency, ...patch.latencyMs };
    }
    if (patch.execution) {
      bot.execution = { ...bot.execution, ...patch.execution };
    }
    if (patch.ordersPerTick !== undefined) {
      bot.config.ordersPerTick = patch.ordersPerTick;
    }
    if (patch.random?.ordersPerTick !== undefined) {
      bot.config.random = { ...(bot.config.random ?? {}), ordersPerTick: patch.random.ordersPerTick };
    }
    const nextChildOrderSize =
      bot.config?.child?.size ?? bot.config?.size ?? bot.config?.orderSize ?? null;
    if (nextChildOrderSize) {
      bot.childOrderSize = nextChildOrderSize;
    }
    this.patchedConfigs.set(id, { ...bot.config });
    return true;
  }

  runScenario(name) {
    const scenario = String(name || "").toLowerCase();
    if (scenario === "thin-book" || scenario === "iceberg-refresh" || scenario === "sticky-book") {
      const res = this.market.applyOrderBookPreset?.(scenario) ?? { ok: false };
      return { ok: res.ok, message: res.ok ? `Applied ${scenario} preset` : "Preset application failed" };
    }
    return { ok: false, message: `Scenario disabled: ${name}` };
  }
}
