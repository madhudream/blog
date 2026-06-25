---
title: How does a semantic cache work?
chapter: 7
kicker: Serving
reading: 11 min
---

# How does a semantic cache work?

A semantic cache remembers the questions your system has already answered, and when a new question *means* the same thing as an old one, it hands back the stored answer instead of running your whole pipeline again. A cache is just a fast lookup table that returns a saved result instead of recomputing it.

Here is why you should care. Every chapter before this one made your answers *better* — better chunks, better retrieval, better reranking. None of them made answering *cheaper*. In the real world, questions repeat constantly, and recomputing the same answer four hundred times a day is pure waste. A semantic cache cut our average latency by 92% on repeated questions, and it does that without touching accuracy. It also hides one knife-edge setting that this entire post is really about.

In this post, we will cover the following:

- The waste a normal RAG pipeline pays on every repeated question
- Why an exact-text cache barely helps real users
- How a semantic cache matches on meaning instead of spelling
- The threshold — the single number that decides everything — and the code behind it
- The collision trap: how Form 1040 vs 1040-NR can poison your cache
- The measured cost and quality numbers, with exact figures
- What the cache changes (economics) and what it deliberately does not (accuracy)
- How to take this to production

## The waste we are cleaning up

Your pipeline is good by now, but it is not cheap. Every single question runs the full machine: embed the query, search 38,000 chunks two ways, run a slow reranker over the shortlist, then call the LLM to write an answer. That is fine to pay once. An embedding turns a piece of text into a vector — a list of numbers — so that text with similar meaning lands at nearby points.

The problem is that questions repeat. Ten different users ask the same thing this morning. The same person rephrases and asks again. A support bot gets "how do I file as a nonresident?" four hundred times a day. For every one of those, you pay the full cost again to produce an answer you already produced. At any real traffic, that waste is enormous.

This is the IRS corpus we have been using all along, and the questions users ask of it are deeply repetitive. The same handful of forms — 1040, 1040-NR, Schedule C — come up again and again, worded a hundred different ways. That repetition is exactly the opportunity a cache exists to capture.

## Why a normal cache is not enough

The obvious fix is a cache: store each question with its answer, and when a question comes in, check whether you have seen it. A plain cache matches **exact text**, though, and that barely helps here. Look at these two:

> "What is Form 1040 used for?"
> "What's the 1040 form used for?"

Same question. Zero characters that a string match would treat as equal — the words, punctuation, and order all differ. A normal cache sees two completely different keys and misses. People almost never phrase things identically, so an exact cache hits almost never.

What you need is a cache that recognizes *meaning*, not spelling.

## The mechanism: match on meaning

You already have the perfect tool for "do these two pieces of text mean the same thing" — embeddings. So a semantic cache works like this. Store a vector for every question you have answered. When a new question arrives, embed it and find the closest stored question by cosine similarity. Cosine similarity is a score from -1 to 1 that measures the angle between two vectors — close to 1 means the meanings line up.

```
new question ──embed──► compare (cosine) against every cached question
                          │
              best match ≥ threshold?  ──yes──► return its stored answer   (~0.2s, $0)
                          │
                          no ────────────────► run the full pipeline, store it  (~2.6s)
```

If the closest stored question is *close enough*, you have seen this question before in different clothes — return its answer. If nothing is close enough, run the full pipeline and add this one to the cache for next time. A lookup is a single dot-product against your stored vectors — microseconds, against the seconds a full pipeline run takes.

Here is the heart of the lookup. The cached questions live in one matrix `mat`, every row L2-normalized, so a plain dot-product against the normalized query embedding *is* the cosine similarity. You take the best match and compare it to the threshold:

```python
def lookup(self, q_emb, threshold):
    if self._mat is None or len(self._mat) == 0:
        return 0.0, None
    sims = self._mat @ q_emb          # both sides normalized → dot == cosine
    i = int(sims.argmax())
    best = float(sims[i])
    if best < threshold:
        return best, None             # nothing close enough → miss
    return best, self._cache.get(self._keys[i])
```

The whole pipeline then sits behind one `answer` method. You embed the query, look it up, and on a hit you return the stored answer immediately. On a miss you run the real base pipeline and store the result so the next caller gets the fast path:

```python
def answer(self, question):
    q_emb = self._embed_query(question)
    sim, entry = self.cache.lookup(q_emb, self.threshold)
    if entry is not None:             # HIT — stored answer, no LLM
        out = dict(entry["answer_dict"])
        out["cache_hit"] = True
        return out
    out = self.base.answer(question)  # MISS — full pipeline, then store
    self.cache.store(question, q_emb, out)
    out["cache_hit"] = False
    return out
```

Notice there is no special intelligence in either snippet. The cache is dumb on purpose. All of its behavior — when it helps and when it hurts — comes down to that one comparison, `best < threshold`.

## The one number that decides everything: the threshold

That phrase "close enough" is doing all the work, and it hides the entire difficulty of semantic caching. The threshold is the minimum cosine similarity a new question must reach before the cache will reuse an old answer. It is a knife-edge.

Set it **too high** and real paraphrases never clear the bar — the cache almost never fires, and you have saved almost nothing. Set it **too low** and two *genuinely different* questions get treated as the same, and you confidently serve the wrong answer. The whole skill is finding the line between "the same question reworded" and "a different question that happens to sound similar." That line lives in your own data, so you have to measure it.

You warm the cache with your 50 golden questions, then ask 50 reworded versions and sweep the threshold:

| threshold | hit-rate | correct hits | **wrong hits** |
|---|---|---|---|
| 0.80 | 1.00 | 50 | **0** |
| 0.84 | 0.98 | 49 | 0 |
| 0.88 | 0.90 | 45 | 0 |
| 0.92 | 0.66 | 33 | 0 |

As the threshold climbs, coverage falls — fewer paraphrases clear the bar. Across the board, zero wrong answers. So on this set, 0.80 looks free: every reworded question is recognized, none misfires.

## The trap hiding in "zero wrong"

You have to be careful here, because that clean result is a property of *this question set*, not of semantic caching in general.

Your 50 golden questions cover distinctly different topics, so each paraphrase maps cleanly back to its own original — no two are close enough to collide. A real production stream is not so polite. Watch the IRS villain do its damage one more time, now to the cache:

> Warm the cache with: *"Who must file Form 1040-NR?"*
> Then ask: *"Who must file Form 1040?"*

Those are *different questions* — nonresident versus resident — but to an embedding they are nearly identical (cosine ≈ 0.76, because they share almost every word). Set your threshold below that, chasing more cache hits, and the cache will cheerfully serve the **1040-NR answer to the 1040 question.** Confidently. Wrongly. The same form-versus-form confusion that haunted retrieval now haunts the cache.

The lesson is not "0.80 is safe." The lesson is *"measure where your own collision line sits, and stay above it."* On a corpus where every question is about a wholly separate topic, a low threshold is harmless. On the IRS corpus, where 1040 and 1040-NR live a cosine hair apart, a low threshold is a loaded gun. Your data decides, not a blog post.

## Quality and cost, measured

At the chosen threshold, answering 50 paraphrases without the cache versus with it:

| metric | no-cache | cache |
|---|---|---|
| Context Recall | 0.76 | 0.85 |
| Faithfulness | 0.917 | 0.920 |
| Answer Relevancy | 0.703 | 0.679 |
| **avg latency** | **2.62s** | **0.21s** |

Average latency collapsed from 2.62s to 0.21s — a **92% drop** — and faithfulness held essentially flat at ~0.92. Recall even ticked *up*, from 0.76 to 0.85, which has a tidy explanation: a cache hit returns the answer computed for the *original* question, whose cleaner phrasing retrieved slightly better than the paraphrase would have. Serving the canonical answer can beat re-answering a reworded one from scratch. The only real cost was a hair of answer relevancy, 0.703 down to 0.679, because the cached answer was written for the original wording, not the new phrasing.

## What it does not do, on purpose

Notice what the cache *did not* change: the core accuracy of a fresh answer. It cannot. A cache never makes an answer *better* — it can only hand back a good answer faster. Its job is not quality, it is economics. Those accuracy numbers were set by [contextual retrieval](/blog/rag-contextual-retrieval) and the chapters before it; the cache just stops you from paying for them twice.

That is the right way to slot it into your mental model. The accuracy chapters built a good answer. The cache makes serving that answer, again and again, nearly free. If your answers are wrong, a cache will faithfully serve wrong answers faster — fix accuracy first, then cache.

## Taking it to production

The cache also has a notion of freshness so it never serves a stale answer forever. TTL — time to live — is the number of seconds a cached entry stays valid before it expires and gets recomputed. Tax guidance changes; a one-hour TTL means a popular question gets re-answered against the live pipeline at least once an hour, while still absorbing the flood of repeats in between.

Locally you can back the whole thing with **diskcache** — zero infrastructure, works on any laptop, persists across runs. For production you swap that one storage class for **Redis + RedisVL** and keep the exact same `lookup` and `store` contract. Nothing about the matching logic changes; you just move from a file on one machine to a shared, networked store every replica can read.

For the threshold itself, start around **0.90**, raise it to **0.92**, and watch your eval scorecard the whole way. The numbers above are why: 0.92 still recovered two-thirds of paraphrases with zero wrong hits, and a slightly higher floor keeps you comfortably above collision pairs like 1040 vs 1040-NR. Treat the threshold as a dial you tune against measured results, never a constant you copy from someone else's corpus.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 07 · no cache
   Context Recall       0.760   did we fetch the needed facts?
   Context Precision    0.918   relevant context ranked high?
   Faithfulness         0.917   grounded, no hallucination?
   Answer Relevancy     0.703   answers the actual question?
   Retrieval hit-rate   0.640   ≥1 expected form retrieved
   Avg latency          2.62s   per question, end-to-end

📊 RAGAS scorecard — 07 · cache (warm)
   Context Recall       0.850   did we fetch the needed facts?
   Context Precision    0.912   relevant context ranked high?
   Faithfulness         0.920   grounded, no hallucination?
   Answer Relevancy     0.679   answers the actual question?
   Retrieval hit-rate   0.680   ≥1 expected form retrieved
   Avg latency          0.21s   per question, end-to-end

```

## Summary

A semantic cache stores a vector for every question you have answered, and when a new question's meaning lands close enough to a stored one, it returns the old answer instead of recomputing it. It matches on meaning, not spelling, so it catches the paraphrases a plain cache misses — and it lives or dies by a single threshold that trades coverage against the risk of serving a similar-but-different question the wrong answer.

- A semantic cache changes your **economics, not your accuracy** — same answers, served far cheaper.
- It cut average latency from **2.62s to 0.21s (~92%)** while faithfulness held at ~0.92 and recall even rose 0.76 → 0.85.
- The **threshold** is the whole game: too high saves nothing, too low serves wrong answers.
- Measure your **collision line** on your own data — on the IRS corpus, 1040 vs 1040-NR sit at cosine ≈ 0.76.
- Use **TTL** so popular answers refresh; start the threshold near 0.90, raise to 0.92, watch the scorecard.
- Back it with **diskcache** locally and swap to **Redis + RedisVL** in production behind the same contract.

## What's next

You now have a pipeline that is both accurate and cheap to serve. The remaining arcs are about making it *robust*. Production hardening comes first — handling failures, monitoring drift, guarding against the cache and retrieval collisions you just met at real scale. After that comes agentic RAG, where the system stops answering one question at a time and starts planning multi-step retrieval, deciding for itself when to search, when to reuse, and when to ask again.
