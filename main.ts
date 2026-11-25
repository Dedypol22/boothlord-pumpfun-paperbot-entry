// Pump.fun Paper Sprint entry: launch-snipe bot with a creator filter.
// The hello message starts the run, each batch carries one slot of events,
// and this bot answers every batch with the orders it decides for that slot
// (each order fills 2 slots later, per the harness latency). See strategy.ts
// for the full design: tiny tickets on fresh launches, scale into runners,
// cut losers fast.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
