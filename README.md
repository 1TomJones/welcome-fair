# welcome-fair

Multiplayer trading sim with a live market synced across devices that reacts to news and other player inputs.

## High level architecture

| Layer | Purpose |
| --- | --- |
| **`server.mjs`** | Express + Socket.IO host responsible for orchestrating player sessions, streaming market data, and coordinating admin controls. |
| **`public/`** | Browser clients for players and admins. Players trade from mobile/desktop; admins can start, pause, and broadcast news events. |
| **`src/engine/`** | Modular market core. `MarketEngine` owns price dynamics, player state, and PnL. `BotManager` offers a plug-in surface for AI traders that will ultimately drive liquidity and realism. |

The server now delegates all pricing and inventory logic to `MarketEngine`, which keeps the simulation deterministic and testable. Bots are managed separately so we can iterate on behaviours (market making, arbitrage, momentum, hedging) without tangling socket concerns.

## Getting started

```bash
npm install
npm start
```

Open `http://localhost:10000` for the player UI and `http://localhost:10000/admin.html` for controls.

## Simulation modes

The admin console can toggle between two pricing regimes mid-round:

* **News-driven** &mdash; price mean reverts toward an admin-controlled fair value while responding to headline shocks with decaying volatility bursts.
* **Volume-driven** &mdash; price impact is sourced from the aggregate buy/sell pressure of humans and bots, producing more microstructure-style swings when order flow is lopsided.

You can observe the live tape (last trade and fair value) directly in the admin dashboard chart to keep tabs on what players see.

## Depth of market

When volume-driven mode is active the engine clears every order against a central limit book. The player and admin UIs now expose a depth-of-market pane that auto-centres the inside bid/ask so you can watch liquidity disappear as market orders lift the offer or hit the bid. News-driven mode still shows the book for situational awareness, but only volume mode consumes levels.

## Built-in bot roster

A handful of distinct AI desks inject liquidity and realism as soon as a round starts:

* **Grid Market Maker** keeps spreads tight, leaning against extended moves and working back to a flat inventory.
* **Momentum Fund** chases short-term price strength, scaling into trends and unwinding when momentum fades.
* **Headline Desk** reacts to the gap between price and the admin-set fair target, piling into positive or negative news until the move is absorbed.
* **Flow Noise** adds background order flow with a slight momentum bias, forcing humans to trade against a constantly shifting tape.

They appear in the admin leaderboard with a “BOT” tag so you can monitor their PnL alongside human participants.

## Pulling in assistant updates

If the branch you are merging into already has manual edits, GitHub may surface conflicts when applying an assistant-generated PR. Check out [`docs/merge-guide.md`](docs/merge-guide.md) for a step-by-step workflow to integrate the update without losing your own changes.

## Next steps

* Flesh out diverse bot archetypes (market making, trend following, macro/news driven) on top of `BotManager`.
* Expand the order book so bots and (eventually) players can stage resting limit orders with richer behaviours (icebergs, pegged quotes, etc.) and introduce routing/latency nuances.
* Add persistence and analytics so rounds can be replayed and scored after the fact.
* Expand the admin dashboard with richer telemetry (order flow, depth, bot diagnostics, risk metrics) and surface per-player trade history.
