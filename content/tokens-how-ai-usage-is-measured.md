---
title: "Tokens: How AI Usage Is Measured, Metered, and Billed"
slug: "tokens-how-ai-usage-is-measured"
date: "2026-08-24"
tags: ["llm", "tokens", "cost", "billing", "infrastructure"]
reading_time: "9 min read"
words: 1640
summary: "In this blog, we will learn what a token actually is, how every AI API meters usage in tokens, why output tokens cost several times more than input tokens, how prompt caching changes the bill, and how to compute the cost of a single AI call and a whole season of traffic — with a worked example from a real experiment."
---

# Tokens: How AI Usage Is Measured, Metered, and Billed

In this blog, we will learn the unit that everything in AI infrastructure is priced in: the **token**. Whether the bill comes from a hosted API, a reserved-capacity contract, or a fleet of GPUs, the meter underneath is always counting tokens. A DevOps or infrastructure engineer who can read that meter can estimate any AI bill on the back of an envelope — before the invoice arrives.

We will cover the following:

- What a token is: the ruler for all AI text
- Input tokens vs output tokens: two meters, two prices
- Why output costs more: a hardware reason, not a pricing trick
- Where the numbers live: the `usage` object
- Cached input tokens: the third meter
- Worked example: the cost of one AI call
- Worked example: the cost of a season
- Conclusion

Let's get started.

## What a token is: the ruler for all AI text

A language model does not read characters or words. Before any text reaches the model, a **tokenizer** splits it into chunks called tokens — common words become one token, rare words split into several, and punctuation or numbers get their own pieces. The rule of thumb worth memorizing:

**1 token ≈ 4 characters ≈ 0.75 words** (for English text).

```
"The quick brown fox jumps over the lazy dog"

split into ~4-char chunks (each chunk ~= 1 token):
[The ][quic][k br][own ][fox ][jump][s ov][er t][he l][azy ][dog]
```

Scaling that up:

```
1 word              #  ~1.3 tok
1 page (500 words)  #######################  ~700 tok
1M tokens           ##########################################  ~5 novels of text
```

Structured data is less efficient than prose: JSON keys, braces, and quoted numbers all consume tokens, so a JSON payload often costs 20–40% more tokens than the same information written as sentences. This matters because most production AI calls send structured data.

## Input tokens vs output tokens: two meters, two prices

Every AI API call runs two meters:

- **Input tokens** (also called prompt tokens): everything you send — the system prompt, the instructions, the user's data.
- **Output tokens** (also called completion tokens): everything the model writes back.

They are priced separately, and the gap is large. The consistent industry pattern: **output tokens cost 4–8x more than input tokens.** A representative frontier-model price as of 2026:

```
$/MILLION TOKENS (frontier hosted model, indicative)
input    ##  $1.25
output   ################  $10.00     <- 8x input
```

The immediate operational consequence: **an uncapped response length is an uncapped bill.** In one experiment we ran, a single runaway call with no output limit generated for 437 seconds and cost $1.30 — about 100x the normal cost of that call. After that, every call carried a `max_completion_tokens` guardrail. Treat the output cap the way you treat a request timeout: mandatory, everywhere.

## Why output costs more: a hardware reason, not a pricing trick

The price gap mirrors how the hardware spends its time.

- **Input (prefill)** is processed in parallel: the GPU ingests the whole prompt in one large, efficient batch of matrix math. Thousands of tokens are read in a single pass.
- **Output (decode)** is generated one token at a time: to produce each token, the GPU must stream the entire model's weights out of memory, produce one token, and repeat. A 1,000-token answer means 1,000 sequential passes.

So a token of output occupies the machine far longer than a token of input. The 4–8x price ratio is roughly the ratio of machine time consumed. This is also why the single most effective cost lever is shortening *output*, not input — and why the GPU-hardware blog in this series ([A100, H100, and friends](/blog/gpu-guide-a100-h100)) spends so much time on memory bandwidth, the number that sets decode speed.

## Where the numbers live: the `usage` object

You never have to estimate your own token counts after the fact. Every OpenAI-compatible API (hosted or self-hosted — vLLM and SGLang included) returns a `usage` object on each response:

```json
{
  "usage": {
    "prompt_tokens": 2609,
    "completion_tokens": 1307,
    "total_tokens": 3916,
    "prompt_tokens_details": { "cached_tokens": 2400 }
  }
}
```

This object is the ground truth the provider bills from. Three operational habits follow:

- **Log it on every call.** Token counts per endpoint, per feature, per customer — this is the raw material for every capacity and cost decision later.
- **Alert on drift.** If `prompt_tokens` creeps from 2,600 to 4,000 because someone appended to the system prompt, the bill grows 50% on the input side with no traffic change.
- **Meter at the gateway.** An API gateway (Azure API Management, Kong, or similar) can read `usage` from each response and enforce **tokens-per-minute quotas per team or per application** — real numbers from real responses, not estimates. We proved this pattern live: three calls against two different models decremented one shared 200K-token counter, and every response carried `x-tokens-consumed` / `x-remaining-tokens` headers.

## Cached input tokens: the third meter

Most production prompts are almost identical from call to call: a large fixed instruction block plus a small tail of per-request data. Providers exploit this with **prompt caching** — if the leading portion of your prompt matches a recent request, the provider skips recomputing it and bills those tokens at a deep discount, typically **90% off input price**:

```
$/MILLION INPUT TOKENS (same model as above)
uncached input  ##########  $1.25
cached input    #  $0.125          <- 10x cheaper
```

The design rule that makes caching work: **put the static content first, the variable content last.** Caching matches from the start of the prompt, so a timestamp or user ID placed at the top breaks the cache for everything after it. With a well-ordered prompt, cache hit rates of 90%+ on the fixed block are normal in steady traffic.

Self-hosted engines do the same thing for free — vLLM and SGLang call it prefix caching, and it shows up as latency rather than money: in our measurements, a warm prefix cache cut time-to-first-token from ~1,500 ms to ~114 ms.

## Worked example: the cost of one AI call

Here is the arithmetic, end to end, on a real workload. We experimented with an AI feature that reads a customer's financial data and writes a short list of personalized insights. Measured with the `usage` object over many runs:

```
input   2,609 tokens   (fixed instruction block + customer figures)
output  ~1,030 tokens  (6-8 written insights)
```

On pay-as-you-go frontier-model pricing ($1.25 in / $10 out per million):

```
input:   2,609 / 1,000,000 x  $1.25  =  $0.0033
output:  1,030 / 1,000,000 x $10.00  =  $0.0103
                                        -------
cost per answer                         $0.0136
```

Notice the split: **output is 76% of the bill** despite being 28% of the tokens. Now add prompt caching — say 92% of the input is the fixed block and hits the cache:

```
uncached input:  2,609 x 0.08 / 1M x $1.25   =  $0.00026
cached input:    2,609 x 0.92 / 1M x $0.125  =  $0.00030
output:          1,030 / 1M x $10.00         =  $0.01030
                                                --------
cost per answer with caching                    $0.0109   (~20% saved)
```

Caching helped, but the bill is still dominated by output — which is why the highest-leverage change on this workload was capping and tightening the response, not compressing the prompt.

## Worked example: the cost of a season

Per-call arithmetic scales linearly, so the season estimate is one multiplication. Our experimental workload served a seasonal business: **12 million customer documents per season, and each customer views the AI panel up to 15 times**, so the ceiling is 180M calls:

```
SEASON COST AT $0.0136/CALL (pay-as-you-go API)
 12M calls  (1 view/doc)    ###          ~$164,000
 60M calls  (5 views/doc)   ##########   ~$819,000
180M calls  (15 views/doc)  ##########################  ~$2,460,000
```

Three levers, in the order we found them worth pulling:

1. **Cache the AI responses themselves.** If the underlying data hasn't changed between views, the second view should not be an API call at all. At a 70% response-cache rate the 180M-call season drops to ~54M billable calls (~$730K).
2. **Cap and tighten output.** Every 100 output tokens removed saves $0.001/call — $180K/season at full volume.
3. **Reprice the token.** The same workload on a self-hosted 30B open-weight model measured ~$0.0013/call batched — a ~10x cut — which is the subject of the [TPS and capacity planning](/blog/tps-throughput-and-capacity-planning) and [GPU](/blog/gpu-guide-a100-h100) blogs in this series.

The habit to build: **any AI feature proposal should arrive with this table attached.** Tokens in, tokens out, calls per user, users per season — four numbers, one multiplication, and the business knows what it is signing up for.

## Conclusion

- **1 token ≈ 4 chars ≈ 0.75 words** — the ruler for everything; JSON runs 20–40% richer.
- **Two meters, two prices:** output runs 4–8x the input price because decode is sequential, one weight-streaming pass per token.
- **The `usage` object is the ground truth** — log it per call, alert on drift, and enforce quotas at the gateway with it.
- **Cached input is ~10x cheaper** — static content first, variable content last.
- **Worked numbers:** 2,609 in + 1,030 out ≈ $0.0136/call pay-as-you-go; 180M calls/season ≈ $2.46M — and output is three-quarters of it.

Next in the series: [the GPU handbook — what A100 and H100 actually are](/blog/gpu-guide-a100-h100), and then [how to turn traffic numbers into TPS and GPU counts](/blog/tps-throughput-and-capacity-planning).

That's it for now.
