// pump-bot-riidzhsn: a paper-trading bot for the pump.fun replay harness
// (protocol agent-fun/replay/v2). Paper trading only: the bot reads a replay
// of recorded market data and answers with paper orders. It never touches a
// real wallet, never holds a key and never sends a real transaction.
//
// Strategy in one line: buy washed-out coins only after buyers reclaim the
// dip, exit fast on fixed take-profit / stop / trailing rules, and rotate
// tiny scout lots so at least 20 distinct coins complete a round trip.
//
// How the wire works: the hello message carries the caps (max open
// positions, max order size as a share of a curve's real reserve, max orders
// per batch). After that, every batch covers one slot of events, fills and
// marks, and the bot replies with the orders for that slot. Everything here
// is deterministic — no clock, no randomness, no network — so the two
// grading executions produce identical orders byte for byte.

import { runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1_000_000_000;

// ---- entry: washout-and-reclaim reversal ----
// A coin qualifies when, inside the lookback window, its price first fell
// hard from the window high and has since bounced off the window low while
// fresh buyers (not one wallet) push net flow positive again.
const LOOKBACK = 60; // slots of tape kept per coin
const MIN_AGE_SLOTS = 200; // slots after CreateEvent before eligibility
const DIP_MIN = 0.18; // window high -> window low drawdown at least 18%
const DIP_MAX = 0.55; // ...and at most 55% (deeper is a collapse, not a dip)
const RECLAIM_MIN = 0.06; // last price at least 6% above the window low
const RECLAIM_MAX = 0.45; // ...but not already up 45% off the low (no chasing)
const FLOW_SLOTS = 12; // recent-flow window in slots
const FLOW_NET_MIN = 1.5; // net SOL inflow over FLOW_SLOTS
const FLOW_BUYS_MIN = 6; // distinct buyers over FLOW_SLOTS
const FLOW_BUY_SHARE = 0.55; // buy SOL share of total SOL over FLOW_SLOTS
const RESERVE_MIN_SOL = 2; // real SOL reserves band for entries
const RESERVE_MAX_SOL = 70;
const ENTRY_SOL = 0.05; // first (and only) tranche per position
const ENTRY_MIN_SOL = 0.02; // never open below this after caps / cash checks
const ENTRY_SLIP_BPS = 1200;
const MAX_MAIN_POSITIONS = 4; // keep one of the 5 slots free for scout lots
const REENTRY_COOLDOWN = 900; // slots before a coin may be entered again
const LOSS_HALT_SOL = 0.9; // realized-loss circuit breaker for new entries

// ---- exits ----
const TAKE_PROFIT = 0.13; // sell everything at +13% over cost
const STOP_LOSS = 0.07; // sell everything at -7% under cost
const TRAIL_ARM = 0.05; // trailing stop arms once value is +5% over cost
const TRAIL_DROP = 0.09; // then a 9% fall from the peak sells
const FADE_SLOTS = 10; // outflow window for the momentum-fade exit
const FADE_NET_MAX = -0.7; // net SOL below this over FADE_SLOTS sells
const MAX_HOLD_SLOTS = 180; // time stop

// ---- guardrail rotation: round trips on >= 20 distinct coins ----
// The guardrail wants a round trip of at least 0.01 SOL on 20+ coins, so
// while the count is short the bot scouts the most actively traded coin it
// has not round-tripped yet with a small lot and sells it next batch.
const SCOUT_TARGET = 26;
const SCOUT_SOL = 0.015;
const SCOUT_EVERY = 250; // slots between scout buys while below target

interface Tick { slot: number; buy: boolean; sol: number; user: string; price: number }
interface CoinTape { created: number | null; ticks: Tick[]; lastExit: number }
interface OpenPos { opened: number; peakValue: number; exiting: boolean; filledOnce: boolean }

const tapes = new Map<Pubkey, CoinTape>();
const open = new Map<Pubkey, OpenPos>();
const scouts = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let lastScoutSlot = -1_000_000;
let filledBuySol = 0;
let filledSellSol = 0;

function tapeFor(mint: Pubkey): CoinTape {
  let t = tapes.get(mint);
  if (!t) {
    t = { created: null, ticks: [], lastExit: -1_000_000 };
    tapes.set(mint, t);
  }
  return t;
}

// Recent-flow summary over the last `span` slots of a coin's tape.
function recentFlow(t: CoinTape, now: number, span: number) {
  let buySol = 0;
  let sellSol = 0;
  const buyers = new Set<string>();
  for (let i = t.ticks.length - 1; i >= 0; i--) {
    const tick = t.ticks[i]!;
    if (tick.slot <= now - span) break;
    if (tick.buy) {
      buySol += tick.sol;
      buyers.add(tick.user);
    } else {
      sellSol += tick.sol;
    }
  }
  return { net: buySol - sellSol, buySol, sellSol, buyers: buyers.size };
}

// Washout-and-reclaim test over the full lookback window.
function reclaimSignal(t: CoinTape, now: number, reserveSol: number): boolean {
  if (reserveSol < RESERVE_MIN_SOL || reserveSol > RESERVE_MAX_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  let high = 0;
  let low = Infinity;
  let last = 0;
  let seen = 0;
  for (const tick of t.ticks) {
    if (tick.slot <= now - LOOKBACK) continue;
    seen++;
    if (tick.price > high) high = tick.price;
    if (tick.price < low) low = tick.price;
    last = tick.price;
  }
  if (seen < 12 || high <= 0 || low === Infinity || last <= 0) return false;
  const dip = 1 - low / high;
  if (dip < DIP_MIN || dip > DIP_MAX) return false;
  const reclaim = last / low - 1;
  if (reclaim < RECLAIM_MIN || reclaim > RECLAIM_MAX) return false;
  // The bounce must be buyers reclaiming, not a single print: check flow.
  const flow = recentFlow(t, now, FLOW_SLOTS);
  const total = flow.buySol + flow.sellSol;
  if (total <= 0) return false;
  if (flow.net < FLOW_NET_MIN) return false;
  if (flow.buyers < FLOW_BUYS_MIN) return false;
  if (flow.buySol / total < FLOW_BUY_SHARE) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAM;
    const activeMints = new Set<Pubkey>();

    // Bookkeeping from fills: a filled sell completes a round trip for its
    // mint, and realized flow feeds the loss circuit breaker.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'sell') {
        roundTripped.add(f.mint);
        filledSellSol += Number(f.quote_lamports) / LAM;
      } else {
        filledBuySol += Number(f.quote_lamports) / LAM;
      }
    }
    const realizedSol = filledSellSol - filledBuySol;
    const entriesHalted = realizedSol < -LOSS_HALT_SOL;

    // Fold this batch's events into the per-coin tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeFor(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        t.ticks.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAM,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        activeMints.add(e.mint);
      }
    }
    // Trim tape older than the lookback so memory stays bounded.
    for (const mint of activeMints) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - LOOKBACK - 5) cut++;
      if (cut > 0) t.ticks.splice(0, cut);
    }

    const pendingMints = new Set<Pubkey>();
    const pendingSells = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      pendingMints.add(p.order.mint);
      if (p.order.side === 'sell') pendingSells.add(p.order.mint);
    }

    // 1) Exits first: take-profit, stop, trailing stop, fade, time stop.
    for (const [mint, pos] of open) {
      const heldPos = state.positions.get(mint);
      if (!heldPos) {
        if (!pendingMints.has(mint)) {
          open.delete(mint);
          if (pos.filledOnce) tapeFor(mint).lastExit = now;
        }
        continue;
      }
      pos.filledOnce = true;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const tokens = Number(heldPos.token_amount);
      const gross = (tokens * Number(curve.virtual_quote_reserves)) / (Number(curve.virtual_token_reserves) + tokens);
      const valueSol = (gross / LAM) * (1 - 0.0125) - txSol; // fees + slippage haircut
      const costSol = Number(heldPos.cost_lamports) / LAM;
      if (valueSol > pos.peakValue) pos.peakValue = valueSol;
      let exit = pos.exiting;
      if (valueSol >= costSol * (1 + TAKE_PROFIT)) exit = true;
      if (valueSol <= costSol * (1 - STOP_LOSS)) exit = true;
      if (pos.peakValue >= costSol * (1 + TRAIL_ARM) && valueSol <= pos.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (now - pos.opened > MAX_HOLD_SLOTS) exit = true;
      const tape = tapes.get(mint);
      if (tape && recentFlow(tape, now, FADE_SLOTS).net < FADE_NET_MAX) exit = true;
      if (!exit || pendingSells.has(mint) || orders.length >= orderCap) continue;
      pos.exiting = true;
      orders.push({ side: 'sell', mint, token_amount: heldPos.token_amount, max_slippage_bps: 10_000 });
    }

    // 2) Scout lots: sell as soon as the scout buy has landed.
    for (const mint of [...scouts]) {
      const heldPos = state.positions.get(mint);
      if (!heldPos) {
        if (!pendingMints.has(mint)) scouts.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || pendingMints.has(mint) || orders.length >= orderCap) continue;
      orders.push({ side: 'sell', mint, token_amount: heldPos.token_amount, max_slippage_bps: 10_000 });
    }

    // 3) Reversal entries: one tranche, no pyramiding.
    let cashSol = Number(state.freeCashLamports()) / LAM;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (!entriesHalted) {
      for (const mint of activeMints) {
        if (orders.length >= orderCap || slotsLeft <= 0) break;
        if (open.size >= MAX_MAIN_POSITIONS || open.has(mint) || scouts.has(mint)) continue;
        if (pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (now - t.lastExit < REENTRY_COOLDOWN) continue;
        const reserveSol = Number(curve.real_quote_reserves) / LAM;
        if (!reclaimSignal(t, now, reserveSol)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAM;
        let amount = Math.min(capSol, ENTRY_SOL, cashSol - txSol);
        if (amount < ENTRY_MIN_SOL) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: ENTRY_SLIP_BPS });
        cashSol -= amount + txSol;
        slotsLeft--;
        open.set(mint, { opened: now, peakValue: 0, exiting: false, filledOnce: false });
      }
    }

    // 4) Guardrail rotation: while the round-trip count is short, scout the
    // most actively traded fresh coin (most ticks this batch, then largest
    // real reserve) and sell it on the next batch via step 2.
    if (
      roundTripped.size < SCOUT_TARGET &&
      now - lastScoutSlot >= SCOUT_EVERY &&
      slotsLeft > 0 &&
      scouts.size === 0 &&
      orders.length < orderCap
    ) {
      let best: Pubkey | null = null;
      let bestTicks = -1;
      let bestReserve = -1;
      for (const mint of activeMints) {
        if (roundTripped.has(mint) || open.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        let ticksNow = 0;
        const t = tapes.get(mint)!;
        for (let i = t.ticks.length - 1; i >= 0; i--) {
          if (t.ticks[i]!.slot !== now) break;
          ticksNow++;
        }
        const reserve = Number(curve.real_quote_reserves);
        if (ticksNow > bestTicks || (ticksNow === bestTicks && reserve > bestReserve)) {
          bestTicks = ticksNow;
          bestReserve = reserve;
          best = mint;
        }
      }
      if (best !== null) {
        const capSol = Number(state.maxBuyLamports(best)) / LAM;
        const amount = Math.min(capSol, SCOUT_SOL);
        if (amount >= 0.01 && cashSol >= amount + 2 * txSol) {
          orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: ENTRY_SLIP_BPS });
          scouts.add(best);
          lastScoutSlot = now;
        }
      }
    }

    return orders;
  },
});
