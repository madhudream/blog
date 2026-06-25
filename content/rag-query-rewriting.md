---
title: How query rewriting helps (and hurts)
chapter: 5
kicker: Retrieval
reading: 11 min
---

# How query rewriting helps (and hurts)

Query rewriting is the idea that the question a user types is just a first draft of what you should actually search for. Instead of feeding the user's exact words into retrieval, you let the LLM reshape them into something that lands closer to the right document, and you search with that.

This matters because of a wall we keep hitting. Your Context Recall sits frozen, your reranker has nothing left to give, and the right document never even makes it into the shortlist. When ranking can't help you, the only lever left is the question itself. This is the chapter where our recall finally broke off a two-chapter plateau, and it came with a bill worth being honest about.

In this post, we will cover the following:

- Why your retrieval can be stuck even with hybrid search and a reranker in place
- The blunt insight: the user's words aren't always the best search
- Multi-query: casting a wider net with several phrasings
- HyDE: searching with a fake answer
- The one honesty trick that keeps the whole experiment fair
- What we measured on the IRS corpus, with exact numbers
- Why a real recall win can still be the wrong long-term choice
- Where we go next

## The wall we hit

For two chapters our Context Recall sat frozen at 0.73. We had added hybrid search, then a cross-encoder reranker, and neither one budged it. [The reranker chapter](/blog/rag-reranking) told us exactly why. A reranker can only reorder the shortlist it was handed. For the questions we keep missing, the right document was never *in* that shortlist to begin with. The ceiling is set by what retrieval pulls, and reordering a pool that lacks the answer cannot conjure the answer back in.

So if reordering can't help, there is only one place left to push. You stop touching how you *rank*, and you change what you *ask*. If the question the user typed doesn't surface the right document, send a better question.

## The blunt insight: the user's words aren't always the best search

Picture the villain we have been fighting all along — the IRS corpus, where the document that answers a question almost never uses the same words as the question. A user asks: *"If I live abroad and I'm not a citizen, which form do I file?"* The document that answers it talks about "nonresident alien individuals" and the form `1040-NR`.

Notice that the question and the answer share almost no vocabulary. The user wrote in plain English. The form is written in tax English. A literal search of the user's phrasing can sail right past the document that holds the answer, because the embedding of "non-citizen abroad" simply does not sit near the embedding of "nonresident alien individual."

A **query transform** is an LLM step that rewrites the user's question into one or more better search queries before retrieval runs. It is the recognition that the question is just your opening guess at what to search for, and the LLM can make better guesses. There are two common ways to do it, and we will look at both.

## Multi-query: cast a wider net

**Multi-query** is the transform where the LLM rewrites your one question into several different phrasings, you search with all of them, and you merge the results into a single pool. A **paraphrase** here is just one of those alternate phrasings — same meaning, different words.

The intuition is a wider net. Any single phrasing might miss the document. Four different phrasings, casting in slightly different directions, are far more likely to catch it between them. If "nonresident" doesn't land but "alien individual living abroad" does, that rewrite pulls in the `1040-NR` chunk the original could never reach. You are directly attacking the pool problem the reranker couldn't touch — you are making the shortlist contain the right document in the first place.

Here is the fan-out, with our non-citizen-abroad question going in:

```
"which form does a non-citizen abroad file?"
        │  LLM fans it out
        ▼
  ┌─ "nonresident alien filing requirements"
  ├─ "tax return for foreign individuals living abroad"
  ├─ "form 1040-NR who must file"
  └─ "US tax form for non-citizens with US income"
        │  search each, fuse the hits
        ▼
   one combined shortlist (wider, more diverse)
```

The code that does the fan-out is small. The LLM is asked for `n` alternative phrasings, one per line, and the original question is always prepended so the paraphrases can't completely take over the merge:

```python
def _multi_query(self, q: str) -> list[str]:
    raw = chat(_MULTI_SYS.format(n=self.n_multi), q)
    paraphrases = [line.strip() for line in raw.splitlines() if line.strip()]
    # ALWAYS include the original — paraphrases shouldn't dominate the merge.
    return [q] + paraphrases[: self.n_multi]
```

That `[q] + paraphrases` line is doing quiet work. The original question stays in the search set, so even if every rewrite drifts, the user's real intent is still being searched for directly.

## HyDE: search with a fake answer

The second transform is cleverer and a little strange. **HyDE** (Hypothetical Document Embeddings) does not rewrite the *question* at all. It asks the LLM to write a hypothetical *answer* to the question — a made-up paragraph of what the answer might say — and then you search with that paragraph.

Why on earth would searching with a fabricated answer help? Because a hypothetical answer lives in the same *vocabulary and style* as the real document. A terse question and a dense tax paragraph look quite different to an embedding. A plausible fake answer and the real answer look very similar. For the non-citizen-abroad case, the LLM might invent a paragraph full of "nonresident alien," "Form 1040-NR," and "effectively connected income" — exactly the tax English the real document uses. The fake answer is a better-shaped probe into meaning-space than the bare question ever was, even when the fake answer gets its facts slightly wrong.

The prompt that drives it is unapologetic about this — it explicitly tells the model the paragraph does not need to be correct, because it exists only to steer retrieval. The honesty there is deliberate: HyDE is trading factual accuracy of the probe for vocabulary match, and that trade is the whole reason it works.

## The one trick that keeps the experiment honest

Both transforms change *only* the query that goes into retrieval. They do not change what the reranker sees, and they do not change what the generator answers. This is the single most important detail in the whole chapter.

Look at the `answer()` flow. The query gets reshaped, retrieval runs once per query and unions the results, but then the reranker and the generator both go back to the **original question**:

```python
def answer(self, question: str) -> dict:
    # 1. RESHAPE the query (or queries) using the LLM.
    queries = self._transform(question)

    # 2. RETRIEVE for each; union by node id, keep the best score.
    pool: dict[str, object] = {}
    for q in queries:
        for n in self.retriever.retrieve(q):
            k = n.node.node_id
            if k not in pool or (pool[k].score or 0) < (n.score or 0):
                pool[k] = n

    # 3. RERANK with the ORIGINAL question — that's the real user intent.
    reranked = self.reranker.postprocess_nodes(
        list(pool.values()), query_bundle=QueryBundle(query_str=question)
    )
    # 4. GENERATE — answer the ORIGINAL question from the reranked context.
```

The reranker scores the merged pool against the question the user actually typed, not against any paraphrase or hypothetical. The generator answers the user's real question, never the transform. The transforms exist purely to widen the net during retrieval, and then you snap straight back to the user's true intent. That separation is what makes the recall delta attributable to retrieval alone — if recall moves, you know it moved because the right documents reached the pool, not because you quietly changed the question being graded.

## What we measured

Both transforms run on top of the same hybrid + reranker stack from the previous chapter. The only thing that changes is the query transform. Same IRS corpus, same questions, same generator.

| config | Recall | Precision | Faithfulness | latency |
|---|---|---|---|---|
| rerank only | 0.73 | 0.851 | 0.909 | 2.56s |
| **+ multi-query** | **0.78** | 0.852 | 0.909 | 6.50s |
| + HyDE | 0.78 | 0.849 | 0.815 | 4.12s |

Read that table slowly, because every column is telling you something.

**Multi-query moved recall 0.73 → 0.78.** That is the first recall gain in two chapters. The wider net worked exactly as the intuition predicted: more phrasings reached more of the right documents, so the shortlist finally started containing the chunks we had been missing — the `1040-NR` kind of chunk that the user's plain English could never reach. Faithfulness held at 0.909. Precision held. This is a clean, real gain on the one metric that had been stuck.

Now look at the latency column for multi-query: **2.56s → 6.50s.** It more than doubled. Of course it did. Every query now triggers an LLM call to generate the rewrites, *and then* runs retrieval four times instead of once. That cost is not a one-time setup expense. It is paid on **every single request, forever.** You did not buy this recall gain. You are renting it, and the rent comes due on every call your users ever make.

**HyDE matched the recall at 0.78 but quietly damaged faithfulness, 0.909 → 0.815.** This is the "hurts" in the title, and it is instructive. HyDE's probe is, by construction, a *made-up* answer. When that fabricated text leaks into the retrieved context and the model leans on it, grounding suffers — the system starts trusting its own guess instead of the document. On a tax assistant, where a confidently wrong answer about which form a non-citizen files is worse than no answer at all, trading away faithfulness for recall is a bad deal. HyDE was out.

## A good fix can still be the wrong one

Multi-query was the right idea *for this moment*. It was the only lever we had to widen the pool, and it delivered a genuine recall gain that nothing else had managed. You should reach for it when your right documents exist but your phrasing can't find them.

Step back and look at what it costs, though. An LLM rewrite plus four retrievals, on every query, indefinitely. The gain is real, but the bill never stops arriving. That framing is the whole setup for the next chapter, because there is another way to make sure the right document is in the pool.

Instead of reshaping the *question* every time someone asks, you can reshape the *documents* once, when you index them. You pay the cost a single time at build, not forever at query. When [contextual retrieval](/blog/rag-contextual-retrieval) did exactly that — matching this recall at a fraction of the latency — we removed query rewriting entirely. A good idea, retired by a better one. That is exactly what a scorecard is for.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 05 · rerank only
   Context Recall       0.730   did we fetch the needed facts?
   Context Precision    0.851   relevant context ranked high?
   Faithfulness         0.909   grounded, no hallucination?
   Answer Relevancy     0.643   answers the actual question?
   Retrieval hit-rate   0.600   ≥1 expected form retrieved
   Avg latency          2.56s   per question, end-to-end

📊 RAGAS scorecard — 05 · + multi-query
   Context Recall       0.780   did we fetch the needed facts?
   Context Precision    0.852   relevant context ranked high?
   Faithfulness         0.909   grounded, no hallucination?
   Answer Relevancy     0.665   answers the actual question?
   Retrieval hit-rate   0.660   ≥1 expected form retrieved
   Avg latency          6.50s   per question, end-to-end

📊 RAGAS scorecard — 05 · + HyDE
   Context Recall       0.780   did we fetch the needed facts?
   Context Precision    0.849   relevant context ranked high?
   Faithfulness         0.815   grounded, no hallucination?
   Answer Relevancy     0.642   answers the actual question?
   Retrieval hit-rate   0.620   ≥1 expected form retrieved
   Avg latency          4.12s   per question, end-to-end

```

## Summary

You stop treating the user's exact words as the search and treat them as a first draft. Multi-query fans the question into several phrasings and casts a wider net. HyDE searches with a hypothetical answer that is shaped more like the target document. Both can pull in documents a literal search misses, and both make the LLM work *before retrieval even starts*, so you pay in latency on every call.

- Reranking is capped by what retrieval pulls; when the right document isn't in the pool, you have to fix the question, not the ranking.
- Multi-query lifted recall 0.73 → 0.78 with faithfulness and precision held — a real, clean win on the IRS corpus.
- That win cost latency 2.56s → 6.50s, paid on every request forever. You rent the gain; you don't buy it.
- HyDE matched the recall but dropped faithfulness 0.909 → 0.815, because a fabricated probe can leak into the context. Bad trade for a tax assistant.
- The reranker and the generator always see the ORIGINAL question. Only retrieval is shifted, which is what keeps the recall delta honest.

## What's next

Multi-query fixes the question every single time someone asks one. The next chapter asks the obvious follow-up: what if you fix the *documents* once instead? In [contextual retrieval](/blog/rag-contextual-retrieval), we rewrite each chunk at index time so it carries its own context — so the `1040-NR` chunk already reads like the answer to "non-citizen living abroad" before any user types a thing. Pay once at build, not forever at query. It matched this recall at a fraction of the latency, and it is why query rewriting did not survive the scorecard.
