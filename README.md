# Slack2PR — Your AI Code Companion on Slack

Mention it in Slack like a teammate, describe a feature or a bug, and it plans, codes, tests, and opens a pull request on GitHub.

Slack2PR is a [Hexabot](https://hexabot.ai) app that automates the software development lifecycle end to end: a Slack message triggers an agentic workflow that interviews you about requirements, breaks the work into components, implements them one by one inside a sandboxed clone of your repository, writes unit tests, and replies in the thread with a PR link. It exists to answer the question every Hexabot engineer eventually gets asked: *"Are you using it yourself?"* — yes, even to build Hexabot.

Watch the [YouTube video demo](https://youtu.be/2Ex3OkX-Eh8).

## How It Works

```
Slack message
    │
    ▼
Slack channel (hexabot-channel-slack)
    │
    ▼
Slack2PR workflow ── classify intent
    │
    ├─ develop  → requirements interview → plan components → implement each
    │             in a loop → write unit tests → open PR → reply with the URL
    ├─ bug      → read-only investigation rounds → user picks "dig deeper" /
    │             "fix it" / "stop" → approved fixes ship as a PR
    └─ question → read-only code inspection → concise answer in the thread
```

Three building blocks:

1. **Slack channel** — the [Slack channel integration](https://hexabot.ai/extensions/67613afd203814420b6483d1) (`hexabot-channel-slack`) connects a Slack workspace to Hexabot, so mentioning the bot starts a conversation thread.
2. **Slack2PR workflow** — [workflows/Slack2PR.workflow.yml](workflows/Slack2PR.workflow.yml) orchestrates the whole cycle: intent classification, a quick-reply requirements interview, and the plan → implement loop → test → PR pipeline, with thread-scoped memory carrying the plan and todo list between steps.
3. **AI coding agent action** — [src/extensions/actions/coding/](src/extensions/actions/coding/) is a custom Hexabot action (`ai_coding_agent`) that runs a coding harness inside a Docker sandbox.

## The AI Coding Agent Action

The heart of this project. It wraps [TanStack AI sandboxes](https://tanstack.com/ai) (`@tanstack/ai-sandbox` + `@tanstack/ai-sandbox-docker`) as a Hexabot workflow action:

- **Pluggable harnesses** — runs Claude Code, Codex, OpenCode, or Grok Build; pick the harness and model per task in the workflow YAML. Harness CLIs are installed into the sandbox automatically when missing.
- **Sandboxed workspaces** — each conversation thread gets a Docker container with a clone of the target repository at `/workspace`. The sandbox is reused across the thread (`per_thread` lifecycle) so the plan, the implemented components, and the harness session survive between workflow steps, then torn down when the thread closes or goes idle.
- **Git and GitHub ready** — HTTPS git auth and the GitHub CLI are pre-configured from Hexabot credentials, so the agent can branch, commit, push, and `gh pr create` without ever seeing the raw token.
- **Plan contract** — with `plan_mode: optional | required`, the action injects a structured-output contract into the system prompt and parses the returned plan and todo list into thread memory, so the workflow can loop over todos deterministically (one component per iteration).
- **Session resume** — the harness session id is persisted in thread-scoped memory, letting later steps (implement, test, PR) continue the same agent session.
- **Guardrails** — command allow/ask/deny policies (with `sudo`, `rm -rf`, etc. denied by default), file read/write policies, and secrets injected as environment variables only.

Layout of [src/extensions/actions/coding/](src/extensions/actions/coding/):

| File | Purpose |
| --- | --- |
| `ai-coding-agent.action.ts` | The action: prompt building, sandbox lease per thread, plan enforcement, memory persistence. |
| `ai-coding-agent.runtime.ts` | Sandbox definition and TanStack chat run wiring. |
| `ai-coding-agent.schemas.ts` | Zod input / output / settings contracts. |
| `ai-coding-agent.constants.ts` | Harness defaults, plan contract prompt, git/GH bootstrap commands. |
| `ai-coding-agent.modules.ts` | Lazy loading of the TanStack AI modules. |
| `ai-coding-agent.utils.ts` | State-block parsing, session helpers. |

## Quick Start

Requirements:

- Node.js `24.17.x`
- Docker (required — the coding agent runs its sandboxes in Docker)
- A Slack app for your workspace ([setup guide](https://hexabot.ai/extensions/67613afd203814420b6483d1))
- A GitHub token and an LLM provider API key for the workflow defaults, or credentials for the harness/model provider you choose

Run it:

```sh
npm install
cp .env.example .env   # set SEED_ADMIN_* before first startup
npm run dev            # or: hexabot dev
```

The admin UI runs at `http://localhost:3000`. Then:

1. **Create credentials** in the admin UI:
   - GitHub: create a personal access token that can clone, push branches, and open pull requests on the target repository. A fine-grained PAT should grant **Contents: read/write** and **Pull requests: read/write**; a classic PAT needs equivalent `repo` access.
   - Google AI: the bundled workflow uses Google Generative AI (`gemini-*`) for both the interview model and the default OpenCode coding-agent runs, so use a paid-tier Google AI key.
2. **Import the workflow**: in the admin UI, open the workflow visual editor and import [workflows/Slack2PR.workflow.yml](workflows/Slack2PR.workflow.yml).
3. **Configure the imported workflow**: point every `repository` input at your target repo, replace the mock GitHub and Google AI credential placeholders with the credentials you created, and review the AI coding agent settings before publishing.
4. **Adapt the coding stack if needed**: each `ai_coding_agent` step can use a different harness and model. The action supports Claude Code, Codex, OpenCode, and Grok Build; update `harness`, `model`, `agent_api_key`, and `agent_api_key_env` to match the provider you want. If you replace Google AI entirely, update the `interview_model` binding too. You can use another hosted provider, or a local provider, as long as the selected harness can reach it from inside the Docker sandbox.
5. **Connect Slack** via the Slack channel integration and subscribe the workflow to it.
6. **Mention the bot** in Slack: *"Add a dark-mode toggle to the settings page"* — answer a couple of quick-reply questions, and watch the PR arrive.

## Commands

| Task | Command |
| --- | --- |
| Local dev | `npm run dev` or `hexabot dev` |
| Build | `npm run build` |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Production start | `npm run start:prod` |
| Diagnostics | `hexabot check` |

## Project Map

| Path | Purpose |
| --- | --- |
| `src/main.ts` | Boots the Hexabot app. |
| `src/app.module.ts` | Root module. |
| `src/extensions/actions/coding/` | The `ai_coding_agent` action (TanStack AI sandboxes). |
| `workflows/Slack2PR.workflow.yml` | The Slack2PR workflow bundle (workflow, memory definition, credential refs). |
| `hexabot.config.json` | CLI scripts, env paths, and package manager config. |

## Why This Project Exists

Hexabot lets you build agentic workflows across channels — conversational, scheduled, tool-calling, memory-aware. Slack2PR is the dogfooding proof: if a workflow engine can automate the software development lifecycle itself — requirements, planning, implementation, testing, code review conversations, and delivery — it can automate anything. Fork it, point it at your repo, and put your AI teammate on payroll.
