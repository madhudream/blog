---
title: "PagedAttention: How vLLM Stops Wasting KV Cache Memory"
slug: "paged-attention"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "4 min read"
words: 792
summary: "In this blog, we will learn about PagedAttention, the technique that stores the KV cache in small fixed-size blocks instead of one big reserved chunk per request, eliminating memory waste and enabling block sharing across requests."
---

# PagedAttention: How vLLM Stops Wasting KV Cache Memory

In this blog, we will learn about **PagedAttention**, the memory-management idea at the heart of the vLLM serving engine. It targets the [KV cache](/blog/kv-cache), the ever-growing store that decides how many users one GPU can serve.

We will cover the following:

- The problem: naive KV cache allocation wastes memory
- PagedAttention
- Seeing it in a diagram
- The analogy
- Sharing blocks across requests
- PagedAttention and prefix caching are different ideas
- Conclusion

Let's get started.

## The problem: naive KV cache allocation wastes memory

Recall from the [KV cache blog](/blog/kv-cache) that every request's cache grows by one entry per generated token, and nobody knows in advance how long an answer will be.

In a naive system, each request's KV cache lives in one large continuous block of memory, sized for the longest answer that could possibly occur. The flaw is that most of that reserved space never gets used and goes to waste. If the model can produce 2,000 tokens but the answer is 50, space for 1,950 tokens sits reserved and empty. The waste can be enormous, and the leftover gaps between requests' blocks are too scattered to hold new requests — a problem called fragmentation.

The result: the GPU has plenty of memory on paper, but serves few users in practice.

## PagedAttention

**PagedAttention stores the KV cache in small fixed-size blocks, typically 16 tokens apiece, that can sit anywhere in GPU memory, rather than one big continuous chunk per request.** A small table, called the **block table**, tracks which scattered blocks belong to which request. A fresh block is allocated only when the sequence actually grows into it.

This borrows an old, battle-tested computing trick called **paging**, which operating systems have used for decades: memory is dealt out in small equal pieces only at the moment they are truly needed.

## Seeing it in a diagram

```
WITHOUT paging (one big contiguous block reserved up front):
  Request A: [used][used][used][------ reserved but empty ------]
  Request B: [used][used][--------- reserved but empty ---------]
             wasted empty space sits unused inside each block

WITH paging (small fixed-size blocks, given only when needed):
  Request A -> block 7, block 2, block 9     (scattered anywhere)
  Request B -> block 4, block 1
  a block table remembers which blocks belong to which request
  shared prefix? two requests can point to the SAME block
```

We can see that the contiguous approach reserves one big block and wastes its empty portion, while paging hands out small blocks only as the sequence expands. There is no over-reservation, and because every block is the same size, any free block fits any request — fragmentation all but disappears.

## The analogy

Rather than demanding one big empty parking lot for each car's luggage, the valet uses many small numbered lockers spread around the building and keeps a slip recording which lockers belong to whom. No space gets wasted on empty reserved lots. And when two people carry identical luggage (a shared prefix), they can simply use the same locker.

## Sharing blocks across requests

That last line of the diagram is a superpower, not a footnote. Because the cache is now made of blocks, two requests whose prompts begin identically can point their block tables at the **same physical blocks** for the shared part, storing it once instead of twice. This is what makes [prefix caching](/blog/prefix-caching) cheap to implement, and it also helps beam search, where several candidate answers share a common beginning.

When a request finishes, its blocks return to the free pool instantly — which is exactly what [continuous batching](/blog/continuous-batching) needs to slot the next waiting request in without delay. The two techniques are a matched pair: PagedAttention keeps the memory full of useful data, continuous batching keeps the compute full of useful work.

## PagedAttention and prefix caching are different ideas

**Note:** PagedAttention is the memory layout that stops the waste, while [prefix caching](/blog/prefix-caching) is the reuse of already-computed KV across requests. They are separate ideas, but PagedAttention is what makes prefix caching's block sharing feasible.

PagedAttention all but eliminates wasted KV cache memory, allows larger batches to fit, and lifts [throughput](/blog/llm-inference-metrics). It was introduced by the vLLM serving system, where it is on by default — you can watch the block pool fill via the `gpu_cache_usage_perc` metric in the [vLLM practical guide](/blog/serving-llms-with-vllm).

## Conclusion

PagedAttention treats the KV cache the way an operating system treats memory: small fixed-size blocks, handed out on demand, tracked by a block table, shared where contents are identical, and reclaimed the moment a request ends. It converts wasted reservation into served users, and it is the foundation the rest of the [optimization series](/topic/llm-inference) builds on.

That's it for now.
