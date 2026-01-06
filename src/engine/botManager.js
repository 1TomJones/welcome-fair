import { EventEmitter } from "events";
import { createBotFromConfig } from "../bots/strategies.js";
import { loadDefaultBotConfigs } from "../bots/presets.js";

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function computeVolume(trades) {
  return trades.reduce((sum, t) => sum + Math.abs(Number(t?.size || 0)), 0);
}

export class BotManager extends EventEmitter {
  constructor({ market, logger = console } = {}) {
    super();
    this.market = market;
    this.logger = logger;
    this.bots = new Map();
    this.configs = [];
    this.tickMs = market?.config?.tickMs ?? 250;
    this.metricsWindowMs = 60_000;
    this.newsWindowMs = 300_000;
    this.lastTickAt = null;
    this.lastSummaryAt = 0;
    this.summaryIntervalMs = 1_000;
    this.cooldowns = new Map();
  }

  loadDefaultBots() {
    const defaults = loadDefaultBotConfigs();
    this.loadConfig(defaults);
  }

  loadConfig(configs = []) {
    this.clear();
    this.configs = configs.map((cfg, idx) => ({ ...cloneConfig(cfg), id: cfg.id || `bot-${idx}` }));
    for (const cfg of this.configs) {
      try {
        const bot = createBotFromConfig(cfg, { market: this.market, logger: this.logger });
        if (!bot.id) bot.id = cfg.id;
        this.registerBot(bot, cfg);
      } catch (err) {
        this.logger.error?.(`[bot-manager] failed to create bot ${cfg?.id}`, err);
      }
    }
  }

  registerBot(bot, config) {
    if (!bot?.id) throw new Error("Bot requires an id");
    bot.attach({ market: this.market, logger: this.logger });
    bot.onRegister?.();
    const entry = { bot, config: config || cloneConfig(bot.config || {}) };
    this.bots.set(bot.id, entry);
    bot.on("decision", (decision) => {
      this.emit("decision", { botId: bot.id, decision });
    });
    bot.on("telemetry", (payload) => {
      this.emit("telemetry", { botId: bot.id, payload });
    });
    this.logger.info?.(`[bot-manager] registered ${bot.id} (${bot.type})`);
    return bot;
  }

  clear() {
    for (const { bot } of this.bots.values()) {
      try {
        bot.cancelAll?.();
      } catch (err) {
        this.logger.error?.(`[bot-manager] cancelAll failed for ${bot.id}`, err);
      }
      bot.removeAllListeners();
    }
    this.bots.clear();
  }

  tick(snapshot) {
    if (!this.bots.size) return;
    const now = Date.now();
    const delta = this.lastTickAt ? now - this.lastTickAt : this.tickMs;
    this.lastTickAt = now;

    const top = this.market.getTopOfBook(12);
    const depth = this.market.getDepthSnapshot(12);
    const trades = this.market.getRecentTrades(this.metricsWindowMs);
    const news = this.market.getNewsEvents({ lookbackMs: this.newsWindowMs });
    const metrics = {
      imbalance: this.market.getImbalance(8),
      depth: depth.metrics ?? null,
      vol: this.market.getVolMetrics(this.metricsWindowMs),
      marketVolume: computeVolume(trades),
    };
    const context = {
      deltaMs: delta,
      now,
      snapshot,
      topOfBook: top,
      depth,
      trades,
      news,
      metrics,
      tickSize: this.market?.bookConfig?.tickSize ?? 0.5,
    };

    for (const { bot } of this.bots.values()) {
      try {
        if (this.enforceRisk(bot, now)) continue;
        bot.tick(context);
      } catch (err) {
        this.logger.error?.(`[bot-manager] tick failure for ${bot.id}`, err);
      }
    }

    if (now - this.lastSummaryAt >= this.summaryIntervalMs) {
      this.lastSummaryAt = now;
      this.emit("summary", this.getSummary());
    }
  }

  getSummary() {
    const bots = [];
    for (const { bot, config } of this.bots.values()) {
      bots.push({
        ...bot.getTelemetry(),
        config,
      });
    }
    return { bots };
  }

  getDetail(id) {
    const entry = this.bots.get(id);
    if (!entry) return null;
    return { ...entry.bot.getTelemetry(), config: entry.config };
  }

  enforceRisk(bot, now) {
    const entry = this.bots.get(bot.id);
    if (!entry) return false;
    const config = entry.config ?? {};
    const cooldownUntil = this.cooldowns.get(bot.id) ?? 0;
    if (cooldownUntil && now < cooldownUntil) {
      bot.setEnabled(false);
      bot.status = "cooldown";
      return true;
    }
    const player = this.market.getPlayer(bot.id);
    const inventory = player?.position ?? 0;
    const pnl = (player?.pnl ?? 0) + (player?.realized ?? 0);
    const maxPos = config.inventory?.maxAbs ?? bot.inventoryCap;
    const maxLoss = config.risk?.maxLoss ?? null;
    const maxDrawdown = config.risk?.maxDrawdown ?? null;
    const cancelToFill = bot.metrics?.cancelToFill ?? 0;
    const cancelThreshold = config.risk?.maxCancelToFill ?? 7;

    const breach =
      Math.abs(inventory) > maxPos ||
      (Number.isFinite(maxLoss) && pnl <= -Math.abs(maxLoss)) ||
      (Number.isFinite(maxDrawdown) && player?.pnl <= -Math.abs(maxDrawdown)) ||
      cancelToFill >= cancelThreshold;

    if (breach) {
      const cooldownMs = bot.execution?.cooldownMs ?? 5_000;
      const until = now + cooldownMs;
      this.cooldowns.set(bot.id, until);
      bot.setEnabled(false);
      bot.cancelAll?.();
      this.emit("telemetry", {
        botId: bot.id,
        payload: {
          type: "cooldown",
          reason: {
            inventory,
            pnl,
            cancelToFill,
          },
          until,
        },
      });
      return true;
    }
    if (cooldownUntil && now >= cooldownUntil) {
      this.cooldowns.delete(bot.id);
      bot.setEnabled(true);
    }
    return false;
  }

  toggleBot(id, enabled) {
    const entry = this.bots.get(id);
    if (!entry) return false;
    entry.bot.setEnabled(enabled);
    entry.config.enabled = enabled;
    return true;
  }

  applyPatch(id, patch = {}) {
    const entry = this.bots.get(id);
    if (!entry) return false;
    entry.config = { ...entry.config, ...patch };
    entry.bot.config = { ...entry.bot.config, ...patch };
    if (patch.latencyMs) {
      entry.bot.latency = { ...entry.bot.latency, ...patch.latencyMs };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      entry.bot.setEnabled(patch.enabled);
    }
    return true;
  }

  runScenario(name) {
    const scenario = String(name || "").toLowerCase();
    if (scenario === "block-trade-day") {
      this.market.pushNews({
        text: "Large asset manager executes buy program",
        delta: 12,
        sentiment: 0.6,
        intensity: 4,
        halfLifeSec: 240,
      });
      return { ok: true, message: "Triggered block trade day scenario" };
    }
    if (scenario === "data-drop") {
      this.market.pushNews({
        text: "Tech sector beats on earnings",
        delta: 18,
        sentiment: 0.8,
        intensity: 5,
        halfLifeSec: 180,
      });
      return { ok: true, message: "Triggered data drop scenario" };
    }
    if (scenario === "thin-book") {
      const res = this.market.applyOrderBookPreset?.("thin-book") ?? { ok: false };
      return { ok: res.ok, message: res.ok ? "Applied thin book preset" : "Preset application failed" };
    }
    if (scenario === "iceberg-refresh") {
      const res = this.market.applyOrderBookPreset?.("iceberg-refresh") ?? { ok: false };
      return { ok: res.ok, message: res.ok ? "Applied iceberg refresh preset" : "Preset application failed" };
    }
    if (scenario === "sticky-book") {
      const res = this.market.applyOrderBookPreset?.("sticky-book") ?? { ok: false };
      return { ok: res.ok, message: res.ok ? "Applied sticky book preset" : "Preset application failed" };
    }
    return { ok: false, message: `Unknown scenario: ${name}` };
  }
}
