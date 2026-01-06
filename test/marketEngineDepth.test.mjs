import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { MarketEngine } from "../src/engine/marketEngine.js";

const DEFAULT_BOOK = {
  tickSize: 0.5,
  randomJitter: 0,
  regenRate: 0.4,
  baseDepth: 3,
  depthFalloff: 0,
  minVolume: 0.1,
};

function createEngine(overrides = {}) {
  const { orderBook, priceMode, noisePct, turbulenceNoisePct, priceAcceleration, priceDamping, ...rest } = overrides;
  return new MarketEngine({
    defaultPriceMode: priceMode || "orderflow",
    noisePct: noisePct ?? 0,
    turbulenceNoisePct: turbulenceNoisePct ?? 0,
    priceAcceleration: priceAcceleration ?? 0.02,
    priceDamping: priceDamping ?? 0.1,
    maxPosition: overrides.maxPosition ?? 50,
    ...rest,
    orderBook: { ...DEFAULT_BOOK, ...(orderBook || {}) },
  });
}

describe("market engine depth and sweep handling", () => {
  it("updates last trade and book after multi-level sweeps", () => {
    const engine = createEngine();
    engine.startRound({ startPrice: 100 });
    const sweeper = engine.registerPlayer("sweeper", "Sweeper");
    assert.ok(sweeper);

    const preBook = engine.getDepthSnapshot(3);
    const preBestAsk = preBook.bestAsk;
    const result = engine.submitOrder("sweeper", { type: "market", side: "BUY", quantity: 30 });
    assert.ok(result.ok && result.filled > 0, "market sweep should execute");
    assert.ok(result.fills.length > 1, "should consume multiple levels");

    assert.ok(engine.currentPrice > preBestAsk, "price should reflect clearing level");

    const postBook = engine.getDepthSnapshot(3);
    assert.ok(postBook.bestAsk > preBestAsk, "best ask should move up after sweep");
    const asksAtOldPrices = postBook.asks.filter((lvl) => lvl.price <= preBestAsk);
    assert.equal(asksAtOldPrices.length, 0, "swept price levels should remain empty immediately after sweep");
  });

  it("price velocity reacts to imbalance and sweep pressure", () => {
    const engine = createEngine({
      noisePct: 0,
      turbulenceNoisePct: 0,
      priceAcceleration: 0,
      sweepRegenDampen: 0.9,
      orderBook: { regenRate: 0.1 },
    });
    engine.startRound({ startPrice: 100 });
    const trader = engine.registerPlayer("momentum", "Momentum");
    assert.ok(trader);

    const sweep = engine.submitOrder("momentum", { type: "market", side: "BUY", quantity: 50 });
    assert.ok(sweep.ok && sweep.filled > 0);
    engine.setPriceMode("news");
    const beforeTick = engine.currentPrice;
    const depthMetrics = engine.getDepthSnapshot(6).metrics;
    assert.ok(depthMetrics, "depth metrics should be present");
    assert.ok(engine.lastSweepPressure > 0, "sweep pressure should be recorded after sweep");

    engine.stepTick();
    assert.ok(engine.currentPrice > beforeTick, "price should rise from imbalance and sweep pressure");
  });
});
