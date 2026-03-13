# Thinking in Agents: The New Mental Model Every Developer Needs

> *We used to write code that specified every step. More and more, we’re building systems that give agents goals, tools, and boundaries — then let them decide the next move.*

---

It started with a text from a friend.

*"Hey, can you help me turn this kids learning site into a PDF? My daughter loves it but needs something she can scroll through offline."*

Simple enough request on the surface. But this wasn’t a normal site with a nice API or clean structured data. It was an old-school interactive site. Click a link, a page loads. Click the next one, another page loads. No clean export path. No neat feed of lesson content. Just a stack of pages a kid was supposed to click through one at a time.

My friend wanted her daughter to be able to **scroll through the material offline as a single PDF**.

So I sat down to build it.

And I immediately caught myself following a familiar path.

I was about to write a solution **for that exact site**: fetch the homepage, parse the DOM using assumptions about that site’s navigation, extract the page URLs, visit each page, capture it, and stitch the captures into a PDF.

It would work. For that site.

Until the structure changed.  
Until the navigation moved.  
Until my friend asked about a different site.

That was the moment I stopped and asked a different question.

> *What if, instead of writing every decision, I gave an agent the capabilities?*

---

## The Trap of Thinking in Steps

The developer instinct is to think procedurally. Break the task down. Write the steps. Execute them.

For this problem, the classic thought process looked something like this:

```text
1. Download the starting page
2. Parse the DOM
3. Find the links that look like lesson pages
4. Clean and order those links
5. Visit each page
6. Capture each page
7. Combine the captures into a PDF
```

This works. But look closely at where the fragility lives.

Even if the code is not using browser selectors directly, it still depends on assumptions about one site’s DOM structure, one site’s navigation patterns, one site’s ordering rules, and one site’s content layout.

That’s the trap.

You feel like you’re automating a workflow, but often you’re really encoding a pile of site-specific decisions that will have to be rediscovered the next time the input changes.

---

## What My First Version Really Looked Like

In the first version, I used Python requests to fetch the starting page and parsed the DOM to extract the lesson URLs. In spirit, it looked more like this:

```text
function collect_pages_for_pdf(start_url):
    download the start page HTML
    parse the DOM
    find all links that look like lesson/content pages
    clean and normalize those links
    sort them in reading order
    return the ordered page URLs

function capture_pages(page_urls):
    for each page URL:
        open the page
        wait until the content is visible
        capture the page as an image

function create_scrollable_pdf(captures, output_file):
    combine captures in order
    save them into one PDF
```

That version worked, but it was still tightly coupled to how that site happened to expose its navigation.

The code wasn’t just solving the task. It was also silently carrying assumptions like:

- which links count as actual lesson pages
- how those links should be ordered
- what to ignore
- when a page is ready to capture

Those assumptions are where maintenance lives.

---

## The Mental Model Shift

The breakthrough for me was realizing that the **actions** were reusable even if the **decisions** were not.

For this task, the reusable capabilities were simple:

- extract the content links from a page
- capture a page as an image
- combine the captured pages into a PDF

That meant I could think about the problem in a very different way.

Instead of building a rigid solution for one site, I could define a small toolbox and let an agent use that toolbox to work through the site.

In pseudocode, the agent-style version looked like this:

```text
tools = [
  extract_content_links,
  capture_page,
  build_pdf
]

goal:
  Turn this learning site into a scrollable PDF.

plan:
  1. Package the core actions as reusable tools instead of hardcoded logic
  2. Add resilience paths for cases where the workflow gets stuck
  3. Give the agent the goal and let it orchestrate those tools to generate the PDF
```

Or even more simply:

```text
from typing import Annotated

@function_tool
def extract_content_links(
    start_url: Annotated[str, "Starting URL for the learning site"]
) -> list[str]:
    """Fetch the page, parse the DOM, and return lesson/content links."""
    return []


@function_tool
def capture_page(
    page_url: Annotated[str, "A lesson page URL to capture"]
) -> str:
    """Capture a page as an image."""
    return "capture.png"


@function_tool
def build_pdf(
    captures: Annotated[list[str], "Ordered page captures"],
    output_file: Annotated[str, "Destination PDF file path"]
) -> str:
    """Combine captures into a single PDF."""
    return output_file


agent = Agent(
    name="Site to PDF Agent",
    instructions=(
        "Turn the learning site into a scrollable PDF. "
        "Discover lesson pages, capture them in reading order, "
        "and build the final PDF."
    ),
    tools=[extract_content_links, capture_page, build_pdf],
)
```

That shift mattered.

The tools stayed the same.  
The site-specific decisions moved into the agent’s judgment.

---

## Old Thinking vs. Agent Thinking

```text
OLD THINKING
- Write the decisions
- Encode assumptions about one structure
- Predict the edge cases up front
- Rewrite the logic for the next variation

AGENT THINKING
- Write the capabilities
- Let the system inspect the current context
- Reuse the same tools across similar tasks
- Adapt the decisions at runtime
```

That is the mental model change.

Not: *"AI will magically solve everything."*

But: *"Maybe I shouldn’t hardcode every branch when the real problem is judgment over changing inputs."*

---

## What an Agent Is, Really

An agent is not magic. It is a loop.

You give the model:
- a goal
- a set of tools
- boundaries on what it is allowed to do

Then the loop repeats:
1. inspect the current state
2. decide the next step
3. call a tool
4. observe the result
5. continue until done

That’s it.

The interesting part is not that the loop exists. The interesting part is that the model is now handling decisions that developers used to hardcode manually.

For this PDF workflow, that meant deciding things like:
- which links looked like real content
- which ones were probably navigation chrome
- what order made sense
- when it had enough material to build the final PDF

---

## Tools Are the Whole Game

When you think in agents, your job changes.

You spend less time hand-authoring every branch and more time designing:
- clear tools
- useful descriptions
- sensible constraints
- strong defaults
- good recovery paths

That’s where the engineering craft moves.

A tool is not just a function. It is an action with a clean boundary and a clear purpose.

For example:

```text
extract_content_links(start_url)
→ fetch HTML, parse the DOM, and return links that look like lesson/content pages

capture_page(page_url)
→ open the page, wait until content is ready, and capture it

build_pdf(captured_pages, output_file)
→ combine captured pages into one ordered PDF
```

The system does not need a different tool for every site.  
It needs a reusable set of actions and enough judgment to apply them well.

---

## Agents Are Not Magic

This part is important.

The first version of the agent did **not** perfectly complete the task on its own.

I had to:
- give it examples of what “good” looked like
- improve the tool descriptions
- add constraints when it got stuck
- step in when it made weak decisions

That actually made the lesson more valuable.

The breakthrough was not that the agent replaced developer judgment.  
The breakthrough was that developer judgment moved up a level.

Instead of spending all my effort on brittle site-specific branching logic, I could spend that effort on:
- better tools
- better examples
- better constraints
- better fallback behavior

That is a much more reusable place to invest engineering effort.

---

## The Bigger Lesson

This pattern extends well beyond this one PDF workflow.

A lot of software problems share the same shape:
- the inputs are messy or unpredictable
- the number of steps is not known in advance
- the system has to inspect context before deciding what to do next
- edge cases are too numerous to enumerate cleanly

That is where agent thinking becomes powerful.

Not because it removes software engineering, but because it changes what software engineering is optimizing for.

Old model:
- branch logic
- exact procedures
- up-front prediction of cases

Agent model:
- reusable capabilities
- runtime judgment
- boundaries and recovery paths

---

## But What About Control?

If the agent is making decisions, are you losing control?

Not really.

You still control the parts that matter most.

- **You define the tools.** If there is no delete tool, nothing gets deleted.
- **You define the boundaries.** Same domain only. Max pages. No login flows. No payment clicks.
- **You implement the tools.** You still own retries, timeouts, validation, and output quality.
- **You observe the loop.** Good logging makes the behavior inspectable.

Agents do not remove control.  
They relocate control — from hardcoded decision trees to capability design and system boundaries.

---

## When to Think in Agents — and When Not To

This is not a universal pattern.

Use agent-style systems when:
- the input is unpredictable
- the path is not fully known in advance
- the work requires judgment
- the edge cases are hard to enumerate

Use traditional code when:
- the process is deterministic
- the transformation is straightforward
- reproducibility matters more than adaptation
- there is little ambiguity in the task

Turning changing interactive sites into PDFs is a great agent candidate.  
Resizing an image to 800 pixels wide is not.

---

## The Question I Ask Now

The biggest thing that changed for me was not a framework or a library.

It was a question.

Before I write brittle logic now, I pause and ask:

> *Is this a deterministic program? Or is this a judgment problem with reusable tools?*

That question changes the architecture.

Sometimes the answer is still traditional code.  
Sometimes the answer is an agent loop.

But once you start seeing the difference, it becomes hard to unsee.

---

## Closing Thought

My friend’s daughter got her PDF.

More importantly, I got a new way of thinking about software.

The lesson was not that agents can magically do everything.  
It was that I no longer needed to hand-author brittle logic for every variation of the same class of problem.

That is the shift I keep coming back to.

Less: writing every decision.  
More: designing the capabilities, examples, and boundaries that let a system make better decisions on its own.

And for a growing class of software problems, that feels like a much better mental model.

---

**Tags:** `#AI` `#Agents` `#LLM` `#SoftwareEngineering` `#DeveloperThinking` `#Automation`
