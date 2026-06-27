---
title: How do you actually measure a RAG system?
chapter: Foundations
kicker: Evaluation
reading: 12 min
---

# How do you actually measure a RAG system?

A RAG system retrieves relevant documents and then asks a language model to write an answer from them. Measuring it means putting a number on whether that answer is actually any good — and, just as important, on *where* it went wrong when it isn't.

This is the single most-skipped step in the whole field, and skipping it is how teams ship for months on vibes. You change a setting, read three answers, decide they "feel" sharper, and push to production. Without a scorecard, every change is a guess, and you only learn you guessed wrong when your users do. This post is the scorecard the rest of the series leans on.

In this post, we will cover the following:

- Why "it looks better" is a trap
- Splitting RAG into retrieval and generation
- The four metrics, with plain-English intuition
- Why we let an LLM be the judge — and how RAGAS does it in code
- The deterministic counters that keep the judge honest
- The frozen 50-question discipline
- What "good" looks like on a hard corpus
- Summary and what's next

## Why "it looks better" is a trap

Let's slow down here, because this trap is subtle and almost everyone falls into it at least once. You change your chunk size, ask your favourite test question, and the answer reads beautifully. A win, surely? Except your favourite question was always easy. The change you just made quietly *broke* a harder class of questions you never thought to check — and you won't find out until much later.

The deeper problem is that a RAG answer can be wrong in several different ways, and they do not look the same from the outside. The system might have fetched the wrong documents. It might have fetched the right ones but buried them under junk. It might have had perfect context and still made something up. Or it might have answered a different question than the one you asked.

Here is where it gets concrete. Our running corpus is real IRS tax forms, and the classic confusion is Form 1040 versus its instruction booklet, i1040gi. A user asks how to fill in a line, and the honest answer lives in the instructions — but a careless retriever grabs the form itself, which states the line without explaining it. A different failure: someone asks about Form 1040 and the system serves up 1040-NR, the non-resident version, which looks almost identical and is wrong for most filers. "It looks better" cannot tell these failures apart, and each one gets fixed by a *different* change. So we need numbers that pull them apart.

## Split the problem in two

The first useful move is to stop treating "RAG quality" as one thing. A RAG answer is produced in two stages — first **retrieval** finds the context, then **generation** writes an answer from it — and each stage fails in its own way. So we measure them separately:

```
RETRIEVAL — did we find the right stuff?
    Context Recall     did we fetch the facts the answer needs?
    Context Precision  are those facts ranked above the noise?

GENERATION — did we use it well?
    Faithfulness       is the answer grounded in what we fetched?
    Answer Relevancy   does it actually answer the question asked?
```

Keep this split in your head — it is the most valuable mental model in this entire series. Almost every technique we cover targets exactly one of these four metrics. Knowing which one a change is supposed to move tells you what to expect, and what *not* to expect, before you even run the experiment. If you add a reranker hoping to fix recall, you are going to be disappointed, and the split is what tells you why in advance.

## The four metrics, with intuition

Let me define each one plainly and tie it back to the tax assistant, because intuition matters more than the formula here.

**[Context Recall](/blog/measure-recall) — did we even fetch the needed facts?** Recall simply asks: of the facts the correct answer requires, how many showed up in what we retrieved? This is the ceiling on everything else. A model cannot use a fact it never saw. If recall is low, no amount of clever prompting or reranking will save you, because the right information never made it into the room. If the answer needs the i1040gi instructions and you only pulled the bare 1040 form, recall is where that shows up. When the series later mentions "the recall ceiling," this is the number we mean.

**[Context Precision](/blog/measure-precision) — are the relevant chunks near the top?** You can retrieve the right document and still bury it under four irrelevant ones. Precision asks whether the good chunks are ranked high, where the model will actually read them, rather than padding the bottom of the context window. The clean way to remember the pair: recall is "is it in the pile?", precision is "is it on top of the pile?"

**[Faithfulness](/blog/measure-faithfulness) — did the answer stick to the context?** Faithfulness checks whether every claim in the answer is actually supported by the retrieved chunks, or whether the model invented some. This is your hallucination detector. On a tax assistant it is the metric that matters most — a fluent, confident, completely *made-up* answer about someone's taxes is the worst failure this system can produce.

**[Answer Relevancy](/blog/measure-answer-relevancy) — did it answer the actual question?** A response can be perfectly grounded in real context and still wander off, or quietly answer a neighbouring question. Relevancy catches the answer that is technically true but unhelpful — the kind that recites what Form 1040-NR is when you asked about 1040.

Four numbers, two stages. When a change lifts faithfulness but leaves recall flat, that is not a mystery — it is telling you the change improved how the model *used* context, not what context it *found*. The scorecard turns surprises into explanations.

## Why we let an LLM be the judge

How do you score "is this claim supported by this context" automatically? Exact string matching falls apart instantly. "April 15th" and "the fifteenth of April" are the same answer with zero characters in common. You need a grader that reads for *meaning*, not characters.

A quick note for you on one term you'll see everywhere: cosine similarity simply measures how close two vectors of text point — 1.0 means identical in meaning, 0 means unrelated. That handles meaning-matching, but scoring a full claim against a paragraph of context needs more judgement than a single similarity number can give. So we use **RAGAS** (Retrieval-Augmented Generation Assessment), a library that grades with an LLM acting as the judge.

In code, the four metrics are exactly the retrieval/generation split made concrete. Here is the list, lifted straight from our `eval.py`:

```python
from ragas.metrics import (
    Faithfulness,
    LLMContextPrecisionWithReference,
    LLMContextRecall,
    ResponseRelevancy,
)

metrics = [
    LLMContextRecall(),
    LLMContextPrecisionWithReference(),
    Faithfulness(),
    ResponseRelevancy(),
]
```

Notice `LLMContextPrecisionWithReference`. The "WithReference" part is the whole defence against the obvious worry — isn't this the model grading its own homework? Every golden question in our set ships with a human-written **reference answer** (the ground truth). Recall and precision are judged against that human ground truth, not against the model's own opinion of itself.

You can see that contract in how each evaluation sample is assembled. We run the pipeline on a question and pack four things into one `SingleTurnSample`:

```python
from ragas import SingleTurnSample

out = pipeline.answer(row["question"])
sample = SingleTurnSample(
    user_input=row["question"],
    retrieved_contexts=out["contexts"],   # what retrieval found
    response=out["answer"],               # what generation wrote
    reference=row["ground_truth"],        # the human-written answer
)
```

The judge sees the question, the retrieved context, the generated response, and the reference, and grades all four metrics from that. All of them run on a 0..1 scale, higher is better.

## The counters that keep the judge honest

An LLM judge is powerful, but it is still an LLM, and it can be wrong or be charmed by a fluent answer. We do not take its word alone. We pair the LLM-judged metrics with two cheap, *deterministic* numbers that cannot be talked into anything:

- **Retrieval hit-rate** — did we pull at least one of the expected source forms? A blunt yes/no. In code it is just a set intersection between the docs we expected and the docs we retrieved — no model involved, so a persuasive answer cannot game it.
- **Latency** — end-to-end seconds per question. Every "improvement" in the series is weighed against what it costs here, because a 3% quality gain that triples latency is usually a bad trade.

That hit-rate is computed right in the evaluation loop, alongside building the samples:

```python
if set(row.get("expected_docs", [])) & set(out.get("retrieved_docs", [])):
    hits += 1
```

Between a reference-grounded judge and two un-foolable counters, we trust the direction the scorecard points — and we stay honest about the LLM-as-judge risk by never relying on it in isolation.

## The rule that keeps us honest

Here is the discipline that makes the whole series mean something. We freeze **one golden set of 50 questions** over the same ~1,400 real IRS forms. From chapter to chapter we change **exactly one thing** and re-score on that identical set. No moving the goalposts, no quietly swapping the test when a change underperforms.

And when a change *doesn't* help — or helps one metric while hurting another — we report it. That is not a footnote, it is the point. The chapter where a reranker lifts faithfulness but moves recall by precisely zero teaches you more about how RAG actually works than any clean victory could. Holding the question set frozen is what makes those deltas trustworthy: the only thing that changed was the one thing you changed.

## What "good" looks like here

We deliberately chose a hard corpus — dense, near-duplicate tax forms where 1040 and 1040-NR sit side by side — so the naive baseline is honestly mediocre: **0.65 recall, 0.75 faithfulness**. That is the floor, and it leaves real room to climb.

Six chapters of one-change-at-a-time improvements later, the system sits at **0.83 recall, 0.97 faithfulness**. Every step of that climb is a number you can reproduce on your own machine, not a claim you have to take on faith. That is the whole idea: read the intuition, then look at the receipt.

## Measured output

The exact RAGAS scorecards this chapter's run printed — **50 golden questions** over the full IRS corpus, `gpt-5.4-mini` judge + `text-embedding-3-small` embeddings. Reproduce them with the [companion Colab notebook](https://colab.research.google.com/drive/19uwMujUPNRFyLRlVj06H8mKixA3mAPM9?usp=sharing) (it inlines the exact pipeline code and embeds these JSON scorecards).

```text
📊 RAGAS scorecard — 00 · naive baseline
   Context Recall       0.650   did we fetch the needed facts?
   Context Precision    0.779   relevant context ranked high?
   Faithfulness         0.751   grounded, no hallucination?
   Answer Relevancy     0.584   answers the actual question?
   Retrieval hit-rate   0.500   ≥1 expected form retrieved
   Avg latency          1.01s   per question, end-to-end

```

## Summary

You cannot improve what you cannot measure, and "it looks better" is a measurement that lies to you. The fix is to split RAG into its two real stages, score four meaning-aware metrics against a frozen golden set, and guard the LLM judge with deterministic counters. Do that and every change becomes an explanation instead of a guess.

Key takeaways:

- A RAG answer fails in distinct ways — wrong docs, buried docs, hallucination, off-topic — and each needs a different fix, so measure them separately.
- **Retrieval** is graded by Context Recall (is the fact in the pile?) and Context Precision (is it on top of the pile?); recall is the ceiling on everything downstream.
- **Generation** is graded by Faithfulness (grounded, no hallucination) and Answer Relevancy (answers the actual question).
- RAGAS uses an LLM as judge, made reliable by a human-written reference answer per question (`LLMContextPrecisionWithReference`).
- Retrieval hit-rate and latency are deterministic counters that cannot be charmed by a fluent answer — they keep the judge honest.
- One frozen set of 50 questions, one change per chapter, and honest reporting of changes that didn't help are what make the numbers mean something.

## What's next

Now that you have the scorecard, you can watch it move. The next chapter takes the cheapest improvement in the whole book — changing how documents are split into chunks — and shows exactly which of these four numbers it lifts and which it leaves alone. Read on in [how chunking changes RAG](/blog/rag-chunking).
