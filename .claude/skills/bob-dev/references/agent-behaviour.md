# Agent behaviour: reproduce, test and fix

Use for any bug or change in what the assistant says or which tool it calls: refusals, wrong tool, wrong
arguments, tone, language, length. Learned on #750 (2026-10-01), where 168 clean runs "proved" a bug did not
exist because they ran on the wrong model.

## 1. Reproduce on the model that runs

- The chat model comes from `BOB_CHAT_MODEL` in the root `.env`, not the code default in
  `apps/ai/src/config.ts`. Read the root `.env` first, and confirm what actually answered: the journal's
  `v2.turn_stage_agent_completed` carries `model`, `prompt_layout`, `called_tools` and token counts, and a
  script can print `result.response.modelId`.
- The root `.env` can change while you work. Re-read it before you trust an earlier run.
- Behaviour differs a lot by model: on #750 gpt-4o refused 0/168 advice questions and gemini-2.5-flash refused
  60/112 with the same prompt.

## 2. Run the flag matrix, before and after

- Agent flags change the prompt: `BOB_AGENT_HONEST_ACTIONS` (on/unset) and `BOB_PROMPT_LAYOUT`
  (`cache-v1`/legacy). Run every combination; a flag is a suspect only if its cells differ.
- `BOB_AGENT_INSTRUCTIONS` is fixed at module load, so each flag cell needs its own process.
- "Before" is measured on an unchanged tree: a detached worktree at the base commit (see
  [facts.md](facts.md#git-under-the-safety-net-hook) to remove it afterwards), not by reverting your edit.
- Several reps per case (4 is enough); report counts such as `60/112`, never a single reply.
- Harness: `buildToolEvalAgent({ memoryContext, timeZone })` in `apps/ai/evals/tool-agent.ts` builds the
  production per-turn agent with every tool on stub callbacks. Memory blocks must use the real headers from
  `apps/api/src/memory/retrieval.ts`.

## 3. The red test is an eval

- A behaviour bug gets a live eval in `apps/ai/evals/` (fixture JSON in `evals/data/`, schema in
  `evals/fixtures.ts`, `npm run eval:<name>` in the root `package.json`) plus a deterministic scorer in
  `apps/ai/src/eval-scorers.ts`. The scorer has unit tests in `apps/api/tests/eval-scorers.test.ts` that use the
  real bad replies as failing cases, so they run inside `validate`.
- Show the eval failing on the "before" tree and passing after, on the configured model.
- Prompt text is pinned by `apps/api/tests/agent-instructions.test.ts` (text and lengths): update it in the
  same commit as `apps/ai/src/prompts.ts`.
- After a prompt change, run `npm run eval:tools` before and after: a new rule must not cost tool selection.

## 4. Spend: check the budget first

- Every live call bills the gateway key in the root `.env`, and each key has a hard cap. When it is reached,
  every app on that key fails with "API key budget exceeded".
- Check the headroom before any matrix or model comparison: `vercel ai-gateway budgets list`. Only the owner
  raises a cap.
- Rough cost: a full eval set (tools, quality, voice-reply, continuity, advice) is about $0.10-0.15 per model on
  a flash-class model. Nine models in parallel plus probes used about $5 on 2026-10-01.

## 5. Comparing models

- Candidates: `vercel ai-gateway models list` (prices, tags such as `tool-use`) and
  `vercel ai-gateway leaderboard models --modality text --metric requests -F json`.
- Compare on the eval set above plus p50 latency and dollars per 1k turns from real `totalUsage` and the
  gateway prices. Voice replies are spoken, so markdown in replies and added latency are real costs.
- The `isEnglish` voice-reply score moves 70-90% between runs on the same model; don't decide on it alone.
- Results of the 2026-10-01 comparison: #750 and PR #751.
