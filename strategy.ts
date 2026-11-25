// Overhang Exhaustion & Breakout Survivor bot for the pump.fun paper sprint.
//
// What actually wins on the dev window (tested, not assumed): the launch
// snipe. The first trade on every curve in this dataset is a buy, and the
// price essentially never falls back below its create price in the first few
// hundred slots — so a bot that buys a launch in its first ~15 slots, at
// most ~40% above its create price, buys the floor of the opening tape
// rather than its top. Most launches then bleed slowly, so tickets are
// tiny (0.01 SOL) and losers are cut fast (8% stop, 75-slot time limit).
// The money is in the rare runner: as a launch's real SOL grows, the 1%
// reserve cap lets the bot scale in up to 0.4 SOL, and a 30%-armed trailing
// stop lets a runner run for hundreds of slots. One such runner
// (CHjgAurR) made +2.05 SOL on the dev window; the other ~400 tickets
// bled ~-0.002 SOL each. Momentum / breakout-survivor entries were tried
// extensively and lost money on every variant, so they are off by default
// (useMomentum) and kept only for research.
//
// Sizing and exits for the snipe: first buy small, pyramid into strength
// only (price stepped up from the last add, position in profit, real SOL
// still growing), up to a per-position cap. Exits: stop-loss vs cost, a
// trailing stop once armed, an exit the moment the creator sells, a stale
// exit that sells into the frozen mark when the tape goes quiet, and a time
// limit that does not bind while the position is up. Positions are always
// sold whole. The stop is 8%, not 6%: at 6% a second runner (4ufdcDYm,
// +0.315 SOL over 723 slots) was stopped out on an early 6-8% dip before it
// ran, while 8-10% is a flat plateau (+2.02..+2.11 SOL); 4% destroys the
// book (-0.24 SOL) and strands whole-position sells against shrunken real
// reserves (sell-side max_order_size rejects). Tiny probe round-trips keep the run above the guardrail pace
// (at least 20 distinct mints) when the main signals go quiet.
//
// Deterministic by construction: no clock, no randomness, no environment
// reads; iteration only over insertion-ordered maps fed by the batch stream.
// The hello message seeds nothing random here; every decision is a pure
// function of the batches seen so far.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Short entry window in slots. */
  window: number;
  /** Long window whose high defines a breakout (slots). */
  longWindow: number;
  /** Fresh runner: age window (slots since CreateEvent). */
  freshMinAge: number;
  freshMaxAge: number;
  /** Fresh runner: minimum price rise over the short window. */
  freshMinUp: number;
  /** Fresh runner: minimum net SOL (buys minus sells) over the short window. */
  freshMinNet: number;
  /** Breakout survivor: price must have fallen at least this far from its all-time high. */
  survivorDump: number;
  /** Breakout survivor: minimum net SOL over the long window. */
  survivorMinNet: number;
  /** Shared entry filters. */
  minBuys: number;
  minBuyers: number;
  maxTopShare: number;
  nearHigh: number;
  /** Pullback survived: long-window low at most this share of the long-window high. */
  pullback: number;
  minRqSol: number;
  maxRqSol: number;
  /** Curve real SOL above this is treated as near completion: never enter. */
  nearCompleteRqSol: number;
  /** Sizing (SOL). */
  initialSol: number;
  addSol: number;
  stakeSol: number;
  minBuySol: number;
  maxExposureSol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  hardTakeProfit: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  holdIfUp: number;
  /** Add only once price is this much above the last add's price. */
  addStep: number;
  /** Add only while net SOL over the short window is at least this. */
  addNetSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Guardrail pacing: target fills / coins over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Launch snipe: buy a new curve in its first slots, before the opening
   * tape has run away, and scale in as its real SOL grows. */
  snipeMaxAge: number;
  snipeMinRqSol: number;
  snipeMaxRqSol: number;
  /** Skip a launch whose price already ran this far past its create price. */
  snipeMaxRunup: number;
  snipeMinBuyers: number;
  snipeInitialSol: number;
  snipeAddSol: number;
  snipeStakeSol: number;
  snipeAddStep: number;
  snipeStopLoss: number;
  snipeTrailArm: number;
  snipeTrail: number;
  snipeMaxHold: number;
  snipeStaleSlots: number;
  /** Time limit does not apply while value is at least cost * (1 + this). */
  snipeHoldIfUp: number;
  /** Skip a launch whose creator already bought at least this much SOL. */
  snipeMaxCreatorBuySol: number;
  /** Momentum / breakout-survivor entries (shape A/B). Off by default: on
   * the full dev window every momentum variant lost money (-0.5 to -1.7 SOL
   * over ~240 trips) while the launch snipe carried the PnL. */
  useMomentum: boolean;
}

// Settings traded by main.ts. Tuned on the full 24h dev window with the
// local simulator, preferring flat regions over a single best cell.
export const DEFAULT_PARAMS: Params = {
  window: 30,
  longWindow: 150,
  freshMinAge: 200,
  freshMaxAge: 1200,
  freshMinUp: 0.1,
  freshMinNet: 0.8,
  survivorDump: 0.3,
  survivorMinNet: 0.2,
  minBuys: 4,
  minBuyers: 5,
  maxTopShare: 0.45,
  nearHigh: 0.95,
  pullback: 0.88,
  minRqSol: 2,
  maxRqSol: 60,
  nearCompleteRqSol: 75,
  initialSol: 0.1,
  addSol: 0.15,
  stakeSol: 0.75,
  minBuySol: 0.01,
  maxExposureSol: 6,
  buySlipBps: 1500,
  stopLoss: 0.15,
  trailArm: 0.1,
  trail: 0.15,
  hardTakeProfit: 0.4,
  fadeWindow: 15,
  fadeNetSol: 0.8,
  maxHold: 900,
  holdIfUp: 0.1,
  addStep: 0.05,
  addNetSol: 0.3,
  cooldown: 200,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
  snipeMaxAge: 15,
  snipeMinRqSol: 1,
  snipeMaxRqSol: 40,
  snipeMaxRunup: 1.4,
  snipeMinBuyers: 2,
  snipeInitialSol: 0.01,
  snipeAddSol: 0.2,
  snipeStakeSol: 0.4,
  snipeAddStep: 0.05,
  snipeStopLoss: 0.08,
  snipeTrailArm: 0.3,
  snipeTrail: 0.25,
  snipeMaxHold: 75,
  snipeStaleSlots: 200,
  snipeHoldIfUp: 0.05,
  snipeMaxCreatorBuySol: 0.2,
  useMomentum: false,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
/** SOL of cash never spent on buys: sells always need a tx fee, and a bot
 * that spends its last lamport on a buy can never sell anything again. */
const CASH_RESERVE_SOL = 0.05;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  createPrice: number;
  creator: string;
  creatorSold: boolean;
  creatorBuySol: number;
  trades: Trade[];
  /** Highest recorded price so far. */
  ath: number;
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
  lastRqSol: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  kind: string;
  lastRqSol: number;
  lastTradeSlot: number;
}

interface WindowStats {
  buySol: number;
  sellSol: number;
  buys: number;
  buyers: number;
  topShare: number;
  startPrice: number;
  high: number;
  low: number;
  lastPrice: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.longWindow, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, creator: '', creatorSold: false, creatorBuySol: 0, trades: [], ath: 0, entries: 0, lastExit: -1e12, lastTradeSlot: -1e12, lastRqSol: 0 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Rolling stats over the last `w` slots ending at `now`, plus the price at the window start. */
  const windowStats = (t: Tape, now: number, w: number): WindowStats => {
    const from = now - w;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let high = 0;
    let low = Infinity;
    let startPrice = -1;
    let lastPrice = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      lastPrice = tr.price;
    }
    if (startPrice < 0) startPrice = lastPrice;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    return {
      buySol,
      sellSol,
      buys,
      buyers: byUser.size,
      topShare: buySol > 0 ? top / buySol : 1,
      startPrice,
      high,
      low: low === Infinity ? lastPrice : low,
      lastPrice,
    };
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Shared dispersed-ownership check on a window's stats. */
  const dispersed = (s: WindowStats): boolean =>
    s.buys >= p.minBuys && s.buyers >= p.minBuyers && s.topShare <= p.maxTopShare;

  /**
   * Entry test for one curve at slot `now`. Returns 'fresh' | 'survivor' | null.
   * `price` is the current curve price, `rqSol` its real SOL reserves.
   */
  const entryKind = (t: Tape, now: number, price: number, rqSol: number): string | null => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol || rqSol >= p.nearCompleteRqSol) return null;
    if (t.created === null) return null;
    const age = now - t.created;
    const short = windowStats(t, now, p.window);
    const long = windowStats(t, now, p.longWindow);
    if (short.lastPrice <= 0 || long.high <= 0) return null;
    // Both shapes need the price sitting near the long-window high after a
    // pullback, on dispersed buying.
    if (price < long.high * p.nearHigh) return null;
    if (long.low > long.high * p.pullback) return null;
    if (!dispersed(short)) return null;
    // Shape A: fresh runner — young, already up hard on strong net inflow.
    if (age >= p.freshMinAge && age <= p.freshMaxAge) {
      const up = short.startPrice > 0 ? price / short.startPrice - 1 : 0;
      if (up >= p.freshMinUp && short.buySol - short.sellSol >= p.freshMinNet) return 'fresh';
    }
    // Shape B: breakout survivor — dumped hard from its all-time high, based
    // out, now back near the long high on flat-to-positive long flow.
    if (age >= p.freshMinAge && t.ath > 0 && price <= t.ath * (1 - p.survivorDump)) {
      if (long.buySol - long.sellSol >= p.survivorMinNet) return 'survivor';
    }
    return null;
  };

  /**
   * Launch-snipe test: a brand-new curve, real SOL already established, the
   * creator has not sold, at least a couple of distinct buyers are in, and
   * the price has not already run far past its create price. The first trade
   * on every curve in this dataset is a buy, and the price essentially never
   * falls back below its create price in the first few hundred slots, so an
   * early entry buys the floor of the opening tape rather than its top.
   */
  const snipeEntry = (t: Tape, now: number, price: number, rqSol: number): boolean => {
    if (t.created === null || t.createPrice <= 0) return false;
    if (now - t.created > p.snipeMaxAge) return false;
    if (rqSol < p.snipeMinRqSol || rqSol > p.snipeMaxRqSol) return false;
    if (price > t.createPrice * p.snipeMaxRunup) return false;
    if (t.creatorSold) return false;
    if (t.creatorBuySol > p.snipeMaxCreatorBuySol) return false;
    const buyers = new Set<string>();
    for (const tr of t.trades) if (tr.buy) buyers.add(tr.user);
    return buyers.size >= p.snipeMinBuyers;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user, price });
          if (price > t.ath) t.ath = price;
          t.lastTradeSlot = e.slot;
          t.lastRqSol = Number(e.real_quote_reserves) / LAMPORTS;
          if (e.user === t.creator) {
            if (e.is_buy) t.creatorBuySol += Number(e.sol_amount) / LAMPORTS;
            else t.creatorSold = true;
          }
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop-loss, armed trailing stop, hard take-profit, fade, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        h.lastTradeSlot = t.lastTradeSlot;
        h.lastRqSol = t.lastRqSol;
        let exit = h.exiting;
        if (h.kind === 'snipe') {
          // Snipe exits: stop-loss, armed trailing stop, creator dump, stale
          // tape (sell into the stale mark), and a time limit that does not
          // bind while the position is up. No hard take-profit: a launch
          // that keeps running is where the money is.
          if (!exit && value < cost * (1 - p.snipeStopLoss)) exit = true;
          if (!exit && h.peakValue >= cost * (1 + p.snipeTrailArm) && value < h.peakValue * (1 - p.snipeTrail)) exit = true;
          if (!exit && t.creatorSold) exit = true;
          if (!exit && now - t.lastTradeSlot > p.snipeStaleSlots) exit = true;
          if (!exit && now - h.opened > p.snipeMaxHold && value < cost * (1 + p.snipeHoldIfUp)) exit = true;
        } else {
          if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
          if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
          if (!exit && value >= cost * (1 + p.hardTakeProfit)) exit = true;
          if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
          if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        let newKind = 'main';
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          // Launch snipe first: it buys the floor of the opening tape.
          if (snipeEntry(t, now, price, rqSol)) {
            newKind = 'snipe';
            want = Math.min(p.snipeInitialSol, p.snipeStakeSol);
          } else {
            if (!p.useMomentum || entryKind(t, now, price, rqSol) === null) continue;
            want = Math.min(p.initialSol, p.stakeSol);
          }
        } else if (h.kind === 'snipe') {
          // Scale into a launch as its real SOL grows: adds are capped by
          // the 1%-of-reserve rule anyway, so a runner can take real size
          // while a dud stays at its tiny first buy.
          if (h.exiting || !h.filled || h.invested >= p.snipeStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.snipeAddStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (rqSol < h.lastRqSol) continue;
          if (now - h.opened > p.snipeMaxHold) continue;
          want = Math.min(p.snipeAddSol, p.snipeStakeSol - h.invested);
        } else {
          // Pyramid into strength only: price stepped up from the last add,
          // the position is in profit, and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx - CASH_RESERVE_SOL) amount = free - tx - CASH_RESERVE_SOL;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0, kind: newKind, lastRqSol: rqSol, lastTradeSlot: t.lastTradeSlot });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
          h.lastRqSol = rqSol;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx + CASH_RESERVE_SOL) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
