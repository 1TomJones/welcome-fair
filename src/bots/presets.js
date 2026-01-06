export const DEFAULT_BOT_CONFIG = [
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
  return DEFAULT_BOT_CONFIG.map((cfg) => ({ ...cfg, id: cfg.id }));
}
