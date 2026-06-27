---
title: What is Context Precision?
chapter: Measurements
kicker: Measurements
reading: 7 min
---

# What is Context Precision?

> *You fetched the right chunk — but is it near the top where the model reads, or buried under noise? That's precision.*

💡 **In one line:** don't bring the junk.

**Context Precision** is the second retrieval metric in the [RAG scorecard](/blog/rag-measuring-rag). Where [recall](/blog/measure-recall) asks whether the needed fact made it into the pile at all, precision asks the sharper follow-up: of the chunks you retrieved, how many are actually relevant — and are the relevant ones **ranked high**?

This matters because a language model only really reads the first few chunks you hand it. You can retrieve the perfect document and still fail if it sits at position 8, padded out by four near-duplicates the model reads first.

## The intuition: "is it on top of the pile?"

The clean way to hold the pair in your head:

- **Recall** — is the right fact *in the pile?*
- **Precision** — is it *on top of the pile?*

On the IRS corpus, low precision looks like this: you ask about Form 1040, retrieval does pull the right form, but it also drags in `1040-NR` (the nonresident version) and three instruction booklets that all look almost identical. The right chunk is in there — it's just not on top, and the model reads the look-alikes first.

## How it's scored

RAGAS judges precision against the human-written reference answer (`LLMContextPrecisionWithReference`). For each rank position it asks "is this chunk relevant?", then rewards relevant chunks that appear **early** more than relevant chunks that appear late:

```
Context Precision = weighted mean of precision@k over the ranking,
                    giving more credit to relevant chunks ranked higher
```

Scored 0..1, higher is better. A high score means the useful context sits at the top of the window, not the bottom.

## What good and bad look like

Naive RAG starts at **0.779 precision** on our corpus — decent, but with too many look-alikes near the top. The fix that moves precision most is the [reranker](/blog/rag-reranking): a slow, careful second reader that re-sorts a wide candidate pool so the genuinely relevant chunks rise. [Contextual retrieval](/blog/rag-contextual-retrieval) helps too, by making near-duplicate chunks easier to tell apart. By the end of the series precision reaches **0.95**.

## The trap: precision vs recall

Precision is easy to game in the wrong direction. Retrieve only **one** chunk and if it's relevant your precision is perfect — but you've almost certainly missed needed facts, so [recall](/blog/measure-recall) craters. The two trade off, which is the whole reason the scorecard tracks both. Tuning one blind to the other is how teams ship a system that's confidently right about a third of questions and silently wrong about the rest.

---

**Part of the [Measurements](/topic/measurements) series.** Next: [Faithfulness](/blog/measure-faithfulness) — did the answer stick to the context, or make something up? See all four metrics in [how to measure a RAG system](/blog/rag-measuring-rag).
