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

  it("starts with an empty order book (no baseline liquidity)", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const book = engine.getOrderBookView(10);
    assert.equal(book.bids.length, 0);
    assert.equal(book.asks.length, 0);
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

  it("registers default bots and exposes detail/toggle controls", async () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 150 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadDefaultBots();
    const summary = manager.getSummary();
    assert.ok(summary.bots.length >= 1, "default config should register automated bots");

    const flowPulse = summary.bots.find((b) => b.type === "FlowPulse");
    assert.ok(flowPulse, "FlowPulse bot should be part of default roster");

    manager.toggleBot(flowPulse.id, false);
    const detail = manager.getDetail(flowPulse.id);
    assert.ok(detail, "detail view should be available for bot");
    assert.equal(detail.enabled, false, "toggled bot should be disabled");
  });

  it("keeps scenarios inert while bots/news are disabled", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 180 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadDefaultBots();
    const result = manager.runScenario("block-trade-day");
    assert.equal(result.ok, false);
    const news = engine.getNewsEvents({ lookbackMs: 5_000 });
    assert.equal(news.length, 0, "scenarios should not inject news");
  });

  it("rounds all quantities to whole-number shares", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const seller = engine.registerPlayer("seller", "Seller");
    const buyer = engine.registerPlayer("buyer", "Buyer");
    assert.ok(seller && buyer, "players should register");

    const askPrice = engine.currentPrice + TICK;
    const place = engine.submitOrder("seller", { type: "limit", side: "SELL", price: askPrice, quantity: 3.72 });
    assert.equal(place.ok, true);
    assert.equal(Math.round(place.resting.remainingUnits), place.resting.remainingUnits, "resting order should be whole units");

    const exec = engine.submitOrder("buyer", { type: "market", side: "BUY", quantity: 3.14 });
    assert.ok(exec.ok && exec.filled > 0, "market order should execute");
    assert.equal(Math.round(exec.qty), exec.qty, "executed quantity should be an integer");

    const trades = engine.getRecentTrades(5_000);
    assert.ok(trades.length > 0, "trade tape should contain fills");
    for (const t of trades) {
      assert.equal(Math.round(t.size), t.size, "trade sizes should be integer lots");
    }
  });

  it("FlowPulse bot scales flow per tick and layers resting orders away from the top", async () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 110 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadConfig([
      {
        id: "flow-test",
        name: "Flow Test",
        botType: "FlowPulse",
        mix: { market: 0, limit: 1 },
        priceLevels: 4,
        maxDistanceTicks: 4,
        smoothing: 1,
        child: { size: { fixed: 1 } },
      },
    ]);

    const randomSeq = [0.95, 0.8, 0.7, 0.6];
    let idx = 0;
    const originalRandom = Math.random;
    Math.random = () => {
      const val = randomSeq[idx % randomSeq.length];
      idx += 1;
      return val;
    };

    try {
      for (let i = 0; i < 8; i += 1) {
        const snapshot = engine.stepTick();
        manager.tick({ ...snapshot, deltaMs: engine.config.tickMs });
        await flushMicrotasks();
      }
    } finally {
      Math.random = originalRandom;
    }

    const resting = engine.orderBook.getOrdersForOwner("flow-test");
    assert.ok(resting.length > 0, "flow bot should leave resting liquidity");
    const best = engine.getTopOfBook(1);
    const tick = engine.bookConfig.tickSize;
    const hasDistance = resting.some((ord) => {
      if (ord.side === "BUY" && Number.isFinite(best.bestBid)) {
        return ord.price <= best.bestBid - tick;
      }
      if (ord.side === "SELL" && Number.isFinite(best.bestAsk)) {
        return ord.price >= best.bestAsk + tick;
      }
      return false;
    });
    assert.ok(hasDistance, "orders should span away from the top levels");
  });
});
