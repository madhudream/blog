---
title: "Numbers Every AI Engineer Should Know"
slug: "numbers-every-ai-engineer-should-know"
date: "2026-07-25"
tags: ["llm", "ai", "system-design", "gpu"]
reading_time: "10 min read"
words: 1966
summary: "In this blog, we will learn the back-of-envelope numbers behind every LLM system-design decision: how big tokens are, how many bytes a parameter takes, what T4, A10, A100, and H100 GPUs actually offer, how fast decoding can possibly go, and what a million tokens really costs — all with simple worked examples."
---

# Numbers Every AI Engineer Should Know

In this blog, we will learn the small set of numbers that lets us estimate almost any LLM system-design question on the back of an envelope. Will a 7B model fit on a T4? Why does the same model stream 5x faster on an H100 than on an A10? Is self-hosting cheaper than an API? Every one of these answers comes from a handful of numbers multiplied together — no benchmarks needed for a first estimate.

The numbers are rounded on purpose. Estimation first, precision later.

We will cover the following:

- Tokens and text: the token ruler
- Bytes per parameter: precision is just bytes
- Model size: one multiplication
- The GPU lineup: T4, A10, A100, H100, and friends
- What fits where
- Memory bandwidth: the number that sets your decode speed
- Throughput and latency anchors
- Cost per million tokens, with worked examples
- Conclusion

Let's get started.

## Tokens and text: the token ruler

Everything in LLM land is measured in tokens, so we need a ruler.

**1 token ≈ 4 characters ≈ 0.75 words.**

```
"The quick brown fox jumps over the lazy dog"

split into ~4-char chunks (each chunk ~= 1 token):
[The ][quic][k br][own ][fox ][jump][s ov][er t][he l][azy ][dog]
```

Scaling that up:

```
1 word              #  ~1.3 tok
1 page (500 words)  #######################  ~700 tok
book (150k words)   ##########################################  ~200,000 tok
```

Simple example: a 2,000-token system prompt (like the one in our [prefix caching](/blog/prefix-caching) blog) is about 3 pages of instructions. A 200-token answer is a short paragraph. When an API bill says "1 million tokens," that is roughly 5 novels of text.

## Bytes per parameter: precision is just bytes

A model is a pile of numbers (parameters, or weights), and each number is stored at some precision. Precision is just bits, and 8 bits = 1 byte:

```
FP32  32 bits  =  4 bytes/param
FP16  16 bits  =  2 bytes/param
INT8   8 bits  =  1 byte/param
INT4   4 bits  =  0.5 bytes/param
```

What do we lose as we shrink? Just decimal places. Storing the number 0.3927 at each precision:

```
FP32  0.3925790   4 bytes
FP16  0.39258     2 bytes
INT8  0.393       1 byte
INT4  0.40        0.5 byte
```

The model still "knows" roughly the same things — it just remembers them a little more coarsely. This is the entire intuition behind [quantization](/blog/llm-compressor-quantization): the W4A16 scheme we build there is exactly the INT4 row of this table.

## Model size: one multiplication

Model memory is one multiplication: **parameters × bytes per parameter**.

```
7,000,000,000 params  x  2 bytes (FP16)  =  14,000,000,000 bytes  =  14 GB
```

The whole size table follows instantly:

```
7B WEIGHTS
FP32  ####################################  28 GB
FP16  ##################  14 GB
INT8  #########  7 GB
INT4  ####  3.5 GB

70B WEIGHTS
FP32  ####################################  280 GB
FP16  ##################  140 GB
INT8  #########  70 GB
INT4  ####  35 GB
```

70B is 10x the 7B at every precision — no surprises, it is just multiplication.

**Note:** this is weights only. The [KV cache](/blog/kv-cache) sits on top of the weights and grows with every token and every concurrent user — plan for it. A rough serving rule: leave at least 20 to 30 percent of GPU memory above the weights, more if you want large batches.

## The GPU lineup: T4, A10, A100, H100, and friends

Now the hardware side. Two numbers define a GPU for LLM work: **how much memory it has** (decides what fits) and **how fast that memory is** (decides how fast decode streams — more on this in a moment). Price closes the loop.

| GPU | Memory | Memory bandwidth | Cloud $/hr (on-demand) | Think of it as |
| --- | --- | --- | --- | --- |
| T4 | 16 GB | ~0.3 TB/s | $0.35–0.60 | The budget workhorse: small models, INT4/INT8 |
| L4 | 24 GB | ~0.3 TB/s | $0.70–1.00 | T4's successor: same speed class, more room |
| A10 | 24 GB | ~0.6 TB/s | $0.75–1.20 | Mid-tier: 7B at FP16 comfortably |
| RTX 4090 | 24 GB | ~1.0 TB/s | $0.30–0.70 (rented) | Consumer card, surprisingly fast memory |
| A100 40GB | 40 GB | ~1.6 TB/s | $1.00–3.00 | The serious tier begins |
| A100 80GB | 80 GB | ~2.0 TB/s | $1.00–3.00 | The workhorse of 2023–2025 |
| H100 | 80 GB | ~3.4 TB/s | $2.00–4.00 | Same memory as A100 80GB, ~1.7x faster at it |
| H200 | 141 GB | ~4.8 TB/s | $4.00–8.00 | H100 with nearly double the memory |
| Apple M-series Max | up to 128 GB | ~0.4–0.5 TB/s | your laptop | Huge memory, modest bandwidth — fits big, streams slow |

Two observations worth pausing on:

- **H100 vs A100 80GB is not about capacity.** Both hold 80 GB. The H100 costs more because its memory is ~1.7x faster — and since [decode is memory-bandwidth-bound](/blog/prefill-vs-decode), that translates almost directly into ~1.7x faster token streaming.
- **T4 and A10 are not toys.** A T4 at ~$0.40/hr holding a 7B INT4 model (3.5 GB) is a perfectly good serving box for modest traffic. This is exactly why we built the W4A16 model in the [LLM Compressor blog](/blog/llm-compressor-quantization) — 4-bit weights are what turn cheap GPUs into viable servers.

## What fits where

Combine the size table with the memory column and placement becomes mechanical:

```
WHAT FITS WHERE  (weights only)

 3.5 GB  INT4 7B    ->  fits  16 GB T4        (12 GB left for KV cache)
  7 GB   INT8 7B    ->  fits  16 GB T4        (tighter)
 14 GB   FP16 7B    ->  fits  24 GB A10/4090  (10 GB left for KV cache)
 35 GB   INT4 70B   ->  fits  40 GB A100
 70 GB   INT8 70B   ->  fits  80 GB A100/H100
140 GB   FP16 70B   ->  needs 2x 80 GB GPUs
```

Simple example, start to finish: can we serve Llama-70B on one H100? FP16: 70B × 2 bytes = 140 GB — no. INT8: 70B × 1 byte = 70 GB — yes, with 10 GB left for KV cache. That 10 GB of cache at (say) 160 KB per token is roughly 60,000 tokens of context across all users — a handful of long conversations at once. One multiplication told us the deployment shape before renting anything.

## Memory bandwidth: the number that sets your decode speed

Here is the most useful trick in this whole blog.

Recall from [Prefill vs Decode](/blog/prefill-vs-decode): every decode step must stream the entire model out of GPU memory to produce one token. That gives us a speed limit with no benchmark needed:

```
max single-stream decode speed  ≈  memory bandwidth / model size in bytes
```

Take a 7B model in FP16 (14 GB) and run the division on each GPU:

```
DECODE SPEED LIMIT  (7B FP16, 14 GB, single stream)

T4     0.3 TB/s / 14 GB   ->  ~21 tok/s    (reading speed x4)
A10    0.6 TB/s / 14 GB   ->  ~43 tok/s
4090   1.0 TB/s / 14 GB   ->  ~71 tok/s
A100   2.0 TB/s / 14 GB   ->  ~140 tok/s
H100   3.4 TB/s / 14 GB   ->  ~240 tok/s
```

Real numbers land somewhat below these ceilings (there is overhead), but the ratios hold. This one division explains so much:

- Why the H100 streams ~5x faster than a T4 for the same model: 3.4 / 0.3 ≈ 11x the bandwidth, throttled by overheads.
- Why [quantization](/blog/llm-compressor-quantization) speeds up decode: INT4 shrinks 14 GB to 3.5 GB, so the same bandwidth moves 4x fewer bytes — the T4's ceiling jumps from ~21 to ~85 tok/s.
- Why a MacBook fits a 70B but streams it slowly: 128 GB of memory, but only ~0.4 TB/s to read it with — 70 GB INT8 caps at ~6 tok/s, barely above human reading speed.

## Throughput and latency anchors

A few anchors to calibrate expectations.

```
NETWORK ROUND-TRIP (RTT)
same region     1-5 ms
transatlantic   ~80 ms
US-Australia    200+ ms
```

```
SERVING
TTFT hosted API              200-500 ms
reasoning model, 1st token   ~1 s or more
```

```
TOKENS / SEC
human reading         #  4-6 tok/s
single-stream 7B      ###########  50-150 tok/s      (good GPU)
batched H100 2023-24  ####################  1,000-3,000 tok/s
batched H100 2026     #########################  5,000-15,000 tok/s  (vLLM / SGLang / FP8)
```

The jump from single-stream to batched is the big one: **batching multiplies total throughput by ~100x.** This works because decode leaves the GPU's math units mostly idle ([the memory-bound story](/blog/prefill-vs-decode)) — [continuous batching](/blog/continuous-batching) fills that idle capacity with other users' tokens. It is why per-token prices keep falling and why one GPU can serve a whole product.

And the number the user actually feels:

```
perceived speed = TTFT + (output tokens / decode rate)
```

That formula is unpacked fully in the [metrics blog](/blog/llm-inference-metrics).

## Cost per million tokens, with worked examples

Hosted APIs price per million tokens, input and output separately. The pattern to remember: **output costs ~5x input at every tier** (mid-2026 Claude lineup for concreteness):

```
$/MILLION TOKENS
Haiku 4.5 (small)     in  $1    out  $5
Sonnet 4.6 (mid)      in  $3    out  $15
Opus 4.8 (large)      in  $5    out  $25
Fable 5 (frontier)    in  $10   out  $50
```

Now the self-hosted side, worked from our own numbers.

**Worked example 1 — a 7B on one H100:**

```
5,000 tok/s  x  3,600 s/hr  =  18 M tok/hr
$3/hr  /  18 M tok/hr       =  ~$0.17 per million output tokens
```

5,000 tok/s is a realistic batched rate for a 7B on an H100 in 2026. ~$0.17/M undercuts hosted output ($5–50/M) by 30–300x — but that is a 7B, not a frontier model. The real trade is model quality, plus ops effort and idle-GPU risk.

**Worked example 2 — a 70B on one H100, the sweet spot:**

```
~500 tok/s  x  3,600 s/hr  =  1.8 M tok/hr
$3/hr  /  1.8 M tok/hr     =  ~$1.7 per million output tokens
```

The 70B (INT8) fits one 80 GB H100; ~10x the weights of a 7B means ~10x fewer tokens per second through the same bandwidth, so ~10x the cost per token. Still ~$1.7/M against hosted $5–50/M, with far stronger quality than a 7B — the practical self-host sweet spot.

**Worked example 3 — the break-even instinct.** APIs bill per call; a rented GPU bills per hour whether busy or idle. So there is always a crossover load: below some requests/hour the API is cheaper, above it self-hosting wins, and the win grows with traffic because the GPU cost is flat. In our own production experiment, one A100 running a 30B model cleared ~2,880 requests/hour — about 11x past its break-even against the API it replaced. The instinct to keep: **self-hosting is a bet that you can keep the GPU busy.** Techniques like [prefix caching](/blog/prefix-caching) and [continuous batching](/blog/continuous-batching) exist precisely to win that bet.

## Conclusion

Ten minutes of arithmetic replaces a week of guessing:

- **1 token ≈ 4 chars ≈ 0.75 words** — the ruler for everything.
- **Model GB = params × bytes/param** — FP16 is 2, INT8 is 1, INT4 is 0.5.
- **A GPU is memory (what fits) + bandwidth (how fast it streams) + $/hr** — T4 16 GB budget tier, A10 24 GB mid, A100/H100 80 GB serious, H200 141 GB headroom.
- **Decode ceiling ≈ bandwidth / model bytes** — the single most useful division in serving.
- **Batching ≈ 100x throughput; output ≈ 5x input cost; self-host ≈ $0.17–1.7/M for 7B–70B** — versus $5–50/M hosted.

These numbers are the "why" behind the entire [inference optimization series](/topic/llm-inference): quantization shrinks the bytes, [PagedAttention](/blog/paged-attention) protects the memory, [continuous batching](/blog/continuous-batching) fills the idle math units, and the [vLLM guide](/blog/serving-llms-with-vllm) shows the whole stack running.

That's it for now.
