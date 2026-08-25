---
title: "A100, H100, and Friends: A GPU Handbook for Infrastructure Engineers"
slug: "gpu-guide-a100-h100"
date: "2026-08-24"
tags: ["gpu", "a100", "h100", "hardware", "infrastructure", "llm"]
reading_time: "12 min read"
words: 2220
summary: "In this blog, we will learn what an A100 and an H100 actually are — memory, bandwidth, tensor cores, NVLink, SXM vs PCIe, MIG — plus the full accelerator lineup from T4 to B200, what model fits on which card, the one division that predicts serving speed, and what these GPUs cost on Azure, GCP, and AWS."
---

# A100, H100, and Friends: A GPU Handbook for Infrastructure Engineers

In this blog, we will learn the hardware that AI workloads actually run on. When a team says "we need two A100s" or "the H100 quota request is stuck," an infrastructure engineer should be able to picture exactly what is being asked for: how much memory, how fast, what it costs per hour, and whether the workload genuinely needs it. By the end, sizing a GPU request will be arithmetic, not folklore.

We will cover the following:

- Why AI runs on GPUs at all
- The three numbers that define a GPU for AI work
- The A100, in detail
- The H100, in detail
- The full lineup: T4 to B200
- SXM vs PCIe, NVLink, and MIG
- What fits where: model memory math
- The one division that predicts serving speed
- What they cost in the cloud
- Choosing: A100 vs H100 in practice
- Conclusion

Let's get started.

## Why AI runs on GPUs at all

A language model is a very large pile of numbers (its **parameters**, or weights) and running it is mostly one operation repeated endlessly: matrix multiplication. A CPU has a few dozen powerful cores optimized for branching logic; a GPU has thousands of simple cores optimized for doing the same multiplication on huge blocks of numbers at once. For matrix math, one GPU replaces racks of CPUs.

Modern NVIDIA data-center GPUs add **tensor cores** — dedicated units that perform small matrix multiplications in a single instruction, at reduced numeric precision (FP16, BF16, FP8, INT8). Nearly all AI arithmetic runs on tensor cores; the headline "TFLOPS" figures in spec sheets refer to them.

## The three numbers that define a GPU for AI work

For LLM serving, ignore most of the spec sheet. Three numbers decide everything:

1. **Memory capacity (GB)** — decides which models *fit*. A model needs its weights in GPU memory, plus working room (the KV cache) that grows with every concurrent user and every token of context.
2. **Memory bandwidth (TB/s)** — decides how fast tokens *stream*. Generating each token requires reading the entire model out of memory once, so decode speed is capped by how fast memory can be read.
3. **Price ($/hr)** — closes the business loop.

Compute TFLOPS matters mainly for prefill (prompt ingestion) and training; for the token-by-token generation phase that dominates serving, bandwidth is king.

## The A100, in detail

The **NVIDIA A100** (Ampere architecture, launched 2020) was the workhorse of the 2021–2025 AI buildout, and it remains the most available, best-understood data-center GPU.

| Spec | A100 40GB | A100 80GB |
| --- | --- | --- |
| Architecture | Ampere (7nm, 54B transistors) | Ampere |
| Memory | 40 GB HBM2 | 80 GB HBM2e |
| Memory bandwidth | ~1.6 TB/s | ~2.0 TB/s |
| BF16/FP16 tensor compute | 312 TFLOPS | 312 TFLOPS |
| INT8 tensor compute | 624 TOPS | 624 TOPS |
| NVLink (GPU-to-GPU) | 600 GB/s | 600 GB/s |
| Power (SXM) | 400 W | 400 W |
| MIG partitions | up to 7 | up to 7 |

Things worth knowing beyond the table:

- **HBM** (High Bandwidth Memory) is the reason these cards cost what they do: memory dies stacked vertically next to the GPU die, wired with thousands of connections. The bandwidth — 2 TB/s reads the entire 80 GB in 40 milliseconds — is the product being paid for.
- **The 40GB vs 80GB choice is about model fit, not speed.** Same compute, same architecture; the 80GB simply holds a 2x bigger model (or 2x the concurrent users' KV cache).
- **No FP8.** Ampere's tensor cores bottom out at INT8. Models quantized to FP8 (increasingly the default serving precision in 2026) need Hopper or newer.

## The H100, in detail

The **NVIDIA H100** (Hopper architecture, launched 2022) is the A100's successor and the card most of the "GPU shortage" headlines were about.

| Spec | H100 SXM | H100 PCIe |
| --- | --- | --- |
| Architecture | Hopper (4nm, 80B transistors) | Hopper |
| Memory | 80 GB HBM3 | 80 GB HBM2e |
| Memory bandwidth | ~3.35 TB/s | ~2.0 TB/s |
| BF16/FP16 tensor compute | ~990 TFLOPS | ~756 TFLOPS |
| FP8 tensor compute | ~1,980 TFLOPS | ~1,513 TFLOPS |
| NVLink | 900 GB/s | 600 GB/s |
| Power | 700 W | 350 W |
| MIG partitions | up to 7 | up to 7 |

The two upgrades that matter for serving:

- **~1.7x the memory bandwidth** of an A100 80GB (3.35 vs 2.0 TB/s). Since decode is bandwidth-bound, the same model streams tokens roughly 1.7x faster — that, not capacity (both are 80 GB), is what the higher price buys.
- **The Transformer Engine and FP8.** Hopper's tensor cores natively run 8-bit floating point, which halves model memory *and* doubles compute versus FP16, with quality loss small enough that FP8 serving became mainstream. An H100 serving an FP8 model gets a double win: half the bytes to stream, over the faster memory.

The **H200** (2024) is the same Hopper compute die with the memory system upgraded: **141 GB of HBM3e at ~4.8 TB/s** — for when the H100's 80 GB is the constraint.

## The full lineup: T4 to B200

| GPU | Arch (year) | Memory | Bandwidth | Think of it as |
| --- | --- | --- | --- | --- |
| T4 | Turing (2018) | 16 GB | ~0.3 TB/s | Budget inference: small/quantized models |
| A10 | Ampere (2021) | 24 GB | ~0.6 TB/s | Mid-tier: 7B-class at FP16 |
| L4 | Ada (2023) | 24 GB | ~0.3 TB/s | T4's successor; GCP's cheap serving card |
| L40S | Ada (2023) | 48 GB | ~0.9 TB/s | Big-memory Ada; graphics + inference |
| A100 | Ampere (2020) | 40/80 GB | 1.6/2.0 TB/s | The workhorse; easiest quota to get |
| H100 | Hopper (2022) | 80 GB | ~3.4 TB/s | The serving flagship of 2023–2026 |
| H200 | Hopper (2024) | 141 GB | ~4.8 TB/s | H100 with the memory doubled |
| B200 | Blackwell (2024–25) | 192 GB | ~8 TB/s | The next generation; FP4 support |

Reading the table top to bottom is reading the same three numbers grow: more memory (bigger models fit), more bandwidth (tokens stream faster), higher price.

## SXM vs PCIe, NVLink, and MIG

Three terms that appear in every quota conversation:

- **SXM vs PCIe.** The same GPU ships in two forms. **SXM** modules are soldered onto a shared board (an HGX baseboard, usually 8 GPUs), run at higher power, get the full-speed HBM, and interconnect via NVLink. **PCIe** cards slot into ordinary servers, run cooler and slower. Cloud "8x" instances are SXM; "1x/2x/4x" offerings are often PCIe. For single-GPU serving the difference is modest; for multi-GPU work it is large.
- **NVLink** is the GPU-to-GPU interconnect: 600 GB/s on A100, 900 GB/s on H100 — versus ~64 GB/s for PCIe Gen4. When one model is split across GPUs (tensor parallelism), every token generated requires the GPUs to exchange partial results; NVLink is what makes a 2-GPU model behave like one big GPU instead of two small ones connected by a straw.
- **MIG (Multi-Instance GPU)** partitions one A100/H100 into up to 7 isolated slices, each with its own memory and compute. Useful for packing many small models or notebook users onto one card; not useful for serving one large model.

## What fits where: model memory math

Model memory is one multiplication: **parameters × bytes per parameter** (FP16 = 2 bytes, INT8/FP8 = 1 byte, INT4 = 0.5 bytes).

```
WHAT FITS WHERE (weights only)

 3.5 GB  INT4 7B    ->  fits 16 GB T4
 14 GB   FP16 7B    ->  fits 24 GB A10/L4
 60 GB   FP16 30B   ->  fits 80 GB A100/H100  (20 GB left for KV cache)
 70 GB   INT8 70B   ->  fits 80 GB A100/H100  (tight)
140 GB   FP16 70B   ->  needs 2x 80 GB, NVLink-connected
```

Leave **20–30% of GPU memory above the weights** for the KV cache — the per-conversation working memory that grows with context length and concurrent users. This is why a 30B model on an 80 GB card is comfortable while a 70B is tight: the difference is entirely KV-cache headroom, which is what sustains concurrency when many requests stream at once.

In our own serving experiment this exact trade appeared in practice: a 30B model (~60 GB at FP16) deployed on **2x A100** gave 160 GB total — double the KV-cache room of a single H100 — and the pair cost about the same per hour as the one H100 while being far easier to get quota for.

## The one division that predicts serving speed

Every generated token requires streaming the whole model out of memory once, so:

**max single-stream decode speed ≈ memory bandwidth ÷ model size in bytes**

For a 30B model at FP16 (60 GB):

```
DECODE CEILING (30B FP16, 60 GB, single stream)
A100 80GB   2.0 TB/s / 60 GB  ->  ~33 tok/s
H100        3.4 TB/s / 60 GB  ->  ~56 tok/s
H200        4.8 TB/s / 60 GB  ->  ~80 tok/s
```

Real single-stream numbers land below these ceilings (overhead), but the *ratios* hold, and the division answers purchasing questions instantly: an H100 will stream this model ~1.7x faster than an A100 — is 1.7x latency worth ~2x the price for this workload? For a user-facing chat product, often yes. For a workload where time-to-first-token and total concurrency matter more than raw streaming speed, the cheaper card with more aggregate memory often wins — that was our result.

Batching changes throughput, not this ceiling: serving engines (vLLM, SGLang) overlap many users' requests so the one expensive memory-stream produces tokens for dozens of users at once. Total throughput rises ~100x; each individual stream still obeys the division above.

## What they cost in the cloud

Indicative on-demand rates as of mid-2026 (always check current pricing pages; regions vary):

| GPU | Typical cloud $/hr (on-demand, per GPU) | Where |
| --- | --- | --- |
| T4 | $0.35–0.60 | GCP n1+T4, AWS g4dn |
| L4 | $0.70–1.00 | GCP g2, AWS g6 |
| A10 | $0.75–1.20 | AWS g5, Azure NVadsA10 |
| A100 80GB | $1.00–4.00 | GCP a2-ultragpu, Azure NC A100 v4, AWS p4de |
| H100 | $2.00–8.00 | GCP a3-highgpu, Azure NC/ND H100 v5, AWS p5 |
| H200 | $4.00–10.00 | GCP a3-ultragpu, AWS p5e |

Two real data points from our own deployments, for calibration: an **A100 80GB ran ~$3.67/hr** on pay-as-you-go cloud pricing, and a **single-H100 managed-compute deployment billed $7.91/hr**. Spot/preemptible capacity cut the A100 rate roughly 3.6x (to ~$1/hr) when quota allowed.

The pricing follows the bandwidth almost linearly — which is exactly what the decode-ceiling division says it should do. You are renting memory bandwidth by the hour.

## Choosing: A100 vs H100 in practice

A decision checklist that has held up:

- **Model ≤ 80 GB, latency-sensitive, budget available** → H100. The 1.7x bandwidth shows up directly as 1.7x faster token streaming.
- **Model ≤ 80 GB, throughput/concurrency-bound** → A100(s). Same capacity per card at roughly half the price; spend the savings on a second card and double your KV cache and batch size.
- **Model needs FP8** → H100 or newer; Ampere cannot run it.
- **Quota is the bottleneck** → A100. Every cloud's A100 pool is deeper than its H100 pool; in our deployments the A100 capacity was consistently available when H100 capacity was not — and a working A100 beats a wishlisted H100 every time.
- **Model > 80 GB at serving precision** → 2x 80 GB with NVLink, or one H200, and compare prices that week.

## Conclusion

- **Three numbers define a GPU:** memory (what fits), bandwidth (how fast it streams), price. Compute TFLOPS is a training concern first.
- **A100** = 40/80 GB at 1.6–2.0 TB/s, the available workhorse. **H100** = 80 GB at 3.4 TB/s with FP8 — same capacity, ~1.7x the speed, ~2x the price. **H200** = H100 with 141 GB.
- **Model GB = params × bytes/param**; leave 20–30% headroom for KV cache — headroom *is* concurrency.
- **Decode ceiling ≈ bandwidth ÷ model bytes** — the single most useful division in GPU purchasing.
- **Cloud anchors:** A100 ~$1–4/hr, H100 ~$2–8/hr on demand; spot cuts ~3–4x. You are renting memory bandwidth by the hour.

Next in the series: [turning user traffic into TPS, concurrency, and a GPU count](/blog/tps-throughput-and-capacity-planning).

That's it for now.
