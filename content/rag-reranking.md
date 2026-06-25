---
title: How does a reranker work?
chapter: 4
kicker: Retrieval
reading: 13 min
---

# How does a reranker work?

A reranker takes the rough pile of documents your search pulled back and reorders it so the ones that truly answer the question rise to the top. It is a second reader you let look at the shortlist before the answer gets written: slower than your search, but with far better judgement.

That sounds like a minor tweak. It is not. In a RAG system the language model only ever reads the top few chunks you hand it, and a confident answer built on the wrong chunk is worse than no answer at all. A reranker's whole job is to make sure those top few are the right few. By the end of this post you will know exactly how it does that, why it works, and the one thing it fundamentally cannot do, which we will prove with real numbers.

In this post, we will cover the following:

- The look-alike retrieval failure that motivates the whole idea
- Where a reranker sits in the retrieve-augment-generate pipeline
- The two-stage hiring-funnel pattern and why two different models exist
- Bi-encoders vs cross-encoders, and why one is fast while the other is sharp
- How to wire a FlashRank cross-encoder into a two-stage query engine
- What a reranker actually did to a real system, measured on 50 golden questions
- The price you pay in latency, and when not to reach for a reranker at all
- The rerankers you can use today and a late-interaction middle ground

## First, feel the problem

Here is a real failure from our corpus of 1,400 IRS tax forms. You ask the system:

> "What is Form 1040 used for?"

and it confidently retrieves `i1040gi`, the instructions for Form 1040, instead of `f1040`, the form itself. Then it answers out of the instruction booklet, or worse, says it does not know.

Why does this happen? To a search engine that works by meaning, "Form 1040" and "Instructions for Form 1040" are almost the same thing. They share nearly every word. They sit in nearly the same place in meaning-space. The search is not broken. It is doing exactly what it was built to do, which is find things that mean something similar. It just has no way to know you wanted the form, not the manual about the form.

Hold onto `f1040` vs `i1040gi`. It is the villain of this whole post, and everything below is about beating it.

## Where a reranker sits

A RAG pipeline is three moves: retrieve relevant chunks, augment the prompt with them, generate an answer. The reranker slips in as a filter between the first two.

```
question
   │
   ▼
retrieve top-20        ← fast, runs over ALL 38,000 chunks
   │  (20 rough candidates)
   ▼
RERANK → keep top-4    ← slow, runs over only those 20
   │  (4 precise chunks)
   ▼
LLM writes the answer
```

Notice the two jobs are different. Retrieval is responsible for recall, which means out of everything in the corpus, do not miss the right document. Reranking is responsible for precision, which means out of what we found, put the best ones first. Two jobs, and as you will see, two completely different kinds of model.

## The two-stage idea: a hiring funnel

Think about how a company hires for one open role when 200 people apply.

Nobody interviews 200 candidates. That would take months. Instead there are two stages. First, a recruiter does a fast scan of all 200 résumés, a keyword match against the job description, a few seconds each. It is shallow and it makes mistakes, but it is cheap enough to run over everyone, and it narrows 200 down to maybe 10. Then a hiring manager does the slow, careful part: a real interview with each of those 10, reading the candidate and the role together, and ranks them.

That is exactly the shape of modern retrieval. The recruiter is your first-stage search: fast, shallow, runs over the whole corpus. The hiring manager is the reranker: slow, sharp, runs over only the shortlist. You cannot afford to interview everyone, and you cannot afford to hire off a keyword scan. So you do both, in that order. This is the heart of reranking, and it is the whole reason two different models exist.

## Why the first stage is fast but shallow

To run over 38,000 chunks in milliseconds, first-stage search has to do something clever ahead of time. It converts every chunk into an embedding, a single vector that captures its meaning, and stores all of them. At query time it converts your question into a vector too, and just looks for the nearest stored vectors. It is fast because the hard work was done in advance.

Look closely at what that speed costs. The question and each document are turned into vectors completely separately. The model that embeds a chunk never sees your question. The model that embeds your question never sees the chunk. They only ever meet as two finished vectors, compared by distance. A whole paragraph of nuance gets compressed into one point in space, and a lot of fine detail is lost in that compression, including, fatally, the difference between a form and its instructions.

This is called a bi-encoder: two separate encodings, compared at the end. It is why `f1040` and `i1040gi` look like twins to your search.

## The core idea: cross-encoders read them together

A reranker is built the opposite way. It is a cross-encoder: it takes the question and one document and feeds them through a single model at the same time. Now every word of your question can look at every word of the document and vice versa. The model is not comparing two frozen summaries. It is actively reading the document with your question in mind, the way the hiring manager reads a résumé with the specific role in mind.

That joint reading is why a cross-encoder can finally tell `f1040` from `i1040gi`. It can notice that one is the form you fill in and the other is the booklet that explains it, because it is reading the question "what is the form used for" right alongside the text. The detail the bi-encoder compressed away is exactly the detail the cross-encoder recovers.

The catch, and the reason we do not just use cross-encoders for everything, is speed. Because it needs the question to do its work, a cross-encoder cannot pre-compute anything. It has to run, live, on every (question, document) pair. Doing that across 38,000 chunks per query would take seconds and cost a fortune. So we never do. We let the cheap bi-encoder narrow the field to about 20, and spend the expensive cross-encoder only there.

| | Bi-encoder (search) | Cross-encoder (reranker) |
|---|---|---|
| Reads question + doc together? | No — encoded apart | **Yes — together** |
| Can pre-compute doc vectors? | Yes, once | No — needs the live query |
| Speed | Very fast | Slow |
| Accuracy | Rough | High |
| Runs over | The whole corpus | A small shortlist |

The bi-encoder is built for scale. The cross-encoder is built for judgement. A good system uses each for what it is good at.

## Watch it score, up close

Enough abstraction. Run the failing example through a real cross-encoder. We use FlashRank, a tiny local cross-encoder. We give it the question and three candidate chunks, and it returns a relevance score from 0 to 1 for each.

```
query: "What is Form 1040 used for?"

  0.993   f1040     "Form 1040, U.S. Individual Income Tax Return…"
  0.960   i1040gi   "Instructions for Form 1040 and 1040-SR…"
  0.000   fw4       "Form W-4, Employee's Withholding Certificate…"
```

The form scores 0.993 and its instruction booklet 0.960. The cross-encoder put the actual form on top, the exact distinction the bi-encoder could not make, recovered because it read each candidate with the question. The unrelated W-4 gets a flat zero. This is the mechanism working perfectly on one example, with our villain finally sorted the right way around.

## Wiring it in: FlashRank as a postprocessor

FlashRank is a tiny ONNX cross-encoder runtime. ONNX just means a portable, optimized model format that runs fast on plain CPU, so there is no GPU and no API to call. The default model is `ms-marco-MiniLM-L-12-v2`, a 22 MB cross-encoder trained on passage relevance, exactly the shape of our job.

In LlamaIndex a reranker is a node postprocessor: it receives the retrieved nodes and returns a reordered, trimmed list. Here is the core of that postprocessor, faithful to the real code. We hand FlashRank the candidates with stable integer ids, ask it to rerank, and keep the top few.

```python
from flashrank import Ranker, RerankRequest

ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2", cache_dir=".cache/flashrank")

passages = [{"id": i, "text": n.node.get_content(), "meta": {}} for i, n in enumerate(nodes)]
scored = ranker.rerank(RerankRequest(query=query_bundle.query_str, passages=passages))

# `scored` comes back sorted descending by cross-encoder relevance.
out = []
for s in scored[: self.top_n]:
    n = nodes[int(s["id"])]
    n.score = float(s["score"])   # replace bi-encoder score with the cross-encoder's
    out.append(n)
return out
```

Now the two-stage wiring. The trick is that when reranking is on, you ask the retriever for more chunks up front, then trust the cross-encoder to pick the best handful. You retrieve 20, you keep 4.

```python
postprocessors = [FlashRankReranker(top_n=4)]
query_engine = index.as_query_engine(
    vector_store_query_mode="hybrid",
    similarity_top_k=20,                # broad first-stage net
    node_postprocessors=postprocessors, # tight cross-encoder second stage
    response_mode="compact",
)
```

That `similarity_top_k=20` with `top_n=4` is the whole retrieve-20-then-rerank-4 pattern in two lines. The bi-encoder casts a wide net, the cross-encoder tightens it. Now the honest question, the one this whole series is built to answer: what does it do to a real system, measured properly?

## What it actually did, and the twist

We added the reranker to our pipeline as the only change, with the same chunks and the same search underneath, and re-scored on 50 golden questions over the full corpus.

| config | Recall | Precision | Faithfulness | hit-rate | latency |
|---|---|---|---|---|---|
| search only | 0.730 | 0.852 | 0.865 | 0.58 | 1.36s |
| **+ reranker** | **0.730** | 0.851 | **0.909** | 0.60 | 2.56s |

Read the recall column. It moved from 0.730 to 0.730. Exactly nothing. And latency nearly doubled.

If you only knew the marketing, that is baffling, because the reranker is supposed to make retrieval better. Go back to the one sentence we anchored at the start: a reranker can only reorder the pile it was handed. It cannot go back into the stacks. Recall asks whether the chunks we showed the model actually contained the needed facts. For the questions we still miss, the right form simply is not in the top-20 that search pulled, so there is nothing for the reranker to promote. The recall ceiling is set upstream, by search, and the reranker lives downstream of it. Expecting it to lift recall was asking the hiring manager to recruit candidates who never applied.

Now read the column that did move: faithfulness, 0.865 to 0.909, the best in our series to that point. This is precisely what reordering can do. Once the look-alike `i1040gi` booklets are pushed out of the top-4, the model is left with cleaner, more on-target context, so it stops hedging and stops hallucinating. The reranker did not find new facts. It made sure the facts we already had were the ones the model actually read.

That is the real lesson, and it is more useful than a clean win would have been: a reranker is a precision-and-grounding tool, not a recall tool. Reach for it when your retrieval finds the right documents but ranks them poorly. Do not reach for it when your retrieval is missing documents entirely. That is a different fix, and it is the next chapter.

## The price: latency and cost

Every reranked query runs that slow model over about 20 candidates before the LLM even starts writing. For us that was the jump from 1.36s to 2.56s. The wider the shortlist you rerank, the better the ordering and the slower the response, a dial you tune to your latency budget.

On a tax assistant, where a confidently wrong answer is the worst outcome, the faithfulness gain was clearly worth a second. On a high-traffic, latency-critical endpoint, you might rerank a smaller pool, or only on the hard questions. There is no universal answer, only the one your own measurements give you.

The other thing to be explicit about: the reranker is powerless when the docs are missing from the pool. If `f1040` never made it into the top-20, no amount of cross-encoder judgement can promote it, and you have spent a second of latency for nothing. The reranker is the right tool only once the right document is already somewhere in the candidate list.

## A middle ground: late interaction (ColBERT)

There is a third option between the two encoders. Late-interaction models, of which ColBERT is the well-known one, embed the question and document as many token-level vectors instead of one each, then compare them with a cheap best-match step at query time. You keep some of the cross-encoder's word-level sensitivity while keeping most of the bi-encoder's speed, at the cost of a much larger index. It is the right tool when a full cross-encoder is too slow but a single-vector search is too blunt.

## Rerankers you can actually use

- **FlashRank** — tiny local cross-encoders (ONNX MiniLM). No GPU, no API. What we used.
- **Cohere Rerank** — a strong hosted reranking API; the common production default.
- **bge-reranker** — open-weight cross-encoders you can self-host.
- **Jina / Voyage rerankers** — competitive hosted alternatives.

They are nearly drop-in. You retrieve a wide pool, pass `(query, candidates)` to the reranker, and keep the top few it returns.

## So, how does a reranker work?

You retrieve a rough, generous shortlist with a fast bi-encoder that judges every document and the question separately. Then you hand that shortlist to a slow cross-encoder that reads each document together with the question and re-sorts them by true relevance, and you keep only the best few. The first model gives you reach. The second gives you judgement. That is how `f1040` finally lands above `i1040gi` in the top-4.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 04 · hybrid (no rerank)
   Context Recall       0.730   did we fetch the needed facts?
   Context Precision    0.852   relevant context ranked high?
   Faithfulness         0.865   grounded, no hallucination?
   Answer Relevancy     0.648   answers the actual question?
   Retrieval hit-rate   0.580   ≥1 expected form retrieved
   Avg latency          1.36s   per question, end-to-end

📊 RAGAS scorecard — 04 · + reranker
   Context Recall       0.730   did we fetch the needed facts?
   Context Precision    0.851   relevant context ranked high?
   Faithfulness         0.909   grounded, no hallucination?
   Answer Relevancy     0.643   answers the actual question?
   Retrieval hit-rate   0.600   ≥1 expected form retrieved
   Avg latency          2.56s   per question, end-to-end

```

## Summary

A reranker is the careful second reader that reorders your shortlist by reading each candidate with the question in mind. It is brilliant at precision and grounding, and powerless at recall, because it never goes back into the stacks for documents your search missed.

- Retrieval owns recall; reranking owns precision. They are two jobs and two different models.
- A bi-encoder encodes the question and document apart, which is fast but blurs look-alikes like `f1040` and `i1040gi`.
- A cross-encoder reads them together, which is slow but tells the form from its instructions.
- Retrieve a broad top-20, rerank to a tight top-4: `as_query_engine(similarity_top_k=20, node_postprocessors=[FlashRankReranker(top_n=4)])`.
- On 50 golden questions the reranker lifted faithfulness from 0.865 to 0.909 and left recall flat at 0.730, for a latency cost of 1.36s to 2.56s.
- Use it when the right docs are in the pool but mis-ranked; do not use it to fix a pool that is missing the right docs.

## What's next

The reranker did everything it could and recall still would not budge, because the problem is upstream: sometimes the right form never enters the candidate pool at all. The fix is not a better reranker, it is fixing the pool itself, by changing the question we send to search. That is [query rewriting](/blog/rag-query-rewriting), where we go next.
