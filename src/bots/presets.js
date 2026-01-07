export const DEFAULT_BOT_CONFIG = [
  {
    id: "mm-bot-1",
    name: "MM-bot-1",
    botType: "MM-Book",
    enabled: true,
    latencyMs: { mean: 200, jitter: 25 },
    minDecisionMs: 150,
    inventory: { maxAbs: Number.POSITIVE_INFINITY, target: 0 },
    execution: { marketBias: 0 },
    refillMs: 5_000,
    volumeMultiplier: 1,
    walkTicksPerSecond: 2,
    levelPercents: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    features: { enabled: true },
  },
  {
    id: "random-bot-1",
    name: "Random-Bot",
    botType: "Random-Bot",
    enabled: true,
    latencyMs: { mean: 50, jitter: 10 },
    minDecisionMs: 25,
    inventory: { maxAbs: Number.POSITIVE_INFINITY, target: 0 },
    buyProbability: 0.5,
    marketProbability: 0.7,
    limitRangePct: 0.01,
    ordersPerTick: 5,
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
