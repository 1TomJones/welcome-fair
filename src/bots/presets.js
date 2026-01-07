export const DEFAULT_BOT_CONFIG = [
  {
    id: "mm-bot-1",
    name: "MM Bot 1",
    botType: "MM-Book",
    enabled: true,
    ladderPct: 0.1,
    levels: 10,
    volumeByPct: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    refillIntervalMs: 5000,
    walkTicksPerSecond: 2,
    execution: { style: "passive", marketBias: 0 },
    risk: { maxLoss: -20000, maxDrawdown: -12000, killSwitch: true },
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
