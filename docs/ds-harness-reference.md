# DeepSeek Harness (dsh) — reference notes

Checkout: `vendor/deepseek-harness` (gitignored; `git clone --depth 1
https://github.com/deepseek-ai/deepseek-harness.git`), MIT, TypeScript on a
vendored Cordis plugin runtime. Read 2026-08-25 as reference for how another
first-party harness handles loop hygiene — specifically the failure we
diagnosed in grok: the model narrating tool work it never performed.

## Architecture in one line

**Everything is a plugin.** `packages/core/agent-loop` is the only package
allowed to contain concrete loop logic; every behavior — guards, timeouts,
compaction, plan mode — is a plugin on documented extension points
(waterfall listeners that must call `next()` to delegate). Two repo-wide
invariants matter for us:

- *Model-visible ⟺ logged*: anything that reaches a model request must be
  reconstructable from the session log. (grok's `updates.jsonl` is close,
  but dsh enforces it as a review gate.)
- *Plugins, not loop changes*: new behavior lands as a plugin; touching the
  loop requires an architecture-doc update.

## The three mechanisms relevant to fake execution

### 1. `guard/repeat-tool-reminder` — the doom-loop counterpart

Their analogue of grok's `doom_loop_recovery`, but philosophically opposite:
**advise, never veto, never resample.**

- Listens on `tools/post-execute`; counts consecutive identical calls
  (tool name + deep-key-sorted canonical arguments).
- At thresholds `[3, 5, 8]` it injects a reminder *into the conversation*
  as a plugin-sourced logged user message (`source: {kind:'plugin',
  form:'notice'}`): gentle first ("analyze the previous result… try a
  different approach"), detailed later (names the tool, run length, and
  arguments; "Do not call this tool with these exact arguments again").
- A human interjection resets the chain — repetition across a user message
  is not a loop.
- Denied calls still count: "a model hammering a denied call is exactly
  the loop worth breaking."

### 2. `goal/` + `goal-round-driver` — their actual answer to "claims done, isn't"

They do **not** try to detect lying in a single turn. Instead they restructure
the work so lying doesn't terminate it:

- A goal is durable session state with revision + lifecycle.
- When the agent goes idle with an active goal and remaining round capacity,
  the driver automatically queues the next `<goal_round>` prompt.
- The round prompt **"requires evidence before completion, and tells the
  model to leave the goal active when work remains."** Evidence-based
  completion is the contract; a narrated non-result just earns another round.
- `maxGoalRounds` caps the loop; human input always preempts automatic
  rounds.

### 3. Bounded LLM request recovery — empty/failed responses

Structured `LlmFailure` facts (HTTP status, retry-after, provider request
id) instead of message parsing; retry ownership pinned to exactly one layer
(library-internal transport retries are forbidden when the loop also
retries); every recovery leaves a durable status fact so backoff doesn't
look like a stall. grok's `AttemptOutcome::Empty` retry is the same family
with less structure.

## Mapping to our three options for the grok fake-scan incident

Diagnosis recap: harness sent 26 tools; model returned 265 tokens of pure
text with `reasoning_tokens: 0` and zero tool calls — model-side laziness.

- **Option A (app-side warning)** aligns with dsh's advisory philosophy:
  state the hard fact, don't guess intent. dsh feeds the notice to the
  *model*; we can surface "this turn called no tools" to the *user* — even
  more honest, zero false-positive risk.
- **Option B (prompt discipline)** has ready-made wording in the goal round
  prompt: require evidence before claiming completion.
- **Option C (harness-side detector/resample)** is the one thing dsh
  deliberately does **not** build: no single-turn fabrication classifier
  exists anywhere in the codebase. They route around the detection problem
  with structured goals. Signal: the lowest-value, highest-risk option.

Their guard's escalation copy (`GENTLE_REMINDER` / `detailedReminder` in
`packages/guard/repeat-tool-reminder/src/index.ts`) is worth borrowing
verbatim-adjacent if we ever inject corrective context.
