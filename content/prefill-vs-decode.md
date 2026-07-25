---
title: "Prefill vs Decode: The Two Phases of LLM Inference"
slug: "prefill-vs-decode"
date: "2026-07-25"
tags: ["llm", "ai", "system-design"]
reading_time: "14 min read"
words: 2765
summary: "In this blog, we will explore Prefill and Decode, the two phases every LLM goes through during inference. We will see how each phase operates, why one is compute-bound and the other memory-bound, and why this single split explains nearly every inference optimization."
---

# Prefill vs Decode: The Two Phases of LLM Inference

In this blog, we will explore Prefill and Decode, the two phases every LLM goes through during inference, and see how knowing them helps us make an LLM faster. This is the foundation blog for the whole [LLM inference optimization series](/topic/llm-inference) — every technique in the series targets one of these two phases.

We will cover the following:

- What is LLM inference
- The two phases: Prefill and Decode
- Prefill explained in simple words
- Decode explained in simple words
- A diagram of the two phases and the KV cache flow
- Prefill vs Decode comparison table
- Why this split matters: compute-bound vs memory-bound
- Conclusion

Let's get started.

## What is LLM inference

Before diving into prefill and decode, we need to be clear about what LLM inference actually means.

An **LLM** is a Large Language Model. It is the model behind the chat assistants we use every day.

**Inference** means using an already-trained model to produce an answer. Put simply, inference is the model doing its actual job: taking in your question and writing a reply back to you.

Now, here is the single most important idea to hold on to. An LLM never produces its full answer in one go. It builds the answer piece by piece, and each of those small pieces is called a **token**. A token is a little chunk of text, roughly a word or a fragment of a word.

The model emits one token, then another, then another, until the answer is finished. This is exactly why a chat assistant appears to type its reply word by word in front of you. That live, token-by-token delivery is known as **streaming**.

For a sense of scale, a short sentence comes out to roughly 15 to 20 tokens. So a 1,000 token prompt is around a page of text, while a 200 token answer amounts to a few sentences.

A **request** is just a single user question sent to the model. When we talk about a server handling many requests, we simply mean it is answering many users' questions.

That is LLM inference in a nutshell: the model producing text one token at a time.

## The two phases: Prefill and Decode

Whenever an LLM handles a request, the work happens in two distinct phases.

- **Prefill** comes first. It takes in and processes the entire input prompt you submitted.
- **Decode** comes second. It produces the output tokens one by one.

In plain terms, prefill is the model reading your question, and decode is the model writing its answer.

Both phases run on the exact same model. There are no separate models or separate weights involved. The **weights** are the millions of numbers the model picked up during training. They represent everything the model "knows", and there are so many of them that they occupy a large slice of the GPU's memory. Keep this fact in mind, because we will need it shortly. The only thing that differs between the two phases is how they operate, and that one small difference changes everything, as we are about to see.

Let's dig into each phase.

## Prefill explained in simple words

**Prefill is the phase where the model takes in your entire input prompt in one single pass and emits the very first output token.**

The easiest way to grasp this is through an example.

Say you paste in a question that is 1,000 tokens long. During prefill, the model does not go through those 1,000 tokens one after another. It processes all 1,000 tokens together, simultaneously.

Think of a chess grandmaster stepping up to the board. Before making a single move, the grandmaster takes in the entire board in one glance. Every piece, every threat, every open file is absorbed together in one sweep, and along the way the grandmaster builds a mental map of what matters in the position. This taking-in-the-whole-board part is prefill.

Since the full prompt is available from the start, nothing has to wait. The model can work on every input token at once. This is known as **parallel processing**, which means many things happening together rather than one after another.

While going through the prompt, the model also prepares some notes for later use. For each input token, it computes and saves two special pieces of data: the **Key (K)** and the **Value (V)**. Taken together, all these saved Keys and Values make up the **KV cache**. For now, just think of the KV cache as the model's memory of your prompt — we study it properly in [its own blog](/blog/kv-cache).

So prefill loads this KV cache with the model's notes on every input token. And when prefill finishes, it emits the very first output token.

Here is a point worth underlining. **Prefill delivers only the first output token, never the full answer.** Every remaining token arrives later, during decode.

**Prefill is compute-bound.** Compute-bound means the raw math is the only thing limiting the speed. A **GPU** is the powerful chip the model runs on. Inside the GPU sit **math units**, the components that actually carry out the multiplications. Throughout prefill, these math units are slammed with heavy arithmetic. On a high-end GPU, they can stay extremely busy during prefill, frequently reaching 90 percent or more on large prompts. The GPU is being put to good use.

Why is prefill such a math-heavy phase? Because processing many tokens together turns the work into multiplying enormous tables of numbers. Such a big table of numbers is called a matrix, and multiplying two large tables is precisely the job GPUs were designed for. So the GPU operates close to its peak power.

One more thing to be aware of: longer prompts stretch out prefill. A short question feels nearly instant. But paste an entire document in front of the model, and prefill drags on, delaying the moment the first word shows up.

In fact, part of the prefill workload grows faster than the prompt length itself. Within the model there is a step called **attention**, in which every token must examine every other token to make sense of the context. As a result, doubling the prompt roughly quadruples this portion of the work. To make it concrete, going from a 100 token prompt to a 200 token prompt makes this part about 4 times larger, not 2 times. Here is a simple picture. In a room with 10 people, everyone shaking everyone's hand is manageable. In a room with 100 people, the handshake count explodes. The larger the room, meaning the longer the prompt, the faster the work piles up.

This wait before the first word is important enough to have a name of its own, TTFT, covered in the [metrics blog](/blog/llm-inference-metrics). Until then, keep this one line in mind.

> Faster prefill means sooner you see the first token.

That covers prefill. On to decode.

## Decode explained in simple words

**Decode is the phase where the model produces the output tokens one at a time, reusing the KV cache that prefill built.**

Let's continue our chess example. Taking in the whole board was prefill. Now the grandmaster starts playing out the winning combination, one move at a time. The grandmaster makes a move, looks at the new position it creates, then chooses the next move, and so on. No move can be chosen before the previous move is on the board. This slow, move-by-move play is decode.

During decode, the model emits exactly one new token per step. That token is then fed back into the model to help generate the token after it. Since every new token depends on the token that came just before, the tokens must arrive strictly in sequence. This is known as **autoregressive** generation. Put simply, the model keeps looping its own output back in as fresh input.

So decode is inherently sequential. Unlike prefill, which handles all the input tokens at once, decode cannot handle all the output tokens at once. Every token has to wait its turn.

And here comes the clever bit. At each decode step, the model does not go back and reprocess your entire prompt from scratch. That would be painfully slow and wasteful. Instead, it consults the [KV cache](/blog/kv-cache), the memory prefill already built. It computes the Key and Value for only the single new token, pulls all the earlier Keys and Values from the cache, emits the next token, and then adds the new token's Key and Value onto the cache.

So with every decode step, the cache gains exactly one entry.

**Decode is memory-bandwidth-bound.** This is the exact opposite of prefill. What limits decode is how quickly data can travel from the GPU's memory into its math units, not the arithmetic itself.

Let's unpack why, one small piece at a time.

In decode, each step handles just one token. So rather than multiplying two huge tables together the way prefill does, decode multiplies the big table by one thin row of numbers, representing the single new token. A thin row of numbers like that is called a vector. The math for one token is therefore tiny.

Yet to produce even that single token, the GPU still has to pull the entire set of model weights plus the ever-growing KV cache out of its memory. Recall that the weights are enormous, so this is a huge amount of data to move. **Memory bandwidth** is the rate at which data can flow out of the GPU's memory. And here is the crucial fact: inside a GPU, arithmetic is blazingly fast, but hauling large volumes of data out of memory is comparatively slow.

The result is that the GPU spends most of its time waiting for data to show up, while its math units mostly sit idle. During decode, the math units of a high-end GPU may only be around 20 to 40 percent busy for a single request.

Here is a simple analogy. Picture a chef who has to walk into a giant pantry, fetch a single ingredient, walk back, chop it, and then repeat, one ingredient per trip. All that walking (moving data from memory) takes far more time than the chopping (the tiny bit of math). The knives (the GPU's math units) stay unused most of the time.

So prefill keeps the GPU busy doing math, whereas decode keeps the GPU stuck waiting on memory.

One more point worth noting. For a typical request, prefill wraps up in a fraction of a second, while decode can stretch across several seconds, since it emits many tokens back to back. Decode therefore consumes most of the total time even though it taps only a small share of the GPU's math power. That is precisely why so many optimizations aim at the decode phase.

Keep this one line in mind.

> Faster decode means faster you see the rest of the answer.

Now that we understand both phases, let's put them in one picture.

## A diagram of the two phases and the KV cache flow

Here is a clean diagram of a request flowing through prefill and then decode.

```
INPUT PROMPT (for example, 1,000 tokens)
        |
        v
+-----------------------------+
|   PREFILL  (one big step)   |
|  - reads ALL input tokens   |
|    in parallel              |
|  - writes the KV cache      |
|  - GPU compute very busy    |
+-----------------------------+
        |
        | produces the FIRST output token
        v
+-----------------------------+        +------------------+
|   DECODE  (many small steps)| <----> |     KV CACHE     |
|  - one token per step       |  read  |  (the memory of  |
|  - reads the KV cache       |  and   |   all tokens so  |
|  - appends one new entry    |  grow  |   far)           |
|  - GPU mostly waits on      |        +------------------+
|    memory                   |
+-----------------------------+
        |
        | token 2, token 3, token 4, ... token N
        v
   FULL ANSWER
```

The timeline stands out clearly here. There is exactly one prefill pass, followed by many decode steps. For a 200 token answer, that means 1 prefill pass plus 200 sequential decode steps. Prefill writes the KV cache once, and every single decode step then reads it and extends it.

That is how the two phases cooperate.

## Prefill vs Decode comparison table

Let me lay out the differences between Prefill and Decode in a table for your better understanding.

| Aspect | Prefill | Decode |
| --- | --- | --- |
| What it does | Processes the whole input prompt | Generates output tokens one by one |
| Parallelism | Parallel (all prompt tokens at once) | Sequential (one token at a time) |
| Steps | One big step | Many small steps (N of them) |
| Math shape | Big table times big table | Big table times a thin vector |
| Bottleneck | Compute-bound (limited by math speed) | Memory-bandwidth-bound (limited by data movement) |
| GPU utilization | High (math units busy, can approach 90 percent or more) | Low (math units mostly idle, around 20 to 40 percent) |
| KV cache action | Writes the cache | Reads and extends the cache |
| Latency metric | Time To First Token (TTFT) | Time Per Output Token (TPOT) |
| Cost driver | Grows with prompt length | Streams full weights plus KV cache every step |

This table captures the entire story. Prefill and decode are mirror images of one another.

## Why this split matters: compute-bound vs memory-bound

So why do we care so deeply about this two-phase split?

Because the two phases hit opposite bottlenecks, and nearly every optimization flows from that one fact. A **bottleneck** is the single slow part that drags down the whole process, much like the narrow neck of a bottle limits how fast the water can pour out.

**Prefill is compute-bound.** It performs heavy math across many tokens at once, keeping the GPU's math units fully occupied. The work turns into large table-times-table multiplication, which GPUs thrive on.

**Decode is memory-bandwidth-bound.** Its math per token is tiny, yet every step it must stream the entire model plus the growing KV cache out of memory. The GPU therefore spends most of its time waiting on memory while the math units idle.

Here is an easy way to keep the difference straight. Prefill is like a chef chopping an entire pile of vegetables in one go, hands fully occupied. Decode is like plating one finished dish at a time while making a trip to the fridge for every single dish, where the fridge trips, not the plating, are what slow everything down.

Let's set the two phases side by side.

```
PREFILL (compute-bound)           DECODE (memory-bound)
many tokens processed at once     one token processed at a time

GPU math units: [#########-]      GPU math units: [##--------]
  about 90% busy                    about 20 to 40% busy

held back by: doing the MATH      held back by: MOVING DATA
                                  (model weights + KV cache)
```

The mirror image is plain to see. Prefill fills the math units nearly to capacity, while decode leaves them largely idle, waiting on memory instead.

This single difference accounts for two big observations.

First, it explains why long prompts delay the start of the answer. A longer prompt means more prefill math.

Second, it explains why serving many users simultaneously during decode costs so little extra. Since a single decode step barely touches the GPU's math capacity, many users' decode steps can run together. That idea is called batching, and [continuous batching](/blog/continuous-batching) has its own blog.

Because the two phases demand different things from the hardware, some serving systems go as far as running prefill and decode on separate GPUs — see [disaggregated serving](/blog/disaggregated-serving).

## Conclusion

An LLM answers in two phases. **Prefill** takes in your whole prompt in one parallel pass, fills the KV cache, and emits the first token. It is compute-bound, and it determines how quickly the answer starts. **Decode** then produces the rest of the answer one token at a time, reading and extending the KV cache at every step. It is memory-bandwidth-bound, and it determines how quickly the answer streams.

From here, the natural next reads are the [KV cache](/blog/kv-cache), which bridges the two phases, and the [metrics blog](/blog/llm-inference-metrics), which puts numbers (TTFT, TPOT, throughput) on everything we just described. The full set of optimization techniques lives in the [series hub](/topic/llm-inference), and you can see both phases live on a real server in the [vLLM practical guide](/blog/serving-llms-with-vllm).

That's it for now.
