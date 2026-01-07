export const DEFAULT_ENGINE_CONFIG = {
  tickMs: 250,
  leaderboardInterval: 2,
  maxPosition: 5,
  startPrice: 100,
  defaultPriceMode: "orderflow",
  orderFlowDecay: 0.55,
  tradeLotSize: 1,
  minDepthLots: 12,
  maxSpreadTicks: 6,
  minTopLevels: 3,
  orderBook: {},
};

export const DEFAULT_PRODUCT = {
  name: "Demo Asset",
  startPrice: 100,
};
