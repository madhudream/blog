---
title: "Build the KV Cache from Scratch in PyTorch"
slug: "kv-cache-from-scratch-pytorch"
date: "2026-07-25"
tags: ["llm", "ai", "pytorch", "hands-on"]
reading_time: "7 min read"
words: 1493
summary: "In this blog, we will build LLM text generation from scratch in PyTorch: write the attention formula as four lines of code, implement the naive decode loop, count exactly how much work it wastes, then add the KV cache and watch the token computations collapse from quadratic to linear."
---

# Build the KV Cache from Scratch in PyTorch

In this blog, we will stop reading about the [KV cache](/blog/kv-cache) and build it. Using nothing but PyTorch and a small Hugging Face model, we will write the attention formula in four lines, implement text generation the naive way, count exactly how many token computations it wastes, then add the KV cache and measure the speedup ourselves.

Everything runs on a laptop CPU. No GPU required.

We will cover the following:

- Setup: a tiny model to experiment on
- Tokenization: what the model actually sees
- The attention formula, translated to code
- Proving our attention is the real thing
- The naive decode loop
- Counting the waste
- The decode loop with a KV cache
- The comparison
- Conclusion

Let's get started.

## Setup: a tiny model to experiment on

We need a real transformer that is small enough to run anywhere. Qwen3-0.6B works well (any Hugging Face causal LM does — the course notebooks this blog is based on used DeepSeek-R1-Distill-Qwen-1.5B):

```python
import time, torch
import torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

model_path = "Qwen/Qwen3-0.6B"
tokenizer = AutoTokenizer.from_pretrained(model_path)
model = AutoModelForCausalLM.from_pretrained(
    model_path,
    torch_dtype=torch.float16,   # 2 bytes/param instead of 4
    device_map="auto",           # GPU if present, else CPU
    low_cpu_mem_usage=True,
)
model.eval()                     # inference mode: no dropout
device = next(model.parameters()).device

input_text = "SGLang is a fast inference engine for"
max_new_tokens = 16
```

Two small notes that matter beyond this demo: `torch.float16` halves the memory (the [numbers blog](/blog/numbers-every-ai-engineer-should-know) explains bytes per parameter), and `model.eval()` plus `torch.inference_mode()` (used below) turn off gradient machinery we never need during generation.

Before implementing anything, we record the ground truth — what the model's built-in, fully optimized `generate()` produces:

```python
input_ids = tokenizer(input_text, return_tensors="pt").input_ids.to(device)
output_ids = model.generate(input_ids, max_new_tokens=max_new_tokens,
                            do_sample=False, use_cache=True,
                            pad_token_id=tokenizer.eos_token_id)
ground_truth = tokenizer.decode(output_ids[0], skip_special_tokens=True)
print(ground_truth)
```

Every implementation we write must reproduce this text **exactly**. That is our correctness test — much stronger than eyeballing the output.

## Tokenization: what the model actually sees

The model never sees text. It sees token IDs:

```python
token_ids = tokenizer.encode(input_text)
print(token_ids)
# e.g. [50, 8494, 524, 374, 264, 4937, 45482, 4712, 369]
for tid in token_ids:
    print(f"{tid:>8} -> '{tokenizer.decode([tid])}'")
```

Our 8-word prompt becomes ~9 tokens (roughly the 0.75-words-per-token rule from the [numbers blog](/blog/numbers-every-ai-engineer-should-know)). Remember this count — call it `initial_tokens` — because our waste-counting below is measured in tokens processed.

## The attention formula, translated to code

Every transformer layer runs attention: `softmax(Q·Kᵀ / √d_k)·V`. That formula looks intimidating in papers and is four lines in PyTorch:

```python
def attention(q, k, v, scale, mask):
    """softmax(Q @ K^T / sqrt(d_k)) @ V"""
    scores = torch.matmul(q, k.transpose(-2, -1)) * scale   # Q @ K^T
    scores = scores.masked_fill(~mask, float("-inf"))        # hide the future
    probs = torch.softmax(scores, dim=-1)                    # normalize
    return torch.matmul(probs, v)                            # weighted sum of V
```

Reading it line by line:

- **Line 1** compares every Query against every Key — one similarity score per (query token, key token) pair. This is the "search" from our [KV cache blog](/blog/kv-cache)'s hotel-database story.
- **Line 2** applies the **causal mask**: a token may only look at tokens before it, so future positions are set to negative infinity (which becomes zero after softmax).
- **Line 3** turns scores into weights that sum to 1.
- **Line 4** blends the Values using those weights.

To plug this into a real model we need one more wrapper, because modern models use **grouped-query attention (GQA)** — several Query heads share each KV head to shrink the KV cache:

```python
def simple_causal_attention(query, key, value, **kwargs):
    """Drop-in replacement for F.scaled_dot_product_attention."""
    scale = 1.0 / (query.shape[-1] ** 0.5)

    # GQA: expand shared K/V heads to match the query heads
    group = query.shape[1] // key.shape[1]
    key = key.repeat_interleave(group, dim=1)
    value = value.repeat_interleave(group, dim=1)

    qf, kf, vf = query.float(), key.float(), value.float()
    Tq, Tk = qf.shape[-2], kf.shape[-2]
    mask = torch.ones((Tq, Tk), device=qf.device, dtype=torch.bool).tril()
    return attention(qf, kf, vf, scale, mask[None, None]).to(query.dtype)
```

## Proving our attention is the real thing

Here is the fun part. PyTorch routes every transformer layer's attention through one function, `F.scaled_dot_product_attention`. We can swap in ours and run the whole model through our four lines:

```python
_orig = F.scaled_dot_product_attention
F.scaled_dot_product_attention = simple_causal_attention   # monkey-patch

# ... generate text (using the decode loop from the next section) ...

F.scaled_dot_product_attention = _orig                     # restore
```

The output matches the ground truth exactly. That equality is the proof: the four-line formula is not a simplification of what LLMs do — it **is** what LLMs do, just without the speed tricks.

## The naive decode loop

Now generation itself. An LLM generates [autoregressively](/blog/prefill-vs-decode): predict one token, append it, repeat. The naive implementation re-feeds the **entire sequence** every step:

```python
@torch.inference_mode()
def decode_no_cache(prompt, max_new_tokens):
    token_ids = tokenizer.encode(prompt)
    for _ in range(max_new_tokens):
        inp = torch.tensor([token_ids], device=device)   # the WHOLE sequence
        logits = model(inp).logits[:, -1, :]             # full forward pass
        next_id = logits.argmax(dim=-1).item()           # greedy pick
        token_ids.append(next_id)
    return tokenizer.decode(token_ids, skip_special_tokens=True)

tic = time.time()
text = decode_no_cache(input_text, max_new_tokens)
time_no_cache = time.time() - tic
assert text == ground_truth                              # still exact
```

It is correct — the assert passes. But look at what it does: at step 1 it processes `initial_tokens` tokens, at step 2 it processes `initial_tokens + 1`, at step 3 `initial_tokens + 2`... every K and V we computed last step gets thrown away and rebuilt from scratch.

## Counting the waste

We don't have to hand-wave "it's slow" — we can count the tokens processed exactly:

```python
initial_tokens = len(tokenizer.encode(input_text))   # e.g. 9

total_ops = sum(initial_tokens + i for i in range(max_new_tokens))
print(total_ops)   # 9+10+11+...+24 = 264 token computations for 16 new tokens
```

The sum `n + (n+1) + (n+2) + ...` is the signature of **quadratic** growth: generate twice as many tokens and the work roughly quadruples. For our toy case it's 264 computations. For a 1,000-token answer on a 1,000-token prompt it would be ~1.5 million — to produce 1,000 tokens. This is the O(n²) our [KV cache blog](/blog/kv-cache) warned about, now with receipts.

## The decode loop with a KV cache

The fix, as we know from the [theory](/blog/kv-cache): a past token's Key and Value never change, so compute them once and keep them. Hugging Face models expose exactly this via `past_key_values` — the KV cache as a real object we can hold in a variable:

```python
@torch.inference_mode()
def decode_with_kv_cache(prompt, max_new_tokens):
    token_ids = tokenizer.encode(prompt)

    # PREFILL: process the whole prompt ONCE, receive the cache
    inp = torch.tensor([token_ids], device=device)
    out = model(inp, use_cache=True)
    past = out.past_key_values                      # <-- the KV cache
    next_id = out.logits[:, -1, :].argmax(dim=-1).item()
    token_ids.append(next_id)

    # DECODE: feed ONE token per step + the cache
    for _ in range(max_new_tokens - 1):
        inp = torch.tensor([[token_ids[-1]]], device=device)   # just 1 token!
        out = model(inp, past_key_values=past, use_cache=True)
        past = out.past_key_values                  # cache grew by one entry
        next_id = out.logits[:, -1, :].argmax(dim=-1).item()
        token_ids.append(next_id)

    return tokenizer.decode(token_ids, skip_special_tokens=True)

tic = time.time()
text = decode_with_kv_cache(input_text, max_new_tokens)
time_with_cache = time.time() - tic
assert text == ground_truth                         # byte-identical output
```

Notice the structure that fell out of this code: one big pass over the prompt, then a loop of one-token passes. We didn't design that — it is forced by the math. **We just derived [prefill and decode](/blog/prefill-vs-decode) from first principles.** The `past` variable being read and re-assigned every iteration is the cache being consulted and extended, exactly as the theory blog's diagram showed.

## The comparison

```python
total_ops_kv = initial_tokens + (max_new_tokens - 1)   # 9 + 15 = 24

print(f"Without cache: {total_ops} token computations, {time_no_cache:.2f}s")
print(f"With cache:    {total_ops_kv} token computations, {time_with_cache:.2f}s")
print(f"Operations:    {total_ops // total_ops_kv}x fewer")
print(f"Speedup:       {time_no_cache / time_with_cache:.1f}x")
```

For our tiny example: 264 computations drop to 24 — 11x fewer — and both outputs are byte-identical to the ground truth. The gap widens with length: the naive loop grows quadratically, the cached loop linearly. Per step the pattern is:

```
step:            1    2    3    4    5   ...
without cache:   9   10   11   12   13   ...   (grows every step)
with cache:      9    1    1    1    1   ...   (prefill once, then 1/step)
```

That flat line of 1s is the entire reason chat assistants can stream long answers at constant speed.

## Conclusion

We wrote attention in four lines, verified it against a real model via monkey-patching, implemented the naive quadratic decode loop, counted its waste exactly (264 vs 24 token computations on even a toy example), and fixed it with `past_key_values` — the KV cache as a concrete PyTorch object. Along the way, prefill and decode emerged naturally from the code instead of being definitions to memorize.

One limitation remains: our cache lives and dies with a single request. The moment generation ends, `past` is garbage-collected — and the next request recomputes everything, even an identical prompt. Fixing that is **prefix caching across requests**, and building it is exactly what we do in the next hands-on blog: [RadixAttention from scratch](/blog/radix-attention-from-scratch-pytorch). For the production version of all of this, see [how SGLang works](/blog/how-does-sglang-work) and the [vLLM guide](/blog/serving-llms-with-vllm).

That's it for now.
