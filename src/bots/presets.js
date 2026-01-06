export const DEFAULT_BOT_CONFIG = [
  {
    id: "flow-pulse-1",
    name: "Flow Pulse",
    botType: "FlowPulse",
    enabled: true,
    mix: { market: 0.6, limit: 0.4 },
    priceLevels: 10,
    maxDistanceTicks: 10,
    smoothing: 0.35,
    child: { size: { mean: 3, sigma: 1 } },
    execution: { randomness: 0.12 },
    features: { enabled: true },
  },
  {
    id: "random-flow-1",
    name: "Random Flow",
    botType: "Rnd-Flow",
    latencyMs: { mean: 1000, jitter: 50 },
    inventory: { maxAbs: 2000, target: 0 },
    execution: { marketBias: 0.6 },
    features: { enabled: true },
  },
];

export function loadDefaultBotConfigs() {
  return DEFAULT_BOT_CONFIG.map((cfg) => JSON.parse(JSON.stringify({ ...cfg, id: cfg.id })));
}
