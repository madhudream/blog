---
title: "Prefill vs Decode: LLM Inference Optimization"
chapter: LLM Inference
kicker: LLM Inference
reading: 34 min
---

# Prefill vs Decode: LLM Inference Optimization

In this blog, we will explore Prefill and Decode, the two phases every LLM goes through during inference, and see how knowing them helps us make an LLM faster. We will look at how each phase operates, how the KV cache ties the two together, how they differ and which one matters for which use case, and the optimization techniques that speed up each phase.

We will cover the following:

- What is LLM inference
- The two phases: Prefill and Decode
- Prefill explained in simple words
- Decode explained in simple words
- A diagram of the two phases and the KV cache flow
- The KV cache as the bridge between the two phases
- A step-by-step walkthrough of a few decode steps
- Prefill vs Decode comparison table
- Why this split matters: compute-bound vs memory-bound
- The key metrics: TTFT, TPOT, throughput, and end-to-end latency
- Optimization techniques mapped to each phase
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

While going through the prompt, the model also prepares some notes for later use. For each input token, it computes and saves two special pieces of data: the **Key (K)** and the **Value (V)**. Taken together, all these saved Keys and Values make up the **KV cache**. Don't worry about the precise meaning of Key and Value yet. For now, just think of the KV cache as the model's memory of your prompt. We will study it properly in a moment.

So prefill loads this KV cache with the model's notes on every input token. And when prefill finishes, it emits the very first output token.

Here is a point worth underlining. **Prefill delivers only the first output token, never the full answer.** Every remaining token arrives later, during decode.

**Prefill is compute-bound.** Compute-bound means the raw math is the only thing limiting the speed. A **GPU** is the powerful chip the model runs on. Inside the GPU sit **math units**, the components that actually carry out the multiplications. Throughout prefill, these math units are slammed with heavy arithmetic. On a high-end GPU, they can stay extremely busy during prefill, frequently reaching 90 percent or more on large prompts. The GPU is being put to good use.

Why is prefill such a math-heavy phase? Because processing many tokens together turns the work into multiplying enormous tables of numbers. Such a big table of numbers is called a matrix, and multiplying two large tables is precisely the job GPUs were designed for. So the GPU operates close to its peak power.

One more thing to be aware of: longer prompts stretch out prefill. A short question feels nearly instant. But paste an entire document in front of the model, and prefill drags on, delaying the moment the first word shows up.

In fact, part of the prefill workload grows faster than the prompt length itself. Within the model there is a step called **attention**, in which every token must examine every other token to make sense of the context. As a result, doubling the prompt roughly quadruples this portion of the work. To make it concrete, going from a 100 token prompt to a 200 token prompt makes this part about 4 times larger, not 2 times. In other words, very long prompts can feel sluggish before the first word ever appears. Here is a simple picture. In a room with 10 people, everyone shaking everyone's hand is manageable. In a room with 100 people, the handshake count explodes. The larger the room, meaning the longer the prompt, the faster the work piles up.

This wait before the first word is important enough to have a name of its own, which we will meet in the metrics section. Until then, keep this one line in mind.

> Faster prefill means sooner you see the first token.

That covers prefill. On to decode.

## Decode explained in simple words

**Decode is the phase where the model produces the output tokens one at a time, reusing the KV cache that prefill built.**

Let's continue our chess example. Taking in the whole board was prefill. Now the grandmaster starts playing out the winning combination, one move at a time. The grandmaster makes a move, looks at the new position it creates, then chooses the next move, and so on. No move can be chosen before the previous move is on the board. This slow, move-by-move play is decode.

During decode, the model emits exactly one new token per step. That token is then fed back into the model to help generate the token after it. Since every new token depends on the token that came just before, the tokens must arrive strictly in sequence. This is known as **autoregressive** generation. Put simply, the model keeps looping its own output back in as fresh input.

So decode is inherently sequential. Unlike prefill, which handles all the input tokens at once, decode cannot handle all the output tokens at once. Every token has to wait its turn.

And here comes the clever bit. At each decode step, the model does not go back and reprocess your entire prompt from scratch. That would be painfully slow and wasteful. Instead, it consults the KV cache, the memory prefill already built. It computes the Key and Value for only the single new token, pulls all the earlier Keys and Values from the cache, emits the next token, and then adds the new token's Key and Value onto the cache.

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

## The KV cache as the bridge between the two phases

The KV cache is the bridge linking prefill and decode, so it deserves a proper understanding.

First, let's look at the problem it exists to solve.

To generate the next token, the model must look back over every token that came before. For every token, the model computes three things: a **Query (Q)**, a **Key (K)**, and a **Value (V)**.

These three names are not random. They come straight from database terminology, and a small database story makes them click.

Imagine a hotel whose front-desk database pairs each guest's last name with their room number. A guest walks up and gives their last name, "Sharma", but the clerk accidentally types "Sharna" into the computer. The computer now has to work out which stored name is closest to what was typed. In database terms, the text the clerk typed in, the search term, is the **query**. The actual names stored in the database, the ones being searched against, are the **keys**. The computer compares the query against every key and ranks each one by similarity. Here, the query "Sharna" lands closest to the key "Sharma", so the database returns that guest's room number, 537. The thing the database hands back as the result, the room number, is the **value**.

To summarize the database picture: the query is what we search with, the keys are what we search against, and the values are what the search returns.

Attention works the same way, with one twist. The new token being generated plays the role of the clerk's search term: its Query gets compared against the Keys of all the earlier tokens, and each comparison produces a similarity score, exactly like the computer ranking every stored name. The twist is that the model does not pick just the single best match the way the hotel database does. Instead, it uses the similarity scores as weights and blends the Values of all the past tokens, leaning most heavily on the closest matches, to decide what comes next. So every past token contributes its "room number", and the strongest matches contribute the most.

Now the key observation. Once computed, a past token's Key and Value never change. They are unaffected by any tokens that follow. So rather than recomputing them at every single step, we can compute them once and keep them stored. That store of Keys and Values is the KV cache.

**The KV cache holds only the Keys and Values of past tokens. Queries are never stored.** The Query is recomputed fresh for the current token at each step, so storing it would serve no purpose.

Let's see why this matters so much through a small numeric walkthrough. For the purpose of understanding, treat one cache entry as one token's stored Key and Value.

Say prefill has just finished processing a 3-token prompt, so the KV cache holds 3 entries. Decode now kicks off.

**Step 1:** The model takes the input for the first output token, computes its Key and Value, and consults the 3 cached entries to look back. It emits token 4, then appends token 4's Key and Value to the cache. The cache now holds 4 entries.

**Step 2:** The model takes token 4, computes its Key and Value, and consults the 4 cached entries to look back. It emits token 5, then appends token 5's Key and Value to the cache. The cache now holds 5 entries.

**Step 3:** The model takes token 5, computes its Key and Value, and consults the 5 cached entries to look back. It emits token 6, then appends token 6's Key and Value to the cache. The cache now holds 6 entries.

Let's picture how the cache expands across these steps.

```
After prefill   |P1|P2|P3|           ->  cache has 3 entries
Decode step 1   |P1|P2|P3|T4|        ->  append T4, now 4 entries
Decode step 2   |P1|P2|P3|T4|T5|     ->  append T5, now 5 entries
Decode step 3   |P1|P2|P3|T4|T5|T6|  ->  append T6, now 6 entries
```

In this picture, the boxes P1, P2, and P3 are the prompt tokens that prefill wrote, while T4, T5, and T6 are added by decode, one box per step.

The pattern is easy to spot. Each step computes the Key and Value for only the one new token. Every older Key and Value comes straight from the cache rather than being recomputed. And the cache grows by exactly one entry each step.

**Note:** Without the KV cache, every decode step would rebuild the Keys and Values of all earlier tokens from scratch. Because step N repeats the work for all N previous tokens, the total work across the whole answer grows roughly with the square of its length, which is extremely slow. The KV cache cuts this down so each token's Key and Value gets computed exactly once. That is why the KV cache is no minor tweak. Without it, decode would be dramatically slower.

There is a catch, though. The KV cache never stops growing. It begins at the size of the prompt right after prefill, then gains one entry for every token generated. It also scales with the number of users served at once, since every user needs a cache of their own. In extreme situations, such as very long contexts combined with many concurrent users, the combined KV cache can even outgrow the model weights themselves and exhaust the GPU's memory. This ever-growing cache is the motivation behind many of the optimizations coming up later.

That is how the KV cache serves as the bridge between prefill and decode.

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

Second, it explains why serving many users simultaneously during decode costs so little extra. Since a single decode step barely touches the GPU's math capacity, many users' decode steps can run together. We will meet this idea, called batching, in the optimization section.

Because the two phases demand different things from the hardware, some serving systems go as far as running prefill and decode on separate GPUs. We will get to that as well.

## The key metrics: TTFT, TPOT, throughput, and end-to-end latency

To optimize anything, we first have to measure it. A handful of key metrics exist, and each maps neatly onto a phase, so this section pulls everything together.

**TTFT (Time To First Token)** is the time between sending your request and the very first output token showing up. It is driven mainly by prefill, since prefill must complete before the first token can exist. Roughly speaking, TTFT equals the prefill time plus one decode step. Longer prompts therefore mean a larger TTFT. In plain terms, TTFT is how quickly the answer begins to appear.

**TPOT (Time Per Output Token)** is the average time taken to produce each token after the first. It also goes by **ITL (Inter-Token Latency)**, meaning the gap between two consecutive tokens. TPOT is governed by decode, since decode is what emits these tokens one at a time. In plain terms, TPOT is the typing speed of the answer once it has begun. For intuition, a TPOT of 50 milliseconds equals 20 tokens per second, and a TPOT of 25 milliseconds equals 40 tokens per second. Cutting TPOT in half therefore doubles the streaming speed every user experiences.

**Note:** For a single request, TPOT and ITL can be treated as the same idea, namely the per-token gap. Across many requests they are measured a little differently, but conceptually they mean the same thing.

**Throughput** is the total count of tokens generated per second across all users being served simultaneously. It is a system-wide metric rather than a per-user one. In plain terms, throughput reflects how many users the server can handle at once. Batching, which means pushing many requests through the GPU together, boosts throughput. The group of requests run together is called a **batch**, and how many requests it contains is the **batch size**.

**End-to-end latency** is the full stretch of time from sending the request to receiving the final token. A simple formula gives us the intuition:

```
End-to-end latency = TTFT + (number of output tokens - 1) x TPOT
```

The first token is already accounted for inside TTFT, which is why the formula uses the number of output tokens minus one. First the prompt gets processed (TTFT), then every remaining output token contributes one TPOT.

Let's run a quick worked example. Suppose TTFT is 400 milliseconds, the answer runs 200 tokens, and TPOT is 25 milliseconds per token. Of those 200 tokens, the first is already covered by TTFT, leaving 199 tokens at 25 milliseconds apiece. The end-to-end latency then comes to roughly 400 milliseconds plus 199 times 25 milliseconds, or about 5.4 seconds.

Let's put this timeline in a picture.

```
request
  sent
    |
    v
    |<------ TTFT ----->|  TPOT  |  TPOT  |  TPOT  |  ...  |  TPOT  |
    | prefill + token 1 | token 2| token 3| token 4|  ...  | token N|

End-to-end latency  =  TTFT  +  (N - 1) x TPOT
```

We can see that TTFT spans everything up to the first token, after which each subsequent token lands one TPOT apart. The answer starts after TTFT and then streams at the pace set by TPOT.

There is also one core trade-off to grasp. TTFT and TPOT are per-user latencies, where smaller is better. Throughput is a system metric, where bigger is better. The two pull in opposite directions. Larger batches push more tokens per second through the GPU (higher throughput) but force every user to wait longer (worse TTFT and TPOT). Smaller batches feel more responsive but leave GPU capacity on the table. The batch size gets tuned to the use case. A chatbot cares about low TTFT and low TPOT, while a bulk document-summarization job cares about high throughput.

We now know which metric belongs to which phase. Prefill owns TTFT. Decode owns TPOT and throughput. So whenever we optimize, the first question is always which metric we are trying to move.

## Optimization techniques mapped to each phase

Time to go through the main optimization techniques. What makes this elegant is that every technique aims at a specific phase. For each one, we will state plainly what it does and which phase or metric it improves.

### KV cache (the foundation, targets decode)

This one we have already covered. The KV cache keeps the Keys and Values of all past tokens so each decode step only performs work for the single new token. It is what makes decode fast to begin with. But since the cache grows with every token and eats GPU memory, all the remaining techniques below exist largely to keep it in check.

### Continuous batching (targets throughput)

Let's start with the old approach and its flaw.

Under the old approach, called static batching, the server bundles several requests into a group and then waits for the slowest member of the group to finish before the next group can begin. The flaw is that short requests wrap up early and their slots sit empty, squandering the GPU. Let's see how the next approach fixes this.

**Continuous batching** revisits the batching decision at every single decode step rather than once per group. The instant one request completes, its slot opens up, and a waiting request slides into the batch on the very next step. The batch stays full, and the GPU stays busy.

Let's picture the difference.

```
STATIC BATCHING  (finished slots sit empty -> GPU wasted)
  slot 1: R1=====                  (idle, wasted) .........
  slot 2: R2==========================
  slot 3: R3==========       (idle, wasted) ...............
          |------- whole batch waits for the slowest -------|

CONTINUOUS BATCHING  (a finished slot is refilled at once -> GPU busy)
  slot 1: R1=====R4====================
  slot 2: R2==========================
  slot 3: R3==========R5================
          (R4 enters the moment R1 ends, R5 enters when R3 ends)
```

We can see that static batching leaves slots empty whenever short requests finish ahead of the rest, while continuous batching refills those slots immediately.

Here is a simple analogy. Think of a shared taxi that, the instant one passenger steps out, immediately picks up the next person waiting at the curb, rather than driving around with empty seats until every trip is over. The taxi never rides with vacant seats.

Compared to the old static approach, continuous batching typically delivers a large leap in throughput.

### Chunked prefill (targets smooth streaming for other users)

The problem first. The prefill for a very long prompt runs as one giant step. While that giant step is running, it monopolizes the GPU and freezes the token streaming of every other user already in their decode phase. Their answers stutter.

**Chunked prefill** breaks one long prompt's prefill into several smaller chunks rather than one massive step. Between the chunks, the model slips in small decode steps. That way, no single long prefill holds everyone else hostage. The other users' token streams are protected, so their answers keep flowing without stutter. As a bonus, blending compute-heavy prefill with memory-heavy decode in one batch makes better use of the hardware.

Let's picture it.

```
WITHOUT chunked prefill:
  long prompt: [============= ONE BIG PREFILL =============]
  other users: tok ....... (frozen, stuttering) ....... tok

WITH chunked prefill:
  long prompt: [chunk 1][chunk 2][chunk 3][chunk 4][chunk 5]
  other users: tok   tok   tok   tok   tok   tok
                  ^ a decode step slips in between the chunks
```

We can see that one giant prefill freezes everyone else, while chunked prefill lets their tokens keep arriving between the chunks.

Here is a simple analogy. Picture a chef with a single stove. When one customer orders a huge banquet, cooking the whole thing in one go leaves every other table's food frozen in place. Instead, the chef prepares the banquet in small rounds, sliding the quick single dishes in between, so no one's plate goes cold.

**Note:** Chunked prefill's main job is keeping ongoing answers from stalling. It does not shrink the total math, so on its own it does not make prefill any faster.

### Prefix caching, also called prompt caching (targets prefill and TTFT)

Many requests open with the same long beginning. Think of identical fixed system instructions, the same document being questioned, or the same earlier turns of a conversation. This shared opening is called a **prefix**.

**Prefix caching** reuses the KV cache for that shared prefix across requests. The prefill for the shared portion is computed a single time and then reused, instead of being redone for every request. Redundant work gets skipped, and TTFT shrinks.

Here is a simple analogy. Imagine a teacher who writes the same lengthy instructions on the board before every class. Rather than rewriting them each time, the teacher keeps a photo of the board and reuses it, spending the saved time only on each student's fresh question.

In production, this can achieve very high cache hit rates and major cost savings on repeated prompts. A high cache hit rate means most requests found their shared opening already stored and waiting, so that work never had to happen. **Note:** Prefix caching pays off only when requests genuinely share a common beginning. With no shared prefix, it simply falls back to a full prefill.

### Disaggregated serving, also called prefill-decode separation (targets both TTFT and TPOT)

We know prefill is compute-bound while decode is memory-bandwidth-bound. When a single GPU handles both, a burst of heavy prefill stalls the in-flight decodes of other users, and there is no way to tune each phase on its own.

**Disaggregated serving** assigns prefill to one pool of GPUs and decode to a different pool. A pool is simply a group of GPUs working as a unit. The KV cache built by the prefill GPU travels over a fast link to the decode GPU. Each pool is then configured around its own bottleneck, and each can hit its own latency target independently.

Let's picture the two pools.

```
           PREFILL POOL                             DECODE POOL
   +-------------------------+              +-------------------------+
   | GPUs tuned for heavy    |              | GPUs tuned for fast     |
   | math (compute-bound)    |   KV cache   | memory (memory-bound)   |
   |                         |  ========>   |                         |
   | reads prompt, writes    |  fast link   | reads cache, streams    |
   | the KV cache, makes     |              | the answer token by     |
   | the first token         |              | token                   |
   +-------------------------+              +-------------------------+
```

We can see the prefill pool building the KV cache and handing it across a fast link to the decode pool, with each pool tuned around its own bottleneck.

Here is a simple analogy. Think of a restaurant that places its heavy prep kitchen in one room and its steady plating-and-serving line in another. Each room is staffed and outfitted for its own kind of work, and the prepped food (the KV cache) moves between them, so neither side drags the other down.

**Note:** Disaggregation does not come for free. It introduces the cost of shipping the KV cache over the network, and the model must be duplicated across the pools. It earns its keep mainly at large scale, when strict TTFT and TPOT targets must be met simultaneously. For smaller deployments, continuous batching plus chunked prefill on a single GPU is often sufficient.

The SGLang serving system supports this prefill-decode disaggregation, along with chunked prefill and prefix caching. We have a detailed blog on how SGLang works that covers these in depth.

### Speculative decoding (targets decode and TPOT)

This one is clever, and it works precisely because decode is memory-bound.

**Speculative decoding** employs a small, fast model, called the draft model, to cheaply guess the next several tokens. The big model, called the target model, then checks all those guesses in one single parallel pass. Correct guesses are kept. The first wrong guess, along with everything after it, gets discarded and corrected by the big model.

Why does this pay off? Since decode is memory-bound, the big model's weights have to be pulled from memory regardless. Verifying 5 guessed tokens at once moves nearly the same amount of data as generating 1 token. Every correct guess is therefore almost free. A slow one-at-a-time process turns into a faster parallel one.

Let's picture one round of speculative decoding.

```
Draft model (small, fast) proposes 5 tokens in one cheap pass:
        g1   g2   g3   g4   g5

Target model (big) verifies ALL of them in ONE parallel pass:
        ok   ok   ok   X    -
                       ^
                       first wrong guess: corrected by the big model,
                       g5 is thrown away

Result: 3 guesses accepted + 1 fix, for about the cost of 1 normal step
```

We can see the big model accepting the correct guesses and fixing the first wrong one within a single pass, yielding several tokens for roughly the price of one.

Here is a simple analogy. A quick junior assistant guesses the next few words of the boss's sentence, and the boss scans the entire guess at a glance, either nodding along at the correct portion or correcting the first slip. Checking a guess takes far less effort than composing from scratch.

**Very important:** Speculative decoding is built to preserve the model's output quality; only the speed changes. When the model always picks the single most likely token, the output is token-for-token identical to what the big model would have generated alone. When the model samples with some randomness, the output is drawn from exactly the same probability distribution the big model uses, so quality holds even though the precise wording may vary between runs. Typical decode speedups land around 2 to 3 times, depending on how often the small model's guesses get accepted.

### PagedAttention (targets KV cache memory efficiency)

The problem first. In a naive system, each request's KV cache lives in one large continuous block of memory, sized for the longest answer that could possibly occur. The flaw is that most of that reserved space never gets used and goes to waste. The waste can be enormous.

**PagedAttention** stores the KV cache in small fixed-size blocks, typically 16 tokens apiece, that can sit anywhere in GPU memory, rather than one big continuous chunk per request. A small table, called the block table, tracks which scattered blocks belong to which request. A fresh block is allocated only when the sequence actually grows into it.

Let's picture the difference.

```
WITHOUT paging (one big contiguous block reserved up front):
  Request A: [used][used][used][------ reserved but empty ------]
  Request B: [used][used][--------- reserved but empty ---------]
             wasted empty space sits unused inside each block

WITH paging (small fixed-size blocks, given only when needed):
  Request A -> block 7, block 2, block 9     (scattered anywhere)
  Request B -> block 4, block 1
  a block table remembers which blocks belong to which request
  shared prefix? two requests can point to the SAME block
```

We can see that the contiguous approach reserves one big block and wastes its empty portion, while paging hands out small blocks only as the sequence expands.

This borrows an old, battle-tested computing trick called paging, in which memory is dealt out in small equal pieces only at the moment they are truly needed.

Here is a simple analogy. Rather than demanding one big empty parking lot for each car's luggage, the valet uses many small numbered lockers spread around the building and keeps a slip recording which lockers belong to whom. No space gets wasted on empty reserved lots. And when two people carry identical luggage (a shared prefix), they can simply use the same locker.

PagedAttention all but eliminates the wasted memory, allows larger batches to fit, and lifts throughput. It is also the foundation that enables prefix caching, since shared prefix blocks can simply point at the same physical block.

**Note:** PagedAttention is the memory layout that stops the waste, while prefix caching is the reuse of already-computed KV across requests. They are separate ideas, but PagedAttention is what makes prefix caching's block sharing feasible.

PagedAttention was introduced by the vLLM serving system. We have a detailed blog on how vLLM works that covers this end to end.

### A quick map of which technique helps which phase

Let me lay out these techniques and the phase or metric each one targets in a table for your better understanding.

| Technique | Main target | What it improves |
| --- | --- | --- |
| KV cache | Decode | Makes decode fast by avoiding recomputation |
| Continuous batching | Both phases | Throughput (more users served together) |
| Chunked prefill | Serving smoothness for other users | Prevents long prefills from stalling ongoing token streaming (protects others' ITL) |
| Prefix caching | Prefill | TTFT (skips redundant prompt processing) |
| Disaggregated serving | Both phases | TTFT and TPOT independently, at scale |
| Speculative decoding | Decode | TPOT (faster token generation) |
| PagedAttention | KV cache memory | Throughput (bigger batches, less waste) |

Keep this table as a handy mental map. When the goal is a faster first word, look to the prefill side. When the goal is faster streaming or more simultaneous users, look to the decode side.

## Conclusion

Let's wrap up with a simple timeline recap.

An LLM answers in two phases. **Prefill** takes in your whole prompt in one parallel pass, fills the KV cache, and emits the first token. It is compute-bound, and it determines TTFT, meaning how quickly the answer starts. **Decode** then produces the rest of the answer one token at a time, reading and extending the KV cache at every step. It is memory-bandwidth-bound, and it determines TPOT, meaning how quickly the answer streams.

The **KV cache** is the bridge between the two phases. Prefill writes it; decode reads it and grows it. It spares us from recomputing the past at every step, but it expands with every token and eats into GPU memory.

Since the two phases face opposite bottlenecks, each optimization goes after one of them. Continuous batching and PagedAttention lift throughput. Prefix caching and chunked prefill help prefill and keep streaming smooth. Speculative decoding accelerates decode. Disaggregated serving separates the two phases so each can hit its own target.

Each of these optimization techniques has its own dedicated deep-dive, collected in our LLM Inference Optimization blog.

This was all about Prefill vs Decode.

That's it for now.
