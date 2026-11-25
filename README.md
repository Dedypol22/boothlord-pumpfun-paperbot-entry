# Boothlord Pump.fun Paper Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dedypol22/boothlord-pumpfun-paperbot-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dedypol22/boothlord-pumpfun-paperbot-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It trades pump.fun bonding curves on a replay of recorded chain data. Paper money only — no real funds, no shorts, no leverage.

## What the bot does

The bot snipes new launches. The first trade on every curve in the dev dataset is a buy, and the price essentially never falls back below its create price in the first few hundred slots — so buying a launch in its first ~15 slots, at most ~40% above its create price, buys the floor of the opening tape rather than its top. Launches where the creator already bought big are skipped (they are dumps in waiting), as is any launch whose creator has sold.

Tickets are tiny (0.01 SOL) and losers are cut fast (8% stop-loss, 75-slot time limit). The money is in the rare runner: as a launch's real SOL grows, the 1%-of-reserve cap lets the bot scale in up to 0.4 SOL per position, and a trailing stop armed at +30% lets a runner run for hundreds of slots. A creator sell, a stale tape, or the time limit exits the rest. A momentum / breakout-survivor entry mode is also implemented in `strategy.ts` but off by default — on the full dev window every momentum variant lost money while the launch snipe carried the PnL.

## Run

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via the vendored shim in `vendor/makefun-bot.ts`: it reads the hello message, answers each batch (one slot of events) with the orders it decides for that slot, and stops at done. It is fully deterministic — no clock, no randomness, no environment reads — so two runs produce identical action logs.

## Local backtest (dev window, all 24h)

| Net PnL | Fills | Coins | Round trips | Wins | Max drawdown |
|--------:|------:|------:|------------:|-----:|-------------:|
| +2.1134 SOL | 473 | 153 | 218 | 15 | 0.0419 |

The PnL is concentrated by design: a single runner carried most of the gain while the many small tickets bled a little each.

## Files

- `main.ts` — entrypoint: runs the strategy through the wire shim.
- `strategy.ts` — the full strategy (`createStrategy` / `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's wire shim, copied byte-for-byte.

## License

MIT — see [LICENSE](LICENSE).
