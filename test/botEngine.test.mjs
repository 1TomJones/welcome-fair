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

  it("keeps bot roster empty by default", async () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 150 });
    const manager = new BotManager({ market: engine, logger: console });
    manager.loadDefaultBots();
    const summary = manager.getSummary();
    assert.equal(summary.bots.length, 0, "default config should register no automated bots");

    const snapshot = engine.getSnapshot();
    manager.tick(snapshot);
    await flushMicrotasks();
    const refreshed = manager.getSummary();
    assert.equal(refreshed.bots.length, 0, "bot roster should remain empty");
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

  it("converts unfilled market orders to resting and allows later market crosses", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const buyer = engine.registerPlayer("buyer", "Buyer");
    const seller = engine.registerPlayer("seller", "Seller");
    assert.ok(buyer && seller, "players should register");

    const buyRes = engine.submitOrder("buyer", { type: "market", side: "BUY", quantity: 2 });
    assert.equal(buyRes.ok, true, "market-to-limit conversion should be accepted");
    const restingOrders = engine.getPlayerOrders("buyer");
    assert.ok(restingOrders.length === 1, "unfilled market order should rest as a limit");
    assert.equal(Math.round(restingOrders[0].remaining), 2);

    const sellRes = engine.submitOrder("seller", { type: "market", side: "SELL", quantity: 1 });
    assert.equal(sellRes.ok, true, "subsequent market sell should execute against resting bid");
    assert.ok(sellRes.filled, "sell should fill");

    assert.equal(engine.getPlayer("buyer").position, 1);
    assert.equal(engine.getPlayer("seller").position, -1);
    const updatedOrders = engine.getPlayerOrders("buyer");
    assert.equal(Math.round(updatedOrders[0].remaining), 1, "resting order should decrement after fill");
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
});
