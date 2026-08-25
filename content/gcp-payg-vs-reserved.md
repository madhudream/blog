---
title: "GCP: Pay-As-You-Go, Provisioned Throughput, and Reserved GPUs"
slug: "gcp-payg-vs-reserved"
date: "2026-08-24"
tags: ["gcp", "vertex-ai", "committed-use-discounts", "spot", "gpu", "cost", "llm"]
reading_time: "9 min read"
words: 1750
summary: "In this blog, we will learn how AI capacity is bought on Google Cloud: Vertex AI per-token pricing and Provisioned Throughput on the managed side, and A2/A3 GPU machine families with committed-use discounts, Spot VMs, and scale-to-zero on the self-hosted side — with the same utilization break-even arithmetic worked on a real seasonal workload."
---

# GCP: Pay-As-You-Go, Provisioned Throughput, and Reserved GPUs

In this blog, we will learn the Google Cloud version of the question every AI platform team faces: pay per token, reserve managed throughput, or rent the GPUs and serve the model ourselves? GCP offers all three, and the good news is that the arithmetic from the [Azure blog](/blog/azure-payg-vs-ptu-reserved) transfers directly — only the names and unit prices change. The structure of every decision remains: **commitments buy a discount in exchange for a utilization bet.**

We will cover the following:

- The three ways to buy AI capacity on GCP
- Managed, pay-as-you-go: Vertex AI per-token pricing
- Managed, reserved: Provisioned Throughput and GSUs
- Self-hosted: the GPU machine families (A2, A3, G2)
- The discount ladder: on-demand, CUDs, Spot, DWS
- Worked example: a season, three ways
- Scale-to-zero: the discipline that makes self-hosting real
- Conclusion

Let's get started.

## The three ways to buy AI capacity on GCP

```
                     managed                      self-hosted
                     -------                      -----------
pay per use          Vertex AI per-token          GPU VMs on-demand / Spot
pay for capacity     Provisioned Throughput       committed use discounts (CUDs)
                     (GSUs, term commitment)      + reservations
```

The left column is Google serving a model for you (Gemini and partner/open models through Vertex AI). The right column is a GPU VM running your own serving stack (vLLM, SGLang, TGI). The rows are the same trade in both columns: per-use pricing has no floor and no guarantee; capacity pricing has both.

## Managed, pay-as-you-go: Vertex AI per-token pricing

Vertex AI bills generative models per million tokens, input and output priced separately, exactly like every hosted API — output at a multiple of input, cached input discounted, batch requests discounted further (batch API runs at ~50% of interactive pricing). The `usage` accounting and all the levers from [the tokens blog](/blog/tokens-how-ai-usage-is-measured) apply unchanged.

One GCP-specific behavior worth knowing: for its flagship models Google runs **dynamic shared quota** — instead of a fixed per-project TPM number, your requests draw from a regional shared pool, and there is no quota-increase ticket to file for ordinary growth. The upside is elasticity for spiky workloads; the flip side is the familiar one — a shared pool guarantees neither latency nor capacity at your worst moment. That gap is, as always, what the reserved product sells.

## Managed, reserved: Provisioned Throughput and GSUs

Vertex AI's reserved offering is **Provisioned Throughput**, sold in **GSUs (Generative AI Scale Units)** — Google's sibling of the Azure PTU. The mechanics rhyme:

- Each GSU provides a fixed, model-specific throughput budget, quoted in tokens per second — larger models get fewer tokens per GSU, and input/output tokens are weighted differently (Google publishes per-model "burndown" rates; output tokens burn several times more than input, same as Azure's ×8 weighting).
- You buy a number of GSUs for a **term** — the terms run shorter than Azure's (weekly and monthly commitments, with longer terms negotiable), which is a genuine advantage for seasonal workloads: a peak *week* can be reserved as a week.
- Traffic beyond your GSUs can **spill over to pay-as-you-go** (a flag on the request), so the reserved layer runs hot and the shared pool takes the burst — the same "reserve the base, burst the peak" pattern as Azure spillover.
- An idle GSU bills like a busy one. The utilization break-even logic is identical: **commitment price ÷ per-use price at the same volume = the utilization above which the commitment wins.**

Sizing works exactly like the [PTU worked example](/blog/azure-payg-vs-ptu-reserved): calls/min × token counts × per-token weights ÷ per-GSU capacity, using Google's published burndown table for the model in question. The structure of the calculation — and the dominance of output tokens in it — carries over one-for-one.

## Self-hosted: the GPU machine families (A2, A3, G2)

GCP exposes data-center GPUs (the cards detailed in [the GPU handbook](/blog/gpu-guide-a100-h100)) through fixed machine families:

| Family | GPU | Shapes | Typical use |
| --- | --- | --- | --- |
| N1 + T4 | T4 16 GB | 1–4 GPUs | Budget inference, quantized small models |
| G2 | L4 24 GB | 1–8 GPUs | Cheap modern serving tier |
| A2 highgpu | A100 40 GB | 1–16 GPUs | The workhorse tier |
| A2 ultragpu | A100 80 GB | 1–8 GPUs | 30B-class models, single card |
| A3 | H100 80 GB | 8 GPUs | Frontier serving/training nodes |
| A3 ultra | H200 141 GB | 8 GPUs | Big-memory Hopper |

Notes that matter when planning:

- **The GPU sets the VM shape.** An `a2-highgpu-1g` is one A100 plus a fixed 12 vCPU / 85 GB RAM — you size by GPU count and accept the rest.
- **Indicative on-demand anchor:** a single-A100 machine runs **~$3.67/hr** (the number used throughout this series' worked examples); single-GPU H100 capacity, where offered, runs roughly 2x that. A3 machines are primarily sold as 8-GPU nodes — relevant if your plan calls for "one H100."
- **Quota is per GPU model per region** and is the real constraint. As in every cloud, the A100 pool is deeper than the H100 pool; our own deployments got A100 capacity reliably when H100 capacity was scarce.

## The discount ladder: on-demand, CUDs, Spot, DWS

Self-hosted GPU pricing is a ladder of the same utilization bet at increasing commitment:

| Rung | Discount vs on-demand | The bet you are making |
| --- | --- | --- |
| On-demand | 0% | none — pay for flexibility |
| 1-year CUD | ~35–40% | this capacity runs most of the year |
| 3-year CUD | ~55–60% | this capacity runs for three years |
| Spot VMs | ~60–90% | interruption is survivable |
| DWS (flex-start) | ~30–50% | the job can wait for a start slot |

**Committed Use Discounts (CUDs)** are the GPU sibling of a PTU reservation: commit to a resource level for 1 or 3 years, pay the discounted rate whether it runs or not. The break-even is one division, same as Azure's 36% rule: a 1-year CUD at ~37% off beats on-demand only if the capacity is used **more than ~63% of the year**. For the seasonal workload below — GPUs busy about a third of the year — a fleet-wide CUD *loses* money; only the year-round floor qualifies.

**Spot VMs** are the deepest discount and the sharpest edge: 60–90% off, but the VM can be preempted with 30 seconds' notice. Stateless inference behind a load balancer is the ideal Spot workload — a killed node drops its in-flight requests, retries land on surviving nodes, and the autoscaler replaces the node. Keep a minority of on-demand nodes as the floor and let Spot carry the elastic majority.

**Dynamic Workload Scheduler (DWS)** trades start-time flexibility for price and *obtainability* — you request GPUs for a bounded duration and GCP schedules them when capacity exists. Made for batch jobs (evaluations, fine-tunes, nightly summarization), not user-facing serving.

## Worked example: a season, three ways

Take the worked company from [the TPS blog](/blog/tps-throughput-and-capacity-planning) — up to 180M AI calls over a season, 2,609 input / ~1,300 output tokens per call — and price the season on GCP three ways, using this series' measured numbers (2,880 answers/hr per A100, $0.0136/answer on a frontier API):

```
SEASON COST, THREE WAYS (180M calls)
managed API, per-token         ##########################  ~$2.46M
self-host A100s, on-demand     ##                          ~$229K
self-host A100s, Spot          #                           ~$63K
```

The 10x gap between the API and on-demand self-hosting is the [break-even math](/blog/tps-throughput-and-capacity-planning) compounding over a season — this workload runs ~11x past the ~270 answers/hour crossover. The further 3.6x from Spot is the discount ladder doing its work on a preemption-tolerant, load-balanced fleet.

Where would CUDs fit? Only under the floor: the handful of GPUs (or GSUs) this product needs year-round. The seasonal 60-GPU peak fleet should live on on-demand + Spot and *disappear in May* — which brings us to the last section.

## Scale-to-zero: the discipline that makes self-hosting real

Every self-hosted number above assumes the fleet tracks the traffic. GCP's tooling makes the discipline enforceable:

- **GKE node auto-provisioning / cluster autoscaler** scales GPU node pools with load — including to zero. A vLLM Deployment behind an HPA driven by queue depth or GPU utilization is the standard shape.
- **Calendar-driven scaling for the big moves.** Seasonal products know their deadline; schedule the ramp (a scheduled scale-up job, or simply Terraform applied per season phase) and let metric-driven autoscaling handle the daily curve on top.
- **Budget alerts as a tripwire, not a report.** A GPU fleet left running through the off-season erases a season's savings in weeks; alert at the daily-spend level where "the fleet didn't scale down" is caught in days.
- **Route the off-season trickle to the managed API.** Below the break-even rate, per-token is simply cheaper. The gateway pattern from [the Azure blog](/blog/azure-payg-vs-ptu-reserved) — one URL, model choice as configuration — is what makes this a config change instead of a migration.

## Conclusion

- **Same trade, new names:** Vertex AI per-token ↔ PAYG; Provisioned Throughput GSUs ↔ PTUs; CUDs ↔ capacity reservations. Every commitment is a discount bought with a utilization bet.
- **GSU sizing is PTU sizing:** calls/min × weighted tokens ÷ per-GSU capacity, with output tokens burning several times input — and GCP's shorter (weekly/monthly) terms suit seasonal peaks well.
- **GPU families:** A2 = A100, A3 = H100/H200, G2 = L4; single A100 ≈ $3.67/hr on demand; quota depth favors A100.
- **The discount ladder:** CUDs ~37/55% (break-even ≈ 63% utilization for 1-year), Spot 60–90% (for preemption-tolerant serving), DWS for batch.
- **Worked season:** ~$2.46M managed per-token vs ~$229K on-demand self-host vs ~$63K Spot — and the entire gap is conditional on scaling to zero when the season ends.

Next in the series: [the rental market beyond the hyperscalers — the startup path, and which workloads belong on which tier](/blog/renting-gpus-startups-secure-vs-nonsecure).

That's it for now.
