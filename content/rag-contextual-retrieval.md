---
title: How does contextual retrieval work?
chapter: 6
kicker: Indexing
reading: 12 min
---

# How does contextual retrieval work?

Contextual retrieval is a technique where, before you embed a chunk, you ask the LLM to write a one-line "you are here" note about that chunk and glue it to the front. A chunk is a small slice of a document, and an embedding is the numeric fingerprint of meaning you search against. The note tells search where the chunk came from, so the chunk can finally describe itself.

Why does this matter so much? Because it fixes the deepest weakness in your whole pipeline — chunks that forgot which document they belong to — and it fixes it once, when you build the index, instead of forever, on every query. On the IRS corpus, this single change beat the expensive per-query trick from the [last chapter](/blog/rag-query-rewriting) on every metric, and it was cheaper. This was the biggest win in the series.

In this post, we will cover the following:

- Why a chunk loses its identity the moment you slice it
- The orphaned `f1040nr` chunk, and why search sails right past it
- The fix: a one-line header, written by the LLM, glued on before you embed
- Why you pay for this once at index time, not forever per query
- The one honest compromise: per-document context vs per-chunk context
- The code: one LLM call per document, returning a JSON array of contexts
- The key move: context that is embedded with the chunk but hidden from the generator
- The results, with exact numbers — and why precision and faithfulness leapt
- The satisfying ending where we delete a whole component

## A chunk with amnesia

Go back to how chunking works. You slice a document into pieces and embed each piece on its own. That slicing has a hidden cost you have been paying the whole time: a chunk forgets which document it came from. An orphaned chunk is a piece of text that no longer carries any reference to its parent — its form, its section, its topic are all gone.

Picture a chunk pulled from the middle of the nonresident return, `f1040nr`:

> "Line 8: enter the amount from Schedule NEC, line 15…"

Read that cold. Which form is it from? You cannot tell. Is it about nonresidents? No way to know. The one fact that would make this chunk findable — that it belongs to Form 1040-NR — lived in the document's title and header, three pages up, and the slicing threw it away.

When you embed this chunk, you embed an orphan. A user asking "what does a nonresident file?" sails right past it, because nothing in the chunk's text says "nonresident." This is the same villain from every chapter, seen from a new angle. It is not that search is dumb. You handed search a chunk that does not describe itself.

## The fix: give every chunk a header before you embed it

The idea is almost embarrassingly simple once you see the problem. Before you embed a chunk, show it to the LLM along with its parent document and ask one question: in one line, where does this chunk live and what is it about? Then you prepend that line to the chunk.

Here is the orphan before and after:

```
BEFORE  (what we used to embed):
   "Line 8: enter the amount from Schedule NEC, line 15…"

AFTER  (what we embed now):
   "Form 1040-NR, U.S. Nonresident Alien Income Tax Return — this part
    covers reporting income not effectively connected with a US trade.
    Line 8: enter the amount from Schedule NEC, line 15…"
```

That is it. The orphan now carries its own identity. Its embedding lands near "nonresident return" in meaning-space, and a keyword search can finally match "1040-NR" because those characters literally appear in the text now. The bare, invisible line became a self-describing, findable fact — and you never touched the user's question to do it.

This is not a brand-new idea you have to take on faith. Anthropic published the technique in September 2024 and reported how much it cut the retrieval failure rate versus naive RAG: contextual embeddings alone gave a -35% reduction, contextual embeddings plus BM25 (the keyword half of hybrid search, which you already run) gave -49%, and adding [the reranker](/blog/rag-reranking) on top gave -67%. Those are big, real numbers from a controlled study, and they map cleanly onto the stack you have already built.

## Pay once, not forever

Here is the part to really absorb, because it is the reason this chapter beats the last one.

The previous chapter fixed the same "the right document never made it into the pool" problem by rewriting the question — and that cost an LLM call plus four retrievals on every query, forever. Index time is when you build your search index, once, before any user shows up. Query time is when a user asks something, and you pay for whatever you do there on every single request.

Contextual retrieval fixes the orphan problem at index time. It rewrites the documents, once, when you build the index. After that, every query is cheap again. You move the LLM work from query time, where you pay endlessly, to index time, where you pay once. Same problem, fundamentally cheaper place to solve it. When you can choose where to spend a cost, prefer the place you pay it once.

## One honest compromise

I want to be straight with you about a trade we made. The original technique, as Anthropic published it, situates every chunk with its own LLM call. On the IRS corpus that is 38,000 calls — and the first time we tried it, that saturated the rate limit and drained the API budget mid-run. So we use the scalable variant: one situating summary per document, about 1,400 calls, roughly 27x fewer, prepended to all of that document's chunks.

Is that cheating? A little — but it is an honest, deliberate trade. On a corpus where the core problem is document identity ("which form is this?"), a per-document summary captures most of the benefit, because every chunk of `f1040nr` wants the same header anyway: this is the nonresident return.

When would you reach for the full per-chunk version instead? When your chunks vary wildly within a single document — a long, heterogeneous report where page 2 is about revenue and page 80 is about litigation risk. There, one summary cannot place every chunk, and you would pay for the per-chunk calls because they earn their keep. Know your corpus, then pick the variant that fits it.

## The code: one LLM call per document

Let me show you how cheap this actually is in code. For each document, you send the whole document plus all of its chunks in a single call, and you ask the model to return a JSON array with one short context per chunk, in order.

```python
def _gen_contexts_for_doc(doc_text: str, chunks: list[str]) -> list[str]:
    n = len(chunks)
    chunk_block = "\n\n".join(f"CHUNK {i + 1}: {c[:400]}" for i, c in enumerate(chunks))
    user = (
        f"DOCUMENT:\n{doc_text}\n\n"
        f"CHUNKS ({n} total):\n{chunk_block}\n\n"
        f"For EACH chunk, write ONE short sentence (max 25 words) that places it "
        f"within the document — what form, what section, what topic. Return a JSON "
        f"array of EXACTLY {n} strings in the same order as the chunks."
    )
    raw = chat(_CONTEXT_SYS, user, temperature=0.0).strip()
    arr = json.loads(raw)
    return [str(x).strip() for x in arr]
```

One call, one document, N contexts back. That is the whole reason the per-document variant is 27x cheaper than per-chunk: you amortize a document's worth of chunks over a single round trip. For very long documents you truncate to the first 16k tokens of context — enough to place the chunks, not enough to bill you for a novel.

## The key move: embed it, but hide it from the generator

Now the subtle part, and the one most people get wrong. The context you generated is meant for the embedding model, not for the model that writes the final answer. If the generator saw your synthetic "this is the nonresident return" line, it might quote it or drift onto LLM-invented context that was never in the real document.

LlamaIndex lets you control this per metadata key on a `TextNode`. You put the context in metadata, then you exclude it from the LLM's view while including it in the embedded text.

```python
TextNode(
    text=c.get_content(),
    metadata={"doc_id": doc_id, "source": source, "context": ctx},
    # KEY MOVE: context is EMBEDDED with the chunk but HIDDEN from the LLM.
    excluded_embed_metadata_keys=["doc_id", "source"],
    excluded_llm_metadata_keys=["context", "source"],
)
```

Read those last two lines slowly. The `context` key is absent from `excluded_embed_metadata_keys`, so it goes into the embedding — that is what lifts retrieval. The `context` key is present in `excluded_llm_metadata_keys`, so the generator never sees it — that is what keeps your answers grounded in the real text. The chunk you search for is augmented; the chunk you answer from is the clean original. You get the recall lift without paying for it in hallucinations.

## What it did — the cheap fix wins outright

We ran contextual retrieval on the same hybrid plus reranker stack from earlier chapters, and we also tried stacking the previous chapter's multi-query on top of it, to see if they compound.

| config | Recall | Precision | Faithfulness | latency |
|---|---|---|---|---|
| rerank + multi-query (Ch 5) | 0.78 | 0.852 | 0.909 | 6.50s |
| **contextual (Ch 6)** | **0.83** | **0.945** | **0.968** | **2.56s** |
| contextual + multi-query | 0.83 | 0.923 | 0.956 | 5.54s |

Read the middle row. Contextual retrieval, by itself, beat last chapter's multi-query on recall (0.83 vs 0.78), precision (0.945 vs 0.852), and faithfulness (0.968 vs 0.909) — at 2.56 seconds instead of 6.50. Cheaper and better on every axis.

## Why precision and faithfulness leapt, not just recall

The recall gain you can predict — self-describing chunks are easier to find. But look at how hard precision (0.85 to 0.95) and faithfulness (0.91 to 0.97) jumped. Those are the biggest single-chapter gains in the series, and they come from a nice second-order effect.

Remember the whole saga of `f1040` versus `i1040gi` — the form versus its look-alike instruction booklet. Once each chunk announces its own identity in its text, the reranker can finally tell them apart cleanly, because the distinguishing words are right there for it to read. So the top-4 it produces is less polluted with near-duplicates, which means the model sees cleaner context, which means it hallucinates less.

Fixing the chunks did not just help search find them — it made every downstream layer sharper. The same logic explains the `f1040nr` orphan: once its chunk says "nonresident return" out loud, it stops competing with the resident `f1040` chunks that used to crowd it out. Good context is upstream of everything.

## When the right move is to remove a component

The bottom row of the table is the quiet hero. Stacking multi-query on top of contextual did not help — same recall, and precision, faithfulness, and answer relevancy all slipped, while latency climbed back to 5.54s. Contextual had already cleaned up the pool, so the extra rewrites just dragged borderline chunks back in.

So we deleted multi-query from the pipeline. Think about how satisfying that is: the system got simpler and better at the same time. We retired a whole component — and its permanent per-query cost — because a cheaper idea did its job better. That is the best outcome a chapter can have, and you only ever find it by measuring whether your shiny components still earn their place.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 06 · multi-query (Ch5)
   Context Recall       0.780   did we fetch the needed facts?
   Context Precision    0.852   relevant context ranked high?
   Faithfulness         0.909   grounded, no hallucination?
   Answer Relevancy     0.665   answers the actual question?
   Retrieval hit-rate   0.660   ≥1 expected form retrieved
   Avg latency          6.50s   per question, end-to-end

📊 RAGAS scorecard — 06 · contextual
   Context Recall       0.830   did we fetch the needed facts?
   Context Precision    0.945   relevant context ranked high?
   Faithfulness         0.968   grounded, no hallucination?
   Answer Relevancy     0.713   answers the actual question?
   Retrieval hit-rate   0.680   ≥1 expected form retrieved
   Avg latency          2.56s   per question, end-to-end

📊 RAGAS scorecard — 06 · contextual+multi
   Context Recall       0.830   did we fetch the needed facts?
   Context Precision    0.923   relevant context ranked high?
   Faithfulness         0.956   grounded, no hallucination?
   Answer Relevancy     0.688   answers the actual question?
   Retrieval hit-rate   0.720   ≥1 expected form retrieved
   Avg latency          5.54s   per question, end-to-end

```

## Summary

You hand each chunk a one-line header that says where it lives and what it is about, written by the LLM, glued on before you embed. The orphaned `f1040nr` chunk becomes self-describing, so search finds it and the reranker stops confusing it with its resident-form neighbors — and because you do this once at index time, every query stays cheap forever.

- A chunk forgets its document the moment you slice it; an orphan like `f1040nr`'s "Line 8…" is unfindable because nothing in it says "nonresident."
- The fix is a one-line LLM-written context, prepended before embedding — Anthropic reports -35% / -49% / -67% failure-rate reductions as you stack it with hybrid and reranking.
- You pay for it once at index time, not forever per query — that is why it beats query rewriting.
- One LLM call per document returns a JSON array of contexts: ~1,400 calls instead of 38,000, an honest compromise that fits an identity-driven corpus.
- Embed the context with the chunk but hide it from the generator, via `excluded_llm_metadata_keys`, so recall lifts without hurting grounding.
- Contextual alone hit 0.83 recall, 0.945 precision, 0.968 faithfulness at 2.56s — better and cheaper than multi-query — so we deleted multi-query.

## What's next

Accuracy is, for our purposes, solved. The harder question now is economics: you have a pipeline that retrieves well, but you are still paying for an LLM call on every query, and many of those queries are near-duplicates of ones you have already answered. The next move is not about finding better chunks — it is about not doing the same expensive work twice. We will build [a semantic cache](/blog/rag-semantic-cache) that recognizes when a new question means the same thing as an old one, and serves the cached answer instead of paying for the whole pipeline again.
