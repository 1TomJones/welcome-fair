export const DEFAULT_ENGINE_CONFIG = {
  tickMs: 250,
  leaderboardInterval: 2,
  maxPosition: 5,
  startPrice: 100,
  defaultPriceMode: "orderflow",
  orderFlowDecay: 0.55,
  tradeLotSize: 1,
  burst: {
    minTicks: 4,
    maxTicks: 12,
    minOrdersPerTick: 1,
    maxOrdersPerTick: 3,
    buyBias: 0.55,
  },
  orderBook: {},
};

export const DEFAULT_PRODUCT = {
  name: "Demo Asset",
  startPrice: 100,
};
