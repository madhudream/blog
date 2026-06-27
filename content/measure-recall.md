---
title: What is Context Recall?
chapter: Measurements
kicker: Measurements
reading: 7 min
---

# What is Context Recall?

> *Of all the facts the right answer needs, how many did retrieval actually fetch? Recall is the ceiling everything else sits under.*

💡 **In one line:** don't miss the good stuff.

**Context Recall** answers one blunt question: of the facts a correct answer requires, how many actually showed up in the chunks you retrieved? It is the first of the two retrieval metrics in the [RAG scorecard](/blog/rag-measuring-rag), and it is the most important number in the whole pipeline — because a model **cannot use a fact it never saw**.

That is why we call recall the *ceiling*. Reranking, prompting, a bigger model — none of it can recover information that retrieval left on the shelf. If recall is 0.6, then 40% of the time the answer the user needs is simply not in the room, and no downstream cleverness invents it.

## The intuition: "is it in the pile?"

Picture retrieval dumping a pile of chunks on the desk. Recall asks only one thing: **is the needed fact somewhere in that pile?** It does not care whether the fact is on top or buried at the bottom — that is [precision](/blog/measure-precision)'s job. Recall only cares whether it made it onto the desk at all.

On our IRS tax corpus, the classic recall failure is this: a user asks how to fill in a line on Form 1040, and the real explanation lives in the `i1040gi` instruction booklet — but retrieval only pulled the bare form. The fact never entered the pile, so recall is where that miss shows up.

## How it's scored

RAGAS computes recall against a **human-written reference answer**, not the model's own opinion (the metric is `LLMContextRecall`). It breaks the reference into individual claims, then checks each claim: can it be attributed to the retrieved context?

```
Context Recall = (reference claims supported by retrieved context)
                 ────────────────────────────────────────────────
                          (total claims in reference)
```

Scored 0..1, higher is better. Grading against the human ground truth is what stops this from being the model marking its own homework.

## What good and bad look like

On our hard corpus, naive RAG starts at **0.650 recall** — a third of the needed facts simply missing. The fixes that move recall are the ones that **widen the pool**: [query rewriting](/blog/rag-query-rewriting) casts a wider net by rephrasing the question, and [contextual retrieval](/blog/rag-contextual-retrieval) makes chunks easier to find by letting them describe themselves. By the end of the series recall climbs to **0.83**.

Note what does *not* move it: a [reranker](/blog/rag-reranking) only reorders the pile it was handed — if the fact was never retrieved, no reordering invents it. When recall is stuck, fix the retrieval, not the ranking.

## The trap: recall vs precision

You can always raise recall by retrieving *more* chunks — fetch 50 instead of 4 and you will catch more needed facts. But now the pile is full of noise, [precision](/blog/measure-precision) collapses, and the model drowns the right answer in junk. The two metrics pull against each other, which is exactly why you measure both. Recall is "is it in the pile?"; precision is "is it on top?".

---

**Part of the [Measurements](/topic/measurements) series.** Next: [Context Precision](/blog/measure-precision) — is the right chunk ranked high, or buried? See all four metrics working together in [how to measure a RAG system](/blog/rag-measuring-rag).
