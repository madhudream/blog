---
title: What is Answer Relevancy?
chapter: Measurements
kicker: Measurements
reading: 7 min
---

# What is Answer Relevancy?

> *A response can be perfectly grounded in real context and still answer the wrong question. Relevancy catches the helpful-sounding miss.*

💡 **In one line:** answer the actual question.

**Answer Relevancy** is the second *generation* metric in the [RAG scorecard](/blog/rag-measuring-rag). [Faithfulness](/blog/measure-faithfulness) makes sure the answer didn't invent anything; relevancy makes sure the answer is actually **about the question you asked** — complete, on-topic, and not padded with detours.

It catches the answer that is technically true but unhelpful: the kind that recites what Form 1040-NR is when you asked about Form 1040, or that buries the one line you needed under three paragraphs you didn't.

## The intuition: "did it answer *my* question?"

Three things can go wrong even with a faithful answer:

- **Off-topic** — it drifts to a neighbouring question.
- **Incomplete** — it answers half of what you asked.
- **Padded** — it's stuffed with hedging and filler that dilutes the point.

Relevancy is low for all three. On the IRS corpus, a low-relevancy answer might correctly describe a form's *purpose* when the user clearly asked *how to fill in line 12* — grounded, but beside the point.

## How it's scored

RAGAS (`ResponseRelevancy`) scores this with a clever reverse trick: it asks an LLM to generate several questions that the **answer** would be a good response to, then measures how close those reconstructed questions are to the *original* question using cosine similarity (how close two pieces of text point in meaning — 1.0 identical, 0 unrelated).

```
Answer Relevancy = average cosine similarity between the original question
                   and the questions an LLM reverse-generates from the answer
```

Scored 0..1, higher is better. The logic: if the answer truly addresses your question, an LLM reading only the answer should be able to guess your question back. If it can't, the answer wandered.

## What good and bad look like

Naive RAG starts at the *lowest* score on the whole scorecard — **0.584 answer relevancy** — because with weak, noisy context the model often hedges or answers a near-miss question. As the retrieval stages improve the context ([hybrid search](/blog/rag-hybrid-search), [reranking](/blog/rag-reranking), [contextual retrieval](/blog/rag-contextual-retrieval)), the model has cleaner material to work from and its answers land on-target far more often.

This is the metric that most reveals a quiet truth of RAG: **fixing retrieval fixes generation.** Better context doesn't just stop hallucinations — it lets the model answer the actual question.

## The trap: relevancy without faithfulness

Relevancy and [faithfulness](/blog/measure-faithfulness) are a pair, and you need both. An answer can be perfectly on-topic and entirely **made up** (high relevancy, low faithfulness), or perfectly grounded and **beside the point** (high faithfulness, low relevancy). Either alone ships a bad assistant. The full [scorecard](/blog/rag-measuring-rag) tracks all four metrics precisely because each one hides a failure the others can't see.

---

**Part of the [Measurements](/topic/measurements) series.** Start with the overview: [how to measure a RAG system](/blog/rag-measuring-rag), then see the metrics in action across the [RAG climb](/blog/rag-the-whole-story).
