import { clamp } from "./utils.js";

export class BotManager {
  constructor({ market, logger = console } = {}) {
    this.market = market;
    this.logger = logger;
    this.bots = new Map();
  }

  registerBot(bot) {
    if (!bot?.id) throw new Error("Bot requires an id");
    if (!bot.market) bot.market = this.market;
    if (!bot.logger) bot.logger = this.logger;
    this.bots.set(bot.id, bot);
    this.logger.info?.(`[bot] registered ${bot.id}`);
    try {
      bot.onRegister?.();
    } catch (err) {
      this.logger.error?.(`[bot] onRegister failed for ${bot.id}`, err);
    }
    return bot;
  }

  clear() {
    this.bots.clear();
  }

  tick(context) {
    if (!this.bots.size) return;
    for (const bot of this.bots.values()) {
      try {
        bot.onTick?.(context);
      } catch (err) {
        this.logger.error?.(`[bot] tick failed for ${bot.id}`, err);
      }
    }
  }
}

export class BaseBot {
  constructor({ id, market, name, logger, meta } = {}) {
    this.id = id;
    this.market = market;
    this.logger = logger;
    this.displayName = name || `Bot-${id}`;
    this.meta = meta ?? null;
  }

  onRegister() {
    this.ensureSeat();
  }

  ensureSeat() {
    if (!this.market) return null;
    const existing = this.market.getPlayer(this.id);
    if (existing) return existing;
    return this.market.registerPlayer(this.id, this.displayName, {
      isBot: true,
      meta: this.meta,
    });
  }

  trade(side) {
    if (!side || !this.market) return null;
    return this.market.processTrade(this.id, side);
  }
}

export class PassiveMarketMakerBot extends BaseBot {
  constructor({
    id,
    market,
    name = "Grid Market Maker",
    spread = 0.6,
    inventoryTarget = 0,
    maxPosition = 4,
    cooldown = 2,
  } = {}) {
    super({ id, market, name, meta: { role: "market-maker" } });
    this.spread = spread;
    this.inventoryTarget = inventoryTarget;
    this.maxPosition = maxPosition;
    this.cooldownTicks = Math.max(1, Math.round(cooldown));
    this.cooldown = 0;
  }

  onTick({ price, fairValue }) {
    const player = this.ensureSeat();
    if (!player) return;

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    const diff = price - fairValue;
    let action = null;

    if (diff > this.spread) {
      action = "SELL";
    } else if (diff < -this.spread) {
      action = "BUY";
    } else {
      const imbalance = player.position - this.inventoryTarget;
      if (Math.abs(imbalance) >= 1) {
        action = imbalance > 0 ? "SELL" : "BUY";
      } else if (Math.abs(diff) > this.spread * 0.5) {
        action = diff > 0 ? "SELL" : "BUY";
      }
    }

    if (!action) return;

    if (action === "SELL" && player.position <= -this.maxPosition) return;
    if (action === "BUY" && player.position >= this.maxPosition) return;

    const result = this.trade(action);
    if (result?.filled) {
      this.cooldown = this.cooldownTicks;
    }
  }
}

export class MomentumTraderBot extends BaseBot {
  constructor({
    id,
    market,
    name = "Momentum Fund",
    lookback = 18,
    threshold = 0.0012,
    maxPosition = 4,
    cooldown = 3,
    aggressiveness = 1.6,
  } = {}) {
    super({ id, market, name, meta: { role: "momentum" } });
    this.lookback = Math.max(6, lookback);
    this.threshold = threshold;
    this.maxPosition = maxPosition;
    this.cooldownTicks = Math.max(1, Math.round(cooldown));
    this.cooldown = 0;
    this.aggressiveness = aggressiveness;
    this.shortFraction = 0.4;
    this.history = [];
  }

  onTick({ price }) {
    const player = this.ensureSeat();
    if (!player) return;

    this.history.push(price);
    if (this.history.length > this.lookback) this.history.shift();

    if (this.history.length < Math.max(4, Math.round(this.lookback * 0.5))) return;

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    const longAvg = this.history.reduce((sum, p) => sum + p, 0) / this.history.length;
    const shortWindow = Math.max(3, Math.round(this.history.length * this.shortFraction));
    const shortSlice = this.history.slice(-shortWindow);
    const shortAvg = shortSlice.reduce((sum, p) => sum + p, 0) / shortSlice.length;
    const signal = (shortAvg - longAvg) / longAvg;

    let target = 0;
    if (Math.abs(signal) >= this.threshold * 0.6) {
      const scaled = signal * this.aggressiveness;
      target = clamp(Math.round(scaled / this.threshold), -this.maxPosition, this.maxPosition);
    }

    if (player.position < target) {
      const result = this.trade("BUY");
      if (result?.filled) this.cooldown = this.cooldownTicks;
    } else if (player.position > target) {
      const result = this.trade("SELL");
      if (result?.filled) this.cooldown = this.cooldownTicks;
    }
  }
}

export class NewsReactorBot extends BaseBot {
  constructor({
    id,
    market,
    name = "Headline Desk",
    sensitivity = 0.08,
    deadband = 0.6,
    maxPosition = 5,
    cooldown = 2,
  } = {}) {
    super({ id, market, name, meta: { role: "news" } });
    this.sensitivity = sensitivity;
    this.deadband = deadband;
    this.maxPosition = maxPosition;
    this.cooldownTicks = Math.max(1, Math.round(cooldown));
    this.cooldown = 0;
  }

  onTick({ price, fairTarget, fairValue, priceMode }) {
    const player = this.ensureSeat();
    if (!player) return;

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    const anchor = priceMode === "news" ? fairTarget : fairValue;
    const diff = anchor - price;
    const withinBand = Math.abs(diff) < this.deadband;
    const desired = withinBand
      ? 0
      : clamp(Math.round(diff * this.sensitivity), -this.maxPosition, this.maxPosition);

    if (player.position < desired) {
      const result = this.trade("BUY");
      if (result?.filled) this.cooldown = this.cooldownTicks;
    } else if (player.position > desired) {
      const result = this.trade("SELL");
      if (result?.filled) this.cooldown = this.cooldownTicks;
    }
  }
}

export class NoiseTraderBot extends BaseBot {
  constructor({
    id,
    market,
    name = "Flow Noise",
    tradeProbability = 0.3,
    maxPosition = 3,
    cooldown = 1,
    flattenProbability = 0.22,
    momentumBias = 0.08,
    bias = 0,
  } = {}) {
    super({ id, market, name, meta: { role: "noise" } });
    this.tradeProbability = tradeProbability;
    this.maxPosition = maxPosition;
    this.cooldownTicks = Math.max(1, Math.round(cooldown));
    this.cooldown = 0;
    this.flattenProbability = flattenProbability;
    this.momentumBias = momentumBias;
    this.bias = bias;
  }

  onTick({ priceChange }) {
    const player = this.ensureSeat();
    if (!player) return;

    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    if (Math.random() > this.tradeProbability) return;

    let action = null;

    const flatten = Math.random() < this.flattenProbability;
    if (flatten && player.position !== 0) {
      action = player.position > 0 ? "SELL" : "BUY";
    } else {
      let directionalBias = this.bias;
      if (priceChange > 0) directionalBias += this.momentumBias;
      else if (priceChange < 0) directionalBias -= this.momentumBias;
      const buyChance = clamp(0.5 + directionalBias, 0.1, 0.9);
      action = Math.random() < buyChance ? "BUY" : "SELL";
    }

    if (action === "BUY" && player.position >= this.maxPosition) return;
    if (action === "SELL" && player.position <= -this.maxPosition) return;

    const result = this.trade(action);
    if (result?.filled) this.cooldown = this.cooldownTicks;
  }
}
