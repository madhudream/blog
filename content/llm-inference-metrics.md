---
title: "LLM Inference Metrics: TTFT, TPOT, Throughput, and Latency"
slug: "llm-inference-metrics"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "5 min read"
words: 910
summary: "In this blog, we will learn the four metrics that define LLM serving performance: TTFT, TPOT, throughput, and end-to-end latency. We will see which phase of inference owns each metric, work through a real latency calculation, and understand the core trade-off between latency and throughput."
---

# LLM Inference Metrics: TTFT, TPOT, Throughput, and Latency

To optimize anything, we first have to measure it. In this blog, we will learn the handful of key metrics that define LLM inference performance, and see how each one maps neatly onto one of the two phases of inference, [prefill and decode](/blog/prefill-vs-decode).

We will cover the following:

- TTFT: Time To First Token
- TPOT: Time Per Output Token
- Throughput
- End-to-end latency, with a worked example
- The latency vs throughput trade-off
- Which metric belongs to which phase
- Conclusion

Let's get started.

## TTFT: Time To First Token

**TTFT (Time To First Token)** is the time between sending your request and the very first output token showing up. It is driven mainly by [prefill](/blog/prefill-vs-decode), since prefill must complete before the first token can exist. Roughly speaking, TTFT equals the prefill time plus one decode step. Longer prompts therefore mean a larger TTFT. In plain terms, TTFT is how quickly the answer begins to appear.

## TPOT: Time Per Output Token

**TPOT (Time Per Output Token)** is the average time taken to produce each token after the first. It also goes by **ITL (Inter-Token Latency)**, meaning the gap between two consecutive tokens. TPOT is governed by decode, since decode is what emits these tokens one at a time. In plain terms, TPOT is the typing speed of the answer once it has begun.

For intuition, a TPOT of 50 milliseconds equals 20 tokens per second, and a TPOT of 25 milliseconds equals 40 tokens per second. Cutting TPOT in half therefore doubles the streaming speed every user experiences.

**Note:** For a single request, TPOT and ITL can be treated as the same idea, namely the per-token gap. Across many requests they are measured a little differently, but conceptually they mean the same thing.

## Throughput

**Throughput** is the total count of tokens generated per second across all users being served simultaneously. It is a system-wide metric rather than a per-user one. In plain terms, throughput reflects how many users the server can handle at once.

Batching, which means pushing many requests through the GPU together, boosts throughput. The group of requests run together is called a **batch**, and how many requests it contains is the **batch size**. [Continuous batching](/blog/continuous-batching) is the modern way serving engines keep the batch full.

## End-to-end latency, with a worked example

**End-to-end latency** is the full stretch of time from sending the request to receiving the final token. A simple formula gives us the intuition:

```
End-to-end latency = TTFT + (number of output tokens - 1) x TPOT
```

The first token is already accounted for inside TTFT, which is why the formula uses the number of output tokens minus one. First the prompt gets processed (TTFT), then every remaining output token contributes one TPOT.

Let's run a quick worked example. Suppose TTFT is 400 milliseconds, the answer runs 200 tokens, and TPOT is 25 milliseconds per token. Of those 200 tokens, the first is already covered by TTFT, leaving 199 tokens at 25 milliseconds apiece. The end-to-end latency then comes to roughly 400 milliseconds plus 199 times 25 milliseconds, or about 5.4 seconds.

Let's put this timeline in a picture.

```
request
  sent
    |
    v
    |<------ TTFT ----->|  TPOT  |  TPOT  |  TPOT  |  ...  |  TPOT  |
    | prefill + token 1 | token 2| token 3| token 4|  ...  | token N|

End-to-end latency  =  TTFT  +  (N - 1) x TPOT
```

We can see that TTFT spans everything up to the first token, after which each subsequent token lands one TPOT apart. The answer starts after TTFT and then streams at the pace set by TPOT.

## The latency vs throughput trade-off

There is one core trade-off to grasp. TTFT and TPOT are per-user latencies, where smaller is better. Throughput is a system metric, where bigger is better. The two pull in opposite directions. Larger batches push more tokens per second through the GPU (higher throughput) but force every user to wait longer (worse TTFT and TPOT). Smaller batches feel more responsive but leave GPU capacity on the table.

The batch size gets tuned to the use case. A chatbot cares about low TTFT and low TPOT, while a bulk document-summarization job cares about high throughput.

## Which metric belongs to which phase

| Metric | Owned by | In plain terms |
| --- | --- | --- |
| TTFT | Prefill | How fast the answer starts |
| TPOT / ITL | Decode | How fast the answer streams |
| Throughput | Decode (mostly) | How many users we serve at once |
| End-to-end latency | Both | Total wait for the full answer |

So whenever we optimize, the first question is always which metric we are trying to move. Prefill owns TTFT, so [prefix caching](/blog/prefix-caching) attacks it. Decode owns TPOT, so [speculative decoding](/blog/speculative-decoding) attacks it. Throughput belongs to [continuous batching](/blog/continuous-batching) and [PagedAttention](/blog/paged-attention).

## Conclusion

Four numbers describe an LLM deployment: TTFT (how fast it starts), TPOT (how fast it streams), throughput (how many users it serves), and end-to-end latency (the total wait). Measuring them on a real server is a solved problem — the [vLLM practical guide](/blog/serving-llms-with-vllm) shows GuideLLM producing exactly these metrics, with p95 and p99 tails, against a live endpoint. The techniques that move each metric are collected in the [series hub](/topic/llm-inference).

That's it for now.
