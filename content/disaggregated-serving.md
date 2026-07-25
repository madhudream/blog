---
title: "Disaggregated Serving: Splitting Prefill and Decode Across GPUs"
slug: "disaggregated-serving"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "3 min read"
words: 610
summary: "In this blog, we will learn about disaggregated serving, also called prefill-decode separation: running prefill on one pool of GPUs and decode on another, so each phase can be tuned around its own bottleneck and hit its own latency target."
---

# Disaggregated Serving: Splitting Prefill and Decode Across GPUs

In this blog, we will learn about **disaggregated serving**, also called **prefill-decode separation** — the technique that takes the [two-phase split of inference](/blog/prefill-vs-decode) to its logical conclusion: if the phases have opposite bottlenecks, why run them on the same hardware at all?

We will cover the following:

- The problem: two workloads fighting over one GPU
- Disaggregated serving
- Seeing the two pools in a diagram
- The analogy
- The costs, and when it earns its keep
- Conclusion

Let's get started.

## The problem: two workloads fighting over one GPU

We know from [Prefill vs Decode](/blog/prefill-vs-decode) that prefill is compute-bound while decode is memory-bandwidth-bound. When a single GPU handles both, a burst of heavy prefill stalls the in-flight decodes of other users ([chunked prefill](/blog/chunked-prefill) softens this, but the phases still share the hardware), and there is no way to tune each phase on its own. A strict [TTFT](/blog/llm-inference-metrics) target and a strict TPOT target end up pulling the same GPU in two directions.

## Disaggregated serving

**Disaggregated serving assigns prefill to one pool of GPUs and decode to a different pool.** A pool is simply a group of GPUs working as a unit. The [KV cache](/blog/kv-cache) built by the prefill GPU travels over a fast link to the decode GPU. Each pool is then configured around its own bottleneck, and each can hit its own latency target independently — scale the prefill pool when TTFT slips, scale the decode pool when TPOT slips.

## Seeing the two pools in a diagram

```
           PREFILL POOL                             DECODE POOL
   +-------------------------+              +-------------------------+
   | GPUs tuned for heavy    |              | GPUs tuned for fast     |
   | math (compute-bound)    |   KV cache   | memory (memory-bound)   |
   |                         |  ========>   |                         |
   | reads prompt, writes    |  fast link   | reads cache, streams    |
   | the KV cache, makes     |              | the answer token by     |
   | the first token         |              | token                   |
   +-------------------------+              +-------------------------+
```

We can see the prefill pool building the KV cache and handing it across a fast link to the decode pool, with each pool tuned around its own bottleneck.

## The analogy

Think of a restaurant that places its heavy prep kitchen in one room and its steady plating-and-serving line in another. Each room is staffed and outfitted for its own kind of work, and the prepped food (the KV cache) moves between them, so neither side drags the other down.

## The costs, and when it earns its keep

**Note:** Disaggregation does not come for free. It introduces the cost of shipping the KV cache over the network — and as the [KV cache blog](/blog/kv-cache) showed, that cache can be hundreds of megabytes per request — and the model weights must be duplicated across both pools.

It earns its keep mainly at large scale, when strict TTFT and TPOT targets must be met simultaneously. For smaller deployments, [continuous batching](/blog/continuous-batching) plus [chunked prefill](/blog/chunked-prefill) on a single GPU is often sufficient — that is exactly the setup the [vLLM practical guide](/blog/serving-llms-with-vllm) runs, and it was enough for our own single-GPU production experiment. Both vLLM and SGLang support disaggregated serving when the scale demands it.

## Conclusion

Disaggregated serving is the two-phase split made physical: a compute-tuned pool prefills and writes the KV cache, a memory-tuned pool decodes and streams, and a fast link carries the cache between them. It buys independent control of TTFT and TPOT at the price of network transfer and duplicated weights, so it is a large-scale tool rather than a default. The rest of the toolbox lives in the [series hub](/topic/llm-inference).

That's it for now.
