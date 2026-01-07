export const DEFAULT_ENGINE_CONFIG = {
  tickMs: 250,
  leaderboardInterval: 2,
  maxPosition: 5,
  startPrice: 100,
  defaultPriceMode: "orderflow",
  orderFlowDecay: 0.55,
  tradeLotSize: 1,
  orderBook: {},
  ambient: {
    seedPerTick: 2,
    sizeRange: [1, 3],
    maxDistanceTicks: 8,
    nearMidWeight: 1.6,
  },
};

export const DEFAULT_PRODUCT = {
  name: "Demo Asset",
  startPrice: 100,
};
