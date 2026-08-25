---
title: "Spot GPUs: The 60–90% Discount, and What It Costs to Earn It"
slug: "spot-gpus-savings"
date: "2026-08-24"
tags: ["spot", "preemptible", "gpu", "cost", "autoscaling", "infrastructure"]
reading_time: "9 min read"
words: 1725
summary: "In this blog, we will learn how Spot GPUs work — why clouds sell the same A100 for a quarter of the price, what preemption actually does to a serving fleet, which workloads tolerate it and which don't — and work the numbers on a real season of traffic where Spot pricing turns a $229K GPU bill into $63K and cuts the self-hosting break-even by 3.6x."
---

# Spot GPUs: The 60–90% Discount, and What It Costs to Earn It

In this blog, we will learn the single largest discount in cloud computing and the engineering contract attached to it. Every cloud sells its idle GPU capacity at **60–90% off** under the names Spot (GCP, Azure, AWS) or preemptible/interruptible (older naming and the rental marketplaces) — with the condition that the machine can be taken back on minutes' or seconds' notice. For AI serving, this is not a niche trick: inference is one of the best-shaped Spot workloads that exists, and on our worked season it is the difference between $229K and $63K for the same tokens.

We will cover the following:

- Why the same GPU has two prices
- The numbers: what Spot actually costs
- How Spot moves the break-even
- Preemption: what actually happens
- Which workloads tolerate Spot — a shape test
- The mixed-fleet architecture
- The fine print that bites: quota, pools, and peak season
- Worked example: the season, re-priced
- Conclusion

Let's get started.

## Why the same GPU has two prices

A cloud region's GPU fleet is sized for peak demand, so off-peak a large fraction sits idle — fully paid for, earning nothing. Spot is the clouds' answer: sell the idle capacity at a deep discount, keep the right to **take it back the moment an on-demand customer pays full price for it**. You are not renting a worse GPU — it is the identical A100 or H100 — you are renting a worse *guarantee*.

That reframing is the whole mental model: **on-demand buys capacity; Spot buys capacity minus certainty.** Everything else in this blog is engineering around the missing certainty.

## The numbers: what Spot actually costs

Indicative discounts as of mid-2026 (rates float with regional supply and demand — Spot prices are dynamic by design):

| Capacity type | A100 80GB $/hr | vs on-demand |
| --- | --- | --- |
| On-demand | ~$3.67 | — |
| Spot | ~$1.00–1.20 | ~65–72% off |
| (typical Spot range across GPU types) | — | 60–90% off |

Flow that through the serving economics from [the TPS blog](/blog/tps-throughput-and-capacity-planning) — the per-GPU throughput doesn't change, only the rent:

```
one A100, 2,880 answers/hour
on-demand:  $3.67/hr / 2,880  =  $0.00127 per answer
Spot:      ~$1.00/hr / 2,880  =  $0.00035 per answer     (3.6x cheaper)
```

One honesty note from our own experiment: our *measured* runs all billed at on-demand rates — the Spot quota request was still in the approval queue when the experiment ended (a foreshadowing of the fine-print section). The Spot figures here apply published Spot pricing to measured throughput; the throughput itself is real.

## How Spot moves the break-even

Recall the crossover against a paid API: **break-even answers/hour = GPU $/hr ÷ API $/answer.**

```
on-demand:  $3.67 / $0.0136  =  ~270 answers/hour
Spot:       $1.00 / $0.0136  =   ~74 answers/hour
```

This is the strategically interesting effect. At on-demand rates, self-hosting only makes sense for genuinely busy workloads; at Spot rates, the bar drops to ~74 answers/hour — **about one answer every 49 seconds**. Whole categories of medium-traffic features that correctly stayed on the API at on-demand prices flip to self-host-viable on Spot. For the seasonal workload in this series, Spot also *extends the season*: shoulder months (May, early January) that sat below the on-demand break-even clear the Spot break-even comfortably.

## Preemption: what actually happens

When the cloud reclaims a Spot machine, you get a notice — **~30 seconds on GCP, up to 2 minutes on AWS, ~30 seconds on Azure** — delivered via instance metadata, then the VM stops. For a serving node, the well-behaved sequence is:

```
notice arrives
  -> node marks itself NotReady (fails the LB health check)
  -> stops accepting new requests
  -> streams out what it can; in-flight requests that don't finish are dropped
client/gateway retries the dropped requests -> they land on surviving nodes
autoscaler notices the missing node -> requests a replacement
```

Two design consequences:

- **Retries must be idempotent and automatic.** An inference request is a pure function of its input — the perfect retry candidate — but only if the client or gateway actually retries. The gateway-level retry/fallback policy from [the Azure blog](/blog/azure-payg-vs-ptu-reserved) (which we proved live rescuing a dead backend in 2.4 s) is exactly the machinery that makes preemption invisible to users.
- **Cold start is your real exposure.** A replacement GPU node must boot, pull a ~30–60 GB model, and warm up — typically 5–20 minutes for a vLLM node. During that window the fleet runs one node short. Fleet size and headroom, not luck, absorb this: losing 1 node of 3 is a 33% capacity cut; 1 of 20 is 5%.

## Which workloads tolerate Spot — a shape test

A workload belongs on Spot when **the unit of lost work is small and repeatable**:

| Workload | Spot fit | Why |
| --- | --- | --- |
| Stateless inference behind an LB | Excellent | lost unit = one request; retry costs seconds |
| Batch jobs: evals, judging, embeddings, nightly summaries | Excellent | lost unit = one shard; re-queue it |
| Training / fine-tuning **with checkpoints** | Good | lost unit = minutes since last checkpoint |
| Long-running stateful single node (a demo pod, a notebook) | Poor | lost unit = everything |
| Hard-SLA serving with **no** on-demand floor or API fallback | Poor | correlated preemptions can zero the fleet |

Most of this blog series' running workload is in the first two rows — which is typical: the majority of AI infrastructure spend at most companies is Spot-shaped, and is nevertheless bought at on-demand prices by default.

## The mixed-fleet architecture

The production pattern is not "all Spot" — it is a **floor of certainty with an elastic Spot majority**:

```
MIXED FLEET (peak-season snapshot, worked example)

on-demand floor      ~25%  ########           always-on; sized to worst-case minimum
Spot majority        ~75%  ####################____  autoscaled; absorbs the daily curve
API fallback          n/a  (gateway route)     absorbs anything the fleet drops
```

The operating rules that make it work:

1. **Diversify the Spot ask.** Spread across zones and, where possible, instance shapes — preemptions correlate within a pool, and diversity is the hedge.
2. **Overprovision Spot slightly** (10–20%): Spot capacity is cheap enough that idle headroom on Spot still undercuts exact-sizing on demand.
3. **Autoscale on queue depth, replace preemptions automatically,** and treat a rising preemption rate as a scaling signal (the pool is drying up — start bidding into on-demand).
4. **Keep the API fallback armed at the gateway.** With retry-and-fallback in place, the worst case of a bad Spot day is a temporary cost increase, not an outage — the same graceful-degradation shape as the dead-backend failover in [the Azure blog](/blog/azure-payg-vs-ptu-reserved).

## The fine print that bites: quota, pools, and peak season

Three lessons that do not appear on the pricing page:

- **Spot quota is its own quota.** It is requested separately from on-demand quota and approved on its own timeline — ours was still pending when the experiment closed. File it in week one, before the architecture depends on it.
- **Spot supply is thinnest exactly when you want it most.** Idle capacity exists because others aren't using it; in a demand spike (a model release, year-end, *your own industry's shared peak season*), pools shrink and preemption rates climb. For the worked example — a deadline business where every competitor peaks the same two weeks in April — the plan deliberately shifts the peak-fortnight floor toward on-demand and reserves Spot aggression for the long mid-season plateau.
- **Newest GPUs have the worst Spot pools.** H100-class Spot is scarce and volatile; A100 and older cards have the deep, stable pools. This stacks with the quota argument from [the GPU handbook](/blog/gpu-guide-a100-h100): the previous-generation card is easier to get, in both markets.

## Worked example: the season, re-priced

The full season from [the TPS blog](/blog/tps-throughput-and-capacity-planning) — up to 180M AI calls, fleet scaled through the calendar — priced three ways with measured throughput:

```
SEASON COST (180M answers)
paid API                 ##########################  ~$2,460,000
self-host, on-demand     ##                          ~$229,000
self-host, mixed Spot    #                            ~$63,000-105,000
```

The pure-Spot arithmetic gives ~$63K; the honest budget for the mixed fleet (on-demand floor, peak-fortnight shift, replacement churn) lands somewhere under ~$105K. Against the on-demand plan that is **$125–165K saved in one season** — earned with a retry policy, an autoscaler, and a quota ticket filed early. Against the API it is ~25–40x. Per answer: **$0.0136 (API) → $0.00127 (on-demand) → ~$0.0005 (mixed Spot)**.

The one-line summary for a budget review: **Spot pays you roughly 3x for engineering your fleet to survive losing any single node — which a good fleet should survive anyway.**

## Conclusion

- **Spot is the same GPU minus the guarantee:** 60–90% off, reclaimable on ~30–120 seconds' notice; A100 ~$3.67 → ~$1/hr.
- **It moves the strategy, not just the bill:** break-even vs the API drops ~270 → ~74 answers/hour, flipping medium-traffic features into self-host territory and extending the viable season.
- **Preemption is an engineering contract:** health-check drain, idempotent retries, gateway fallback, and cold-start headroom — losing one node must already be survivable.
- **Shape test:** small, repeatable units of work → Spot; long-lived state or no-fallback SLAs → on-demand.
- **Fine print:** separate quota (file early), thin pools at shared peaks (floor your peak fortnight on demand), older GPUs have the better pools.
- **Worked season:** ~$229K → ~$63–105K for the same tokens.

Next in the series: what the reserved side of this trade looks like on the two big clouds — [Azure](/blog/azure-payg-vs-ptu-reserved) and [GCP](/blog/gcp-payg-vs-reserved) — and then [the rental market beyond them](/blog/renting-gpus-startups-secure-vs-nonsecure).

That's it for now.
