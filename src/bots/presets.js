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
    inventory: { maxAbs: 1200, target: 0 },
    child: { size: { mean: 3, sigma: 1 } },
    execution: { randomness: 0.12 },
    risk: { maxLoss: -8000, maxDrawdown: -6000, killSwitch: true },
    features: { enabled: true },
  },
  {
    id: "random-flow-1",
    name: "Random Flow",
    botType: "Rnd-Flow",
    latencyMs: { mean: 1000, jitter: 50 },
    inventory: { maxAbs: 2000, target: 0 },
    execution: { marketBias: 0.6 },
    risk: { maxLoss: -6000, maxDrawdown: -4000, killSwitch: false },
    features: { enabled: true },
  },
];

export const DEFAULT_BOT_FIELD_DOCS = {
  type: "Strategy archetype identifier shown in the admin tables and detail panels.",
  name: "Human-friendly label rendered in the admin UI.",
  risk: {
    maxLoss: "Hard loss cap before risk controls pause the bot.",
    maxDrawdown: "Drawdown tolerance tracked in the admin detail view.",
    killSwitch: "Whether to pause automatically when risk thresholds breach.",
  },
  inventory: {
    maxAbs: "Absolute position clamp used for inventory and resting quote limits.",
    target: "Desired position used by strategies when skewing quotes or rebalancing.",
  },
};

export function loadDefaultBotConfigs() {
  return DEFAULT_BOT_CONFIG.map((cfg) => JSON.parse(JSON.stringify({ ...cfg, id: cfg.id })));
}
