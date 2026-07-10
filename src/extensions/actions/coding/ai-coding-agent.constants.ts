/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { MemoryScope, type MemoryDefinitionCreateDto } from '@hexabot-ai/api';

export const SOURCE_TYPES = ['github', 'git', 'none'] as const;

export const HARNESS_TYPES = [
  'codex',
  'claude_code',
  'grok_build',
  'opencode',
] as const;

export const POLICY_DECISIONS = ['allow', 'ask', 'deny'] as const;

export const PACKAGE_MANAGERS = ['auto', 'npm', 'pnpm', 'yarn', 'bun'] as const;

/**
 * Sandbox lifecycle modes.
 * - `per_thread`: reuse one container for the whole conversation thread and tear
 *   it down when the thread closes, goes idle, or the API shuts down.
 * - `per_run`: a fresh container per run, destroyed as soon as the run completes.
 */
export const SANDBOX_LIFECYCLES = ['per_thread', 'per_run'] as const;

export const DEFAULT_DOCKER_IMAGE = 'node:24';

export const DEFAULT_WORKSPACE_ROOT = '/workspace';

export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

/**
 * Default model for the default `claude_code` harness. `claude-sonnet-4-6` is a
 * strong, cost-effective coding model recognized by the Claude Code adapter.
 * Selecting a different harness requires setting a matching `model`.
 */
export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-sonnet-4-6';

export const DEFAULT_OPENCODE_PORT = 4096;

/** Default idle keep-alive window for reusable (`per_thread`) sandboxes. */
export const DEFAULT_KEEP_ALIVE = '30m';

/**
 * Fallback idle TTL (ms) used when `keep_alive` cannot be parsed. Mirrors the
 * default keep-alive window above.
 */
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * Memory definition slug used to persist the harness `sessionId` across runs of
 * the same thread. Attach a thread-scoped memory definition with this slug to a
 * workflow to enable resume; read it elsewhere via
 * `=$context.memory.ai_coding_agent.sessionId`.
 */
export const SESSION_MEMORY_SLUG = 'ai_coding_agent';

/**
 * Fence tag for the optional structured state block a harness can append to its
 * response, e.g. a fenced ```hexabot-state block whose body is JSON with `plan`
 * and/or `todos`. The action parses the last such block and persists it into the
 * session memory so multi-step workflows (plan → implement loop → test → PR) can
 * read the plan and iterate the todo list. Emitting it is entirely optional; a
 * run without the block behaves exactly as before.
 */
export const AGENT_STATE_FENCE = 'hexabot-state';

/**
 * Plan contract modes controlling how the action treats the structured
 * plan/todos state:
 * - `off`: the action neither requests nor requires a plan (fully backward
 *   compatible; a block is still parsed if the agent happens to emit one).
 * - `optional`: the action injects the state contract into the system prompt and
 *   reports compliance via `plan_status`, but a missing/invalid plan does not
 *   fail the run.
 * - `required`: like `optional`, but a missing or invalid plan marks the run
 *   `ok: false` so a workflow can branch on it deterministically.
 */
export const PLAN_MODES = ['off', 'optional', 'required'] as const;

/**
 * Default number of recent conversation messages folded into the coding task
 * when `input_mode` is `history`. Larger than the chat default because coding
 * tasks benefit from more surrounding context.
 */
export const DEFAULT_CODING_MESSAGES_LIMIT = 6;

/**
 * Instruction block the action appends to the system prompt so emitting the
 * structured plan is a contract the action owns and enforces, not a convention
 * a workflow author has to remember. Kept in sync with {@link AGENT_STATE_FENCE}
 * and the state schema the action validates against.
 */
export const AGENT_STATE_CONTRACT_PROMPT = [
  '# Plan reporting contract',
  '',
  'After you finish reasoning about the task, emit your plan and the units of',
  'work as the LAST block of your reply: a single fenced code block tagged',
  `\`${AGENT_STATE_FENCE}\` whose body is one JSON object with this shape:`,
  '',
  '```' + AGENT_STATE_FENCE,
  '{',
  '  "plan": "<one short paragraph describing the overall plan>",',
  '  "todos": [',
  '    { "title": "<unit of work>", "description": "<optional detail>", "status": "pending" }',
  '  ]',
  '}',
  '```',
  '',
  'Rules: emit exactly one such block, as valid JSON, containing at least a',
  '`plan` string or a non-empty `todos` array. `status` is one of `pending`,',
  '`in_progress`, or `done`. Do not wrap the block in extra prose or additional',
  'code fences.',
].join('\n');

/**
 * Thread-scoped memory definition seeded by the action at bootstrap so the
 * harness session id — plus an optional plan and todo list — can be persisted
 * and resumed across runs of a thread.
 */
export const SESSION_MEMORY_DEFINITION: MemoryDefinitionCreateDto = {
  name: 'AI Coding Agent — Session',
  slug: SESSION_MEMORY_SLUG,
  scope: MemoryScope.thread,
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AI Coding Agent — Session',
    description:
      'Harness session id, plan, and todo list persisted per conversation thread so the ai_coding_agent action can resume the agent and drive a multi-step build across runs.',
    type: 'object',
    additionalProperties: true,
    properties: {
      sessionId: {
        type: 'string',
        description:
          'Harness session id returned by the last ai_coding_agent run in this thread.',
      },
      plan: {
        type: 'string',
        description:
          'High-level plan produced by the coding agent (e.g. a React component breakdown), persisted so later runs in the thread can build against it.',
      },
      todos: {
        type: 'array',
        description:
          'Structured todo list the coding agent works through, typically one entry per unit of work (e.g. per React component). A workflow loop can iterate these.',
        items: {
          type: 'object',
          additionalProperties: true,
          required: ['title'],
          properties: {
            title: {
              type: 'string',
              description: 'Short title of the unit of work.',
            },
            description: {
              type: 'string',
              description: 'Optional longer description of the unit of work.',
            },
            status: {
              type: 'string',
              description:
                'Optional progress marker, e.g. pending, in_progress, or done.',
            },
          },
        },
      },
    },
  },
};

export const DEFAULT_DENY_COMMANDS = [
  'sudo *',
  'rm -rf *',
  'shutdown *',
  'reboot *',
];

/**
 * Default environment variable name used for the resolved GitHub token. The
 * GitHub CLI (`gh`) reads `GH_TOKEN` natively, and the git credential helper
 * configured during bootstrap reads the same variable at push time.
 */
export const DEFAULT_GITHUB_TOKEN_ENV = 'GH_TOKEN';

/** Default git author identity configured in the sandbox for agent commits. */
export const DEFAULT_GIT_USER_NAME = 'Hexabot Coding Agent';

export const DEFAULT_GIT_USER_EMAIL = 'coding-agent@hexabot.ai';

/**
 * Default username paired with the token for HTTPS git auth (clone + push).
 * `x-access-token` is GitHub's convention (and mandatory for GitHub App
 * installation tokens). Other hosts differ: use `oauth2` for GitLab OAuth
 * tokens or `x-token-auth` for Bitbucket access tokens.
 */
export const DEFAULT_GIT_AUTH_USERNAME = 'x-access-token';

/**
 * Fallback host origin used to scope the push credential helper when the
 * repository host cannot be derived (e.g. GitHub shorthand with no URL).
 */
export const DEFAULT_GIT_REMOTE_ORIGIN = 'https://github.com';

/** Pinned GitHub CLI release installed when `install_gh` is enabled. */
export const GH_CLI_VERSION = '2.63.2';

/**
 * Idempotently install the GitHub CLI from its official release tarball. It is a
 * no-op when `gh` is already present, resolves the host architecture at runtime,
 * and requires `curl` and `tar` in the Docker image (present in `node:*`). Kept
 * as a single shell command so it slots into the workspace setup plan.
 */
export const GH_INSTALL_COMMAND = [
  'command -v gh >/dev/null 2>&1 || {',
  'set -e;',
  `v="${GH_CLI_VERSION}";`,
  'arch="$(uname -m)";',
  'case "$arch" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) a=amd64;; esac;',
  'tmp="$(mktemp -d)";',
  'curl -fsSL "https://github.com/cli/cli/releases/download/v${v}/gh_${v}_linux_${a}.tar.gz" | tar -xz -C "$tmp";',
  'install "$tmp/gh_${v}_linux_${a}/bin/gh" /usr/local/bin/gh;',
  'rm -rf "$tmp";',
  '}',
].join(' ');

/**
 * Kills any `opencode serve` left behind by a previous run in the same sandbox.
 * The OpenCode adapter spawns its server on a fixed in-sandbox port each run
 * but does not stop it afterwards, so a reused (`per_thread`) sandbox would
 * otherwise fail every later run at startup with "opencode serve exited before
 * becoming ready … ServeError". Run per-run from the sandbox onReady hook
 * (workspace setup does not re-run on reuse). Killing the server is safe:
 * OpenCode session state lives on disk, so the persisted session id resumes.
 * The `[e]` character class keeps the pattern from matching this command's own
 * `sh -c` line, and the trailing `true` makes a no-match exit 0.
 */
export const OPENCODE_STALE_SERVER_KILL_COMMAND =
  'pkill -f "opencode s[e]rve" 2>/dev/null; sleep 1; true';

export type CodingAgentHarness = (typeof HARNESS_TYPES)[number];

export const harnessCredentialEnv: Record<CodingAgentHarness, string> = {
  codex: 'CODEX_API_KEY',
  claude_code: 'ANTHROPIC_API_KEY',
  grok_build: 'XAI_API_KEY',
  opencode: 'OPENAI_API_KEY',
};

/**
 * Default per-harness bootstrap that installs the harness CLI into the sandbox
 * when it is not already present in the Docker image. Each command is
 * idempotent (a no-op when the executable already resolves), so purpose-built
 * images skip the install while generic images such as `node:*` get the CLI for
 * free — selecting a harness works out of the box without hand-written setup
 * commands. Prepended to the workspace setup ahead of the user's own
 * `setup_commands`. `grok_build` ships no default: its CLI installs via x.ai's
 * script into `$HOME/.grok/bin`, which the harness adapter resolves itself.
 */
export const harnessSetupCommands: Record<CodingAgentHarness, string[]> = {
  codex: ['command -v codex >/dev/null 2>&1 || npm install -g @openai/codex'],
  claude_code: [
    'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code',
  ],
  grok_build: [],
  opencode: [
    'command -v opencode >/dev/null 2>&1 || npm install -g opencode-ai',
  ],
};

export const credentialFieldMeta = {
  'ui:widget': 'AutoCompleteWidget',
  'ui:options': {
    entity: 'Credential',
    valueKey: 'id',
    labelKey: 'name',
    enableEntityAddButton: true,
  },
};
