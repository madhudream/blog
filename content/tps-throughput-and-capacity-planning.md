---
title: "TPS and Capacity Planning: From User Traffic to a GPU Count"
slug: "tps-throughput-and-capacity-planning"
date: "2026-08-24"
tags: ["tps", "throughput", "capacity-planning", "scaling", "llm", "infrastructure"]
reading_time: "10 min read"
words: 1805
summary: "In this blog, we will learn how to calculate TPS from real business traffic: a worked example takes a company from daily active users to calls per minute, tokens per second, concurrent requests, and finally a GPU count — plus percentile-based sizing, the API-vs-self-host break-even, and an autoscaling calendar for seasonal load."
---

# TPS and Capacity Planning: From User Traffic to a GPU Count

In this blog, we will learn the calculation every AI capacity plan is built on: turning "we have this many users" into "we need this many GPUs" (or this much reserved API capacity). The chain has five links — users → calls → calls per second → tokens per second → hardware — and each link is one multiplication. We will walk a realistic company through the whole chain with real measured numbers.

We will cover the following:

- The vocabulary: RPS, RPM, TPS, TPM, TTFT, concurrency
- How TPS is calculated, step by step
- Worked example: a company with seasonal traffic
- From TPS to concurrency: Little's Law
- From concurrency to a GPU count
- Sizing to percentiles, not peaks
- The break-even: API vs self-hosted
- The autoscaling calendar
- Conclusion

Let's get started.

## The vocabulary: RPS, RPM, TPS, TPM, TTFT, concurrency

Six terms cover every capacity conversation:

| Term | Meaning | Typical use |
| --- | --- | --- |
| **RPS / RPM** | Requests per second / per minute | Traffic arriving at your service |
| **TPS** | **Tokens per second** | Throughput of a model, a GPU, or a quota |
| **TPM** | Tokens per minute | How API rate limits and reserved capacity are quoted |
| **TTFT** | Time to first token | What the user feels as "it started responding" |
| **Concurrency** | Requests in flight at once | What sizes your GPU memory (KV cache) |
| **Utilization** | Busy time ÷ available time | What decides whether reserved capacity pays off |

One warning on **TPS**: in classic ops usage it means *transactions* per second, and in AI it almost always means *tokens* per second. In a mixed meeting, say which one. In this blog, TPS = tokens per second, and we use RPS for request arrival.

## How TPS is calculated, step by step

TPS is not measured first — it is *derived* from three business numbers, then verified by measurement:

```
1. calls per day        =  active users x calls per user per day
2. calls per second     =  calls per day / busy-window seconds
3. tokens per second    =  calls per second x tokens per call
```

The subtleties are in steps 2 and 3:

- **Use the busy window, not 24 hours.** Consumer and B2B traffic concentrates in business hours. Dividing a day's calls by 86,400 seconds understates the rate your system must actually survive by 2–4x. A 12-hour effective window is a common, defensible default for a business-hours product.
- **Input and output TPS are different numbers with different costs.** Input tokens are ingested in bulk (cheap, fast prefill); output tokens are generated one at a time (expensive, slow decode). Quote them separately: "102K TPS in, 51K TPS out" is a plan; "153K TPS" hides the hard part.

## Worked example: a company with seasonal traffic

Now the whole chain on realistic numbers. Say a company runs a document-preparation product with a hard seasonal deadline (tax-style seasonality). It has added an AI preview panel, and telemetry says:

- Each active client's document generates **~5 AI preview calls per day** it is worked on.
- Traffic lands in a **12-hour business window**.
- Each call measures **2,609 input tokens and ~1,307 output tokens** (from the `usage` object — see [the tokens blog](/blog/tokens-how-ai-usage-is-measured)).

Daily active clients across the season, from a real traffic dataset:

```
DAILY AI CALLS ACROSS A SEASON (clients x 5)
early Jan    ~ 23,000/day   #
late Feb    ~670,000/day    ##################
mid Mar     ~610,000/day    ################
PEAK (mid Apr) 1,695,000/day  ############################################
May          ~30,000/day    #
Aug          ~13,000/day    (off-season floor)
```

Run the peak day through the chain:

```
calls/day      1,695,000
calls/min      1,695,000 / (12 x 60)  =  ~2,355 calls/min
calls/sec      2,355 / 60             =  ~39 RPS

input TPS      39.2 x 2,609  =  ~102,000 tokens/sec in
output TPS     39.2 x 1,307  =   ~51,000 tokens/sec out
```

That is the whole calculation. **This company's peak AI load is ~39 RPS, ~102K TPS of input, ~51K TPS of output** — three numbers that now drive everything: GPU count, reserved-capacity purchase, and rate-limit requests. Note the range: the same product needs ~180x less capacity in August than in mid-April. Hold that thought for the autoscaling section.

## From TPS to concurrency: Little's Law

GPUs do not care about per-day totals; they care how many requests are **in flight at once**, because every concurrent request holds KV-cache memory. The conversion is a one-line queueing identity, Little's Law:

**concurrency = arrival rate × time each request stays in the system**

Our answers take ~9–15 seconds to generate in full. At the peak:

```
concurrency = 39.2 RPS x 12 s (typical)  =  ~470 requests in flight
```

So at peak the fleet must hold roughly **500 concurrent generations** worth of KV cache. This is why the [GPU blog](/blog/gpu-guide-a100-h100) keeps insisting on memory headroom above the weights: concurrency is bought with spare GPU memory. It is also why shortening answers is a *capacity* lever, not just a cost lever — halving generation time halves concurrency at the same RPS.

## From concurrency to a GPU count

The last link needs one measured number: **answers per hour per GPU** for your model, your prompt shape, and your serving engine. Do not take it from a leaderboard — measure it with a load test at realistic concurrency. Our measurement: a 30B open-weight model on one A100 80GB under vLLM, at concurrency 16, sustained **2,880 answers/hour** (0.8 answers/sec) without saturating.

```
GPUs needed at peak = peak RPS / per-GPU answer rate
                    = 39.2 / 0.8
                    = ~49  ->  provision ~60 with headroom
```

Sanity-check the same answer through tokens: 2,880 answers/hr × 1,307 output tokens ≈ 3.8M output tokens/hr ≈ **~1,050 output TPS per A100** (batched). Peak demand of 51,000 output TPS ÷ 1,050 ≈ 49 GPUs — the same answer through an independent path, which is exactly what a capacity plan should show before anyone signs off. And since 2,880/hr was measured **unsaturated at concurrency 16**, the real fleet likely needs somewhat fewer — the next load test (pushing batch depth until latency degrades) tells you how much headroom the measurement left on the table.

Headroom rules worth keeping: provision for **peak hour, not average hour** (peak-hour traffic runs ~1.5–2x the daily average rate); add ~20% for retries, redeploys, and one-node failures; and keep a fallback route to a paid API for overflow (more on that pattern in [the Azure blog](/blog/azure-payg-vs-ptu-reserved)).

## Sizing to percentiles, not peaks

Sizing every day to the single worst day wastes most of the money. The standard discipline: compute the required capacity for every day of the season, then look at **percentiles**. From the same dataset (capacity expressed in reserved-throughput units of the kind covered in the [Azure PTU blog](/blog/azure-payg-vs-ptu-reserved)):

| Month | Average need | P90 need | Single worst day |
| --- | --- | --- | --- |
| February | 1,794 | 2,133 | 2,395 |
| March | 1,755 | 2,115 | 2,230 |
| April | 2,477 | 3,998 | **5,290** |
| August | 36 | 45 | 45 |

Read the April row: the worst day needs **2.1x** the average day. Reserve for the average or P60, and cover the P90-to-max gap with on-demand capacity that can burst — reserving for the maximum means paying for 5,290 units for a month that averages 2,477. The pattern generalizes: **reserve the base, burst the peak.**

## The break-even: API vs self-hosted

A paid API bills per call; a GPU bills per hour whether busy or idle. So there is always a crossover rate:

**break-even answers/hour = GPU $/hr ÷ API $/answer**

With our measured numbers — A100 at $3.67/hr, API answer at $0.0136:

```
break-even = 3.67 / 0.0136 = ~270 answers/hour per GPU
```

One measured A100 delivers 2,880/hour — **~11x past break-even**. That is the shape of a good self-hosting case: not "slightly cheaper," but an order of magnitude, with the gap growing as traffic grows. The instinct to keep: **self-hosting is a bet that you can keep the GPU busy.** Below ~270 answers/hour, the API is simply cheaper — and for this company, that describes the entire off-season.

## The autoscaling calendar

Put the seasonal chart, the percentile table, and the break-even together and the operating plan writes itself:

```
SEASON CALENDAR (GPU fleet for the worked example)
Jan          ramp:    scale 5 -> 30 GPUs through the month
Feb - Mar    steady:  ~45 GPUs, 12 h/day business window
early Apr    peak:    ~60 GPUs, 24 h/day, API overflow armed
mid Apr      cliff:   scale to ~5 within days of the deadline
May - Dec    floor:   0-2 GPUs or API-only (below break-even)
```

Three rules encoded in that calendar:

1. **Scale on a schedule first, on metrics second.** Seasonal businesses know the deadline; calendar-driven scaling is more reliable than reactive autoscaling for the big moves, with metric-driven scaling handling the daily curve.
2. **Scale to zero is a feature.** From May to December this workload runs below the ~270/hour break-even, so the correct GPU count is zero — route the trickle to the paid API.
3. **The idle GPU is the whole risk.** Every cost advantage computed above assumes the fleet tracks the traffic. A 60-GPU fleet left running through May erases the season's savings in weeks.

## Conclusion

- **The chain is five multiplications:** users → calls/day → RPS (divide by the busy window, not 24 h) → TPS (input and output separately) → hardware.
- **Worked peak:** 1.7M calls/day → ~39 RPS → ~102K TPS in / ~51K TPS out → ~470 concurrent → ~49–60 A100s.
- **Little's Law (concurrency = RPS × duration)** converts traffic to GPU memory pressure; shorter answers are a capacity lever.
- **Size to P60/P90 and burst the rest** — the worst April day needed 2.1x the April average.
- **Break-even = GPU $/hr ÷ API $/answer** (~270 answers/hour here). Busy GPUs beat the API ~10x; idle GPUs lose to it — scale to zero without shame.

Next in the series: [the serving stack that sets the per-GPU answer rate — an open model on vLLM](/blog/inference-stack-qwen-vllm), before the purchasing blogs ([Azure](/blog/azure-payg-vs-ptu-reserved), [GCP](/blog/gcp-payg-vs-reserved)) put prices on it.

That's it for now.
