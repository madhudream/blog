---
title: "LLM Inference Optimization: The Series"
slug: "llm-inference-optimization-hub"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "4 min read"
words: 736
summary: "The hub for our LLM inference optimization series. Start with Prefill vs Decode, then follow the KV cache, the metrics, and the six techniques that make each phase fast — ending with hands-on guides to vLLM and LLM Compressor."
---

# LLM Inference Optimization: The Series

Every LLM answers in two phases — prefill reads your prompt, decode writes the answer — and nearly every optimization in production serving targets one of the two. This hub collects the whole series in reading order. Each blog stands alone, but they cross-reference each other, so you can also jump straight to what you need.

> **Browse the full series:** every post below — plus newer additions like SGLang, the from-scratch PyTorch builds, and the numbers reference — lives in the searchable [LLM Inference topic grid](/topic/llm-inference).

## The foundations

### Prefill vs Decode

The foundation for everything else. Prefill processes the whole prompt in one parallel, compute-bound pass and emits the first token; decode then emits the rest one at a time, memory-bandwidth-bound. This single split explains why long prompts delay the first word and why serving many users at once is nearly free.

**Read here:** [Prefill vs Decode](/blog/prefill-vs-decode)

### The KV Cache

The bridge between the phases. Prefill writes the Keys and Values of every prompt token; decode reads them and appends one entry per generated token. Without it, generation would slow to a crawl; with it, the cache becomes the biggest consumer of GPU memory — the problem half the series exists to manage.

**Read here:** [The KV Cache](/blog/kv-cache)

### LLM Inference Metrics

The numbers we optimize: TTFT (how fast the answer starts, owned by prefill), TPOT (how fast it streams, owned by decode), throughput (how many users we serve), and end-to-end latency — plus the core trade-off between latency and throughput.

**Read here:** [LLM Inference Metrics](/blog/llm-inference-metrics)

## The techniques

### Continuous Batching

Revisit the batch at every decode step: the moment a request finishes, a waiting one takes its slot. The main throughput lever, on by default in modern engines.

**Read here:** [Continuous Batching](/blog/continuous-batching)

### Chunked Prefill

Slice a long prompt's prefill into chunks and interleave everyone else's decode steps between them, so one giant prompt can't freeze other users' streaming answers.

**Read here:** [Chunked Prefill](/blog/chunked-prefill)

### Prefix Caching

Compute the KV cache for a shared prompt beginning (system prompt, document, chat history) once, and reuse it across every request that starts the same way. The biggest TTFT win in real applications.

**Read here:** [Prefix Caching](/blog/prefix-caching)

### PagedAttention

Store the KV cache in small fixed-size blocks handed out on demand, instead of one big reserved chunk per request. Eliminates memory waste, enables block sharing, and is the foundation of vLLM.

**Read here:** [PagedAttention](/blog/paged-attention)

### Speculative Decoding

A small draft model guesses several tokens; the big model verifies them all in one pass. Because decode is memory-bound, verification is nearly free — 2 to 3 times faster streaming with identical output quality.

**Read here:** [Speculative Decoding](/blog/speculative-decoding)

### Disaggregated Serving

Run prefill on one pool of GPUs and decode on another, shipping the KV cache between them, so each phase hits its own latency target. A large-scale tool.

**Read here:** [Disaggregated Serving](/blog/disaggregated-serving)

## The hands-on guides

### Serving LLMs with vLLM

Everything above, running. Launch a vLLM server, query it with the OpenAI client, watch continuous batching and prefix caching through live Prometheus metrics, compute KV cache sizes by hand, and benchmark the deployment with GuideLLM and lm_eval.

**Read here:** [Serving LLMs with vLLM](/blog/serving-llms-with-vllm)

### Quantizing a Model with LLM Compressor

Shrink the weights themselves. Apply a GPTQ W4A16 recipe with one `oneshot` call, measure the size win and the perplexity cost, and serve the result directly with vLLM. Includes when to prefer ready-made FP8 checkpoints instead.

**Read here:** [Quantizing a Model with LLM Compressor](/blog/llm-compressor-quantization)

## A quick map of which technique helps which phase

| Technique | Main target | What it improves |
| --- | --- | --- |
| KV cache | Decode | Makes decode fast by avoiding recomputation |
| Continuous batching | Both phases | Throughput (more users served together) |
| Chunked prefill | Serving smoothness | Prevents long prefills from stalling others' streaming |
| Prefix caching | Prefill | TTFT (skips redundant prompt processing) |
| PagedAttention | KV cache memory | Throughput (bigger batches, less waste) |
| Speculative decoding | Decode | TPOT (faster token generation) |
| Disaggregated serving | Both phases | TTFT and TPOT independently, at scale |
| Quantization (LLM Compressor) | Weights and decode | Smaller memory footprint, faster memory-bound decode |

Keep this table as a handy mental map. When the goal is a faster first word, look to the prefill side. When the goal is faster streaming or more simultaneous users, look to the decode side.

That's it for now.
