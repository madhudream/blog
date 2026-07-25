---
title: "Quantizing a Model with LLM Compressor"
slug: "llm-compressor-quantization"
date: "2026-07-25"
tags: ["llm", "ai", "system-design", "quantization", "hands-on"]
reading_time: "8 min read"
words: 1532
summary: "In this blog, we will quantize a real model with LLM Compressor, the production quantization toolkit from the vLLM project. We will apply a GPTQ recipe that produces a W4A16 model in one pass, compare the size on disk, sanity-check the outputs, measure the quality cost with perplexity, and serve the result with vLLM."
---

# Quantizing a Model with LLM Compressor

In this blog, we will quantize a real model with **LLM Compressor** and measure exactly what we gained and what we paid. We will take Qwen3-0.6B in BF16, compress it to 4-bit weights with a GPTQ recipe, and then check size, outputs, and perplexity side by side.

We will cover the following:

- Why quantize at all
- What W4A16 means
- What is LLM Compressor
- The recipe: GPTQModifier
- Running oneshot
- How much smaller did it get
- Sanity check: do the outputs still make sense
- Measuring the quality cost with perplexity
- Serving the quantized model with vLLM
- When to use FP8 instead
- Conclusion

Let's get started.

## Why quantize at all

A model's weights are stored as numbers, and the precision of those numbers is a choice. Qwen3-0.6B in BF16 uses 16 bits (2 bytes) per weight. **Quantization** stores the same weights in fewer bits — 8, or even 4 — accepting a tiny loss of precision in exchange for a much smaller model.

Why do we care? Two reasons, both from the [inference](/blog/prefill-vs-decode) side:

- **Memory.** Smaller weights fit on smaller (cheaper) GPUs, and the freed memory goes to the [KV cache](/blog/kv-cache), which means bigger batches and more concurrent users.
- **Speed.** [Decode is memory-bandwidth-bound](/blog/prefill-vs-decode): every decode step streams the entire set of weights out of GPU memory. Half the bytes to move means the memory-bound part of decode gets meaningfully faster.

So quantization is not just a storage trick. It directly attacks the decode bottleneck.

## What W4A16 means

The scheme we will apply is called **W4A16**:

- **W4** — Weights are stored in 4 bits.
- **A16** — Activations (the numbers flowing through the model at runtime) stay in 16 bits.

So the weights live on disk and in GPU memory at 4 bits, and get expanded back to 16 bits on the fly inside the compute kernels. Compared to BF16, that is a ~4x reduction for every quantized layer.

The algorithm that decides how to round 16-bit weights down to 4 bits is **GPTQ**. Naive rounding would damage the model badly. GPTQ instead processes weights layer by layer, using a small **calibration dataset** — a few hundred samples of real text — to measure which weights matter most and to adjust the remaining weights to compensate for each rounding error. The result is a 4-bit model that behaves remarkably close to the original.

## What is LLM Compressor

[llm-compressor](https://github.com/vllm-project/llm-compressor) is the production quantization toolkit from the vLLM project. It takes a trained model and reduces precision in a single pass, no retraining required.

The core API is **`oneshot`**: you give it a model, a calibration dataset, and a **recipe** describing how to quantize (e.g. GPTQ, W4A16). It produces a smaller model that can be served directly by [vLLM](/blog/serving-llms-with-vllm). The name "oneshot" reflects that this happens in a single pass over calibration data — no training loop, no gradients, no GPUs burning for days.

```bash
pip install llmcompressor
```

## The recipe: GPTQModifier

A recipe tells LLM Compressor what to do to which layers. Ours is three lines:

```python
from llmcompressor.modifiers.quantization import GPTQModifier

recipe = GPTQModifier(
    scheme="W4A16",
    targets="Linear",
    ignore=["lm_head"],
)
```

- **`scheme="W4A16"`** — 4-bit weights, 16-bit activations, as explained above.
- **`targets="Linear"`** — quantize the Linear (fully connected) layers, which is where almost all of an LLM's weights live.
- **`ignore=["lm_head"]`** — leave the final output layer at full precision. The lm_head maps the model's internal state to a score for every token in the vocabulary, and quantizing it hurts output quality far more than the memory it saves. Skipping it is standard practice.

## Running oneshot

Now the single pass:

```python
from llmcompressor import oneshot

oneshot(
    model="Qwen/Qwen3-0.6B",              # HuggingFace model ID
    dataset="wikitext",                   # calibration dataset
    dataset_config_name="wikitext-2-raw-v1",
    recipe=recipe,                        # the GPTQModifier above
    output_dir="./Qwen3-0.6B-W4A16",      # where to save
    max_seq_length=4096,
    num_calibration_samples=256,
)
```

What happens inside: LLM Compressor loads the model, runs the 256 calibration samples through it to observe the activations, applies GPTQ layer by layer (quantizing each layer while compensating for the error it introduces), and saves the result in the **compressed-tensors** format that vLLM reads natively. For a 0.6B model this takes minutes; for a 30B model, an hour or so on a decent GPU.

## How much smaller did it get

We can measure the win directly on disk:

```python
import pathlib

def folder_size(path):
    return sum(f.stat().st_size for f in pathlib.Path(path).rglob("*") if f.is_file())

size_orig = folder_size("./Qwen3-0.6B")
size_q = folder_size("./Qwen3-0.6B-W4A16")
print(f"Original (BF16):   {size_orig / 1024**3:.2f} GB")
print(f"Quantized (W4A16): {size_q / 1024**3:.2f} GB")
print(f"Reduction:         {(1 - size_q / size_orig) * 100:.0f}%")
```

The quantized Linear layers shrink ~4x. The whole folder shrinks somewhat less than 4x, because the embeddings, the ignored lm_head, and the per-group scale factors that GPTQ stores alongside the 4-bit weights all remain at higher precision. On larger models the Linear layers dominate even more, so the overall reduction gets closer to the ideal 4x.

## Sanity check: do the outputs still make sense

Before any formal metric, the cheapest test is greedy generation on the same prompt, base vs quantized:

```python
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

prompt = "Machine learning is a branch of"
tokenizer = AutoTokenizer.from_pretrained("./Qwen3-0.6B")

for name, path in [("Base", "./Qwen3-0.6B"), ("W4A16", "./Qwen3-0.6B-W4A16")]:
    model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.bfloat16)
    inputs = tokenizer(prompt, return_tensors="pt")
    out = model.generate(**inputs, max_new_tokens=60, do_sample=False,
                         pad_token_id=tokenizer.eos_token_id)
    text = tokenizer.decode(out[0][inputs["input_ids"].shape[-1]:],
                            skip_special_tokens=True)
    print(f"{name}: {text}\n")
```

With `do_sample=False` both models pick their single most likely token at every step, so any difference we see comes purely from quantization. Typically the two completions are near-identical for the first stretch and may diverge later — small logit differences compound over long generations. Both should read as coherent, on-topic text. If the quantized model produces garbage here, something went wrong (usually too few calibration samples or a quantized lm_head).

## Measuring the quality cost with perplexity

**Perplexity** measures how surprised the model is by real text — lower is better. It is the standard first-line metric for quantization damage because it is sensitive to exactly the thing quantization perturbs: the model's probability estimates.

```python
import math, torch
from datasets import load_dataset

def calculate_perplexity(model, tokenizer, dataset, max_tokens=5000, stride=512):
    encodings = tokenizer("\n\n".join(dataset["text"]),
                          return_tensors="pt", truncation=True, max_length=max_tokens)
    input_ids = encodings.input_ids
    nlls, prev_end = [], 0
    for begin_loc in range(0, input_ids.size(1), stride):
        end_loc = min(begin_loc + stride, input_ids.size(1))
        trg_len = end_loc - prev_end
        input_slice = input_ids[:, begin_loc:end_loc]
        target_slice = input_slice.clone()
        target_slice[:, :-trg_len] = -100
        with torch.no_grad():
            loss = model(input_slice, labels=target_slice).loss
            nlls.append(loss * trg_len)
        prev_end = end_loc
    return math.exp(torch.stack(nlls).sum() / prev_end)

test_data = load_dataset("wikitext", "wikitext-2-raw-v1", split="test")
base_ppl = calculate_perplexity(base_model, tokenizer, test_data)
quant_ppl = calculate_perplexity(quant_model, tokenizer, test_data)

print(f"Base (BF16):       {base_ppl:.2f}")
print(f"Quantized (W4A16): {quant_ppl:.2f}")
print(f"Difference:        {quant_ppl - base_ppl:+.2f} "
      f"({(quant_ppl / base_ppl - 1) * 100:+.1f}%)")
```

A small perplexity increase is expected — the quantized layers really do carry less information. A few percent is the normal price for W4A16 on a well-calibrated model. If the increase is large (tens of percent), revisit the recipe before shipping. For a production decision, follow up with task-level evaluation via lm_eval against the served model, exactly as shown in the [vLLM blog](/blog/serving-llms-with-vllm).

## Serving the quantized model with vLLM

The whole point of the compressed-tensors format is that vLLM reads it directly:

```bash
vllm serve ./Qwen3-0.6B-W4A16 --max-model-len 4096
```

One caveat: **W4A16 needs a GPU to pay off.** Its optimized 4-bit kernels (Marlin and friends) exist for GPUs; on CPU the format has no fast runtime path. Serve the BF16 model when experimenting on CPU, and deploy the W4A16 model on GPU hardware.

From there, everything in the [vLLM serving guide](/blog/serving-llms-with-vllm) applies unchanged — the OpenAI-compatible API, [continuous batching](/blog/continuous-batching), [prefix caching](/blog/prefix-caching), GuideLLM benchmarking. The freed memory shows up as more room for the [KV cache](/blog/kv-cache), i.e. more concurrent users per GPU.

## When to use FP8 instead

W4A16 with GPTQ is not the only option, and it is not always the first one to reach for:

- **FP8 (W8A8)** halves the weights instead of quartering them, keeps ~99% of quality, and — crucially — many model families publish **official pre-quantized FP8 checkpoints** (e.g. `Qwen/Qwen3-30B-A3B-Instruct-2507-FP8`, `RedHatAI/Llama-3.3-70B-Instruct-FP8-dynamic`). Those need no calibration step at all: `vllm serve <checkpoint>` and done. In our own production experiment we served the Qwen FP8 checkpoint on one A100 for exactly this reason.
- **W4A16 (GPTQ via LLM Compressor)** is the tool when memory is genuinely tight — squeezing a model onto a smaller GPU, or freeing maximum room for KV cache — and when no pre-quantized checkpoint exists for your (possibly fine-tuned) model.

A sensible default: use an official FP8 checkpoint if one exists and fits; run LLM Compressor yourself when it doesn't.

## Conclusion

LLM Compressor turns quantization into a 20-line script: a `GPTQModifier` recipe, one `oneshot` call over 256 calibration samples, and out comes a W4A16 model ~4x smaller in its quantized layers, ready for `vllm serve`. The verification loop matters as much as the compression: compare greedy outputs, check perplexity, and run task evals on the served endpoint before trusting it in production.

Quantization is one lever among several — see the [LLM inference optimization hub](/topic/llm-inference) for how it combines with [PagedAttention](/blog/paged-attention), [continuous batching](/blog/continuous-batching), and the rest of the serving stack.

That's it for now.
