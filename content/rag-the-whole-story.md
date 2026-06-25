---
title: How RAG actually works, start to finish
chapter: The whole story
kicker: Overview
reading: 15 min
---

# How RAG actually works, start to finish

> *A gentle, chapter-by-chapter tour of Retrieval-Augmented Generation — start here, then follow any link that catches you for the deep dive.*

Imagine handing someone a closed-book exam on a 1,000-page tax manual they have never read. They will either stay silent or make something up. That is a language model answering questions about *your* documents. Now hand them the same exam, but let them flip to the right pages first. The answers get honest. That open-book trick is **RAG — Retrieval-Augmented Generation**.

The mechanics are three small moves: **fetch** the text that looks relevant to the question, **paste** it into the prompt, and **ask** the model to answer only from what it was given. No retraining, no fine-tuning — you change *what the model reads*, not what it is.

Most writing about RAG hands you a bag of tricks — hybrid search, rerankers, HyDE — and promises each one helps. This series does the opposite. We built the most naive RAG system that could possibly work, then improved it **one idea at a time**, measuring every step on the same hard test. Some tricks delivered. Some didn't. A couple helped one thing while quietly hurting another.

This page is the **map**. Each section below is a one-screen, gentle explanation of one chapter: what the idea is, the problem it solves, and the one number it moved. When a section makes you want more, follow the **Read the full chapter** link at its end.

> 📓 **Want to check the work?** Every number below comes from one runnable notebook — the exact pipeline (OpenAI + Qdrant + BM25 + FlashRank + RAGAS), the full IRS corpus, the 50-question golden set. Open it in [Google Colab](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) and reproduce the whole climb.

## Table of contents

1. [How do you actually measure a RAG system?](#how-do-you-actually-measure-a-rag-system) — the scorecard everything else leans on
2. [What does naive RAG look like?](#what-does-naive-rag-look-like) — the honest floor we have to beat
3. [How does chunking change RAG?](#how-does-chunking-change-rag) — the cheapest win, free
4. [How does hybrid search work?](#how-does-hybrid-search-work) — a keyword reader, and a surprise
5. [How does a reranker work?](#how-does-a-reranker-work) — a careful second reader that can't retrieve
6. [How does query rewriting help (and hurt)?](#how-does-query-rewriting-help-and-hurt) — fix the question, pay forever
7. [How does contextual retrieval work?](#how-does-contextual-retrieval-work) — the cheap fix that won
8. [How does a semantic cache work?](#how-does-a-semantic-cache-work) — answer once, serve instantly
9. [The whole climb, in one table](#the-whole-climb-in-one-table)
10. [What the series is really teaching](#what-the-series-is-really-teaching)

## The test, and the villain

Before any chapter, two things to meet — because everything below is scored against them.

Everything is measured on a deliberately unforgiving corpus: **~1,400 real IRS tax forms** — the form `f1040`, its nonresident cousin `f1040nr`, dozens of schedules, and the instruction booklets that look almost identical to the forms they explain. We score against a frozen set of **50 golden questions**. We picked a corpus where naive RAG is *bad on purpose*, so there is real room to climb.

That corpus has a recurring **villain**, and it stalks every chapter. Ask *"What is Form 1040 used for?"* and naive search returns `i1040gi` — the *instructions for* Form 1040 — not the form itself. Why? To a system that searches by meaning, "Form 1040" and "Instructions for Form 1040" are nearly the same thing. The same blind spot confuses `1040` with `1040-NR`. Watch how each layer either lands a punch on this villain or pointedly fails to — that is the through-line of the whole series.

## How do you actually measure a RAG system?

You can't improve what you can't score. This is the single most-skipped step in the whole field, and skipping it is how teams ship for months on vibes — you change a setting, read three answers, decide they "feel" sharper, and push to production.

The fix is a scorecard. Split the system in two — **retrieval** (did we fetch the right text?) and **generation** (did the model answer faithfully from it?) — and put a meaning-aware number on each: recall, precision, faithfulness, and a hit-rate. Now every change is a measured before/after, not a guess.

Every number on this page comes from that scorecard, so this is the chapter to read first.

**Read the full chapter:** [how do you actually measure a RAG system?](/blog/rag-measuring-rag)

## What does naive RAG look like?

**Naive RAG** is the three-move loop with every default left untouched: chunk every document (cut it into pieces), embed the chunks (turn each into a vector that captures its meaning), retrieve the top 4 by similarity, drop them into a strict prompt, and generate. On real libraries it is almost one line:

```python
from llama_index.core import VectorStoreIndex

# Chunk + embed + store + top-k retrieval, all on defaults.
index = VectorStoreIndex.from_documents(docs)
engine = index.as_query_engine(similarity_top_k=4, text_qa_template=STRICT_PROMPT)
print(engine.query("What is Form 1040 used for?"))
```

It works — and it's rough: **0.65 recall, 0.75 faithfulness**, and it walks straight into the form-versus-instructions trap. This is the honest floor. Everything after earns its way up from here.

## How does chunking change RAG?

Chunking is the step where you cut documents into smaller pieces before embedding them. It is the **quietest knob in RAG**: most systems set it to a library default and never touch it again, yet it silently decides how much of your retrieval works at all.

Naive RAG used big 1,024-token chunks; we tried 512. Smaller chunks aren't diluted by surrounding filler, so the line that actually answers a question gets a sharper embedding and ranks higher.

**What moved:** every metric — recall 0.65 → 0.70, precision and faithfulness up with it. **What didn't, as expected:** the hit-rate stayed stuck near 0.56, because the villain is a *retrieval* problem, and no chunk size teaches search that `1040` and `1040-NR` are different strings. A layer fixes the problem it's shaped for and leaves the rest.

**Read the full chapter:** [how does chunking change RAG?](/blog/rag-chunking)

## How does hybrid search work?

To finally separate `1040` from `1040-NR`, hybrid search runs two retrievers over the same corpus at once: one that reads *exact words* (BM25 — the classic keyword-matching algorithm) and one that reads *meaning*, then fuses their rankings. Picture two researchers with opposite blind spots — the translator who understands "nonresident" ≈ "alien individual," and the clerk who knows `1040-NR` is simply a different token.

**What moved:** faithfulness jumped to 0.87 — keyword matching pulls the actual form more often, so answers are better grounded. **The surprise:** on this identifier-heavy corpus, pure keyword search actually *beat* the fused version on recall, because blending the fuzzy meaning-search back in diluted the keyword precision that was already winning. Fusion is not a free lunch — and we only knew because we measured.

**Read the full chapter:** [how does hybrid search work?](/blog/rag-hybrid-search)

## How does a reranker work?

A reranker takes the rough pile your search pulled back and reorders it so the documents that truly answer the question rise to the top — a slow, careful second reader let loose on the shortlist before the answer is written. We pulled a wide pool of 20 candidates and let a cross-encoder read each one *together with the question* and keep the best 4.

**What moved:** faithfulness again, to 0.91, the best yet — a cleaner top-4 means fewer look-alike booklets to trip the model. **What didn't, and why it is not a failure:** recall stayed flat at 0.73. A reranker can only *reorder* the shortlist it was handed; if the right form isn't in the top-20, no reordering invents it. Recall is set upstream. This is the most important "no" in the series, and it sets up the next two chapters.

**Read the full chapter:** [how does a reranker work?](/blog/rag-reranking)

## How does query rewriting help (and hurt)?

If the right document never even enters the pool, stop tweaking the ranking and change the *question*. Query rewriting treats the user's words as a first draft: the LLM rewrites the question several ways and searches with all of them — a wider net that catches documents a single phrasing missed.

**What moved:** recall, off its two-chapter plateau, 0.73 → 0.78 — exactly the pool problem the reranker couldn't touch. **The cost, as expected:** latency more than doubled to 6.5s, because every query now triggers an LLM rewrite plus four retrievals. A real gain, rented on every single request. (We also tried HyDE, which matched the recall but quietly damaged faithfulness — a worse trade.)

**Read the full chapter:** [how does query rewriting help (and hurt)?](/blog/rag-query-rewriting)

## How does contextual retrieval work?

Here is the turn. Query rewriting fixed the pool by reshaping the *question* every time. Contextual retrieval fixes the same pool by reshaping the *documents* once: before embedding, we prepend an LLM-written "you are here" line to each chunk — "Form 1040-NR, Nonresident Alien return; this part covers…" — so a chunk stops being an orphan and starts describing itself.

**What moved:** nearly everything, hard — recall 0.78 → 0.83, precision 0.85 → 0.95, faithfulness 0.91 → 0.97, the biggest jumps in the series. Self-describing chunks are easier to find *and* easier for the reranker to tell apart, so every downstream layer got sharper. **And latency fell** (6.5s → 2.6s), because it beat multi-query outright — so we *deleted* query rewriting. The system got simpler and better at once. This was the biggest win in the series.

**Read the full chapter:** [how does contextual retrieval work?](/blog/rag-contextual-retrieval)

## How does a semantic cache work?

Accuracy was solved; now economics. A semantic cache remembers the questions already answered and hands back the stored answer when a new one *means* the same thing — matching on meaning, so it catches the paraphrases an exact-match cache misses.

**What moved:** latency, by 92% on repeats (2.6s → 0.2s), because a cache lookup is a millisecond dot-product instead of a full pipeline run. **What it deliberately doesn't touch:** accuracy — a cache can't make an answer better, only cheaper to serve again. Its real danger is the threshold: set it too loose and two different-but-similar questions collide (the villain, one last time).

**Read the full chapter:** [how does a semantic cache work?](/blog/rag-semantic-cache)

## The whole climb, in one table

Every row is one chapter, one change, scored on the same 50 golden questions over the same ~1,400 forms.

| layer | Recall | Precision | Faithfulness | hit | latency |
|---|---|---|---|---|---|
| Naive (1024) | 0.65 | 0.78 | 0.75 | 0.50 | 1.0s |
| Chunk @ 512 | 0.70 | 0.84 | 0.80 | 0.56 | 0.9s |
| Hybrid | 0.73 | 0.85 | 0.87 | 0.58 | 1.4s |
| + Reranker | 0.73 | 0.85 | 0.91 | 0.60 | 2.6s |
| + Multi-query | 0.78 | 0.85 | 0.91 | 0.66 | 6.5s |
| **Contextual (−multi)** | **0.83** | **0.95** | **0.97** | **0.68** | **2.6s** |
| sparse baseline (for reference) | 0.85 | 0.74 | 0.90 | 0.66 | 1.3s |

From a naive 0.65 / 0.78 / 0.75 to **0.83 recall, 0.95 precision, 0.97 faithfulness** — beating the strong pure-keyword baseline on everything except recall (by 0.02), where it crushes it on precision (0.95 vs 0.74). For this corpus, the retrieval problem is essentially solved.

## What the series is really teaching

Step back from the numbers and there's a pattern worth more than any single technique. **Each layer fixes the problem it is shaped to fix, and is powerless on the others.** Chunking sharpens chunks you already find; it can't find new ones. Reranking reorders the pool; it can't retrieve into it. Query rewriting and contextual retrieval widen the pool; caching doesn't touch quality at all. Knowing *which* problem you have tells you which layer to reach for — and which layers won't help no matter how hard you turn them up.

That is why the measuring came first, and why we reported the flops as loudly as the wins. A reranker that moved faithfulness but not recall taught us more than a clean victory would have.

Five lessons carry the whole series:

- **Measure before you tune.** Split RAG into retrieval and generation, score four meaning-aware metrics on a frozen golden set, and never trust "it looks better."
- **Each layer has a shape.** Chunking and contextual retrieval sharpen and widen the pool; reranking reorders it; caching only makes serving cheaper. Match the layer to the failure.
- **Recall is set upstream.** No reranker invents a document that retrieval never fetched — when recall is stuck, fix the pool, not the ranking.
- **The cheap fix can win.** Contextual retrieval (pay once at index time) beat query rewriting (pay forever per query) on every axis — and let us *delete* a whole component.
- **Report the flops.** BM25 beating hybrid, HyDE hurting faithfulness, the reranker not moving recall — the honest "no" is where the real understanding lives.

## What's next

Two arcs remain. **Production hardening** — persistence, invalidating the cache when documents change, warming, query routing. Then **agentic RAG** — letting the system decide *when* to retrieve, reformulate, and verify, instead of running one fixed pipeline for every question. Those are coming.

For now, start with [how we measure a RAG system](/blog/rag-measuring-rag), then follow the climb chapter by chapter — and run the code that proves every number in the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing).
