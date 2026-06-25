---
title: How does hybrid search work?
chapter: 3
kicker: Retrieval
reading: 11 min
---

# How does hybrid search work?

Hybrid search runs two retrievers over the same corpus at once: one that matches meaning and one that matches exact words. It then fuses their two ranked lists into a single ranking, so the final answer can draw on both strengths.

Why should you care? Because each retriever alone has a blind spot, and those blind spots are opposite. In our IRS corpus, a meaning-based search keeps confusing Form `1040` with `1040-NR` because they live in nearly the same spot in meaning-space. A word-based search would never make that mistake. Hybrid search is the standard recipe for getting both at once. The interesting part of this post is that, on this particular corpus, the recipe did not win the way the textbooks promise, and understanding why teaches you more than a clean victory would.

In this post, we will cover the following:

- The exact failure that pushed us past pure dense search
- What a dense retriever and a sparse retriever each are, in plain terms
- The translator-and-clerk analogy for how they fail in opposite ways
- How you fuse two incompatible rankings with Reciprocal Rank Fusion
- The code that wires dense plus BM25 into one Qdrant collection
- The three-mode results, including a surprise that BM25 won outright
- When fusion genuinely helps and when it is a wash
- Why we still carried hybrid forward despite losing the headline number

## The blind spot we are trying to fix

We ended the last chapter stuck on one stubborn failure. Dense search keeps confusing things that *sound* alike. Ask it about Form `1040` and it happily returns `1040-NR`, or the instruction booklet, because all of those documents sit in nearly the same neighborhood in meaning-space. Tighter chunks did not help. The search has no concept that `1040` and `1040-NR` are *different exact strings*. It only thinks in meaning, and in meaning they are cousins.

So the fix is not a better meaning-search. The fix is to add a *second* kind of search that thinks in words instead of meaning, one that knows `1040-NR` and `1040` are simply different tokens, full stop. That second search is the sparse retriever, and pairing it with the first is what we mean by hybrid.

## Two retrievers that fail in opposite ways

A **dense retriever** searches by meaning. It turns each chunk into a single dense vector, a long list of numbers that captures *what the text is about*, and finds chunks whose vectors point in a similar direction to your question.

A **sparse retriever** searches by exact words. It scores documents on which of your query's literal terms they contain and how rare those terms are. The classic algorithm here is **BM25**, a decades-old keyword-ranking formula that rewards exact term matches and weights rarer words more heavily.

It helps to picture them as two researchers handed the same question.

The dense retriever is a translator. She reads for *meaning*. Ask her "who has to file as a nonresident?" and she will find the right passage even if it says "alien individuals" and never uses the word "nonresident," because she understands they are the same idea. Her weakness is exact identifiers. To her, `1040` and `1040-NR` mean almost the same thing, so she mixes them up.

The sparse retriever is a clerk with a word ledger. He matches *exact terms*. Hand him "1040-NR" and he finds documents containing precisely that token. He would never confuse it with `1040`. His weakness is the mirror image of hers. Ask him about "nonresidents" and he will not match a form that only ever says "alien individuals," because to him those are just different words.

Here is the key observation: their blind spots are opposite. She is strong exactly where he is weak, and weak exactly where he is strong. That is the textbook setup for combining two methods. When two systems fail on different things, fusing them should cover both failure modes at once.

## How retrieval similarity is measured

Before fusing, it is worth naming how each retriever scores a match, because the scores are why fusion needs a trick.

The dense side measures **cosine similarity**, the angle between your question's vector and a chunk's vector; closer angle means more similar meaning, reported as a number like 0.82. The sparse side reports a **BM25 score**, an unbounded keyword-match strength that might come back as 14.3 for a strong term hit.

Those two numbers do not live on the same scale. A cosine of 0.82 and a BM25 of 14.3 are not comparable, so you cannot simply add them and sort. That is the snag fusion has to solve.

## How you actually fuse two rankings: RRF

The trick is to throw the raw scores away and keep only the **rank positions**. This is **Reciprocal Rank Fusion (RRF)**, a rank-fusion method that combines lists using each document's position rather than its score. **Rank fusion** is the general idea of merging ranked lists, and RRF is the specific, tuning-free version everyone reaches for.

The formula is small. For each retriever's list, a document earns `1 / (k + rank)`, and you add up those contributions across both lists. The constant `k` (about 60) softens the gap between the very top ranks so that being #1 is good but not overwhelmingly decisive:

```
score(doc) = Σ  1 / (k + rank_of_doc_in_that_list)      (k ≈ 60)
             over each retriever's list

dense  : [i1040gi, f1040, f1040sr, p17, …]    ← instructions float up
sparse : [f1040, f1040nr, f1040x, i1040gi, …] ← the literal '1040' wins
fused  : [f1040, i1040gi, f1040sr, …]         ← f1040 rises; i1040gi sinks
```

The intuition is that a document ranking *decently in both* lists beats a document ranking brilliantly in one and absent from the other. Being the translator's #2 and the clerk's #1 is a stronger signal than being the translator's #1 and nowhere on the clerk's list. Because RRF reads only positions, it does not care that cosine and BM25 are incomparable, which is exactly why it can fuse two unrelated retrievers without any tuning.

Here is RRF as actual code, faithful to the worked example in `hybrid_rag.py`. Two retrievers each return a ranked list, you accumulate `1 / (k + rank)` per document, then sort:

```python
def explain_rrf(k: int = 60) -> None:
    dense  = ["fA", "fB", "fC", "fD", "fE"]   # dense's top-5
    sparse = ["fC", "fA", "fX", "fY", "fB"]   # sparse's top-5
    scores: dict[str, float] = {}
    for rank, doc in enumerate(dense):
        scores[doc] = scores.get(doc, 0) + 1 / (k + rank + 1)
    for rank, doc in enumerate(sparse):
        scores[doc] = scores.get(doc, 0) + 1 / (k + rank + 1)
    fused = sorted(scores.items(), key=lambda x: -x[1])
    # 'fA' wins: BOTH retrievers ranked it high (1, 2).
    # 'fX'/'fY' had one strong sparse rank but no dense support, so they fall.
```

Notice there is no normalization step anywhere in that loop. RRF needs only ranks, which is why it survives mixing two systems whose scores mean entirely different things.

## Wiring dense plus sparse into one collection

You do not run two separate databases for this. You store *both* a dense vector and a sparse vector for every chunk in a single Qdrant collection, then choose dense, sparse, or hybrid at query time. That keeps the comparison honest, since all three modes read the exact same chunks and the exact same vectors.

The setup is one constructor call. `enable_hybrid=True` tells Qdrant to keep a sparse vector alongside the dense one, and `fastembed_sparse_model="Qdrant/bm25"` picks classic BM25 to build it:

```python
from llama_index.vector_stores.qdrant import QdrantVectorStore

vstore = QdrantVectorStore(
    client=client,
    collection_name="irs_hybrid_sentence_512",
    enable_hybrid=True,
    fastembed_sparse_model="Qdrant/bm25",  # classic BM25 via FastEmbed
    # hybrid_fusion_fn omitted → LlamaIndex defaults to RRF, exactly what we want.
)
```

When you omit `hybrid_fusion_fn`, LlamaIndex fuses with RRF by default, so the diagram above is literally what runs. At query time you flip a single mode flag, `"default"` for dense, `"sparse"` for BM25 only, or `"hybrid"` for both fused, and that is the whole A/B harness. The sparse pool is widened before fusion (`sparse_top_k = top_k * 5`) so BM25 surfaces enough exact-token candidates for RRF to pick the best handful.

## The result, and the surprise

We queried the same corpus three ways and scored each with the same metrics.

| mode | Recall | Precision | Faithfulness | hit-rate |
|---|---|---|---|---|
| **sparse (BM25)** | **0.85** | 0.74 | **0.90** | **0.66** |
| hybrid (RRF) | 0.73 | **0.85** | 0.87 | 0.58 |
| dense | 0.70 | 0.82 | 0.79 | 0.56 |

Read the top row twice. Pure BM25, the old, pre-neural, supposedly outdated keyword technique, crushed everything on recall, faithfulness, and hit-rate. And hybrid, the thing we expected to win, landed *between* the two specialists on recall. Fusion did not dominate. The clerk, working alone with his word ledger, beat the team.

## Why fusion did not win here, and when it would

This is the part worth slowing down on, because the textbook said hybrid should win and the measurements said it did not. Both can be true. It depends on your corpus.

Our corpus is *dominated by exact identifiers*: form numbers, line references, schedule letters, `1040-NR`, `8863`. That is BM25's home turf. When the signal a question depends on is mostly precise keywords, the clerk is already nearly right on his own. Blending the translator back in, with her habit of treating `1040` and `1040-NR` as cousins, actually *drags some near-miss documents back up* the list, diluting the keyword precision that was already getting the answer. Fusion averaged a strong specialist with a weaker one, and on this corpus that is a small step backward, not forward.

On a different corpus, long prose, paraphrase-heavy questions, few exact identifiers, the translator would be the strong one and fusion would clearly help. So the rule of thumb is concrete: fusion helps when neither retriever owns your corpus and their strengths are genuinely complementary, and it is a wash, or a slight loss, when one of them already nearly solves the task alone. The honest lesson is not "hybrid is bad." It is that fusion is not a free lunch, and only your own data says whether it pays. That is the entire reason we built a scorecard before we started changing things.

## Why we carried hybrid forward anyway

Sparse won the headline number, so why take *hybrid* into the next chapter instead of the winner? Three reasons, and they preview how systems thinking beats metric-chasing.

- Hybrid keeps the dense channel alive, and two later chapters (query rewriting, contextual embeddings) are improvements to that dense channel. Throw it away and you would be throwing away the very thing those chapters tune.
- Hybrid had the best precision and was never the worst at anything. It is the robust default that will not collapse on the conceptual questions where pure keyword search goes blind, the questions about "nonresidents" that never say `1040-NR`.
- The next chapter adds [a reranker](/blog/rag-reranking), which wants a wide, diverse shortlist to sort. Hybrid surfaces both keyword and meaning candidates, exactly the raw material a reranker is built to reorder.

You optimize for the best *final* system, not the best retriever in isolation. Sometimes that means carrying forward the option that lost the headline.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 03 · dense
   Context Recall       0.700   did we fetch the needed facts?
   Context Precision    0.821   relevant context ranked high?
   Faithfulness         0.785   grounded, no hallucination?
   Answer Relevancy     0.629   answers the actual question?
   Retrieval hit-rate   0.560   ≥1 expected form retrieved
   Avg latency          0.85s   per question, end-to-end

📊 RAGAS scorecard — 03 · sparse (BM25)
   Context Recall       0.850   did we fetch the needed facts?
   Context Precision    0.739   relevant context ranked high?
   Faithfulness         0.895   grounded, no hallucination?
   Answer Relevancy     0.656   answers the actual question?
   Retrieval hit-rate   0.660   ≥1 expected form retrieved
   Avg latency          1.30s   per question, end-to-end

📊 RAGAS scorecard — 03 · hybrid (RRF)
   Context Recall       0.730   did we fetch the needed facts?
   Context Precision    0.852   relevant context ranked high?
   Faithfulness         0.865   grounded, no hallucination?
   Answer Relevancy     0.648   answers the actual question?
   Retrieval hit-rate   0.580   ≥1 expected form retrieved
   Avg latency          1.36s   per question, end-to-end

```

## Summary

Hybrid search runs a meaning-based retriever and a word-based retriever side by side, then fuses their rankings by position so their incomparable scores stop mattering. When their blind spots are genuinely opposite, you cover both failure modes at once, the dense translator handling paraphrase and the sparse clerk nailing exact tokens like `1040-NR`. When one retriever already owns your corpus, as BM25 owned our identifier-heavy IRS forms, fusing can quietly water down the winner. The mechanism is simple; whether it helps is an empirical question you have to ask of your own data.

- A dense retriever matches meaning (cosine similarity); a sparse retriever (BM25) matches exact words. Their blind spots are opposite.
- RRF fuses two lists by position, `score += 1 / (k + rank)`, so it never needs the scores to be comparable and needs no tuning.
- You store dense and sparse vectors in one Qdrant collection (`enable_hybrid=True`, `fastembed_sparse_model="Qdrant/bm25"`) and pick the mode at query time.
- On our corpus, pure BM25 won recall (0.85), faithfulness (0.90), and hit-rate (0.66); hybrid sat in the middle.
- Fusion helps when strengths are complementary and is a wash when one retriever already nearly solves the task.
- Hybrid still went forward because it kept the dense channel alive, had the best precision, and feeds a reranker the diverse shortlist it needs.

## What's next

Hybrid hands you a wide, diverse shortlist, but a wide shortlist is also a noisy one: the right chunk might be sitting at position four, not one. The next step is to add a second pass that re-reads the question against each candidate and reorders them by true relevance. That is what [a reranker](/blog/rag-reranking) does, and it is where the diverse hybrid shortlist finally pays off.
