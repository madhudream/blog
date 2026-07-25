---
title: "Continuous Batching in LLM Serving"
slug: "continuous-batching"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "3 min read"
words: 646
summary: "In this blog, we will learn about continuous batching, the scheduling technique that keeps a GPU fully busy by refilling a finished request's slot at every decode step, instead of waiting for the whole batch to finish."
---

# Continuous Batching in LLM Serving

In this blog, we will learn about **continuous batching**, the technique that decides how a serving engine groups many users' requests on one GPU. It is the main lever for [throughput](/blog/llm-inference-metrics), and it works precisely because [decode barely uses the GPU's math units](/blog/prefill-vs-decode).

We will cover the following:

- Why batching exists at all
- The old approach: static batching, and its flaw
- Continuous batching
- Seeing it in a diagram
- Continuous batching in practice
- Conclusion

Let's get started.

## Why batching exists at all

Recall from [Prefill vs Decode](/blog/prefill-vs-decode) that decode is memory-bandwidth-bound: a single request's decode step leaves the GPU's math units 60 to 80 percent idle. Since one decode step barely touches the GPU's math capacity, many users' decode steps can run together at almost no extra cost. Running requests together in a group is called **batching**, and the group is a **batch**.

So batching is how we turn one user's wasteful decode into many users sharing the same hardware. The question is how to manage the batch, and that is where the old approach goes wrong.

## The old approach: static batching, and its flaw

Under the old approach, called **static batching**, the server bundles several requests into a group and then waits for the slowest member of the group to finish before the next group can begin. The flaw is that short requests wrap up early and their slots sit empty, squandering the GPU. Let's see how the modern approach fixes this.

## Continuous batching

**Continuous batching revisits the batching decision at every single decode step rather than once per group.** The instant one request completes, its slot opens up, and a waiting request slides into the batch on the very next step. The batch stays full, and the GPU stays busy.

## Seeing it in a diagram

```
STATIC BATCHING  (finished slots sit empty -> GPU wasted)
  slot 1: R1=====                  (idle, wasted) .........
  slot 2: R2==========================
  slot 3: R3==========       (idle, wasted) ...............
          |------- whole batch waits for the slowest -------|

CONTINUOUS BATCHING  (a finished slot is refilled at once -> GPU busy)
  slot 1: R1=====R4====================
  slot 2: R2==========================
  slot 3: R3==========R5================
          (R4 enters the moment R1 ends, R5 enters when R3 ends)
```

We can see that static batching leaves slots empty whenever short requests finish ahead of the rest, while continuous batching refills those slots immediately.

Here is a simple analogy. Think of a shared taxi that, the instant one passenger steps out, immediately picks up the next person waiting at the curb, rather than driving around with empty seats until every trip is over. The taxi never rides with vacant seats.

Compared to the old static approach, continuous batching typically delivers a large leap in throughput.

## Continuous batching in practice

Continuous batching is on by default in modern serving engines like vLLM — no flag needed. It also pairs perfectly with [PagedAttention](/blog/paged-attention): when a request finishes, PagedAttention frees its KV cache blocks instantly, and continuous batching immediately hands that freed memory and slot to a waiting request.

You can catch it in the act. vLLM exposes a `num_requests_running` metric; fire five concurrent requests and scrape it mid-flight, and you will see the live batch size above one while all five finish in far less time than five sequential calls. The [vLLM practical guide](/blog/serving-llms-with-vllm) has the exact code.

One caveat: a very long prompt's [prefill](/blog/prefill-vs-decode) can still stall everyone in the batch, which is the problem [chunked prefill](/blog/chunked-prefill) solves.

## Conclusion

Continuous batching swaps the batch membership at every decode step: finished requests leave, waiting requests join, and no GPU slot ever idles waiting for someone else's long answer. It is the main throughput lever in the [optimization series](/topic/llm-inference), and together with [PagedAttention](/blog/paged-attention) it keeps both the GPU compute and the GPU memory fully used.

That's it for now.
