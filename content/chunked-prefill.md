---
title: "Chunked Prefill in LLM Serving"
slug: "chunked-prefill"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "3 min read"
words: 597
summary: "In this blog, we will learn about chunked prefill, the technique that breaks a long prompt's prefill into smaller chunks so it cannot freeze the token streaming of every other user on the same GPU."
---

# Chunked Prefill in LLM Serving

In this blog, we will learn about **chunked prefill**, the technique that protects users' streaming answers from being frozen by someone else's giant prompt. It sits on top of [continuous batching](/blog/continuous-batching), and it exists because [prefill and decode](/blog/prefill-vs-decode) compete for the same GPU.

We will cover the following:

- The problem: one long prefill freezes everyone
- Chunked prefill
- Seeing it in a diagram
- What chunked prefill does not do
- Chunked prefill in practice
- Conclusion

Let's get started.

## The problem: one long prefill freezes everyone

Recall from [Prefill vs Decode](/blog/prefill-vs-decode) that prefill processes the entire prompt in one compute-heavy pass. With [continuous batching](/blog/continuous-batching), many users share the GPU: some are mid-decode, streaming their answers token by token, when a new request arrives with a very long prompt.

The prefill for that very long prompt runs as one giant step. While that giant step is running, it monopolizes the GPU and freezes the token streaming of every other user already in their decode phase. Their answers stutter. Their [inter-token latency](/blog/llm-inference-metrics) spikes.

## Chunked prefill

**Chunked prefill breaks one long prompt's prefill into several smaller chunks rather than one massive step.** Between the chunks, the model slips in small decode steps. That way, no single long prefill holds everyone else hostage. The other users' token streams are protected, so their answers keep flowing without stutter.

As a bonus, blending compute-heavy prefill with memory-heavy decode in one batch makes better use of the hardware — the prefill chunk keeps the math units busy while the decode tokens ride along on the memory bandwidth.

## Seeing it in a diagram

```
WITHOUT chunked prefill:
  long prompt: [============= ONE BIG PREFILL =============]
  other users: tok ....... (frozen, stuttering) ....... tok

WITH chunked prefill:
  long prompt: [chunk 1][chunk 2][chunk 3][chunk 4][chunk 5]
  other users: tok   tok   tok   tok   tok   tok
                  ^ a decode step slips in between the chunks
```

We can see that one giant prefill freezes everyone else, while chunked prefill lets their tokens keep arriving between the chunks.

Here is a simple analogy. Picture a chef with a single stove. When one customer orders a huge banquet, cooking the whole thing in one go leaves every other table's food frozen in place. Instead, the chef prepares the banquet in small rounds, sliding the quick single dishes in between, so no one's plate goes cold.

## What chunked prefill does not do

**Note:** Chunked prefill's main job is keeping ongoing answers from stalling. It does not shrink the total math, so on its own it does not make prefill any faster. The long prompt still pays its full prefill cost — just in installments that don't block anyone else. To actually skip prefill work, you need [prefix caching](/blog/prefix-caching).

## Chunked prefill in practice

In vLLM's modern engine, chunked prefill is always on — the scheduler works with a per-step token budget (tunable via `--max-num-batched-tokens`), and long prompts are automatically split to fit it, with decode tokens mixed into every step. You can observe the effect on a live server by watching inter-token latency stay flat while a long-prompt request lands; the [vLLM practical guide](/blog/serving-llms-with-vllm) shows how to measure it.

## Conclusion

Chunked prefill slices a long prompt's prefill into pieces and interleaves other users' decode steps between them. It protects streaming smoothness (inter-token latency) rather than raw speed, and together with [continuous batching](/blog/continuous-batching) it lets one GPU serve a mix of long and short requests gracefully. The rest of the toolbox lives in the [series hub](/topic/llm-inference).

That's it for now.
