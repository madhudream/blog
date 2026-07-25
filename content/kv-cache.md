---
title: "The KV Cache: The Bridge Between Prefill and Decode"
slug: "kv-cache"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "6 min read"
words: 1230
summary: "In this blog, we will understand the KV cache, the store of Keys and Values that lets an LLM generate each token without recomputing its entire past. We will see what Query, Key, and Value actually mean, walk through the cache growing step by step, and see why this one idea makes decode fast."
---

# The KV Cache: The Bridge Between Prefill and Decode

In this blog, we will understand the **KV cache**, the single most important data structure in LLM inference. It is the bridge linking the two phases of inference, [prefill and decode](/blog/prefill-vs-decode), so it deserves a proper understanding.

We will cover the following:

- The problem the KV cache solves
- Query, Key, and Value through a database story
- What the cache stores (and what it never stores)
- A step-by-step walkthrough of the cache growing
- Why the cache is no minor tweak
- The catch: the cache never stops growing
- Conclusion

Let's get started.

## The problem the KV cache solves

Quick recap of where we are. During [prefill](/blog/prefill-vs-decode), the model reads the whole prompt in one pass. During decode, it generates the answer one token at a time, and each new token must look back over every token that came before.

To do this looking back, for every token, the model computes three things: a **Query (Q)**, a **Key (K)**, and a **Value (V)**.

These three names are not random. They come straight from database terminology, and a small database story makes them click.

## Query, Key, and Value through a database story

Imagine a hotel whose front-desk database pairs each guest's last name with their room number. A guest walks up and gives their last name, "Sharma", but the clerk accidentally types "Sharna" into the computer. The computer now has to work out which stored name is closest to what was typed. In database terms, the text the clerk typed in, the search term, is the **query**. The actual names stored in the database, the ones being searched against, are the **keys**. The computer compares the query against every key and ranks each one by similarity. Here, the query "Sharna" lands closest to the key "Sharma", so the database returns that guest's room number, 537. The thing the database hands back as the result, the room number, is the **value**.

To summarize the database picture: the query is what we search with, the keys are what we search against, and the values are what the search returns.

Attention works the same way, with one twist. The new token being generated plays the role of the clerk's search term: its Query gets compared against the Keys of all the earlier tokens, and each comparison produces a similarity score, exactly like the computer ranking every stored name. The twist is that the model does not pick just the single best match the way the hotel database does. Instead, it uses the similarity scores as weights and blends the Values of all the past tokens, leaning most heavily on the closest matches, to decide what comes next. So every past token contributes its "room number", and the strongest matches contribute the most.

## What the cache stores (and what it never stores)

Now the key observation. Once computed, a past token's Key and Value never change. They are unaffected by any tokens that follow. So rather than recomputing them at every single step, we can compute them once and keep them stored. That store of Keys and Values is the KV cache.

**The KV cache holds only the Keys and Values of past tokens. Queries are never stored.** The Query is recomputed fresh for the current token at each step, so storing it would serve no purpose.

## A step-by-step walkthrough of the cache growing

Let's see why this matters so much through a small numeric walkthrough. For the purpose of understanding, treat one cache entry as one token's stored Key and Value.

Say prefill has just finished processing a 3-token prompt, so the KV cache holds 3 entries. Decode now kicks off.

**Step 1:** The model takes the input for the first output token, computes its Key and Value, and consults the 3 cached entries to look back. It emits token 4, then appends token 4's Key and Value to the cache. The cache now holds 4 entries.

**Step 2:** The model takes token 4, computes its Key and Value, and consults the 4 cached entries to look back. It emits token 5, then appends token 5's Key and Value to the cache. The cache now holds 5 entries.

**Step 3:** The model takes token 5, computes its Key and Value, and consults the 5 cached entries to look back. It emits token 6, then appends token 6's Key and Value to the cache. The cache now holds 6 entries.

Let's picture how the cache expands across these steps.

```
After prefill   |P1|P2|P3|           ->  cache has 3 entries
Decode step 1   |P1|P2|P3|T4|        ->  append T4, now 4 entries
Decode step 2   |P1|P2|P3|T4|T5|     ->  append T5, now 5 entries
Decode step 3   |P1|P2|P3|T4|T5|T6|  ->  append T6, now 6 entries
```

In this picture, the boxes P1, P2, and P3 are the prompt tokens that prefill wrote, while T4, T5, and T6 are added by decode, one box per step.

The pattern is easy to spot. Each step computes the Key and Value for only the one new token. Every older Key and Value comes straight from the cache rather than being recomputed. And the cache grows by exactly one entry each step.

## Why the cache is no minor tweak

Without the KV cache, every decode step would rebuild the Keys and Values of all earlier tokens from scratch. Because step N repeats the work for all N previous tokens, the total work across the whole answer grows roughly with the square of its length, which is extremely slow. The KV cache cuts this down so each token's Key and Value gets computed exactly once. That is why the KV cache is no minor tweak. Without it, decode would be dramatically slower.

## The catch: the cache never stops growing

There is a catch, though. The KV cache never stops growing. It begins at the size of the prompt right after prefill, then gains one entry for every token generated. It also scales with the number of users served at once, since every user needs a cache of their own.

How big does it get in practice? For a real model (Qwen3-0.6B: 28 layers, 8 KV heads, head dimension 128, BF16), each token's entry costs 2 x 28 x 8 x 128 x 2 bytes = 112 KB. A single 4,096-token context is therefore ~448 MB, and 10 concurrent users at that context need ~4.4 GB — several times more than the model's own weights. The [vLLM practical guide](/blog/serving-llms-with-vllm) computes this live with a few lines of Python.

In extreme situations, such as very long contexts combined with many concurrent users, the combined KV cache can outgrow the model weights and exhaust the GPU's memory. This ever-growing cache is the motivation behind much of the [optimization series](/topic/llm-inference): [PagedAttention](/blog/paged-attention) stops it wasting memory, [prefix caching](/blog/prefix-caching) reuses it across requests, and [disaggregated serving](/blog/disaggregated-serving) even ships it between GPUs.

## Conclusion

The KV cache is the bridge between the two phases of inference. Prefill writes it; decode reads it and grows it by one entry per token. It stores only Keys and Values (never Queries), it spares the model from recomputing the past at every step, and its relentless growth in GPU memory is the central resource problem that serving engines like [vLLM](/blog/serving-llms-with-vllm) are built to manage.

That's it for now.
