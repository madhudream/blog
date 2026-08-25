---
title: "From 1,000 to 10,000 Tokens per Second: How Inference Evolved, 2024–2026"
slug: "throughput-evolution-2024-2026"
date: "2026-08-24"
tags: ["inference", "throughput", "fp8", "speculative-decoding", "disaggregation", "moe", "industry", "llm"]
reading_time: "9 min read"
words: 1740
summary: "In this blog, we will learn how per-GPU LLM throughput grew roughly 5x between 2024 and 2026 — the same H100 that served 1,000–3,000 tokens per second in early 2024 serves 5,000–15,000 today — by walking through each compounding driver: precision, kernels, schedulers, speculative decoding, disaggregated serving, and model architecture, plus where 2026 research is pushing next."
---

# From 1,000 to 10,000 Tokens per Second: How Inference Evolved, 2024–2026

In this blog, we will learn why every AI capacity plan has a shelf life. Between early 2024 and 2026, the throughput of the *same physical GPU* serving comparable models grew roughly **5x** — from the low thousands of tokens per second to five figures. Nobody changed the silicon; the industry changed everything around it. An infrastructure engineer who understands *where* that 5x came from can judge which gains their own stack has already banked and which are still on the table.

We will cover the following:

- The headline: the same card got 5x faster
- Why there was so much room to improve
- Driver 1: precision — FP16 → FP8 → FP4
- Driver 2: kernels — attention caught up to the hardware
- Driver 3: schedulers — the engine war paid out
- Driver 4: speculative decoding went mainstream
- Driver 5: disaggregated serving — prefill and decode split up
- Driver 6: the models themselves changed shape
- The price collapse that followed
- Where 2026 research is pushing
- What this means for your capacity plan
- Conclusion

Let's get started.

## The headline: the same card got 5x faster

Batched serving throughput for a mid-size (7B–30B-class) model on one H100:

```
BATCHED TOKENS/SEC, ONE H100 (order of magnitude)
2023-24, early vLLM era      ######  1,000-3,000 tok/s
2026, tuned modern stack     ##############################  5,000-15,000 tok/s
```

And the number a single user feels — uninterrupted single-stream generation — moved too: good GPU serving sits at 50–150 tok/s, while custom inference silicon (SRAM-based and wafer-scale designs) demonstrated **1,000–2,000+ tok/s single-stream** on 70B-class models, an existence proof that the ceiling is far from reached.

For calibration: our own measured stack ([previous blog](/blog/inference-stack-qwen-vllm)) ran an MoE model on an *A100* — a 2020 card — at ~2,880 structured answers/hour unsaturated, roughly 1,000 output tok/s, without speculative decoding or deep batch tuning. Mid-pack 2024-era performance on 2020 hardware, with known levers unpulled: that is what most production deployments look like, and it is why the 5x matters practically — much of it is *available*, not exotic.

## Why there was so much room to improve

The 2022-era serving stack used the GPU astonishingly badly. Decode is memory-bound ([GPU handbook](/blog/gpu-guide-a100-h100)): each token requires streaming the weights, leaving compute idle. On top of that, servers wasted 60–80% of KV memory on padding, batched statically, recomputed identical prompt prefixes millions of times, and ran attention kernels achieving a third of the hardware's arithmetic peak. The 2024–2026 story is simply this waste being eliminated layer by layer — which is why the gains *compound* instead of competing.

## Driver 1: precision — FP16 → FP8 → FP4

Bytes-per-parameter is a direct multiplier on the decode ceiling (bandwidth ÷ bytes). In 2023 production served FP16. By 2025, **FP8 became the default serving precision** on Hopper — halving streamed bytes and doubling tensor-core throughput, with quality loss small enough that it stopped being debated. Blackwell (B200) hardware added native **FP4**, and 4-bit weight serving of large models moved from enthusiast quantization to vendor-supported paths. Each halving of bytes is worth roughly a halving of decode cost. KV caches got the same treatment — FP8 KV quantization doubles how many concurrent requests fit, which is throughput by another name.

## Driver 2: kernels — attention caught up to the hardware

The attention operation itself was leaving most of the machine idle. FlashAttention-2 reached roughly a third of the H100's peak; **FlashAttention-3 (2024) reached ~75%** by exploiting Hopper-specific asynchrony and FP8 — a ~2x speedup of the single hottest kernel, felt mostly in prefill and long-context work. Around it, CUDA-graph capture, fused kernels, and compiler-generated code (torch.compile-class toolchains) shaved the per-token CPU and launch overhead that used to cap small-model throughput.

## Driver 3: schedulers — the engine war paid out

Between 2024 and 2026, vLLM, SGLang, and TensorRT-LLM competed publicly on benchmarks, and every good idea propagated to all three within months:

- **Continuous batching** ([previous blog](/blog/inference-stack-qwen-vllm)) went from novelty to table stakes.
- **Chunked prefill** — slicing a long prompt's prefill into pieces interleaved with decode steps — stopped new arrivals from stalling everyone else's token stream, taming tail latency at high load.
- **Prefix/radix caching** became automatic, turning repeated system prompts from millions of recomputations into one.
- **Engine rewrites** (vLLM's V1 core, 2025) removed Python-scheduler overhead that had become the bottleneck once the GPU-side waste was gone.

The compounding here is quiet but large: schedulers do not make any one request faster — they keep the memory-stream busy every microsecond, which is where batched tok/s figures come from.

## Driver 4: speculative decoding went mainstream

In 2024, speculative decoding was a paper; by 2026 it is a config flag. The EAGLE-class methods — a lightweight draft head proposing several tokens, the target model verifying them in one parallel pass — deliver **2–3x decode speedups losslessly** on structured and predictable output ([mechanics in the previous blog](/blog/inference-stack-qwen-vllm)). Providers run it silently: part of why hosted APIs got faster *and* cheaper without model changes. Research through 2025–26 kept raising accepted-tokens-per-pass (better draft architectures, multi-token prediction heads trained into the base model itself), so this driver is still appreciating.

## Driver 5: disaggregated serving — prefill and decode split up

The most important *architectural* shift in serving since continuous batching: prefill (compute-bound, bursty) and decode (memory-bound, steady) fight for the same GPU and degrade each other's latency. Large-scale operators — the pattern was popularized by systems like DistServe and Mooncake (the serving stack behind a major Chinese assistant) around 2024 — **split them onto separate GPU pools**: prefill nodes ingest prompts and ship the resulting KV cache over fast interconnect to decode nodes that do nothing but stream tokens.

Each pool then scales and batches for its own bottleneck: prefill nodes run huge compute batches; decode nodes pack maximum concurrency per GB of bandwidth. By 2026 disaggregation is a supported deployment mode in mainstream engines rather than a hyperscaler secret, and it is a meaningful slice of the fleet-level throughput gains — though at single-GPU and small-fleet scale (most readers of this series), it is the one driver on this list you can reasonably skip.

## Driver 6: the models themselves changed shape

Model architecture became an inference-cost feature:

- **Mixture-of-experts went mainstream** — 30B-class models activating ~3B per token ([previous blog](/blog/inference-stack-qwen-vllm)) stream a tenth of the bytes. Most 2025–26 open flagship releases are MoE.
- **KV-cache compression at the architecture level:** grouped-query attention (GQA) cut KV size several-fold and became universal; multi-head latent attention (MLA, from the DeepSeek line) compressed it by roughly an order of magnitude — KV cache per token fell faster than model quality, and KV is exactly what limits concurrency.
- **Hybrid attention layouts** (sliding-window and linear-attention layers mixed with full attention) made long context affordable instead of quadratic everywhere.

This driver compounds with all the others: fewer active bytes (MoE) through faster kernels at lower precision, with more requests resident because each one's KV shrank.

## The price collapse that followed

Throughput per GPU-hour up ~5x, plus competition, shows up on the invoice. Frontier-model output tokens that cost ~$60/M in 2023 sold for ~$10/M by 2026 ([tokens blog](/blog/tokens-how-ai-usage-is-measured)); capable open models self-host at ~$0.33/M blended ([TPS blog](/blog/tps-throughput-and-capacity-planning)). The strategic consequence for any AI feature: **a cost model built on last year's per-token price is wrong in your favor** — re-run the break-even math at least twice a year, because the answer to "API or self-host?" and "which model tier?" genuinely changes.

## Where 2026 research is pushing

The directions visible in current research and vendor roadmaps, stated as directions rather than promises:

- **KV-cache tiering:** spilling cold KV to CPU RAM and NVMe with smart prefetch, so long conversations stop being GPU-memory hostages.
- **Deeper speculation:** multi-token prediction trained into base models, making 3–5 accepted tokens per verify pass normal.
- **FP4 and below with quality guarantees** — the last easy byte-halvings.
- **Sparse and linear attention at frontier quality**, aimed at making million-token context linear-cost.
- **Scheduling across the fleet, not the GPU:** KV-aware routing (send the request to the node that already holds its prefix), which turns prefix caching into a cluster-wide property.

None of these change the governing division — **tokens/sec ≈ bandwidth ÷ bytes streamed per token, times batch efficiency** — they all just attack one of its three terms.

## What this means for your capacity plan

1. **Benchmarks expire.** A per-GPU answer rate measured 12 months ago understates today's achievable rate, possibly by 2x. Re-measure before buying hardware or reserving capacity.
2. **Audit against the driver list.** FP8? Prefix caching on? Speculative decoding enabled? Batch depth actually tuned? Most deployments are missing at least two — that is free capacity.
3. **Prefer levers to fleets.** Before adding GPUs, check which of the six drivers you have not banked; a config flag that yields 2x beats a purchase order that yields 2x.
4. **Model choice is an infrastructure decision.** An MoE with GQA/MLA is not just "a model" — it is a smaller KV cache, a higher decode ceiling, and a cheaper fleet.

## Conclusion

- **Same GPU, ~5x the tokens (2024 → 2026):** 1,000–3,000 → 5,000–15,000 batched tok/s on an H100 — waste removed, not silicon changed.
- **Six compounding drivers:** FP8/FP4 precision, attention kernels at ~75% of peak, mature schedulers (continuous batching, chunked prefill, prefix caching), mainstream speculative decoding (2–3x, lossless), disaggregated prefill/decode, and models shaped for inference (MoE, GQA/MLA).
- **Prices followed throughput down** ~5–6x at the frontier — re-run break-even math twice a year.
- **The division still governs:** bandwidth ÷ bytes per token × batch efficiency. Every advance on this list attacks one term.

Next in the series: [Spot GPUs — the 60–90% discount, and what it costs to earn it](/blog/spot-gpus-savings).

That's it for now.
