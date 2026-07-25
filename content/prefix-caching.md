---
title: "Prefix Caching (Prompt Caching) in LLMs"
slug: "prefix-caching"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "3 min read"
words: 650
summary: "In this blog, we will learn about prefix caching, also called prompt caching: reusing the KV cache for the shared beginning of many prompts so the same prefill work is never done twice. It is the single biggest TTFT win for real applications."
---

# Prefix Caching (Prompt Caching) in LLMs

In this blog, we will learn about **prefix caching**, also called **prompt caching** — the technique that skips redundant [prefill](/blog/prefill-vs-decode) work when many requests start with the same text. In real applications, this is usually the biggest [TTFT](/blog/llm-inference-metrics) win available.

We will cover the following:

- The observation: prompts share beginnings
- Prefix caching
- The analogy
- When it pays off (and when it doesn't)
- Prefix caching in practice
- Conclusion

Let's get started.

## The observation: prompts share beginnings

Many requests open with the same long beginning. Think of identical fixed system instructions, the same document being questioned, or the same earlier turns of a conversation. This shared opening is called a **prefix**.

Now recall what [prefill](/blog/prefill-vs-decode) does: it processes the prompt and writes the [KV cache](/blog/kv-cache) for every prompt token. And recall a key property of the KV cache: a token's Key and Value depend only on the tokens before it, never after. So two prompts that share the same beginning produce **identical KV cache entries for that beginning**. Computing them twice is pure waste.

## Prefix caching

**Prefix caching reuses the KV cache for that shared prefix across requests.** The prefill for the shared portion is computed a single time and then reused, instead of being redone for every request. Redundant work gets skipped, and TTFT shrinks. Each request only pays prefill for its unique part — typically the short user question at the end.

## The analogy

Imagine a teacher who writes the same lengthy instructions on the board before every class. Rather than rewriting them each time, the teacher keeps a photo of the board and reuses it, spending the saved time only on each student's fresh question.

## When it pays off (and when it doesn't)

In production, this can achieve very high cache hit rates and major cost savings on repeated prompts. A high cache hit rate means most requests found their shared opening already stored and waiting, so that work never had to happen.

The payoff scales with how much of the prompt is shared. A chatbot with a 2,000-token system prompt and a 50-token user question skips ~97 percent of prefill on every cache hit. [Agent](/blog/serving-llms-with-vllm) workloads, which resend the same large instruction block on every step, benefit enormously.

**Note:** Prefix caching pays off only when requests genuinely share a common beginning. With no shared prefix, it simply falls back to a full prefill. And the sharing must be exact and start from the first token — a prompt that differs in its first word shares nothing.

## Prefix caching in practice

In vLLM, prefix caching is on by default and is built on top of [PagedAttention](/blog/paged-attention): because the KV cache lives in fixed-size blocks, two requests with the same prefix can simply point at the same physical blocks. (The SGLang engine takes a different approach, matching shared prefixes with a radix tree.)

You can watch it work. vLLM's `/metrics` endpoint exposes `prefix_cache_queries_total` and hit counters; send five requests with the same system prompt and the counters climb — request 1 pays full prefill, requests 2 through 5 skip the shared portion. The [vLLM practical guide](/blog/serving-llms-with-vllm) has the runnable code.

A real-world data point: in our production experiment, a ~2.4K-token system prompt was identical on every call. With vLLM's prefix caching, prefill for it was effectively free after the first request — a big part of why first-token time was ~92 ms self-hosted versus ~1.5 s on a cloud API.

## Conclusion

Prefix caching computes the KV cache for a shared prompt beginning once and reuses it across all requests that start the same way. It directly attacks TTFT and prefill cost, costs nothing when there is no sharing, and comes free with [PagedAttention](/blog/paged-attention)'s block design. See the [series hub](/topic/llm-inference) for how it fits alongside the other techniques.

That's it for now.
