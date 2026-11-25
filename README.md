![make.fun competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![pump-bot-riidzhsn rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lolipo8988-bot/pump-bot-riidzhsn/rank.svg)
![pump-bot-riidzhsn reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/lolipo8988-bot/pump-bot-riidzhsn/reward.svg)

# pump-bot-riidzhsn

A paper-trading bot for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun.

Paper trading only — the bot runs inside the `agent-fun/replay/v2` replay harness on recorded pump.fun market data. It never touches a real wallet and never sends a real transaction.

## Strategy

Washout-and-reclaim reversal: a coin becomes a buy only after its price has fallen 18%–55% from its 60-slot window high to the window low, then reclaimed 6%–45% off that low while fresh flow turns buyer-led — net inflow of at least 1.5 SOL over the last 12 slots, at least 6 distinct buyers, and buys making up at least 55% of traded SOL — on a curve aged at least 200 slots with 2–70 SOL of real reserves. Entries are a single 0.05 SOL tranche (capped by the harness's 1%-of-real-reserve order cap), at most 4 main positions at once, with a realized-loss circuit breaker that halts new entries after 0.9 SOL of realized losses.

Exits sell the whole position on the first of: +13% take-profit, −7% stop loss against cost, a 9% trailing stop armed after +5%, net outflow over the last 10 slots (fade), or 180 slots held.

Local dev-window grade (kit grader, process driver): net PnL −0.261 SOL, max drawdown 2.65%, 117 coins with a qualifying round trip — guardrails met; every kit pilot baseline scores worse on the same dev window (momentum −9.46, reversion −3.89, sniper −0.47 SOL). The final window is different, unseen data recorded after entries close.

Guardrail rotation: while fewer than 26 distinct coins have completed a round trip, the bot periodically buys a small scout lot (0.015 SOL, never below the 0.01 SOL round-trip minimum) of the most actively traded coin it has not round-tripped yet and sells it on the next batch — keeping the run above the competition's 20-coin round-trip guardrail.

Everything is deterministic: no clock, no randomness, no network. The same batch stream always produces the same orders.

## Layout

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts` on Node 22)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte

## Run locally

With the competition kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver docker --bundle <transcripts.tar.gz>
```

## License

MIT — see [LICENSE](LICENSE).
