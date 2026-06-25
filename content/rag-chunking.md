---
title: How does chunking change RAG?
chapter: 2
kicker: Indexing
reading: 10 min
---

# How does chunking change RAG?

Chunking is the step where you cut your documents into smaller pieces before you embed them. An **embedding** is a single fixed-size list of numbers that captures the meaning of a span of text, and chunking decides how much text each one has to summarize.

This matters because chunk size is the quietest knob in RAG. Most systems set it to a library default and never touch it again, yet it silently decides how much of your retrieval works at all. It is also the cheapest improvement in this whole series. In this chapter we change nothing but the size of the pieces, and we beat the baseline on every metric we measure.

In this post, we will cover the following:

- Why we cut documents into pieces at all instead of embedding whole forms
- What a chunk, a token, and an overlap actually are
- The Goldilocks problem: why too big and too small both fail
- The sweep we ran over the full IRS corpus, with exact numbers
- What moved when we halved the default, and the reason it moved
- What chunking deliberately did not fix, and why
- The code that produced these results
- Where we go next

## Why you can't skip this step

You might wonder why we chop documents up at all. Why not embed each whole tax form as one vector and search those?

Because an embedding is a single fixed-size summary of meaning, and a whole tax form is far too much meaning to fit in one. Cram an entire 30-page instruction booklet into a single vector and you get a blurry average of everything it talks about, which is useless for finding the one paragraph that answers a specific question. Embeddings work best on a focused span of text that is *about one thing*.

So you split each document into chunks, embed each chunk, and search those. A **chunk** is just one of those slices of a document, and it is the unit your retriever actually returns. When a user asks a question, you embed the question, find the chunks whose embeddings sit closest to it, and hand those chunks to the language model as context. Everything the model knows about the answer, it learns from the chunks you retrieved, which is why their size matters so much.

The question this whole chapter answers is simple to state and surprisingly deep to get right: how big should a chunk be? It feels like a throwaway setting, the kind you accept from the library and forget. It is actually the dial that sets the resolution of your entire pipeline, and getting it wrong caps how well every later component can possibly perform.

## The Goldilocks problem

Chunk size is a balance between two opposite failures, and you feel both as soon as you picture them.

Make the chunks **too big** and the one line that answers the question drowns. A 1,000-token chunk might contain the sentence you need plus nine sentences you don't, so its embedding gets diluted, pulled toward the average of all ten, and it ranks lower than it should. A **token** here is roughly a word-piece, the unit both the embedding model and the language model count text in, so a 1,000-token chunk is about 750 words. You also waste the model's limited prompt budget shipping all that filler into the answer step.

Make the chunks **too small** and you lose the context that gives a line meaning. Picture a chunk that is just `$13,850`. Retrieved on its own it is almost worthless. Which form? Which filing status? Which year? The number got orphaned from the rule it belongs to. A chunk has to be small enough to stay focused but large enough to stand on its own.

There is a useful analogy here: slicing bread for sandwiches. The whole loaf is one giant chunk. It technically contains everything, but it is useless to eat in one bite. Crumbs are tiny chunks. You can chew them, but you have lost which slice the filling was ever on. Even slices with a little overlap are token-aware chunks done right. Each bite is coherent, and the overlap means a word split at the edge of one slice still shows up whole in its neighbour.

The sweet spot is corpus-specific, and the only honest way to find it is to measure. There is no universal best chunk size, only the best size *for your documents and your questions*, and a number that wins on prose can lose badly on dense tabular tax forms. If you have not yet set up a scorecard, [measuring a RAG system](/blog/rag-measuring-rag) is the chapter that builds the one we use here.

## The sweep

Our naive baseline used the library's default 1,024-token chunks. We swept three sizes over the full IRS corpus, scoring the same 50 golden questions each time so that the only thing changing between runs was the chunk size.

One more term before the table. The **overlap** is how many tokens neighbouring chunks share, so a sentence that falls on a boundary is not sliced clean in half and lost. A small overlap means a fact split at the edge of one chunk still appears whole in its neighbour.

| chunk / overlap | Recall | Precision | Faithfulness | hit-rate |
|---|---|---|---|---|
| 1024 / 200 (default) | 0.65 | 0.78 | 0.75 | 0.50 |
| **512 / 128** | **0.70** | **0.84** | **0.80** | **0.56** |
| 256 / 64 | 0.69 | 0.80 | 0.77 | 0.55 |

## What moved, and why

Halving the default to **512 tokens beat 1024 on everything**. Recall went 0.65 to 0.70, precision 0.78 to 0.84, faithfulness 0.75 to 0.80. The reason is exactly the "too big" failure above. Tighter chunks are less diluted, so the chunk that actually contains the answer has a sharper embedding and ranks higher in the search. And because the model now reads four *focused* chunks instead of four bloated ones, its answers are better grounded, which is the faithfulness bump you see in the last column.

Let's slow down here, because the next row is where the lesson lives. Notice what happened at **256 tokens**. Recall held, but precision and faithfulness slipped back below the 512 mark. That is the "too small" failure showing up in the numbers. At 256 tokens, chunks start orphaning context, splitting a rule from the figure it applies to, exactly like the lonely `$13,850` from earlier. There is a floor, and for this corpus 512 sat right above it. That is the whole Goldilocks story, in one table: tighter helps until it doesn't, and the turn is something you can see rather than guess.

## What it deliberately did not fix

Now look at the hit-rate column again. Even at the winning size it only crept to 0.56. Nearly half the questions still failed to retrieve a single correct form. And that is *expected*, because the thing breaking those questions isn't chunk size at all.

It is our recurring villain. Dense search cannot tell `1040` from `1040-NR`, because to an embedding those two strings *mean* almost the same thing. They sit right next to each other in vector space no matter how you slice the document. No chunk size on earth teaches a retriever the difference between two near-identical form numbers. That is a retrieval recall problem, not a granularity one.

This is the pattern worth internalising early. Each layer fixes the problem it is shaped to fix, and leaves the others for the layer that is shaped to fix *them*. Chunking sharpened every chunk we already retrieve, raising precision and faithfulness on the questions that were already landing. It could not, and was never supposed to, retrieve the chunks we were missing entirely. Keeping those two jobs separate in your head is what lets you debug a RAG system instead of guessing at it.

## The code

The whole experiment is one dictionary and one parser. Each strategy is a row on the scorecard, and the only thing that varies between rows is how documents get cut.

```python
STRATEGIES = {
    "sentence_1024": {"kind": "sentence", "chunk_size": 1024, "chunk_overlap": 200},  # default
    "sentence_512":  {"kind": "sentence", "chunk_size": 512,  "chunk_overlap": 64},   # tuned tighter
    "sentence_256":  {"kind": "sentence", "chunk_size": 256,  "chunk_overlap": 32},   # small & focused
}
```

Turning a named strategy into an actual splitter is a one-liner. The `SentenceSplitter` is token-aware: it splits on sentence boundaries, packs sentences together up to `chunk_size` tokens, and overlaps neighbours by `chunk_overlap` tokens so an edge-split fact still appears whole somewhere.

```python
from llama_index.core.node_parser import SentenceSplitter

def make_parser(cfg):
    return SentenceSplitter(
        chunk_size=cfg["chunk_size"],
        chunk_overlap=cfg["chunk_overlap"],
    )
```

Scoring a strategy means building an index with that parser and running it through the exact same evaluation harness from the previous chapter. Nothing else about the system changes, which is what makes the comparison fair.

```python
for strategy in STRATEGIES:
    rag = ChunkedRAG(strategy=strategy).build()
    scorecard = run_eval(rag, name=f"02_{strategy}")
    scorecards.append(scorecard)
```

That loop is the entire A/B test. Build each strategy, score it against the 50 golden questions, and read the deltas against the baseline. The winner is the strategy with the highest recall that doesn't sacrifice faithfulness, which is how we landed on 512.

One detail worth noting from the real code: each strategy builds its own index once and is then reused, instead of re-embedding the corpus on every run. Embedding is the slow, paid step, so you pay it a single time per strategy and load the saved vectors afterward. For a 40-form corpus this is convenience. In production, where the corpus is large and the embedding bill is real, it is the difference between a system you can iterate on and one you can't afford to touch.

## So, how does chunking change RAG?

It sets the resolution of everything downstream. Too coarse and your answers drown in filler. Too fine and they lose the context that made them mean anything. Finding the right size is the cheapest win available to you, a single parameter with no new components, and it is the foundation the rest of the system is built on. We carried **512 / 128** forward as that foundation, and every later chapter is measured on top of it.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 02 · chunk 1024
   Context Recall       0.650   did we fetch the needed facts?
   Context Precision    0.779   relevant context ranked high?
   Faithfulness         0.751   grounded, no hallucination?
   Answer Relevancy     0.584   answers the actual question?
   Retrieval hit-rate   0.500   ≥1 expected form retrieved
   Avg latency          1.01s   per question, end-to-end

📊 RAGAS scorecard — 02 · chunk 512 (win)
   Context Recall       0.700   did we fetch the needed facts?
   Context Precision    0.838   relevant context ranked high?
   Faithfulness         0.799   grounded, no hallucination?
   Answer Relevancy     0.664   answers the actual question?
   Retrieval hit-rate   0.560   ≥1 expected form retrieved
   Avg latency          1.10s   per question, end-to-end

📊 RAGAS scorecard — 02 · chunk 256
   Context Recall       0.690   did we fetch the needed facts?
   Context Precision    0.745   relevant context ranked high?
   Faithfulness         0.698   grounded, no hallucination?
   Answer Relevancy     0.511   answers the actual question?
   Retrieval hit-rate   0.560   ≥1 expected form retrieved
   Avg latency          0.96s   per question, end-to-end

```

## Summary

Chunking is where you decide the granularity of retrieval, and that decision quietly governs how much of your RAG system works.

- An embedding summarizes one span of text, so you split documents into focused **chunks** before embedding rather than embedding whole forms.
- Chunk size is a **Goldilocks** problem: too big dilutes the answer, too small orphans its context.
- On the IRS corpus, halving the default to **512 / 128** beat 1024 on every metric (recall 0.65 → 0.70, precision 0.78 → 0.84, faithfulness 0.75 → 0.80).
- Going further to **256** held recall but slipped precision and faithfulness back, marking the floor where chunks start losing context.
- Chunking did *not* lift hit-rate past ~0.56, because it cannot make dense search distinguish `1040` from `1040-NR`.
- Each layer fixes only the problem it is shaped to fix. Chunking sharpens chunks you already retrieve; it does not retrieve the ones you miss.

## What's next

The hit-rate ceiling is the loud signal that retrieval, not granularity, is now the bottleneck. The villain is two near-identical form numbers that mean the same thing to an embedding, and the fix is a search that reads *exact words* alongside meaning. That is [how hybrid search works](/blog/rag-hybrid-search), where we finally start retrieving the chunks chunking left on the table.
