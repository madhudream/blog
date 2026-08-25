---
title: "Azure: Pay-As-You-Go vs Provisioned Throughput (PTU), with a Season of Real Traffic"
slug: "azure-payg-vs-ptu-reserved"
date: "2026-08-24"
tags: ["azure", "ptu", "provisioned-throughput", "pay-as-you-go", "cost", "llm"]
reading_time: "11 min read"
words: 1975
summary: "In this blog, we will learn the two ways Azure sells model capacity — per-token pay-as-you-go and reserved PTUs — how a PTU requirement is actually calculated from calls per minute and token counts, the hourly vs monthly vs yearly price break-evens, and how to size a seasonal workload using percentiles, with every number worked from a real season of daily traffic."
---

# Azure: Pay-As-You-Go vs Provisioned Throughput (PTU), with a Season of Real Traffic

In this blog, we will learn how model capacity is bought on Azure. There are exactly two ways: pay for the tokens you use (**pay-as-you-go**, or PAYG), or pay for capacity you reserve whether you use it or not (**Provisioned Throughput Units**, or PTUs). Every Azure AI cost decision reduces to choosing between them — and the choice is arithmetic, not preference. We will do that arithmetic on a full season of real daily traffic.

We will cover the following:

- Pay-as-you-go: the default meter
- What a PTU actually is
- How many PTUs a workload needs: the real formula
- Worked example: from calls per minute to a PTU count
- What PTUs cost: hourly vs monthly vs yearly
- The utilization break-even
- Sizing a seasonal workload: percentiles again
- The buying strategy: layer the commitments
- Operational notes that saved us
- Conclusion

Let's get started.

## Pay-as-you-go: the default meter

PAYG (Azure calls the deployment type **Standard**; the newer naming is Global Standard / Data Zone Standard / regional Standard, differing in where requests may be processed) bills per token at published per-model rates. For the frontier model in our running example:

```
$/MILLION TOKENS (the model in our example)
input          $1.25
cached input   $0.125
output         $10.00
```

You get a **quota** expressed in tokens-per-minute (TPM) and requests-per-minute (RPM) per model per region — a ceiling, not a reservation. Two properties matter operationally:

- **No floor:** zero traffic costs zero dollars. PAYG is unbeatable for development, spiky low-volume features, and off-season months.
- **No guarantee:** latency varies with shared-pool load, and quota increases are a request process, not a right. A product with a hard deadline spike cannot *assume* the shared pool will absorb it.

Those two gaps — predictable latency and guaranteed throughput — are exactly what PTUs sell.

## What a PTU actually is

A **Provisioned Throughput Unit** is a fixed slice of model-serving capacity, reserved for you alone. You choose a model, a version, and a region, and deploy N PTUs of it; that deployment then serves your traffic with consistent latency up to the throughput those N PTUs provide, regardless of what the shared pool is doing.

The mechanics worth knowing:

- **Purchased in increments.** Deployments have a minimum size and step — for the model family in our example, **minimum 15 PTUs, increments of 5** (minimums vary by model and deployment type; regional deployments have higher minimums than global).
- **Capacity is per model+version+region.** Moving a PTU deployment to a new model version or region is a redeployment decision, not a toggle.
- **Throughput is a ceiling too.** Past the deployment's capacity, requests get throttled (429s). Azure provides a **spillover** pattern: excess traffic overflows automatically to a PAYG deployment, so the reserved layer runs hot and the shared pool takes the burst.
- **Billing is per PTU-hour deployed, not per token used.** An idle PTU deployment costs the same as a saturated one. Every PTU decision is therefore a *utilization* bet — the same bet as owning a GPU (see [the break-even section of the TPS blog](/blog/tps-throughput-and-capacity-planning)).

## How many PTUs a workload needs: the real formula

Azure publishes a capacity calculator, and behind it sits a simple model: each PTU processes a fixed budget of **weighted tokens per minute**, where the weights reflect how expensive each token type is to serve. For the model we deployed, the factors were:

```
uncached input tokens   weight 1
cached input tokens     weight ~0   (prompt-cache hits are nearly free capacity)
output tokens           weight 8    (decode dominates, same as pricing)
capacity per PTU        4,750 weighted tokens/minute
```

So the sizing formula is:

```
weighted TPM = (calls/min x uncached input tokens x 1)
             + (calls/min x output tokens x 8)

PTUs needed  = weighted TPM / 4,750
deployment   = MAX(15, round up to the next 5)
```

(The weights and per-PTU capacity are model-specific — always pull the current numbers from the capacity calculator in the Azure AI Foundry portal. The *structure* of the calculation is what this section is teaching.)

Notice what the formula rewards: **prompt caching increases PTU capacity**, because cached input barely counts against the budget, and **short outputs increase it 8x per token saved**. The optimization advice from the [tokens blog](/blog/tokens-how-ai-usage-is-measured) is also a reserved-capacity sizing lever.

## Worked example: from calls per minute to a PTU count

Take the worked company from [the TPS blog](/blog/tps-throughput-and-capacity-planning): 2,609 input tokens per call with a **92% cache hit rate** (so 8% of input is uncached), 1,307 output tokens, traffic in a 12-hour window.

**A mid-season day** — 610,460 calls/day → 848 calls/min:

```
uncached input:  848 x 2,609 x 0.08  =    177,000 weighted TPM
output:          848 x 1,307 x 8     =  8,866,000 weighted TPM
                                        ---------
total                                   9,043,000 weighted TPM

PTUs = 9,043,000 / 4,750 = 1,904  ->  deploy 1,905
```

**The peak day** — 1,695,320 calls/day → 2,355 calls/min → same arithmetic → **5,290 PTUs**.

**An off-season day** — 13,000 calls/day → 18 calls/min → 41 PTUs → **deploy 45**.

Pause on the output line: output tokens are ~9% of this workload's uncached weighted-token *count* but **98% of its PTU requirement**. If this product capped answers at 650 tokens instead of 1,307, the mid-season deployment would drop from ~1,905 to ~970 PTUs — the cheapest capacity you will ever buy is the output tokens you stop generating.

## What PTUs cost: hourly vs monthly vs yearly

PTUs are billed one of three ways (indicative global-deployment rates as of 2026 — confirm current pricing):

| Commitment | Price per PTU | Per PTU per month |
| --- | --- | --- |
| Hourly (no commitment) | ~$1/hour | ~$730 |
| Monthly reservation | $260/month | $260 |
| Yearly reservation | ~$2,652/year | ~$221 |

The reservation is a **capacity billing discount, not a separate deployment** — you deploy PTUs (billed hourly by default) and a reservation absorbs their hours at the discounted rate.

## The utilization break-even

The hourly-vs-monthly choice is one division:

```
monthly $260  /  hourly-equivalent $730  =  36%
```

**If a PTU will be deployed more than ~36% of the hours in a month, the monthly reservation is cheaper.** A business-hours workload (12h × weekdays ≈ 36% of the month) sits exactly at the line; anything running daily through a season is comfortably past it. The yearly rate ($221 vs $260) adds a second line: commit for a year only if the capacity survives **all twelve months** — at 15% cheaper than monthly, a yearly reservation loses money if the capacity is needed fewer than ~10 months.

## Sizing a seasonal workload: percentiles again

Here is the full season of daily PTU requirements from our traffic dataset, summarized per month, with the monthly-reservation cost at $260/PTU next to it:

| Month | Avg PTUs | P60 | P90 | Max | Cost if reserved at avg | at P90 | at max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jan | 630 | 580 | 1,530 | 2,265 | $164K | $398K | $589K |
| Feb | 1,794 | 1,952 | 2,133 | 2,395 | $466K | $554K | $623K |
| Mar | 1,755 | 1,960 | 2,115 | 2,230 | $456K | $550K | $580K |
| Apr | 2,477 | 2,450 | 3,998 | **5,290** | $644K | $1.04M | $1.38M |
| May | 70 | 85 | 105 | 115 | $18K | $27K | $30K |
| Jun | 53 | 60 | 70 | 110 | $14K | $18K | $29K |
| Jul | 38 | 45 | 50 | 60 | $10K | $13K | $16K |
| Aug | 36 | 40 | 45 | 45 | $9K | $12K | $12K |

Two readings of this table pay for the whole blog:

- **April's max is 2.1x April's average.** Reserving the maximum for the month costs $1.38M; reserving the average costs $644K. The difference — $730K for one month — is the price of sizing to the worst day instead of bursting past it.
- **The season is 40:1.** February needs ~1,800 PTUs; August needs ~40. Any commitment that spans both is mostly waste. This is what monthly (not yearly) reservations are *for*.

## The buying strategy: layer the commitments

The general pattern — **reserve the base, burst the peak, float the tail**:

```
LAYERED PURCHASE (for the season above)

yearly reservation      ~40-50 PTUs      the floor that survives all 12 months
monthly reservations    Jan-Apr, sized  ~P60 of each month (580 / 1,950 / 1,960 / 2,450)
hourly PTUs             peak days only:  scale-out for the Apr max (up to ~5,290)
PAYG spillover          always armed:    absorbs whatever the layers miss
```

Estimated season spend under this layering: the four season months at P60 monthly rates ≈ $1.8M, the off-season floor ≈ $120K/year, plus a few peak days of hourly top-up — versus **$16.5M** if the peak-day 5,290 PTUs were reserved year-round. Layering is not a refinement; it is a 5–8x difference.

And keep the alternative honest: the same season on plain PAYG at $0.0136/answer costs ~$0.8–2.5M depending on view rates (see [the tokens blog](/blog/tokens-how-ai-usage-is-measured)) with zero commitment. PTUs win on latency consistency and guaranteed peak capacity; PAYG wins on flexibility. The layered plan is the middle path most seasonal products land on.

## Operational notes that saved us

- **Put a gateway in front of both layers.** One Azure API Management instance fronted our PAYG and reserved/self-hosted deployments behind a single URL; a policy mapped a model *alias* to whichever deployment was primary, enforced shared token quotas from the real `usage` objects, and — proven live — failed over a dead backend to the paid model in 2.4 seconds with zero application code.
- **The model name belongs in configuration, not code.** With an alias at the gateway, moving traffic between PAYG, PTU, and self-hosted is a configuration change with no deploy.
- **Watch parameter dialects.** Newer models reject the legacy `max_tokens` in favor of `max_completion_tokens`; the gateway is the one place to translate stragglers.
- **Both meters run regardless of traffic.** PTU deployments and gateways bill from creation to deletion. Tear down test deployments the hour the test ends.

## Conclusion

- **Two products:** PAYG has no floor and no guarantee; PTUs have a floor and a guarantee. Everything else is arithmetic.
- **The PTU formula:** weighted TPM = uncached input ×1 + output ×8, divided by per-PTU capacity (4,750 weighted TPM for our model), rounded up to increments of 5 with a 15-PTU minimum. Output tokens drive ~98% of the requirement — capping answers is a capacity purchase.
- **Break-evens:** monthly beats hourly above ~36% utilization; yearly beats monthly only if the capacity survives ~10+ months.
- **Seasonal sizing:** worked season ranged 40 → 5,290 PTUs (40:1). Reserve the base at P60, burst peaks hourly, arm PAYG spillover — a 5–8x saving over flat reservation.
- **One gateway over all layers** makes model, layer, and failover a configuration concern instead of an application rewrite.

Next in the series: [the same two purchasing shapes on GCP](/blog/gcp-payg-vs-reserved).

That's it for now.
