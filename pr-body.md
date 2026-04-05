## Summary
- make the `slv c` core prompt itself thinner after the demand-driven user-context work from #119
- stop reading every enabled `SKILL.md` at startup; register skill doc paths and load the actual docs only when user intent points to that domain or when delegation happens
- add lightweight intent priming so validator / rpc / server / billing-style prompts preload only the relevant modules, agent skill docs, and tools
- keep the #119 demand-driven file/MCP reads and per-session cache behavior intact

## Why
#119 made user-specific context demand-driven instead of injecting MCP account data and inventory files on the first request.

This PR is the next step: make the **core itself** thinner so a trivial message like `hi` does not also pay the cost of broad skill loading. Domain knowledge should show up only when the user's intent clearly demands it.

## What changed
### 1) Lazy skill-doc loading
Before this PR, `buildSystemPrompt()` still read every enabled skill's `SKILL.md` at startup just to populate an in-memory cache.

Now startup only registers skill doc paths. The actual `SKILL.md` contents are read later, on demand:
- when the user intent clearly matches that domain
- or when `delegate_to_agent` is invoked

### 2) Intent-triggered priming
Added a small intent primer for common high-signal domains:
- **validator / vote / identity / deploy** → delegation + validator context + Cecil skill docs
- **rpc / geyser / grpc / index** → delegation context + Tina skill docs
- **server / buy / bare metal / pricing** → delegation + MCP reference + Figaro skill docs + MCP tool
- **subscription / usage / billing / account** → MCP reference + MCP tool
- **benchmark / throughput / latency / shreds** → delegation + Cid skill docs

So `hi` stays thin, but `deploy a validator` arrives with the relevant context already primed.

### 3) Thinner core prompt
The base system prompt now focuses on:
- user interaction rules
- routing hints
- environment facts
- demand-driven loading rules

It no longer spends as much core prompt budget repeating broader domain guidance up front.

## Result
- trivial greetings read almost nothing extra
- domain knowledge arrives when intent demands it
- demand-driven reading/caching from #119 remains intact
- delegation still auto-loads the right skill docs when needed

## Validation
- `~/.deno/bin/deno fmt cli/src/ai/console/systemPrompt.ts cli/src/ai/console/tools.ts cli/src/ai/console/consoleAction.ts`
- `~/.deno/bin/deno check cli/src/ai/console/systemPrompt.ts cli/src/ai/console/tools.ts cli/src/ai/console/consoleAction.ts`
  - still blocked by the same pre-existing type error in `cli/src/ai/console/checkRelease.ts` (`fields as Record<string, string[]>`)

## Base
Please review this as the next stacked step after the demand-driven user-context branch / PR.
Base branch: `fix/issue-119-demand-driven-context`
