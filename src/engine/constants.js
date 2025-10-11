export const DEFAULT_ENGINE_CONFIG = {
  tickMs: 250,
  leaderboardInterval: 2,
  fairSmooth: 0.12,
  fairMaxStepPct: 0.01,
  priceAcceleration: 0.02,
  priceDamping: 0.15,
  velocityCapPct: 0.004,
  noisePct: 0.0015,
  turbulenceNoisePct: 0.001,
  maxPosition: 5,
  startPrice: 100,
  defaultPriceMode: "news",
  newsImpulseFactor: 0.35,
  newsImpulseDecay: 0.88,
  newsImpulseCap: 18,
  orderFlowImpact: 0.65,
  orderFlowDecay: 0.55,
  orderFlowFairPull: 0.015,
  tradeLotSize: 1,
  orderBook: {},
};

export const DEFAULT_PRODUCT = {
  name: "Demo Asset",
  startPrice: 100,
};
