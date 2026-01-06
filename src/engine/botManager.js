import { EventEmitter } from "events";

export class BotManager extends EventEmitter {
  constructor({ market, logger = console } = {}) {
    super();
    this.market = market;
    this.logger = logger;
    this.bots = new Map();
    this.configs = [];
    this.summaryIntervalMs = 1_000;
    this.lastSummaryAt = 0;
  }

  loadDefaultBots() {
    this.loadConfig([]);
  }

  loadConfig(configs = []) {
    this.clear();
    this.configs = Array.isArray(configs) ? configs.map((cfg) => ({ ...cfg })) : [];
  }

  clear() {
    this.bots.clear();
  }

  tick() {
    const now = Date.now();
    if (now - this.lastSummaryAt >= this.summaryIntervalMs) {
      this.lastSummaryAt = now;
      this.emit("summary", this.getSummary());
    }
  }

  getSummary() {
    return { bots: [] };
  }

  getDetail() {
    return null;
  }

  enforceRisk() {
    return false;
  }

  toggleBot() {
    return false;
  }

  applyPatch() {
    return false;
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
