---
title: "Build RadixAttention from Scratch in PyTorch"
slug: "radix-attention-from-scratch-pytorch"
date: "2026-07-25"
tags: ["llm", "ai", "pytorch", "sglang", "hands-on"]
reading_time: "9 min read"
words: 1829
summary: "In this blog, we will build SGLang's RadixAttention in plain PyTorch: a small cache store, a prefix search, and the four-step pattern — traverse, reuse, compute, store. Then we will run a real RAG workload against it and measure the cache hits ourselves."
---

# Build RadixAttention from Scratch in PyTorch

In this blog, we will build the heart of SGLang — **RadixAttention** — from scratch, in about 60 lines of plain PyTorch. No serving engine, no CUDA kernels: just the [KV cache object we already know how to hold](/blog/kv-cache-from-scratch-pytorch), a data structure to keep it alive between requests, and a search that finds shared beginnings.

This is the hands-on companion to [how SGLang works](/blog/how-does-sglang-work). Read that first if "radix tree" means nothing to you yet; read this to see there is no magic inside.

We will cover the following:

- Where the last blog left us: a cache that dies too young
- The napkin math: what's the best case
- CacheEntry: keeping the cache alive
- A (flat) radix tree in 30 lines
- Generation with a prefix cache
- The four-step pattern: traverse, reuse, compute, store
- Experiment 1: a RAG workload, cold vs warm
- Experiment 2: a mixed workload, two documents interleaved
- What production SGLang adds on top
- Conclusion

Let's get started.

## Where the last blog left us: a cache that dies too young

In the [KV cache from scratch blog](/blog/kv-cache-from-scratch-pytorch), we ended with this decode loop:

```python
out = model(inp, use_cache=True)
past = out.past_key_values      # the KV cache, alive in a variable
```

`past` made generation linear instead of quadratic — **within one request**. But when the function returns, `past` is garbage-collected. The next request, even with an identical 2,000-token document in front of it, prefills everything from scratch.

Now picture production: a RAG app has the same document in front of every question; a chatbot has the same system prompt for every user. Each request independently computes identical KV tensors for those shared tokens — and throws them away. That is the waste RadixAttention eliminates: **index the KV cache by token sequence, keep it after the request ends, and let the next request reuse the longest matching prefix.**

## The napkin math: what's the best case

Before writing code, let's compute the ceiling. If a prompt is `total` tokens and `cached` of them can be reused, prefill only has to compute `total - cached`:

```python
def calculate_speedup(total_tokens, cached_tokens):
    return total_tokens / (total_tokens - cached_tokens)

# RAG example: 450-token document + 50-token question
print(calculate_speedup(500, 450))   # 10.0
```

A 450-token shared document in a 500-token prompt means 90 percent cache hit → **10x less prefill work**. That is the prize. (Prefill only — decode is untouched, as the [metrics blog](/blog/llm-inference-metrics) would predict: prefix caching is a [TTFT](/blog/llm-inference-metrics) optimization.)

## CacheEntry: keeping the cache alive

First, we need to remember *which tokens* a cache belongs to. A cache without its token sequence is unidentifiable. So the atom of our system pairs the two:

```python
class CacheEntry:
    """Pairs a token sequence with its precomputed KV cache."""
    def __init__(self, token_ids, kv_cache):
        self.token_ids = list(token_ids)
        self.kv_cache = kv_cache          # a HF past_key_values object

    def get_seq_length(self, layer_idx=0):
        if self.kv_cache is None:
            return 0
        return self.kv_cache.get_seq_length(layer_idx)
```

That's it. The `kv_cache` field holds exactly the `past` object from the previous blog — we are just refusing to let it die.

## A (flat) radix tree in 30 lines

SGLang stores entries in a radix tree — a tree that merges shared prefixes into shared branches, giving fast lookup. For learning, the tree shape is a distraction; what matters is the *operation*: **given a new request's tokens, find the stored entry with the longest matching prefix.** A flat list with a linear scan does the same job in 30 readable lines:

```python
import copy

class FlatRadixTree:
    """Simplified radix tree for prefix matching and KV reuse.
    Production SGLang uses a real tree with O(log n) lookup;
    this flat version does an O(n) scan for clarity."""

    def __init__(self):
        self.entries = []

    def insert(self, token_ids, kv_cache):
        self.entries.append(CacheEntry(token_ids, kv_cache))

    def search(self, token_ids):
        best_len, best_entry = 0, None
        for entry in self.entries:
            match_len = 0
            for a, b in zip(entry.token_ids, token_ids):
                if a != b:
                    break                     # first mismatch ends the prefix
                match_len += 1
            if match_len > best_len:
                best_len, best_entry = match_len, entry
        if best_entry is None or best_len == 0:
            return None
        # Return a cache trimmed to exactly the matched prefix
        trimmed = copy.deepcopy(best_entry.kv_cache)
        trimmed.crop(best_len)
        return CacheEntry(best_entry.token_ids[:best_len], trimmed)
```

Two details deserve attention:

- **The match must be a prefix.** We compare token by token from position 0 and stop at the first mismatch — because a token's K and V depend on everything before it, a cached entry is only valid up to the point where the sequences are identical. This is the same rule we saw in [prefix caching](/blog/prefix-caching).
- **`crop(best_len)`** trims the stored cache down to the matched length. The stored entry may contain the previous request's *full* sequence — document, question, and generated answer. Only the shared beginning is reusable; the rest belongs to someone else's conversation.

## Generation with a prefix cache

Now the generation function. It is the decode loop from the [previous blog](/blog/kv-cache-from-scratch-pytorch) with one new ability: if a prefix cache is provided, prefill **only the suffix**:

```python
@torch.inference_mode()
def generate_with_prefix_cache(prompt, max_new_tokens=16, prefix_cache=None):
    token_ids = tokenizer.encode(prompt)

    if prefix_cache is not None and prefix_cache.get_seq_length() > 0:
        cached_len = prefix_cache.get_seq_length()
        suffix = token_ids[cached_len:] or [token_ids[-1]]
        inp = torch.tensor([suffix], device=device)
        out = model(inp, past_key_values=prefix_cache.kv_cache,
                    use_cache=True)              # prefill ONLY the new part
    else:
        inp = torch.tensor([token_ids], device=device)
        out = model(inp, use_cache=True)         # cold start: full prefill

    past = out.past_key_values
    next_id = out.logits[:, -1, :].argmax(dim=-1).item()
    token_ids.append(next_id)

    for _ in range(max_new_tokens - 1):          # decode, unchanged
        inp = torch.tensor([[token_ids[-1]]], device=device)
        out = model(inp, past_key_values=past, use_cache=True)
        past = out.past_key_values
        next_id = out.logits[:, -1, :].argmax(dim=-1).item()
        token_ids.append(next_id)

    return tokenizer.decode(token_ids, skip_special_tokens=True), \
           CacheEntry(token_ids, past)
```

The entire trick lives in five lines: slice off the cached prefix, feed the model just the suffix plus the cached `past_key_values`. The model neither knows nor cares that the cache came from a different request — KV tensors are KV tensors. Note the function also **returns** its final `CacheEntry`, so the caller can donate it back to the tree.

## The four-step pattern: traverse, reuse, compute, store

Serving a request is now four steps — this loop *is* RadixAttention:

```python
radix = FlatRadixTree()   # empty — grows as requests arrive

def serve(prompt):
    token_ids = tokenizer.encode(prompt)

    prefix = radix.search(token_ids)              # 1. TRAVERSE: longest match
    answer, entry = generate_with_prefix_cache(   # 2. REUSE cached prefix KV
        prompt, prefix_cache=prefix)              # 3. COMPUTE only the suffix
    radix.insert(entry.token_ids, entry.kv_cache) # 4. STORE for the next one

    return answer
```

Every request both benefits from past requests and contributes to future ones. The cache is a commons.

## Experiment 1: a RAG workload, cold vs warm

Let's measure it on the workload prefix caching was born for. One ~400-token article, six different questions about it:

```python
def construct_prompt(article, question):
    return f"Article:\n{article.strip()}\n\nQuestion: {question}\nAnswer:"

questions = [
    "What are the two phases of LLM inference and how do they differ?",
    "How does continuous batching improve GPU utilization?",
    "What is RadixAttention and how does it reuse KV cache across requests?",
    # ... six in total
]

for i, q in enumerate(questions):
    prompt = construct_prompt(article, q)
    token_ids = tokenizer.encode(prompt)

    prefix = radix.search(token_ids)
    matched = prefix.get_seq_length() if prefix else 0

    tic = time.time()
    answer, entry = generate_with_prefix_cache(prompt, prefix_cache=prefix)
    elapsed = time.time() - tic

    radix.insert(entry.token_ids, entry.kv_cache)
    status = "MISS" if matched == 0 else f"HIT ({matched} tokens)"
    print(f"Q{i+1}: {elapsed:.3f}s  [{status}]")
```

The run tells the whole story:

- **Q1 is a MISS.** The tree is empty; it pays the full prefill for article + question. Its entry seeds the tree.
- **Q2 through Q6 are HITs**, each reusing the entire article portion — around 90 percent of their prompt tokens, matching our napkin math. Only each short question plus a few tokens gets prefilled fresh, and hit requests run several times faster than the cold one.

Run the same six questions with plain `generate()` (no tree) as a baseline, and every request pays the Q1 price — the article is prefilled six times instead of once.

## Experiment 2: a mixed workload, two documents interleaved

Real traffic is not one document. So: two different articles, six questions each, all twelve **shuffled randomly** — and one guard we did not need before:

```python
MIN_PREFIX_MATCH = 20   # both prompts share "Article:\n" (~3 tokens)
                        # — that's not a real cache hit

prefix = radix.search(token_ids)
matched = prefix.get_seq_length() if prefix else 0
effective = prefix if matched >= MIN_PREFIX_MATCH else None
answer, entry = generate_with_prefix_cache(prompt, prefix_cache=effective)
```

This tiny threshold teaches a real production lesson: **every prompt template shares a few boilerplate tokens** ("Article:\n"), and reusing a 3-token prefix costs more in bookkeeping than it saves. Real engines apply the same idea by only caching at block granularity.

The shuffled run shows the tree handling both document families at once: the first request touching each article is a MISS, all ten later requests are HITs on their own article's branch — a stable ~83 percent hit rate that would keep climbing with more traffic (2 cold starts amortized over everything that follows). This is exactly the "family tree of sentences" picture from the [SGLang blog](/blog/how-does-sglang-work), running in our own code: two big branches, one per article, each shared by its questions.

## What production SGLang adds on top

Our 60 lines are honestly missing four things, and naming them is the best way to understand what SGLang engineering actually is:

- **A real radix tree.** Our O(n) scan over full sequences becomes an actual tree walk, and shared branches are stored once instead of duplicated per entry (our flat list stores each request's full sequence — fine for 12 requests, fatal for 12,000).
- **Eviction.** GPU memory is finite and our tree only grows. SGLang evicts **least-recently-used branches** first, so hot prefixes (the system prompt everyone shares) stay pinned while one-off tails get dropped.
- **No `deepcopy`.** Our `search` deep-copies tensors to keep the code obvious. Production shares the underlying KV blocks by reference — the same block-sharing idea as [PagedAttention](/blog/paged-attention), with a tree instead of hash-matched blocks.
- **Concurrency.** Ours serves one request at a time. Production interleaves everything through [continuous batching](/blog/continuous-batching), with cache-aware routing sending each request to the worker that already holds its prefix.

None of these change the core loop. Traverse, reuse, compute, store — that is still the whole algorithm.

## Conclusion

RadixAttention, built by hand: a `CacheEntry` that pairs tokens with their KV cache, a 30-line prefix search, and a generate function that prefills only the suffix past the longest cached match. On a RAG workload it turned six full prefills into one cold start plus five ~90-percent hits, exactly as the napkin math promised — and the mixed-workload run showed the tree naturally growing one branch per document family.

Same code path, three altitudes: the [KV cache from scratch](/blog/kv-cache-from-scratch-pytorch) made one request fast, this blog made *repeated* requests fast, and [SGLang](/blog/how-does-sglang-work) runs the industrial-strength version of both. The concept-level story lives in [prefix caching](/blog/prefix-caching), and the whole optimization map is in the [series hub](/blog/llm-inference-optimization-hub).

That's it for now.
