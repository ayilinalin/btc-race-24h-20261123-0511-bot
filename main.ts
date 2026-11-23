// SPDX-License-Identifier: MIT
// SnapBack v4 — cbBTC dip-recovery + strict trend-ride bot (fresh rewrite).
//
// Speaks agent-fun/bars-replay/v1: one 1-minute CBBTC bar per batch, one reply
// per batch, orders fill at the next bar's open. Long only, $1,000 paper money,
// buys spend all cash, sells unload the whole position. Every decision is a
// pure function of the closes and fills seen so far — no clock, no network, no
// randomness — so two runs on the same data answer identically.
//
// Why this shape: the dev window rises +3.64% then drifts sideways, so the bot
// only buys two clean setups and otherwise sits in cash instead of bleeding on
// noise. A dip buy needs the pullback to already be bouncing (buying a still
// falling knife loses); a trend buy needs a wide EMA gap plus a strong 60-bar
// run (loose trend settings fired a losing trade in this window's second half).
// Both legs stop opening late in the window and everything is flattened at
// bar 1430, so the window-end flatten never decides the result.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const TICKER = 'CBBTC';
/** Basis points per unit: 10_000 bps = 100%. */
const BPS = 10_000n;
/** Smallest buy the harness accepts: 1 USDC = 1,000,000 quote units. */
const MIN_BUY_QUOTE = 1_000_000n;

/** Every number the strategy depends on, in one place. */
const TUNE = {
  firstEntryBar: 30, // no entries before scored bar 30
  lastEntryBar: 1380, // no entries after scored bar 1380
  flattenBar: 1430, // sell everything at scored bar 1430
  slipBps: 300, // max slippage vs latest close, buys and sells
  // Dip leg: buy the bounce after a sharp 15-bar pullback.
  dipWindow: 15,
  dipDropBps: 60,
  dipBounceBps: 20,
  dipTakeBps: 250,
  dipStopBps: 80,
  dipTrailArmBps: 150, // trailing stop arms once the peak is +150 bps
  dipTrailBps: 100,
  dipMaxHold: 900,
  // Trend leg: ride only the strongest uptrends.
  fastLen: 8,
  slowLen: 21,
  trendGapBps: 50, // EMA(8) - EMA(21) gap
  trendRunBps: 150, // 60-bar return
  trendRunBars: 60,
  trendTrailArmBps: 50,
  trendTrailBps: 60,
  trendStopBps: 60,
  trendMaxHold: 720,
} as const;

/** True when `to` sits at least `bps` basis points below `from`. Integer math, no floats. */
function downAtLeast(from: bigint, to: bigint, bps: number): boolean {
  return (from - to) * BPS >= BigInt(bps) * from;
}

/** True when `to` sits at least `bps` basis points above `from`. */
function upAtLeast(from: bigint, to: bigint, bps: number): boolean {
  return (to - from) * BPS >= BigInt(bps) * from;
}

/** Highest and lowest close of the last `n` closes, current bar included. */
function windowRange(closes: bigint[], n: number): { hi: bigint; lo: bigint } {
  let hi = closes[closes.length - 1]!;
  let lo = hi;
  const start = Math.max(0, closes.length - n);
  for (let i = closes.length - 2; i >= start; i--) {
    const c = closes[i]!;
    if (c > hi) hi = c;
    if (c < lo) lo = c;
  }
  return { hi, lo };
}

/** One EMA step: alpha 2 / (len + 1), seeded by the caller on the first close. */
function emaNext(prev: number, close: number, len: number): number {
  const alpha = 2 / (len + 1);
  return alpha * close + (1 - alpha) * prev;
}

/** A live position: which leg opened it, at what fill price, and its best close since. */
interface OpenTrade {
  kind: 'dip' | 'trend';
  entryPx: bigint;
  entryBar: number;
  peakPx: bigint;
}

/**
 * The whole bot in one object: closes and EMAs as history, the open trade (if
 * any), and the one order still in flight. `step` runs once per batch and
 * returns that batch's orders, in this order: settle fills, update indicators,
 * exits first, entries only while flat.
 */
class SnapBack {
  private closes: bigint[] = [];
  private emaFast: number | null = null;
  private emaSlow: number | null = null;
  private trade: OpenTrade | null = null;
  private pendingKind: 'dip' | 'trend' | null = null;
  private pendingSell = false;

  step(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === TICKER);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    this.closes.push(close);
    // Scored-bar index: seq counts every batch, warm-up batches included.
    const idx = state.seq - state.warmupBars;

    this.settleFills(batch, idx);
    this.updateTrend(close);
    if (state.warmingUp) return [];

    const held = state.positions.get(TICKER);
    const qty = held === undefined ? 0n : BigInt(held.qty);
    if (this.trade !== null && qty > 0n) {
      if (close > this.trade.peakPx) this.trade.peakPx = close;
      if (this.exitNow(this.trade, close, idx)) {
        this.pendingSell = true;
        return [this.sellOrder(qty, idx)];
      }
      return [];
    }
    if (qty > 0n) {
      // Holding with no recorded entry (should not happen): only the
      // window-end flatten can still get us out.
      if (idx >= TUNE.flattenBar) {
        this.pendingSell = true;
        return [this.sellOrder(qty, idx)];
      }
      return [];
    }
    // Flat: never chase a fill already in flight, never double-order.
    if (this.pendingKind !== null || this.pendingSell) return [];
    return this.tryEnter(state, close, idx);
  }

  /** Fold this batch's fills into the open trade (or clear it on a sell). */
  private settleFills(batch: Batch, idx: number): void {
    for (const fill of batch.fills) {
      if (fill.symbol !== TICKER) continue;
      if (fill.side === 'buy') {
        if (fill.status === 'filled') {
          const px = BigInt(fill.price);
          this.trade = { kind: this.pendingKind ?? 'dip', entryPx: px, entryBar: idx, peakPx: px };
        }
        this.pendingKind = null;
      } else if (fill.side === 'sell') {
        if (fill.status === 'filled') this.trade = null;
        this.pendingSell = false;
      }
    }
  }

  /** Roll both EMAs forward one close; seeded with the first close seen. */
  private updateTrend(close: bigint): void {
    const px = Number(close);
    this.emaFast = this.emaFast === null ? px : emaNext(this.emaFast, px, TUNE.fastLen);
    this.emaSlow = this.emaSlow === null ? px : emaNext(this.emaSlow, px, TUNE.slowLen);
  }

  /** Should the open trade close on this bar? Flatten and max-hold first, then the leg's own exits. */
  private exitNow(trade: OpenTrade, close: bigint, idx: number): boolean {
    if (idx >= TUNE.flattenBar) return true;
    const maxHold = trade.kind === 'dip' ? TUNE.dipMaxHold : TUNE.trendMaxHold;
    if (idx - trade.entryBar >= maxHold) return true;
    if (trade.kind === 'dip') {
      if (upAtLeast(trade.entryPx, close, TUNE.dipTakeBps)) return true;
      if (downAtLeast(trade.entryPx, close, TUNE.dipStopBps)) return true;
      const armed = upAtLeast(trade.entryPx, trade.peakPx, TUNE.dipTrailArmBps);
      if (armed && downAtLeast(trade.peakPx, close, TUNE.dipTrailBps)) return true;
      return false;
    }
    const armed = upAtLeast(trade.entryPx, trade.peakPx, TUNE.trendTrailArmBps);
    if (armed && downAtLeast(trade.peakPx, close, TUNE.trendTrailBps)) return true;
    if (this.emaFast !== null && this.emaSlow !== null && this.emaFast < this.emaSlow) return true;
    if (downAtLeast(trade.entryPx, close, TUNE.trendStopBps)) return true;
    return false;
  }

  /** Flat and inside the entry window: test the dip setup, then the trend setup. */
  private tryEnter(state: BarsState, close: bigint, idx: number): OrderInput[] {
    if (idx < TUNE.firstEntryBar || idx > TUNE.lastEntryBar) return [];
    if (state.cash < MIN_BUY_QUOTE) return [];
    const n = this.closes.length;
    if (n >= TUNE.dipWindow) {
      const { hi, lo } = windowRange(this.closes, TUNE.dipWindow);
      const pulledBack = downAtLeast(hi, close, TUNE.dipDropBps);
      const bouncing = upAtLeast(lo, close, TUNE.dipBounceBps);
      if (pulledBack && bouncing) return [this.buyOrder(state, 'dip', idx)];
    }
    if (n > TUNE.trendRunBars && this.emaFast !== null && this.emaSlow !== null) {
      const px = Number(close);
      const gapBps = ((this.emaFast - this.emaSlow) / this.emaSlow) * 10_000;
      const base = Number(this.closes[n - 1 - TUNE.trendRunBars]);
      const runBps = ((px - base) / base) * 10_000;
      const strongTrend = gapBps >= TUNE.trendGapBps && runBps >= TUNE.trendRunBps && px > this.emaFast;
      if (strongTrend) return [this.buyOrder(state, 'trend', idx)];
    }
    return [];
  }

  /** Buy 100% of cash; the leg kind rides along so the fill knows its exits. */
  private buyOrder(state: BarsState, kind: 'dip' | 'trend', idx: number): OrderInput {
    this.pendingKind = kind;
    return {
      side: 'buy',
      symbol: TICKER,
      notional_quote_units: state.cash,
      max_slippage_bps: TUNE.slipBps,
      client_id: `buy-${idx}`,
    };
  }

  /** Sell the whole position. */
  private sellOrder(qty: bigint, idx: number): OrderInput {
    return {
      side: 'sell',
      symbol: TICKER,
      qty,
      max_slippage_bps: TUNE.slipBps,
      client_id: `sell-${idx}`,
    };
  }
}

const trader = new SnapBack();
await runBars({
  onBatch(state, batch) {
    return trader.step(state, batch);
  },
});
