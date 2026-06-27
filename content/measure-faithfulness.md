---
title: What is Faithfulness?
chapter: Measurements
kicker: Measurements
reading: 7 min
---

# What is Faithfulness?

> *Did the answer stick to what was retrieved, or did the model quietly invent some of it? Faithfulness is your hallucination detector.*

💡 **In one line:** don't make it up.

**Faithfulness** is the first of the two *generation* metrics in the [RAG scorecard](/blog/rag-measuring-rag). Retrieval can do its job perfectly — the right context lands on the desk — and the model can still make something up. Faithfulness catches exactly that: it checks whether **every claim in the answer is actually supported by the retrieved context**.

This is the single most important metric on a high-stakes assistant. A fluent, confident, completely *made-up* answer about someone's taxes is the worst failure a RAG system can produce — worse than saying "I don't know," because it's wrong in a way that looks right.

## The intuition: "did it stay grounded?"

Where [recall](/blog/measure-recall) and [precision](/blog/measure-precision) grade the *retrieval* stage, faithfulness grades what the model *did* with what it was handed. Imagine an open-book exam: faithfulness asks whether the student answered from the book, or wandered off and wrote from memory (and got it wrong).

On the IRS corpus, an unfaithful answer might confidently state a filing deadline or a dollar threshold that appears **nowhere** in the retrieved forms. The context was fine; the model embellished.

## How it's scored

RAGAS (`Faithfulness`) works in two steps:

1. Break the generated answer into individual factual claims.
2. Check each claim: is it supported by the retrieved context?

```
Faithfulness = (answer claims supported by the retrieved context)
               ──────────────────────────────────────────────────
                        (total claims in the answer)
```

Scored 0..1, higher is better. A 0.9 means nine of every ten claims trace back to the context; the rest are the model going off-script.

## What good and bad look like

Naive RAG starts at **0.751 faithfulness** on our corpus — one claim in four not grounded. What lifts it is **cleaner, less confusing context**: the [reranker](/blog/rag-reranking) removes look-alike booklets that tempt the model into mixing up forms, and [contextual retrieval](/blog/rag-contextual-retrieval) makes each chunk unambiguous about which form it belongs to. By the end of the series faithfulness reaches **0.97** — near-zero hallucination.

Notice the pattern: faithfulness is moved by what tidies the *generation* stage, not by what widens the pool. A change that lifts recall but leaves faithfulness flat is telling you it improved *what* was found, not *how it was used*.

## The trap: faithful but useless

An answer can be perfectly faithful and still bad. "I cannot determine that from the provided context" is 100% grounded and often correct to say — but if the context *did* contain the answer, that's a failure of a different metric: [answer relevancy](/blog/measure-answer-relevancy). Faithfulness guards against making things up; it says nothing about whether you actually answered the question. You need both.

---

**Part of the [Measurements](/topic/measurements) series.** Next: [Answer Relevancy](/blog/measure-answer-relevancy) — did it answer the actual question? See all four metrics in [how to measure a RAG system](/blog/rag-measuring-rag).
