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

## Next steps

* Flesh out diverse bot archetypes (market making, trend following, macro/news driven) on top of `BotManager`.
* Implement an order book + matching engine so prices are determined exclusively by participant supply/demand.
* Add persistence and analytics so rounds can be replayed and scored after the fact.
* Expand the admin dashboard with richer telemetry (order flow, bot diagnostics, risk metrics).
