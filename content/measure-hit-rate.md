---
title: What is Retrieval Hit-Rate?
chapter: Measurements
kicker: Measurements
reading: 6 min
---

# What is Retrieval Hit-Rate?

> *A blunt, un-foolable yes/no: did retrieval pull at least one of the documents we know the answer lives in?*

💡 **In one line:** did you fetch any right doc at all?

**Retrieval Hit-Rate** is the odd one out on the [RAG scorecard](/blog/rag-measuring-rag). Where [recall](/blog/measure-recall), [precision](/blog/measure-precision), [faithfulness](/blog/measure-faithfulness), and [answer relevancy](/blog/measure-answer-relevancy) are all *meaning-aware* metrics judged by an LLM, hit-rate is a **deterministic counter** — a plain set intersection with no model in the loop. That is exactly why it exists: an LLM judge can be charmed by a fluent answer, but a set intersection cannot be talked into anything.

## The intuition: "did we land at least one right doc?"

For every golden question we know, ahead of time, which source forms *should* be retrieved — the `expected_docs`. Hit-rate asks the bluntest possible question: did the retrieved set contain **at least one** of them?

It does not care how many, or where they ranked, or how good the answer was. One expected form in the pile = a hit. Zero = a miss. On our IRS corpus, if a question's answer lives in `i1040gi` and retrieval pulled anything but that, it's a miss — full stop.

## How it's scored

It's computed right in the evaluation loop, no LLM involved:

```python
if set(row.get("expected_docs", [])) & set(out.get("retrieved_docs", [])):
    hits += 1

hit_rate = hits / total_questions
```

Scored 0..1 (the fraction of questions with at least one expected doc retrieved), higher is better. Because it's a raw set intersection, a persuasive but wrong answer cannot game it — which is the whole point of keeping it on the board next to the LLM-judged metrics.

## Hit-rate vs Context Recall

These two look similar and are easy to confuse, so pin the difference:

- **Hit-rate** is *all-or-nothing per question* and *document-level*: did **any** expected doc show up? It's a coarse, cheap, deterministic smoke alarm.
- **[Recall](/blog/measure-recall)** is *graded* and *fact-level*: of **all** the facts the answer needs, what fraction were retrieved? It's the fine-grained, LLM-judged ceiling.

You can have a hit (one right doc retrieved) and still have mediocre recall (you missed three other facts the answer needed). Hit-rate tells you the door was open; recall tells you how much of the room you actually got into.

## What good and bad look like

Naive RAG starts at **0.500 hit-rate** on our corpus — half the questions never even retrieved a single expected form. That's a brutal floor, and it's the deterministic proof that the naive baseline's retrieval is genuinely broken, not just unlucky with the judge. As the retrieval stages improve ([hybrid search](/blog/rag-hybrid-search), [contextual retrieval](/blog/rag-contextual-retrieval)), hit-rate climbs to **0.68** — fewer questions where the right document never made it into the room at all.

## Why keep a blunt metric at all?

Because the LLM-judged metrics, for all their nuance, share a single point of failure: the judge is itself an LLM. Pairing them with two deterministic counters — hit-rate and **latency** (end-to-end seconds) — means a real regression can't hide behind a charming answer. When the smart metrics and the dumb counters agree, you trust the direction. When they disagree, you've found something worth investigating.

---

**Part of the [Measurements](/topic/measurements) series.** See it alongside the meaning-aware metrics in [how to measure a RAG system](/blog/rag-measuring-rag), and watch it move across the [RAG climb](/blog/rag-the-whole-story).
