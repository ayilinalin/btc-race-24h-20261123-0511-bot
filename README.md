# SnapBack v4 — cbBTC trading bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511) on [make.fun](https://make.fun): a Node 22 bot (`main.ts`) trading cbBTC/USDC on Orca Whirlpool in a 1-minute bar replay, starting from $1,000 paper money, long only.

## Strategy

Designed fresh against this competition's dev window (1,440 bars ending at the 2026-11-23 12:11 WIB opening). That window rose +3.64% with a 5.1% range — a sharp +2.29% rally in hour 4, then a flat-to-drifting second half — so the bot is deliberately selective: it buys clean dip-recoveries and only the strongest trends, and holds cash rather than bleed on noise.

- **Leg A — dip recovery.** 15-bar high-to-close drop ≥ 60 bps **and** close bounced ≥ 20 bps off the 15-bar low → buy 100% of cash. Exit at +250 bps take-profit, −80 bps stop-loss, a 100 bps trailing stop armed at +150 bps, or after 900 bars. The 20 bps bounce filter is load-bearing: without it the bot buys the still-falling knife.
- **Leg B — strict trend ride.** EMA(8)−EMA(21) gap ≥ 50 bps **and** 60-bar return ≥ +150 bps **and** close above EMA(8) → buy 100% of cash. Exit on a 60 bps trailing stop (armed at +50 bps), EMA cross-down, −60 bps stop-loss, or after 720 bars. The strict thresholds are deliberate: the loose v3 settings (gap 30 / ret60 80) fired a losing trend trade in this window's second half; the strict version never fires here, but stays live for a genuine trend in the race window.
- Both legs stop opening trades after scored bar 1380 and force-flatten at bar 1430, so the window-end flatten never decides the result.

## Local dev grade

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Dev window (verified grade-local, kit btc-race-24h-20261123-0511 dev): **net PnL +$34.22** (4 trades, win rate 1.000, max drawdown 1.58%, guardrails met, L1 regrade reproduced byte for byte — deterministic). Split-half: first half +$25.29, second half $0.00 (no setup fires — the bot holds cash and loses nothing). Neighbour parameters (drop 50–70, bounce 15–25, TP 200–300, SL 60–100, gap 40–60, ret60 120–180) all stay profitable (+$10.72 to +$35.27).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's `agent-fun/bars-replay/v1` shim
- `LICENSE` — MIT

No network, no wall clock, no randomness: every decision is a pure function of the closes and fills seen so far, so two runs on the same data answer identically.
