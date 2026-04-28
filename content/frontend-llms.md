# UI Out of Thin Air — What Frontend Engineers Will Actually Do After Gemma 4

**By Madhu** | April 2026 | 14 min read

> **Live demo:** [webgpu-poc-182505046910.us-central1.run.app](https://webgpu-poc-182505046910.us-central1.run.app) → click into `arena.html` for the agentic playground.

---

> **A lot of frontend engineers I talk to are quietly worried. Claude writes their components. v0 ships their layouts. Cursor refactors their state. The honest question underneath: *is there still a job here in two years?* I think it's the wrong question. The job didn't shrink — it moved. Gemma 4 hit two targets the same week: the 26B-A4B sibling went live behind a one-line Cloudflare Workers AI binding, and the ONNX-quantized E2B sibling became small enough to live in a browser tab. Two real runtimes, both fast, both free or near-free at scale. The frontier moved with them. This is what's on the other side.**

---

## Table of Contents
1. [The Worry Underneath](#worry)
2. [The Week Gemma 4 Hit Both Targets](#the-week)
3. [UI Out of Thin Air — The Thesis](#thin-air)
4. [The Two New Runtimes — Browser & Edge](#two-runtimes)
5. [The Arena — Eight Live Tool-Calling Examples](#arena)
6. [The Local-vs-Edge Toggle](#toggle)
7. [Guardrails Are Frontend Code Now](#guardrails)
8. [PII Stays in the Browser, Period](#pii)
9. [The Cloudflare Worker Proxy — Five Files](#worker)
10. [Killing Gemma 4's Thinking Mode](#thinking)
11. [The New Frontend Stack](#stack)
12. [The New Frontier of the Job](#frontier)
13. [Final Thoughts](#final)

---

## <a id="worry"></a>The Worry Underneath

Three or four frontend engineers messaged me about this in the last month, all variations of the same theme. Claude scaffolds the component faster than they can. v0 ships a layout in one prompt. Cursor refactors a state machine while they sleep. They're not afraid of being lazy — they're afraid of being redundant. *If the model can write the page, what is the page-writer for?*

I want to push back on the premise. The model writing a `<Button />` is not the frontier of the job. It's the floor. The frontier is everywhere the model needs help to actually run, behave, refuse, redact, recover, and ship to a real user on a real device. Most of that floor is invisible from a tutorial. All of it is frontend code now.

The rest of this post is what I built in a weekend to convince myself of that. If by the end you think *"oh — this is what's left, and it's bigger than what was here before,"* then we agree.

---

## <a id="the-week"></a>The Week Gemma 4 Hit Both Targets

I was watching the Gemma 4 release stream the morning of April 4 when Cloudflare's changelog dropped: `@cf/google/gemma-4-26b-a4b-it` was now a one-line invocation behind their `env.AI` binding. Same week, the browser story finally caught up: `onnx-community/gemma-4-E2B-it-ONNX` runs at q4f16 in ~600 MB on a mid-range integrated GPU.

Two runtimes. Same model family. Both reachable from a single page of HTML.

That changed something. For three years the deal for frontend engineers was "you call an API, you stream the response, you render markdown, you put a credit counter in the corner." Now the stack has split:

- The **browser** can run the model directly — your user's GPU, no server, no API token, no per-query cost. Model lives in IndexedDB after first download.
- The **edge** can run a much bigger sibling at single-digit-millisecond latency from anywhere on the planet, billed by the token but cheap (Workers AI: $0.10/M input, $0.30/M output).

Pick one. Or — and this is the interesting part — **pick both at once and route between them per device**.

> **Frontend engineering didn't shrink. It absorbed the inference layer.** The job is no longer "render the API response." It's "decide where the model runs, manage the runtime, enforce guardrails, redact PII, and degrade gracefully when the device can't handle it."

---

### By the Numbers

| Metric | Value |
|---|---|
| **Browser model** | Gemma 4 E2B ONNX (q4f16, ~600 MB) |
| **Edge model** | Gemma 4 26B-A4B (4B active per token, MoE) |
| **Edge cost** | $0.10/M input · $0.30/M output |
| **Edge context window** | 256k tokens |
| **Worker code size** | 2.40 KiB / 0.98 KiB gzipped |
| **First-byte latency (edge)** | ~200 ms cold, ~80 ms warm |
| **Per-query cost (browser)** | $0.00 |
| **API tokens shipped to client** | Zero (binding stays server-side) |

---

## <a id="thin-air"></a>UI Out of Thin Air — The Thesis

Here's the part that I think most people are still missing.

For twenty years the loop was: *designer ships a mock → engineer builds the components → users click the components.* Every screen pre-built, every button pre-wired, every dashboard pre-decided. We shipped a frozen catalogue of UI and hoped users found their request inside it.

That loop is ending. **In the near future we won't build UI and ship it. The user will say what they want, and the page will assemble itself in front of them.** A chart on a 12-column grid because someone said "show me the last quarter." A filled W-2 because someone read out three numbers. A multi-card dashboard because someone said "what do you have on me." UI out of thin air, on the user's GPU, no backend round-trip.

The eight examples I built into `arena.html` are all variations of this one pattern. The model is not the responder — it's the **assembler**. The frontend's job is to give it good primitives (a chart library, a form, a doc-store, a code sandbox) and a tool protocol it can call them with. The "page" is what falls out of the loop.

If that's true, then the question "what will frontend engineers do?" rewords itself. We won't be the people who pre-decide every screen. We'll be the people who design the **primitives the model assembles into screens** — the components, the tool surface, the policy layer, the runtime selection, the guardrails, the recovery paths when generation gets interrupted halfway through mounting a chart.

That's not a smaller job. It's the part of the stack with the most leverage right now, and the part with the fewest tutorials.

---

## <a id="two-runtimes"></a>The Two New Runtimes — Browser & Edge

The mental model I keep coming back to: there are now **three places** an LLM can run, and the right one depends entirely on the device in front of the user.

| Runtime | Where the GPU lives | Per-query cost | Privacy | Best for |
|---|---|---|---|---|
| **Cloud API** (the old way) | Provider's data centre | $$ per token | Data leaves device | Anything you don't care about cost or latency for |
| **Edge (Workers AI)** | Cloudflare PoP nearest to user | $ per token | Data hits Cloudflare, then deleted | Big models, weak client devices, instant warm |
| **Browser (WebGPU)** | User's own GPU | $0 | Never leaves device | Privacy-critical, unlimited usage, predictable cost |

The browser path is unbeatable on cost and privacy when it works. The edge path is unbeatable on latency and capability when the browser can't handle it. The frontend's new responsibility is **knowing which is which on every page load** and choosing without asking the user.

```js
// app/js/arena/model.js — the router
import * as webgpu from './webgpu-backend.js';
import * as cloud  from './cloud-backend.js';

export async function loadModel() {
  const sticky = pickStickyBackend();
  if (sticky === 'cloud') { chooseBackend('cloud'); return cloud.loadModel(); }

  emit('loading', 'Probing GPU…');
  const probe = await webgpu.probeWebGPU();

  if (!probe.ok) {
    console.info('[model] WebGPU probe failed:', probe.reason, '— using cloud backend');
    chooseBackend('cloud');
    return cloud.loadModel();
  }

  chooseBackend('webgpu');
  try { await loadWebGPUWithTimeout(); }
  catch (err) {
    console.warn('[model] local load failed, falling back to cloud:', err);
    chooseBackend('cloud');
    return cloud.loadModel();
  }
}
```

The probe checks `navigator.gpu`, the adapter's `maxStorageBufferBindingSize` (rejects < 1 GiB), and the vendor/architecture string (rejects software adapters like SwiftShader). It's three `await`s and zero dependencies.

---

## <a id="arena"></a>The Arena — Eight Live Tool-Calling Examples

I built `arena.html` to stress-test the runtimes against real agentic patterns. Eight examples, each a self-contained module, each exposing a `tools` array, a `runTool` dispatcher, a `systemPrompt`, and a `setupWorkspace` callback. The agent loop is example-agnostic — it accepts those as args:

| Example | What the model orchestrates | Why it matters |
|---|---|---|
| **Chart Stitcher** | Picks a chart component + dataset, mounts it on a 12-col grid | Tool-call basics |
| **Auto Dashboard** | Fetches every dataset, packs a multi-card layout in one prompt | Multi-step planning |
| **Voice Chart** | STT → Gemma → chart, hands-free | Web Speech API + LLM |
| **Form Filler** | Fills a synthetic W-2 by calling `set_field` / `submit_form` tools | Structured output |
| **Page Q&A** | Reads sections of a sample doc and highlights its source | Citation discipline |
| **Code Sandbox** | Writes JS, runs it in a Web Worker, iterates on output | Closed-loop coding |
| **Content Safety** ✦ | Rule-based guardrails: refuse jailbreaks, off-topic, illegal-tax | Frontend as policy layer |
| **PII Prevention** ✦ | Detect + redact PII before any model ever sees it | Frontend as privacy layer |

The tool-call protocol is plain fenced JSON — chosen over Gemma's native special-token format because it's debuggable and version-stable across both runtimes:

````text
```tool_call
{"name": "set_field", "args": {"name": "wages_box1", "value": "180000.00"}}
```
````

The runtime runs the tool, replies with a `tool_result` block, and the loop continues until the model emits `finish` or speaks plain text.

What surprised me: **the same `agent.js` loop works against both runtimes with zero per-runtime branching.** The browser model and the edge model both speak the same fenced-JSON protocol. The only thing that changes is which `generate()` function is wired in.

Look at any one of these examples and the "out of thin air" pattern is the same: a sentence in, a configured component out, mounted in the DOM by the time the model finishes typing.

---

## <a id="toggle"></a>The Local-vs-Edge Toggle

The arena topbar has a segmented control: **Local GPU** | **Edge**. Click it; the page reloads with a sticky preference, and the model router honours your choice.

The label next to it is the detected GPU — vendor, architecture, and `maxStorageBufferBindingSize` in MB. On my M1 Pro it says `Apple GPU · 4096MB`. On my old Intel iGPU laptop it says `Intel Iris · 768MB`, the Local GPU button is disabled, and the page silently picks Edge.

```js
// arena.html topbar
<div class="arena-backend">
  <span id="gpu-info">detecting GPU…</span>
  <div id="backend-toggle" role="radiogroup">
    <button data-backend="webgpu">Local GPU</button>
    <button data-backend="cloud">Edge</button>
  </div>
</div>
```

The reason this matters: **you can demo both runtimes side-by-side on one machine**. Submit the same prompt to the Auto Dashboard preset, flip the toggle, see the latency difference, see the quality difference, see whether the bigger edge model handles a tricky tool-call sequence the browser model fumbles. Same code, same prompt, two GPUs.

For the two examples that benefit from raw model capability — content-safety classification accuracy, multi-step PII reasoning — the 26B-A4B edge model is noticeably sharper. For everything chart-and-dashboard-shaped, the browser model is plenty.

---

## <a id="guardrails"></a>Guardrails Are Frontend Code Now

When the model runs in the browser, your guardrails run in the browser too. There's no hidden gateway you can lean on. If you want to refuse a jailbreak, that's a function call you write yourself.

The Content Safety example is exactly this — a deterministic, rule-based classifier sitting in front of Gemma:

```js
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|earlier)\b.{0,20}\b(instructions?|prompts?|rules?)\b/i,
  /\b(system\s*prompt|developer\s*mode|jailbreak|DAN\s*mode)\b/i,
  /\bact\s+as\s+(?!a\s+(tax|cpa|accountant|preparer))/i,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>/i,
  /\boutput\s+the\s+(system|hidden|secret)\s+(prompt|message|instructions?)/i
];

function classify(text) {
  const labels = [];
  for (const re of INJECTION_PATTERNS) if (re.test(text)) {
    labels.push({ kind: 'prompt_injection', match: text.match(re)[0] }); break;
  }
  // … jailbreak, illegal_request, abusive, off_topic, tax_question
  return labels;
}
```

The agent's tool list exposes `classify_intent`, `policy_decision (ALLOW | REFUSE)`, `refuse(reason)`, and `answer_safe(text)`. The model orchestrates; the regex is the actual policy. The model could try to skip the classifier — but the runtime also **post-checks** every `answer_safe` call for prompt-leak patterns (`system prompt`, `my instructions are`, `<|im_start|>`) and rejects the answer back at the model with a hint to retry.

That second layer is the part most people miss. **Defence in depth on the frontend looks like a deterministic check around every model output, not a softer system prompt.** The model can be coaxed into anything; a regex around its mouth cannot.

---

## <a id="pii"></a>PII Stays in the Browser, Period

The PII Prevention example takes the same posture for sensitive data. Five tools:

1. `scan_pii(text)` — regex pass: SSN, credit card (Luhn-validated), email, phone, IP, EIN, DOB
2. `redact(text)` — replaces every span with a `<KIND_N>` placeholder, returns mapping
3. `policy_decision(verdict, reason)` — PROCEED with redacted text, or BLOCK
4. `answer(text)` — runtime asserts no original PII string appears in this output
5. `finish(message)` — terminate

The detail that matters: **the placeholder mapping never leaves the browser.** The model only ever sees the redacted version. The mapping object lives in a closure inside `setupWorkspace`, and when the agent calls `answer`, the runtime defence-in-depth check looks for any original PII string in the output and rejects the call if it finds one:

```js
case 'answer': {
  const text = String(args.text ?? '');
  const leaks = [];
  for (const orig of Object.values(lastMapping)) {
    if (orig && text.includes(orig)) leaks.push(orig);
  }
  if (leaks.length) {
    return {
      ok: false,
      error: 'answer contains original PII strings — rewrite using placeholder tokens like <SSN_1>',
      leaked: leaks
    };
  }
  report.setSafeOutput(text);
  return { ok: true };
}
```

When the model echoes a real SSN back into its answer (it tries — they always try), the call fails, the model gets a hint, and it rewrites the answer using `<SSN_1>` instead. Zero original PII tokens cross the network in either direction. On the browser path, no network at all.

This is the kind of code that used to live in a backend service. Now it lives next to the model, in the same module the model lives in. It runs on every device, for every user, with no per-request server cost.

---

## <a id="worker"></a>The Cloudflare Worker Proxy — Five Files

The edge backend is a Cloudflare Worker. The whole thing is **2.40 KiB unzipped, 0.98 KiB gzipped.** Five files in a `worker/` folder:

```
worker/
  wrangler.toml         # 12 lines
  package.json          # 9 lines
  src/index.js          # ~80 lines — the entire proxy
```

The Worker is the only place that touches Workers AI. It uses the `env.AI` binding, which authenticates against the parent account automatically — **no API token in the source, no API token in the browser, ever**:

```js
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    const { messages, max_tokens = 512, stream = true } = await req.json();
    const result = await env.AI.run('@cf/google/gemma-4-26b-a4b-it', {
      messages, stream, max_completion_tokens: max_tokens
    });
    return new Response(result, {
      headers: { ...cors(origin), 'Content-Type': 'text/event-stream' }
    });
  }
};
```

Browser hits the Worker. Worker pipes Gemma 4's SSE stream back through. Token never leaves Cloudflare's edge network.

```toml
# worker/wrangler.toml
name = "webgpu-gemma-tax-proxy"
main = "src/index.js"
compatibility_date = "2026-04-01"

[ai]
binding = "AI"
```

`wrangler deploy` — done. The Worker is at a `*.workers.dev` URL within seconds.

---

## <a id="thinking"></a>Killing Gemma 4's Thinking Mode

This is the kind of detail that took an afternoon to figure out and saves seconds per request once you do.

Gemma 4 26B-A4B ships with a built-in thinking mode. Send a prompt to `@cf/google/gemma-4-26b-a4b-it` cold and the SSE stream emits `delta.reasoning` tokens for **300+ tokens** before any `delta.content` arrives. For a chat interface that's fine, even useful. For an agent loop that's parsing fenced tool-call JSON out of `delta.content`, it's pure latency tax.

The fix is one sentence in the system prompt:

```js
const NO_THINK_DIRECTIVE = 'Reply directly. Do not think. Do not show reasoning.';

function suppressThinking(messages) {
  if (messages[0]?.role === 'system') {
    return [
      { ...messages[0], content: `${NO_THINK_DIRECTIVE}\n\n${messages[0].content}` },
      ...messages.slice(1)
    ];
  }
  return [{ role: 'system', content: NO_THINK_DIRECTIVE }, ...messages];
}
```

Verified empirically: zero `delta.reasoning` tokens after that change. Content streams immediately. The model still produces correct fenced tool calls; it just stops narrating its way there.

> **Lesson:** when the model has a runtime feature you don't want, sometimes the cheapest off-switch is a sentence in the system prompt. No SDK flag necessary.

---

## <a id="stack"></a>The New Frontend Stack

For anyone wiring this kind of architecture for the first time, the layers I ended up with:

| Layer | Browser path | Edge path |
|---|---|---|
| **Model** | Gemma 4 E2B ONNX (q4f16) via Transformers.js | Gemma 4 26B-A4B via Workers AI |
| **Auth** | None (model is local) | `env.AI` binding (no token in client) |
| **Streaming** | Custom `TextStreamer` callback | OpenAI-compatible SSE (`delta.content`) |
| **Tool protocol** | Fenced JSON (` ```tool_call ` blocks) | Same |
| **Probe** | `navigator.gpu` adapter limits + vendor allowlist | n/a |
| **Cache** | IndexedDB, ~600 MB once | Cloudflare warm cache |
| **Cost** | Bandwidth on first load | $0.40/M tokens combined |
| **Privacy** | Data never leaves device | Data hits CF edge, then deleted |
| **Guardrails** | Regex / Luhn / post-checks in JS | Same regex, runs in browser before send |
| **UI router** | `model.js` selects backend at load time | Same module, same UI |

The crucial property: **the application code on the page does not change between runtimes.** The agent loop, the examples, the tool definitions, the guardrails — all identical. Only `model.js` knows which `generate()` is in use. The router pattern is what lets you ship one app and have it adapt itself to whatever GPU the user happens to have.

---

## <a id="frontier"></a>The New Frontier of the Job

So — back to the worried frontend engineers. What will we actually do?

Yes, an LLM can scaffold a button faster than you can. That's not the frontier of the job anymore. The frontier is everywhere the model needs help to actually run on a real device, behave under adversarial input, and assemble UI for a real user. Six things:

1. **Runtime selection.** Probing `navigator.gpu`, knowing what `q4f16` means, knowing the trade-offs between a browser model and an edge model on a phone with weak silicon vs a desktop with a discrete GPU. Choosing without asking the user.
2. **Guardrails as code.** Regex classifiers, Luhn checks, redaction maps with closures, defence-in-depth post-checks. The work that used to live in backend services now lives next to the model on the user's device.
3. **Tool protocols.** Fenced JSON, native function-calling tokens, JSON-schema-validated args. The model is calling code; the frontend is the dispatcher. Every primitive you expose is a verb the model can use to assemble UI.
4. **Cost shaping.** Knowing that `delta.reasoning` is 300 tokens you don't need, that a `stop_strings` flag saves 5–10 tokens per tool call, that an unbounded `max_tokens` parameter is an attack surface.
5. **Edge-worker plumbing.** An 80-line worker is now a normal part of a frontend project, not a "backend thing." It's the place your secrets live so they never reach the page.
6. **Graceful degradation across runtimes.** A page that runs the local model when it can, the edge model when it can't, the cloud API when neither's available — and never asks the user which.

Notice what's not on this list: writing the `<Button />`. That's the floor now, and the floor is fine — let the model have it. What's above the floor is **where the model lives, when it runs, what it sees, what it's allowed to say back, and what primitives it has to assemble UI from**. That's the layer where the leverage is. That's the layer with no tutorial yet.

We're not being replaced. We're being asked to design UI in a new register — one where inference is part of the page, the GPU is part of the stack, and a 600-megabyte model is a normal thing to ship to a user. That's not a smaller job. It's a different one.

---

## <a id="final"></a>Final Thoughts

Three years ago "AI feature" meant "OpenAI API key in your environment, credit counter on the dashboard." Today it means a 600 MB ONNX file in IndexedDB, a `wrangler deploy` away from a 26B model on the edge, and a frontend module that decides between them in three `await`s.

The credit wall doesn't have to exist for most products. The cloud-API-only architecture isn't *the* architecture anymore — it's *one* architecture, and now there are two more sitting next to it, both within a frontend engineer's reach without leaving the browser tab.

What you do with that depends on what you're building. But the part that excites me: **for a huge class of apps — domain-bounded knowledge work, form-filling, data exploration, customer-support assistants — the right architecture is now the local one, with an edge fallback for the user whose laptop can't quite handle it.** And both of those live in code you write as the frontend engineer.

If you've been waiting for the moment when "frontend" stopped meaning "the part above the API call," this is it. The API moved into the page. The page moved onto the GPU. The job got bigger in the most interesting direction it's expanded in years.

Try the demo: [webgpu-poc-182505046910.us-central1.run.app](https://webgpu-poc-182505046910.us-central1.run.app). Open the arena, flip the Local GPU / Edge toggle, watch the same prompt run on two completely different runtimes from the same six lines of router code. Then look at your own product and ask: *which runtime should this be? — and what UI should fall out of thin air when the user just says what they want?*

You don't have to pick one.

---

*Built late at night, again. Thanks to the Gemma team for shipping a model that fits both runtimes, and to Cloudflare for making the edge path a one-line binding.*
