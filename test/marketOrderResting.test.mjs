import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { MarketEngine } from "../src/engine/marketEngine.js";

const TICK = 0.5;

function createEngine() {
  const engine = new MarketEngine({
    defaultPriceMode: "orderflow",
    orderBook: { tickSize: TICK },
  });
  engine.startRound({ startPrice: 100 });
  return engine;
}

describe("executeMarketOrder resting behavior", () => {
  it("rests when book is empty then fills when the opposing side arrives", () => {
    const engine = createEngine();
    engine.registerPlayer("buyer", "Buyer");
    engine.registerPlayer("seller", "Seller");

    const buy = engine.submitOrder("buyer", { type: "market", side: "BUY", quantity: 2 });
    assert.ok(buy.ok, "market order should be accepted");
    assert.ok(buy.resting, "residual should rest on the book");
    assert.equal(buy.resting.remainingUnits, 2);

    const restingOrders = engine.getPlayerOrders("buyer");
    assert.equal(restingOrders.length, 1, "resting order should be visible via getPlayerOrders");
    assert.equal(restingOrders[0].side, "BUY");
    assert.equal(restingOrders[0].remaining, 2);

    const detail = engine.getLevelDetail(100);
    assert.ok(detail?.bid, "bid side detail should exist at the resting price");
    const restingDetail = detail.bid.orders.find((ord) => ord.id === buy.resting.id);
    assert.ok(restingDetail, "resting order should be visible via getLevelDetail");
    assert.equal(restingDetail.remaining, 2);

    const sell = engine.submitOrder("seller", { type: "market", side: "SELL", quantity: 2 });
    assert.ok(sell.ok && sell.filled > 0, "opposing market order should execute against the resting liquidity");

    const remainingOrders = engine.getPlayerOrders("buyer");
    assert.equal(remainingOrders.length, 0, "resting order should be consumed after fill");
    const detailAfter = engine.getLevelDetail(100);
    const remainingBidOrders = detailAfter?.bid?.orders ?? [];
    assert.equal(remainingBidOrders.length, 0, "level detail should no longer show the consumed order");
  });
});
