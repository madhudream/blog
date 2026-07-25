---
title: "Serving LLMs with vLLM: A Practical Guide"
slug: "serving-llms-with-vllm"
date: "2026-07-25"
tags: ["llm", "ai", "system-design", "vllm", "hands-on"]
reading_time: "10 min read"
words: 2020
summary: "In this blog, we will serve a real model with vLLM and touch every big serving idea with running code. We will launch the server, query it with the OpenAI client, watch continuous batching and the KV cache through live Prometheus metrics, demonstrate prefix caching, estimate KV cache memory by hand, and benchmark the deployment with GuideLLM and lm_eval."
---

# Serving LLMs with vLLM: A Practical Guide

In this blog, we will serve a real model with vLLM and touch every big serving idea with running code. Instead of only reading about [PagedAttention](/blog/paged-attention) and [continuous batching](/blog/continuous-batching), we will launch a server, query it, and watch these mechanisms work through the server's own metrics.

We will cover the following:

- What vLLM is, in one minute
- Installing and launching the vLLM server
- Your first request with the OpenAI client
- Streaming tokens
- Watching the engine: live Prometheus metrics
- Continuous batching in action
- Prefix caching in action
- How big is the KV cache, really
- Benchmarking with GuideLLM
- Checking quality with lm_eval
- Serving quantized models
- Conclusion

Let's get started.

## What vLLM is, in one minute

**vLLM is a high-throughput engine for serving LLMs.** It loads a model onto a GPU (or CPU), accepts many user requests at once, and squeezes as many tokens per second out of the hardware as possible.

It does this with a few key mechanisms, each of which has its own deep-dive blog:

| Feature | Benefit |
| --- | --- |
| [Continuous batching](/blog/continuous-batching) | Schedules at the token level: no wasted compute waiting for the longest request |
| [PagedAttention](/blog/paged-attention) | Manages the KV cache in fixed-size blocks: near-zero memory waste |
| [Prefix caching](/blog/prefix-caching) | Reuses the KV cache for shared prompt prefixes across requests |
| Quantization support | Natively serves GPTQ, AWQ, FP8, and compressed-tensors models (see [LLM Compressor](/blog/llm-compressor-quantization)) |
| OpenAI-compatible API | Drop-in replacement for applications already using the OpenAI client |

If any term above is new, read [Prefill vs Decode](/blog/prefill-vs-decode) first — everything in serving builds on those two phases.

## Installing and launching the vLLM server

On a machine with a GPU, installation is one line and serving is one command:

```bash
pip install vllm

vllm serve Qwen/Qwen3-0.6B --dtype=bfloat16 --max-model-len 4096
```

What each part does:

- **`vllm serve`** launches vLLM's built-in inference server. It loads the model weights into the engine (with PagedAttention, continuous batching, and prefix caching enabled by default) and exposes it over HTTP on port 8000.
- **`Qwen/Qwen3-0.6B`** is the model identifier on the Hugging Face Hub. On first run, vLLM downloads the weights, tokenizer, and config into the local cache (`~/.cache/huggingface/hub`), then loads them into memory.
- **`--dtype=bfloat16`** loads the weights in BF16 precision.
- **`--max-model-len 4096`** caps the context window (prompt + generation) at 4096 tokens, which frees KV cache memory for batching.

No GPU? vLLM also ships CPU wheels. This is what we used to run everything in this blog on a plain Linux box:

```bash
uv venv ~/vllm-env --python 3.12
source ~/vllm-env/bin/activate

export VLLM_VERSION=0.18.0
uv pip install https://github.com/vllm-project/vllm/releases/download/v${VLLM_VERSION}/vllm-${VLLM_VERSION}+cpu-cp38-abi3-manylinux_2_35_x86_64.whl \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match

export VLLM_CPU_KVCACHE_SPACE=1
vllm serve Qwen/Qwen3-0.6B --dtype=bfloat16 --max-model-len 4096
```

The server takes a minute or two to be ready. We can wait for it programmatically:

```python
import time, requests

VLLM_URL = "http://localhost:8000"

for attempt in range(60):
    try:
        r = requests.get(f"{VLLM_URL}/v1/models", timeout=5)
        if r.status_code == 200:
            MODEL = r.json()["data"][0]["id"]
            break
    except requests.ConnectionError:
        pass
    time.sleep(5)

print(f"Connected to {VLLM_URL} — model: {MODEL}")
```

## Your first request with the OpenAI client

vLLM wraps the model in an **OpenAI-compatible HTTP API**. It implements the same routes the OpenAI SDK calls (`/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`) with the same request and response shapes. So we talk to our own server with the standard `openai` package — only the `base_url` changes:

```python
from openai import OpenAI
client = OpenAI(base_url=f"{VLLM_URL}/v1", api_key="unused")

resp = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user",
               "content": "What is PagedAttention in one sentence?"}],
    max_tokens=80,
    temperature=0.7,
    top_p=0.8,
    extra_body={"top_k": 20,
                "chat_template_kwargs": {"enable_thinking": False}},
)

print(resp.choices[0].message.content)
print(f"Usage: {resp.usage.prompt_tokens} prompt + "
      f"{resp.usage.completion_tokens} completion = {resp.usage.total_tokens} total")
```

Two details worth noticing:

- `api_key="unused"` — vLLM does not require a key by default, but the OpenAI client insists on one, so we pass a dummy.
- `extra_body` — vLLM accepts extra parameters beyond the OpenAI schema. Here we pass `top_k` and, for Qwen3, disable "thinking" mode so we get direct answers instead of long reasoning traces.

This compatibility is the reason vLLM is so easy to adopt: any tool already written against OpenAI's API can point at our own server by changing one URL.

## Streaming tokens

Because the model generates one token at a time (the [decode](/blog/prefill-vs-decode) phase), we can stream tokens to the user as they are produced:

```python
import sys

stream = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user",
               "content": "What makes continuous batching better than static batching?"}],
    max_tokens=80, temperature=0.7, stream=True,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        sys.stdout.write(chunk.choices[0].delta.content)
        sys.stdout.flush()
```

Streaming is what makes the answer feel fast: the user starts reading after [TTFT](/blog/llm-inference-metrics), not after the whole answer is done.

## Watching the engine: live Prometheus metrics

Here is the practical superpower most tutorials skip. vLLM exposes a **Prometheus `/metrics` endpoint** that tells us exactly what the engine is doing: how many requests are running, how full the KV cache is, how many tokens it has processed. A small scraper turns it into a dictionary:

```python
def get_vllm_metrics(base_url=VLLM_URL):
    """Scrape vLLM Prometheus /metrics and return {name: value}."""
    r = requests.get(f"{base_url}/metrics")
    metrics = {}
    for line in r.text.split("\n"):
        if line.startswith("#") or not line.strip():
            continue
        name = line.split("{")[0].split()[0]
        try:
            metrics[name] = float(line.split()[-1])
        except (ValueError, IndexError):
            continue
    return metrics

metrics = get_vllm_metrics()
for key in ["vllm:num_requests_running", "vllm:num_requests_waiting",
            "vllm:gpu_cache_usage_perc",
            "vllm:prompt_tokens_total", "vllm:generation_tokens_total"]:
    if key in metrics:
        print(f"  {key.replace('vllm:', '')}: {metrics[key]:g}")
```

The most useful ones:

- `num_requests_running` / `num_requests_waiting` — the live batch size and the queue.
- `gpu_cache_usage_perc` — how full the [PagedAttention](/blog/paged-attention) block pool is.
- `prompt_tokens_total` / `generation_tokens_total` — counters for prefill and decode work.
- `prefix_cache_queries_total` and its hit counters — [prefix caching](/blog/prefix-caching) activity.

We will use this scraper to catch the engine in the act, twice.

## Continuous batching in action

[Continuous batching](/blog/continuous-batching) means vLLM runs many requests together and refills a slot the moment a request finishes. Let's prove it is happening. We fire 5 requests at once from threads and scrape the metrics mid-flight:

```python
import concurrent.futures

prompts = [
    "What is quantization?",
    "Explain KV caching briefly.",
    "What is continuous batching?",
    "Why is LLM inference memory-bound?",
    "What is PagedAttention?",
]

def _ask(prompt):
    return client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=60, temperature=0.7,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )

before = get_vllm_metrics()
start = time.time()

with concurrent.futures.ThreadPoolExecutor(max_workers=len(prompts)) as pool:
    futures = {pool.submit(_ask, p): p for p in prompts}
    time.sleep(0.5)
    during = get_vllm_metrics()
    print(f"[mid-flight] running: {during.get('vllm:num_requests_running')}"
          f"  waiting: {during.get('vllm:num_requests_waiting')}")
    for f in concurrent.futures.as_completed(futures):
        resp = f.result()
        print(f"done: {futures[f][:40]} -> {resp.usage.completion_tokens} tokens")

elapsed = time.time() - start
after = get_vllm_metrics()
tokens = (after.get("vllm:generation_tokens_total", 0)
          - before.get("vllm:generation_tokens_total", 0))
print(f"\nAll {len(prompts)} completed in {elapsed:.2f}s "
      f"| ~{tokens / elapsed:.1f} tokens/s")
```

The mid-flight line shows `num_requests_running` above 1 — the engine really is decoding several requests in the same step. And the 5 requests finish in far less time than 5 sequential calls would take, because their decode steps share the hardware.

## Prefix caching in action

Real applications send the **same system prompt** on every request. [Prefix caching](/blog/prefix-caching) means vLLM computes the KV cache for that shared beginning once and reuses it. Let's watch it:

```python
SYSTEM_PROMPT = (
    "You are a helpful AI teaching assistant for a course on "
    "LLM optimization. You specialize in explaining concepts like "
    "quantization, inference optimization, and model serving. Keep "
    "answers concise -- one or two sentences."
)

questions = [
    "What is weight quantization?",
    "How does vLLM handle memory?",
    "What is continuous batching?",
    "Why use prefix caching?",
    "What is GPTQ?",
]

before = get_vllm_metrics()
for i, q in enumerate(questions):
    t0 = time.time()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": q},
        ],
        max_tokens=60, temperature=0.7,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )
    print(f"[{i+1}] {q:<35} {time.time() - t0:.2f}s")
after = get_vllm_metrics()

q_before = before.get("vllm:prefix_cache_queries_total", 0)
q_after = after.get("vllm:prefix_cache_queries_total", 0)
print(f"\nPrefix cache queries: {q_before:g} -> {q_after:g} (+{q_after - q_before:g})")
```

The rising `prefix_cache_queries_total` (and its matching hit counter) confirms vLLM is checking and reusing cached KV blocks for the shared system prompt. Request 1 pays the full prefill; requests 2 through 5 skip the system-prompt portion entirely. The longer the shared prefix, the bigger the saving — this directly cuts [TTFT](/blog/llm-inference-metrics).

## How big is the KV cache, really

The [KV cache](/blog/kv-cache) is the thing all this machinery manages, so let's compute its size by hand for the model we are serving. For Qwen3-0.6B: 28 layers, 8 KV heads (it uses grouped-query attention: 16 query heads share 8 KV heads), head dimension 128, BF16 (2 bytes). Per token we store one Key and one Value per layer per KV head:

```python
num_layers = 28
num_kv_heads = 8     # GQA: 16 Q heads, 8 KV heads
head_dim = 128
dtype_bytes = 2      # BF16

per_token = 2 * num_layers * num_kv_heads * head_dim * dtype_bytes
print(f"Per token: {per_token:,} bytes ({per_token // 1024} KB)")

for ctx in [1, 64, 256, 1024, 4096]:
    size = per_token * ctx
    print(f"{ctx:>6} tokens -> {size / 1024**2:8.1f} MB")

print(f"10 concurrent x 4096 ctx = {per_token * 4096 * 10 / 1024**3:.1f} GB")
```

Each token costs 112 KB of KV cache on this tiny model. A single 4096-token context is ~448 MB, and 10 concurrent users at full context need ~4.4 GB — for a 0.6B model whose weights are only ~1.4 GB. On big models the KV cache can dwarf the weights. This is exactly why [PagedAttention](/blog/paged-attention) exists.

## Benchmarking with GuideLLM

Vibes are not a benchmark. **GuideLLM** (also from the vLLM project) fires a controlled workload at any OpenAI-compatible endpoint and reports the real serving metrics:

```python
import subprocess

cmd = [
    "guidellm", "benchmark",
    "--target", "http://localhost:8000",
    "--model", MODEL,
    "--processor", "Qwen/Qwen3-0.6B",
    "--profile", "synchronous",
    "--max-requests", "10",
    "--data", "prompt_tokens=32,output_tokens=16,samples=32",
    "--output-dir", "./outputs",
]
subprocess.run(cmd, timeout=600)
```

It writes `outputs/benchmarks.json`, which contains full distributions for every metric:

```python
import json

with open("outputs/benchmarks.json") as f:
    report = json.load(f)

metrics = report["benchmarks"][0]["metrics"]
for label, key in {
    "TTFT (ms)":       "time_to_first_token_ms",
    "ITL (ms)":        "inter_token_latency_ms",
    "E2E Latency (s)": "request_latency",
}.items():
    dist = metrics[key]["successful"]
    p = dist["percentiles"]
    print(f"{label:<18} mean {dist['mean']:8.2f}  p50 {p['p50']:8.2f}  "
          f"p95 {p['p95']:8.2f}  p99 {p['p99']:8.2f}")
```

These are exactly the metrics from [our metrics blog](/blog/llm-inference-metrics): TTFT (prefill speed), inter-token latency (decode speed), end-to-end latency, and throughput — with p95/p99 tails, which is what production actually cares about. Swap `--profile synchronous` for a concurrency sweep to find where the server saturates.

## Checking quality with lm_eval

Speed means nothing if the deployment broke the model. **lm_eval** (EleutherAI's evaluation harness) can run standardized tasks against the same vLLM endpoint:

```python
import lm_eval

results = lm_eval.simple_evaluate(
    model="local-completions",
    model_args=(
        f"model={MODEL},"
        f"base_url={VLLM_URL}/v1/completions,"
        "tokenized_requests=False,"
        "tokenizer=Qwen/Qwen3-0.6B,"
        "num_concurrent=1"
    ),
    tasks=["hellaswag"],
    limit=20,
)
print(results["results"]["hellaswag"])
```

This matters most when serving [quantized models](/blog/llm-compressor-quantization): benchmark speed with GuideLLM, benchmark quality with lm_eval, and only ship if both are acceptable.

## Serving quantized models

vLLM natively serves quantized checkpoints — nothing changes except the model path:

```bash
# a model you quantized yourself with LLM Compressor (W4A16 needs a GPU)
vllm serve ./Qwen3-0.6B-W4A16 --max-model-len 4096

# or an official pre-quantized FP8 checkpoint
vllm serve Qwen/Qwen3-30B-A3B-Instruct-2507-FP8 --max-model-len 8192
```

FP8 checkpoints halve the weight memory with ~99% quality retained and need no calibration step; W4A16 (GPTQ) shrinks weights ~4x and is the tool when memory is really tight. We cover how to produce the W4A16 model yourself in the [LLM Compressor blog](/blog/llm-compressor-quantization).

In our own production experiment, this exact stack — vLLM serving a Qwen FP8 checkpoint on one A100, with prefix caching doing the heavy lifting on a ~2.4K-token system prompt repeated every call — delivered a first token in ~92 ms versus ~1,475 ms from a paid cloud API, at matching answer quality.

## Conclusion

We served a model and touched every core serving idea with code. `vllm serve` gives us an OpenAI-compatible server with [PagedAttention](/blog/paged-attention), [continuous batching](/blog/continuous-batching), and [prefix caching](/blog/prefix-caching) on by default. The `/metrics` endpoint lets us watch the batch, the queue, and the cache in real time. GuideLLM measures the speed of the deployment, lm_eval measures its quality, and quantized models from [LLM Compressor](/blog/llm-compressor-quantization) drop straight in.

For the theory behind everything we just observed, start with [Prefill vs Decode](/blog/prefill-vs-decode) and the [LLM inference optimization hub](/topic/llm-inference).

That's it for now.
