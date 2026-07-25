---
title: "How does SGLang work?"
slug: "how-does-sglang-work"
date: "2026-07-25"
tags: ["llm", "ai", "system-design", "sglang"]
reading_time: "13 min read"
words: 2633
summary: "In this blog, we will learn about how SGLang works. We will see the problem it solves, how RadixAttention reuses saved work through a radix tree, how the frontend language and the runtime cooperate, and how SGLang compares to vLLM — with pointers to build the core ideas yourself in PyTorch."
---

# How does SGLang work?

In this blog, we will learn about how SGLang works. We will also see what problem it solves, how it makes serving large language models faster, and the clever ideas that make it special. And because reading about an idea is not the same as building it, this blog pairs with two hands-on companions where we implement SGLang's core in plain PyTorch: [the KV cache from scratch](/blog/kv-cache-from-scratch-pytorch) and [RadixAttention from scratch](/blog/radix-attention-from-scratch-pytorch).

We will cover the following:

- What is SGLang
- A quick recap of how an LLM generates text
- The problem SGLang solves
- RadixAttention: the heart of SGLang
- How RadixAttention reuses past work
- The frontend language of SGLang
- Continuous batching in SGLang
- Structured output and faster decoding
- A simple end-to-end picture
- Trying SGLang yourself
- More powerful features of SGLang
- How SGLang compares to vLLM

Let's get started.

## What is SGLang

SGLang is a high-performance serving framework for large language models and multimodal models.

In simple words, it is a tool that takes a large language model and serves its answers to many users at the same time, as fast as possible.

The name SGLang comes from two parts.

SGLang = `SG` (Structured Generation) + `Lang` (Language).

So, the name itself tells us two things. It helps us generate structured output in a controlled way, and it gives us a small language to write our instructions.

For now, just remember this. SGLang has two main pieces that deliver these two things. One piece is a **runtime**, which is the engine that actually runs the model fast and takes care of the structured output. The other piece is a **frontend language**, the friendly way for us to tell the model what to do.

Now, before we understand why SGLang is fast, we must first understand how an LLM generates text. Once we know that, the magic of SGLang will be very clear.

## A quick recap of how an LLM generates text

An LLM writes text one **token** at a time — roughly one word per token. It reads our input, produces one token, then reads the input plus that new token, produces the next, and keeps going until the answer is complete.

To produce each new token, the model looks back at everything that came before. Looking back at all the previous tokens again and again would be very slow, so the model stores helpful numbers from the previous tokens and reuses them. These stored numbers are called the [**KV cache**](/blog/kv-cache).

> The KV cache is the model's saved work for the tokens it has already seen, so it does not have to redo that work for every new token.

This KV cache is the key to understanding why SGLang is so fast. If you want to *feel* this instead of just reading it, the [KV cache from scratch blog](/blog/kv-cache-from-scratch-pytorch) builds this exact mechanism in PyTorch and counts the saved work: on even a toy example, 264 token computations collapse to 24.

## The problem SGLang solves

In the real world, an LLM does not answer just one person. It answers thousands of people at the same time. And the same model is asked many similar things again and again.

Let's say we build a chatbot. Every single conversation begins with the same instruction, called a **system prompt** — a fixed set of instructions we give the model before the user speaks, for example "You are a helpful assistant.". Every user's request starts with this same instruction, and the model processes this same text again and again, for every user. This is wasted work.

Here is another example. Suppose we are building an agent that answers questions about a document. The document is the same for every question, but the model reads the whole document from scratch for each question. This is like reading an entire book from page one, every single time someone asks you a small question about it.

So, the problem is clear. The model repeats the same expensive work many times. We need a way to do that shared work only once and reuse it.

So, here comes SGLang to the rescue.

SGLang was built around one central idea. **If two requests share the same starting text, they can share the saved work for that text.** This saved work, as we learned, is the KV cache. The technique that makes this sharing possible is called **RadixAttention**. This is the heart of SGLang.

## RadixAttention: the heart of SGLang

Let's break down this name first.

RadixAttention = `Radix` (a way to organize text by shared prefixes) + `Attention` (the core operation an LLM uses to look back at previous tokens).

To understand Radix, we must first understand a **prefix** — the starting part that two pieces of text have in common. Look at "The sky is blue" and "The sky is clear". They share the prefix "The sky is". After that, one says "blue" and the other says "clear".

Now, SGLang keeps a smart structure called a **radix tree** to store the KV cache of many requests. A **radix tree** is a tree-like structure that groups text by its shared prefix. We can think of it as a family tree of sentences. Sentences that begin the same way share the same branch. They only split apart at the point where they become different.

Let's make this very concrete. Suppose three users send these three requests:

- "You are a helpful assistant. What is the capital of France?"
- "You are a helpful assistant. What is the capital of Japan?"
- "You are a helpful assistant. Tell me a joke."

Without SGLang, the model would process "You are a helpful assistant." three separate times. With SGLang, the radix tree stores that shared part once:

```
              "You are a helpful assistant."
              (shared prefix, KV cache stored once)
                            |
              +-------------+--------------+
              |                            |
              v                            v
     "What is the capital of"       "Tell me a joke."
      (shared by two requests,        (unique tail)
       KV cache stored once)
              |
          +---+---+
          |       |
          v       v
      "France?"  "Japan?"
      (unique)   (unique)
```

Here, we can see that the common start sits at the top as one shared branch, computed only once. Below it, the two requests that ask about a capital share even more text — "What is the capital of" — so that part becomes another shared branch, also stored once. Only at the very bottom do "France?" and "Japan?" split into their own unique parts. None of the shared branches are ever recomputed.

This is how RadixAttention saves a huge amount of work.

## How RadixAttention reuses past work

Now, let's understand the steps SGLang follows for each request.

**Step 1:** A new request arrives. For example, "You are a helpful assistant. What is the capital of Italy?".

**Step 2:** SGLang looks at its radix tree and checks how much of the start of this request already exists in the tree.

**Step 3:** It finds that "You are a helpful assistant. What is the capital of" is already there, because the earlier requests about France and Japan added it. So, it reuses the saved KV cache for that whole part. It does not recompute it.

**Step 4:** Only the new part, "Italy?", is processed fresh. The new saved work is then added as a new branch in the tree.

**Step 5:** The model generates the answer one token at a time, just like we learned earlier.

So the more text different requests share, the more work SGLang saves — automatically, with nothing to enable. We call this four-step pattern **traverse, reuse, compute, store**, and the [RadixAttention from scratch blog](/blog/radix-attention-from-scratch-pytorch) implements it in about 60 lines: on a document-Q&A workload, question 1 pays the full prefill and questions 2 through 6 hit ~90 percent of their prompt in the cache.

There is one more thing to understand. The memory that stores the KV cache is limited; it cannot hold everything forever. When memory gets full, SGLang removes the **least recently used** branches first. This is a clever choice: popular shared prefixes, like the system prompt, stay in memory because they are used all the time, while rare one-off parts get removed when space is needed. The concept-level story of this reuse is in our [prefix caching blog](/blog/prefix-caching).

## The frontend language of SGLang

Till now, we have learned about the engine. Now, the friendly part: the **frontend language**, a simple way to write our instructions to the model right inside our Python code.

Why do we need this? Because real tasks are rarely a single question. Let's say we want the model to read a paragraph, summarize it, then translate the summary into French — three steps that depend on each other.

```python
import sglang as sgl

@sgl.function
def summarize_and_translate(s, paragraph):
    s += "Summarize this paragraph:\n" + paragraph + "\n"
    s += "Summary: " + sgl.gen("summary", max_tokens=64)
    s += "Now translate the summary to French.\n"
    s += "French: " + sgl.gen("french", max_tokens=64)
```

- The variable `s` holds the growing conversation. We keep adding text to it.
- `sgl.gen("summary", ...)` asks the model to generate and saves the result under a name.

Here is the nice part: the frontend understands the structure of our program. It knows which parts are fixed and shared, and which parts are new. So when many requests run the same program, they naturally share the same prefixes — and the runtime exploits that through the radix tree. The frontend exposes the shared structure; the runtime turns it into speed.

## Continuous batching in SGLang

SGLang also uses [**continuous batching**](/blog/continuous-batching) — as soon as one request in the running batch finishes, a new waiting request takes its slot right away, so no slot ever sits idle waiting for the whole group.

This idea is not unique to SGLang; every modern engine uses it. The special part is the combination: RadixAttention reuses the shared work through the radix tree, and continuous batching keeps the machine busy. This pairing is what makes SGLang shine when many requests share a long common start.

## Structured output and faster decoding

Now the "Structured Generation" part of the name. Many times we do not want free text — we want, say, JSON:

```json
{
  "name": "Italy",
  "capital": "Rome"
}
```

The problem is that a normal model may produce slightly broken JSON — a missing bracket, extra words — and then our program cannot read it.

SGLang lets us force the output to follow a fixed shape. This is called **constrained decoding**: the model is only allowed to pick tokens that keep the output valid for our chosen format. If a token would break the format, it is simply not allowed. So the output is always valid.

There is a bonus. Because the format already fixes some parts of the output (every `{`, every field name), SGLang can fill those fixed parts very quickly instead of asking the model for them one token at a time. Structured output becomes not just reliable but *faster*.

## A simple end-to-end picture

```
   We write the task (frontend language)
                 |
                 v
        SGLang runtime (engine)
                 |
                 v
     Check the radix tree for a shared prefix
                 |
        +--------+--------+
        |                 |
   found prefix       new part
        |                 |
        v                 v
  reuse saved KV    process fresh and
  cache (Radix      add to the tree
  Attention)             |
        +--------+--------+
                 |
                 v
   Join a batch (continuous batching keeps
            the engine busy)
                 |
                 v
   Generate one token at a time
   (constrained decoding keeps the format valid)
                 |
                 v
       Fast, well-shaped answer
```

The request flows from our frontend code into the runtime, through the radix tree where shared work is reused, into a batch that keeps the engine busy, and out as a valid answer.

## Trying SGLang yourself

Like vLLM, SGLang ships an OpenAI-compatible server, so everything from the [vLLM practical guide](/blog/serving-llms-with-vllm) transfers — only the launch command changes:

```bash
pip install "sglang[all]"

python -m sglang.launch_server --model-path Qwen/Qwen3-0.6B --port 30000
```

Then the same `openai` client code works with `base_url="http://localhost:30000/v1"`. RadixAttention is on by default — send a few requests sharing a system prompt and watch the reported cached-token counts climb.

When does it pay off most? When prompts share long beginnings. Our own production workload is the perfect example: a ~2.4K-token system prompt identical on every call, followed by a short per-customer part. On such traffic the radix tree keeps the entire shared prompt hot, prefill for it becomes nearly free after the first request, and the engine spends its time only on what actually differs between requests.

## More powerful features of SGLang

SGLang is much more than RadixAttention. Briefly, in simple words — many of these appear in other modern engines too, and several have their own deep-dives in [our series](/topic/llm-inference):

- **[Chunked prefill](/blog/chunked-prefill).** Long prompts are read in chunks, mixed in with decode steps, so one giant document cannot freeze everyone else's streaming.
- **[Speculative decoding](/blog/speculative-decoding).** A small helper guesses several tokens ahead; the main model checks the guesses in one step.
- **[Prefill-decode disaggregation](/blog/disaggregated-serving).** The two phases run on separate machines, each tuned for its own job, with a smart router in between.
- **Splitting a model across many GPUs.** Models too big for one GPU get split across several; for giant mixture-of-experts models, the experts get spread across machines.
- **[Quantization](/blog/llm-compressor-quantization).** Weights are stored in a smaller form so the model uses less memory and streams faster.
- **A smart scheduler.** The CPU plans the next batch while the GPU is still busy with the current one, so the GPU almost never waits.
- **Cache-aware load balancing.** Across many machines, each request is routed to the machine that already holds its shared prefix — RadixAttention keeps working at cluster scale.

## How SGLang compares to vLLM

[vLLM](/blog/serving-llms-with-vllm) is the other big open-source serving engine, so it is natural to ask how they differ. The honest picture: both are excellent, and over time they have become quite similar. Both are fast, both batch continuously, both reuse KV cache for shared text, both produce structured output, and both speak the same OpenAI-style API.

What actually differs:

| Point | vLLM | SGLang |
| --- | --- | --- |
| Reusing shared text | In fixed-size blocks ([PagedAttention](/blog/paged-attention)) | Piece by piece, using a radix tree |
| Track record and community | The longest and largest | Newer, but growing very fast |
| Best known for | General fast serving and maturity | Prefix sharing, the frontend language, structured output |
| Great for | Many very different requests | Multi-turn chat, agents, document Q&A |

The sharing difference is the interesting one. SGLang matches shared text precisely, token by token, so it can catch sharing that block-based matching would miss — especially in long back-and-forth chats where each turn adds a little more text. When many requests start with the exact same fixed text, both do very well.

On raw speed, the honest answer is: it depends on the model, the workload, and the version — both keep improving quickly, and there is no single winner.

How to choose: for the largest community and general serving with very different requests, vLLM. For heavy text sharing — multi-turn chat, agents, document Q&A — and strong structured output, SGLang. For many everyday cases, both will serve us well.

## Conclusion

SGLang reuses shared work with RadixAttention's radix tree, lets us write multi-step tasks with the frontend language, keeps the machine busy with continuous batching, and guarantees well-shaped output with constrained decoding. To make these ideas fully concrete, build them yourself: [the KV cache from scratch](/blog/kv-cache-from-scratch-pytorch), then [RadixAttention from scratch](/blog/radix-attention-from-scratch-pytorch) — together they turn this whole blog into about a hundred lines of PyTorch you wrote and measured.

That's it for now.
