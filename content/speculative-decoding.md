---
title: "Speculative Decoding in LLMs"
slug: "speculative-decoding"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "3 min read"
words: 670
summary: "In this blog, we will learn about speculative decoding, where a small draft model guesses several tokens ahead and the big model verifies them all in one pass. It speeds up decode 2 to 3 times without changing output quality, and it works precisely because decode is memory-bound."
---

# Speculative Decoding in LLMs

In this blog, we will learn about **speculative decoding**, one of the cleverest tricks in LLM inference. It attacks [TPOT](/blog/llm-inference-metrics) — the speed at which tokens stream — and it works precisely because [decode is memory-bound](/blog/prefill-vs-decode).

We will cover the following:

- The idea: guess cheap, verify in bulk
- Why verification is almost free
- Seeing one round in a diagram
- The analogy
- Does quality suffer? No, and here is why
- Speculative decoding in practice
- Conclusion

Let's get started.

## The idea: guess cheap, verify in bulk

Recall that decode emits one token per step, and each step must stream the entire model out of GPU memory. That sequential, memory-hauling loop is the bottleneck.

**Speculative decoding employs a small, fast model, called the draft model, to cheaply guess the next several tokens. The big model, called the target model, then checks all those guesses in one single parallel pass.** Correct guesses are kept. The first wrong guess, along with everything after it, gets discarded and corrected by the big model.

## Why verification is almost free

Why does this pay off? Since [decode is memory-bound](/blog/prefill-vs-decode), the big model's weights have to be pulled from memory regardless. Verifying 5 guessed tokens at once moves nearly the same amount of data as generating 1 token. Every correct guess is therefore almost free. A slow one-at-a-time process turns into a faster parallel one.

## Seeing one round in a diagram

```
Draft model (small, fast) proposes 5 tokens in one cheap pass:
        g1   g2   g3   g4   g5

Target model (big) verifies ALL of them in ONE parallel pass:
        ok   ok   ok   X    -
                       ^
                       first wrong guess: corrected by the big model,
                       g5 is thrown away

Result: 3 guesses accepted + 1 fix, for about the cost of 1 normal step
```

We can see the big model accepting the correct guesses and fixing the first wrong one within a single pass, yielding several tokens for roughly the price of one.

## The analogy

A quick junior assistant guesses the next few words of the boss's sentence, and the boss scans the entire guess at a glance, either nodding along at the correct portion or correcting the first slip. Checking a guess takes far less effort than composing from scratch.

## Does quality suffer? No, and here is why

**Very important:** Speculative decoding is built to preserve the model's output quality; only the speed changes. When the model always picks the single most likely token, the output is token-for-token identical to what the big model would have generated alone. When the model samples with some randomness, the output is drawn from exactly the same probability distribution the big model uses, so quality holds even though the precise wording may vary between runs.

Typical decode speedups land around 2 to 3 times, depending on how often the small model's guesses get accepted.

## Speculative decoding in practice

The draft "model" doesn't even have to be a neural network. vLLM ships an **ngram** method that guesses upcoming tokens by looking for repeats of the recent text in the prompt itself — no draft model to load at all:

```bash
vllm serve Qwen/Qwen3-30B-A3B-Instruct-2507-FP8 \
  --speculative-config '{"method":"ngram","num_speculative_tokens":4,"prompt_lookup_max":3}'
```

This shines on structured output. In our production experiment, the model emitted JSON that repeats the same field names (`"CategoryType"`, `"NextSteps"`, ...) constantly — exactly the repetition ngram lookup predicts well, so decode sped up for free. Trained draft approaches (like EAGLE) push the speedup further at the cost of a per-model drafter.

## Conclusion

Speculative decoding turns decode's weakness — hauling the whole model from memory for one measly token — into an opportunity: haul it once, verify five guesses. A draft model (or a simple ngram lookup) proposes, the target model verifies in one pass, and the answer streams 2 to 3 times faster with identical quality. It composes freely with [continuous batching](/blog/continuous-batching) and [PagedAttention](/blog/paged-attention); see the [series hub](/topic/llm-inference) for the whole toolbox.

That's it for now.
