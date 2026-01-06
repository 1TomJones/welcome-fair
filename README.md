# welcome-fair

Multiplayer trading sim with a live market synced across devices that reacts to news and other player inputs.

## High level architecture

| Layer | Purpose |
| --- | --- |
| **`server.mjs`** | Express + Socket.IO host responsible for orchestrating player sessions, streaming market data, and coordinating admin controls. |
| **`public/`** | Browser clients for players and admins. Players trade from mobile/desktop; admin UI still exposes news/bot controls as placeholders. |
| **`src/engine/`** | Modular market core. `MarketEngine` owns price dynamics, player state, and PnL. `BotManager` remains as a stub (no automated order flow) so the UI can render existing panels without powering background bots. |

The server now delegates all pricing and inventory logic to `MarketEngine`, which keeps the simulation deterministic and testable. Bots are managed separately so we can iterate on behaviours (market making, arbitrage, momentum, hedging) without tangling socket concerns.

## Getting started

```bash
npm install
npm start
```

Open `http://localhost:10000` for the player UI and `http://localhost:10000/admin.html` for controls.

## Simulation modes

The admin console still exposes a toggle for price modes, but the current build runs a single simplified path:

* **Volume-driven (default)** &mdash; price impact comes only from live player order flow. Bots and news impulses have been disabled; the toggle remains for UI continuity but does not enable automated shocks.

You can observe the live tape directly in the admin dashboard chart to keep tabs on what players see.

## Depth of market

When volume-driven mode is active the engine clears every order against a central limit book. The player and admin UIs now expose a depth-of-market pane that auto-centres the inside bid/ask so you can watch liquidity disappear as market orders lift the offer or hit the bid. News-driven mode still shows the book for situational awareness, but only volume mode consumes levels.

## Player cockpit

* Desktop-first layout keeps the price chart on the left, the full DOM stack on the right, and a lower strip for the Kent Invest branding, floor chat, and order ticket.
* The order ticket supports one-click market orders or configurable limit orders, and tracks all resting orders so players can cancel specific quotes or flatten everything at once.
* A persistent chat feed lets the desk coordinate reactions to news shocks while the DOM highlights any levels seeded by your own resting liquidity.

## Built-in bot roster

Automated desks are currently disabled. The admin UI still shows the roster panel for future work, but no bots will appear or submit orders in this stripped-back version.

## Pulling in assistant updates

If the branch you are merging into already has manual edits, GitHub may surface conflicts when applying an assistant-generated PR. Check out [`docs/merge-guide.md`](docs/merge-guide.md) for a step-by-step workflow to integrate the update without losing your own changes.

## Next steps

* Flesh out diverse bot archetypes (market making, trend following, macro/news driven) on top of `BotManager`.
* Expand the order book so bots and (eventually) players can stage resting limit orders with richer behaviours (icebergs, pegged quotes, etc.) and introduce routing/latency nuances.
* Add persistence and analytics so rounds can be replayed and scored after the fact.
* Expand the admin dashboard with richer telemetry (order flow, depth, bot diagnostics, risk metrics) and surface per-player trade history.
