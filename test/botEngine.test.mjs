import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { MarketEngine } from "../src/engine/marketEngine.js";
import { BotManager } from "../src/engine/botManager.js";

const TICK = 0.5;

function createEngine() {
  return new MarketEngine({
    defaultPriceMode: "orderflow",
    orderBook: { tickSize: TICK },
  });
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("market engine and bot manager", () => {
  it("keeps price stable without trades in orderflow mode", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const before = engine.currentPrice;
    const afterTick = engine.stepTick();
    assert.equal(engine.currentPrice, before, "price should remain unchanged when no trades occur");
    assert.equal(afterTick.price, before);
  });

  it("records trades and exposes them via getRecentTrades", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const maker = engine.registerPlayer("maker", "Maker");
    const taker = engine.registerPlayer("taker", "Taker");
    assert.ok(maker && taker, "players should register");

    const askPrice = engine.currentPrice + TICK;
    const place = engine.submitOrder("maker", { type: "limit", side: "SELL", price: askPrice, quantity: 4 });
    assert.ok(place.ok, "limit order should be accepted");

    const exec = engine.submitOrder("taker", { type: "market", side: "BUY", quantity: 4 });
    assert.ok(exec.ok && exec.filled > 0, "market order should execute");

    const trades = engine.getRecentTrades(5_000);
    assert.ok(trades.length > 0, "trade tape should contain fills");
    const last = trades.at(-1);
    assert.equal(last.side, "BUY");
  });

  it("captures news events with sentiment", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 120 });
    engine.pushNews({ text: "Test Event", delta: 10, sentiment: 0.6, intensity: 5, halfLifeSec: 200 });
    const events = engine.getNewsEvents({ lookbackMs: 1_000 });
    assert.ok(events.length > 0, "news event should be stored");
    assert.equal(events.at(-1).text, "Test Event");
    assert.equal(events.at(-1).sentiment, 0.6);
  });

  it("loads default bot suite and produces telemetry", async () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 150 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadDefaultBots();
    const summary = manager.getSummary();
    assert.ok(summary.bots.length >= 5, "default config should register multiple bots");

    const snapshot = engine.getSnapshot();
    manager.tick(snapshot);
    await flushMicrotasks();
    const refreshed = manager.getSummary();
    assert.ok(refreshed.bots[0].metrics !== undefined, "telemetry metrics should exist");
  });

  it("runs canned scenarios and records news", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 180 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadDefaultBots();
    const result = manager.runScenario("block-trade-day");
    assert.equal(result.ok, true);
    const news = engine.getNewsEvents({ lookbackMs: 5_000 });
    assert.ok(news.length > 0, "scenario should inject a news impulse");
  });
});

