export class BotManager {
  constructor({ market, logger = console } = {}) {
    this.market = market;
    this.logger = logger;
    this.bots = new Map();
  }

  registerBot(bot) {
    if (!bot?.id) throw new Error("Bot requires an id");
    this.bots.set(bot.id, bot);
    this.logger.info?.(`[bot] registered ${bot.id}`);
    return bot;
  }

  clear() {
    this.bots.clear();
  }

  tick(context) {
    for (const bot of this.bots.values()) {
      try {
        bot.onTick?.(context);
      } catch (err) {
        this.logger.error?.(`[bot] tick failed for ${bot.id}`, err);
      }
    }
  }
}

export class PassiveMarketMakerBot {
  constructor({ id, market, spread = 0.1, inventoryTarget = 0 } = {}) {
    this.id = id;
    this.market = market;
    this.spread = spread;
    this.inventoryTarget = inventoryTarget;
  }

  onTick({ price }) {
    const player = this.market.getPlayer(this.id);
    if (!player) {
      this.market.registerPlayer(this.id, `MM-${this.id}`);
      return;
    }
    const imbalance = player.position - this.inventoryTarget;
    if (imbalance > 0) {
      this.market.processTrade(this.id, "SELL");
    } else if (imbalance < 0) {
      this.market.processTrade(this.id, "BUY");
    }
  }
}
