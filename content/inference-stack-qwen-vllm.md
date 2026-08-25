---
title: "The Inference Stack: How an Open Model on vLLM Cut Cost 10x"
slug: "inference-stack-qwen-vllm"
date: "2026-08-24"
tags: ["vllm", "qwen", "paged-attention", "continuous-batching", "prefix-caching", "speculative-decoding", "inference"]
reading_time: "11 min read"
words: 2000
summary: "In this blog, we will learn the serving stack that turns a rented GPU into a cheap, fast inference service: what an open-weight model like Qwen is, why mixture-of-experts changes the decode math, and how PagedAttention, continuous batching, prefix caching, speculative decoding, and FP8 quantization compound — with measured numbers showing a $0.0136 API answer served for ~$0.0013."
---

# The Inference Stack: How an Open Model on vLLM Cut Cost 10x

In this blog, we will learn where the 10x cost reduction quoted throughout this series actually comes from. It is not one trick. It is a stack: an open-weight model whose architecture streams fewer bytes per token, running on a serving engine (vLLM or SGLang) that wastes almost no memory, batches continuously, caches repeated prompts, and can speculate ahead of itself. Each layer is understandable on its own, and their effects multiply.

Every number in this blog is measured from one workload: 2,609-token prompts, ~1,300-token answers, served first from a frontier paid API ($0.0136/answer, first word in ~1,500 ms) and then from **Qwen3-30B on vLLM on a single rented A100** (~$0.0013/answer batched, first word in ~114 ms).

We will cover the following:

- Open-weight models: what you are actually downloading
- Mixture-of-experts: 30B parameters, 3B per token
- The serving engine: what vLLM actually does
- PagedAttention: stop wasting the KV cache
- Continuous batching: the 100x throughput lever
- Prefix caching: the 18x first-word lever
- Speculative decoding: more tokens per memory pass
- Quantization: FP8 in practice, with one sharp edge
- Closing the quality gap: grounding beats size
- The stack, compounded
- Conclusion

Let's get started.

## Open-weight models: what you are actually downloading

An **open-weight model** (Qwen, Llama, DeepSeek, Mistral) is a model whose parameters are published for download — typically tens of gigabytes of weight files. You rent a GPU, point a serving engine at the weights, and you have a private, OpenAI-compatible API endpoint: same request format, same streaming, same `usage` object as the paid APIs, no per-token bill.

What you give up is frontier quality out of the box, and what you take on is operations. The economics of that trade were computed in [the TPS blog](/blog/tps-throughput-and-capacity-planning) (break-even ~270 answers/hour per GPU); this blog is about the machinery that makes the self-hosted side of that comparison so cheap.

## Mixture-of-experts: 30B parameters, 3B per token

The model in our experiment, **Qwen3-30B-A3B**, has a name that is a spec sheet: 30 **B**illion total parameters, **A**ctive **3B** per token. It is a **mixture-of-experts (MoE)** model: its feed-forward layers are split into many small "experts," and a router picks a few of them per token. Every token flows through only ~3B of the 30B parameters.

Recall the decode speed limit from [the GPU handbook](/blog/gpu-guide-a100-h100): **decode ceiling ≈ memory bandwidth ÷ bytes read per token**. MoE rewrites the numerator's other half:

```
DENSE 30B, FP8:  ~30 GB read per token   ->  A100 (2 TB/s):  ~66 tok/s ceiling
MoE 30B-A3B, FP8: ~3 GB read per token   ->  A100 (2 TB/s):  ~660 tok/s ceiling
```

You still need memory for all 30 GB of weights (any expert may be chosen), but each token only *streams* the active slice. That is the architecture's bargain: **the memory footprint of a 30B model, the serving speed of a 3B model** — and it is why a mid-size MoE on one A100 held its own on latency against a frontier API in our tests.

One measured warning against the intuition "bigger must be better": on the same workload, a dense Llama-70B cost **3–4x more per answer** than Qwen-30B-A3B (16–23 s vs ~5 s per answer) and delivered *identical* quality scores. The failure mode of all the open models was missing information, not missing capacity — more on that below.

## The serving engine: what vLLM actually does

Loading weights into a GPU and calling `generate()` in a loop serves one user badly. A **serving engine** — vLLM and SGLang are the two we tested; TensorRT-LLM is the NVIDIA-native third — is the difference between a science project and a service. It owns four jobs: manage KV-cache memory (PagedAttention), schedule many requests onto one GPU (continuous batching), avoid recomputing repeated work (prefix caching), and expose it all behind an OpenAI-compatible HTTP server with streaming and metrics.

The next four sections are those jobs, one by one.

## PagedAttention: stop wasting the KV cache

The **KV cache** is the per-request working memory: for every token in a conversation the model keeps key/value tensors it must re-read on every subsequent decode step. Naive servers reserve each request's KV cache as one contiguous block sized for the *maximum possible* length — and since most answers stop early, most of that reservation is never used. Measured waste in pre-vLLM systems ran **60–80% of KV memory**.

**PagedAttention** — vLLM's founding idea — manages KV memory like an operating system manages RAM: small fixed-size blocks (pages), allocated on demand, freed on completion, with a lookup table per request. Waste drops to under ~4%.

The payoff is not speed per request — it is **concurrency**. From [the TPS blog](/blog/tps-throughput-and-capacity-planning), concurrency is bought with spare KV memory (Little's Law: ~470 requests in flight at our peak). PagedAttention roughly triples the concurrent requests the same 80 GB card can hold, which triples throughput at no hardware cost.

## Continuous batching: the 100x throughput lever

Decode is memory-bound: streaming 30 GB (or 3 GB) of weights to produce *one user's* token leaves the GPU's math units nearly idle. Batching fixes it — one weight-stream produces the next token for *dozens of requests at once*, nearly free.

Old-style **static batching** grouped requests and waited for the whole batch to finish — one long answer held the exit for everyone. **Continuous batching** schedules at the *token* level: finished requests leave the batch immediately, waiting requests join immediately, every decode step runs whoever is active.

Measured on our workload (one A100, vLLM):

```
throughput vs concurrency (same GPU, same model)
concurrency 1     420 answers/hr   ##
concurrency 16  2,880 answers/hr   ##############   (unsaturated)
```

Same card, ~7x the answers, because the batch keeps the memory-stream busy. Per-answer cost falls in proportion: **$0.0091 single-stream → $0.0013 at concurrency 16.** This one scheduler feature is most of the "10x cheaper" headline.

## Prefix caching: the 18x first-word lever

Production prompts repeat: our 2,609-token prompt is ~2,400 tokens of fixed instruction block plus a small per-customer tail. Prefix caching keeps the computed KV cache of the shared block in GPU memory and reuses it, so a new request only prefills its unique tail. (SGLang's version, RadixAttention, organizes cached prefixes in a tree so partial overlaps share too.)

Measured, same instruction block across 10 different customers:

```
TIME TO FIRST WORD (vLLM, one A100)
call 1  (cold - fills cache)   ####################  2,112 ms
calls 2-10 (warm)              #  112-123 ms          -> 18.5x faster
```

In steady production traffic ~99% of calls are warm, so the *effective* first-word latency of the self-hosted stack was ~114 ms against the paid API's ~1,500 ms. Prefix caching is also a capacity feature: prefill work you skip is GPU time returned to decode — which is exactly why the [Azure PTU formula](/blog/azure-payg-vs-ptu-reserved) counts cached input tokens at nearly zero weight. The design rule from [the tokens blog](/blog/tokens-how-ai-usage-is-measured) — static content first, variable tail last — is what makes the hit rate possible.

## Speculative decoding: more tokens per memory pass

Decode's bottleneck is one weight-stream per token. **Speculative decoding** breaks the one-token limit: a small, fast **draft** (a tiny model, or a lightweight head grafted onto the big model, as in the EAGLE family of methods) proposes several next tokens; the big model then *verifies* the whole proposal in a single forward pass. Verification is parallel — checking 4 proposed tokens costs about one memory-stream, not four.

Two properties matter for an infrastructure engineer:

- **The output is exactly what the big model would have produced.** Verification accepts only tokens the target model agrees with; this is a lossless speedup, not an approximation.
- **The win depends on predictability.** Typical measured speedups are **2–3x** on structured, template-like output (JSON, code, formulaic prose — our insights workload is exactly this shape) and less on freewheeling creative text, where the draft guesses wrong and verification rejects.

Both vLLM and SGLang ship it as a configuration flag, not a research project — it stacks on top of everything above.

## Quantization: FP8 in practice, with one sharp edge

[The GPU handbook](/blog/gpu-guide-a100-h100) covered the theory: fewer bytes per parameter → smaller model → faster decode. In practice, our stack served Qwen in **FP8** (1 byte/param, ~30 GB) — halving the streamed bytes versus BF16 (~58 GB) and leaving far more of the 80 GB card for KV cache (which is concurrency).

The sharp edge we hit, worth passing on: **FP8 support is kernel-specific, not just hardware-specific.** On an A100 (Ampere — no native FP8), vLLM served FP8 anyway via Marlin kernels that dequantize on the fly; SGLang's FP8 path required an H100-only kernel and refused to start on the A100 (it fell back to BF16, which still fit). Same model, same card, different engines, different precision options. The lesson generalizes: *quantization claims are verified per engine + GPU pair, not read off a model card.*

## Closing the quality gap: grounding beats size

The honest part of the story: raw open models scored **5–6/10** on our task against the frontier API's 8.5+. But every open model failed the *same* way — stale domain figures and invented eligibility claims. That is missing **information**, not missing intelligence.

The fix was in the prompt, not the GPU budget: embedding **five verified reference facts** in the instruction block raised every model tested by about **+1.0 judge point**, lifting Qwen to 7.25/7.0 against the frontier model's 8.0/7.5 on independent judges — close enough that streaming and an 18x faster first word won the overall product trade, with the frontier API kept as a fallback route for unusual cases. Meanwhile the "throw parameters at it" alternative (Llama-70B) had already failed: 3–4x the cost, same score.

The pattern to keep: **before paying for a bigger model, check whether the small one is missing facts you could just include.**

## The stack, compounded

```
WHERE THE 10x COMES FROM (measured, one workload)

paid frontier API                    $0.0136/answer   TTFT ~1,500 ms
open MoE model, naive single-stream  $0.0091          TTFT ~2,100 ms cold
+ prefix caching                      (same $)        TTFT ~114 ms warm
+ PagedAttention + continuous
  batching @ concurrency 16          $0.0013          TTFT ~114 ms
+ speculative decoding, deeper
  batch, Spot pricing                headroom below $0.001
```

No single layer is magic. The MoE architecture set a high ceiling, FP8 halved the bytes, PagedAttention bought the concurrency, continuous batching spent it, and prefix caching made the first word instant. **10x is what a stack looks like, not what a trick looks like.**

## Conclusion

- **Open-weight + serving engine = a private OpenAI-compatible API** at GPU-hour prices; the trade is out-of-box quality and ops.
- **MoE changes the decode math:** 30B stored, 3B streamed — memory footprint of a big model, speed of a small one. Bigger dense models are not automatically better; ours cost 3–4x more for the same score.
- **PagedAttention buys concurrency** (KV waste 60–80% → <4%), **continuous batching spends it** (420 → 2,880 answers/hr, $0.0091 → $0.0013), **prefix caching makes it instant** (2,112 → 114 ms), **speculative decoding adds 2–3x** losslessly on structured output.
- **FP8 is an engine+GPU pairing question** — verify, don't assume.
- **Ground before you upsize:** five verified facts in the prompt beat 40 billion extra parameters.

Next in the series: [how the whole industry's throughput went from ~1,000 to 10,000+ tokens per second between 2024 and 2026](/blog/throughput-evolution-2024-2026).

That's it for now.
