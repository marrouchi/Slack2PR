/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { z } from 'zod';

import {
  credentialFieldMeta,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODING_MESSAGES_LIMIT,
  DEFAULT_DENY_COMMANDS,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_GIT_AUTH_USERNAME,
  DEFAULT_GIT_USER_EMAIL,
  DEFAULT_GIT_USER_NAME,
  DEFAULT_GITHUB_TOKEN_ENV,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_OPENCODE_PORT,
  DEFAULT_WORKSPACE_ROOT,
  HARNESS_TYPES,
  PACKAGE_MANAGERS,
  PLAN_MODES,
  POLICY_DECISIONS,
  SANDBOX_LIFECYCLES,
  SESSION_MEMORY_SLUG,
  SOURCE_TYPES,
} from './ai-coding-agent.constants';
import { parseUrl } from './ai-coding-agent.utils';

const trimOptional = z.string().trim().min(1).optional();
/**
 * Shared `ui:options` fragment that keeps a non-essential field out of the
 * action editor until the user explicitly adds it. Essentials (prompt, source,
 * docker image, harness/model, and credentials) stay visible.
 */
const hideUntilAdded = {
  'ui:options': { hideUntilAdded: true },
} as const;
/**
 * Repository-scoped fields (repository, branch, clone depth) only matter when
 * the run actually clones a source, i.e. the source type is not "none".
 */
const SOURCE_HAS_REPO = { field: 'source_type', notEquals: 'none' } as const;
/** Harness-specific tuning fields, gated on the selected harness. */
const HARNESS_IS_CODEX = { field: 'harness', equals: 'codex' } as const;
const HARNESS_IS_OPENCODE = { field: 'harness', equals: 'opencode' } as const;
/** Keep an always-shown field, but hide it when `condition` is not met. */
const visibleWhen = (condition: Readonly<Record<string, unknown>>) =>
  ({ 'ui:options': { showWhen: condition } }) as const;
/**
 * Hide a field until the user adds it AND only offer it when `condition` is met,
 * so the "Add option" menu stays scoped to fields that apply to the current
 * source type / harness.
 */
const optionalWhen = (condition: Readonly<Record<string, unknown>>) =>
  ({ 'ui:options': { hideUntilAdded: true, showWhen: condition } }) as const;
/**
 * Default session id: a workflow expression that reads the harness session
 * persisted in thread-scoped memory by the previous run, so runs resume the
 * same agent automatically without any manual wiring.
 */
const DEFAULT_SESSION_ID_EXPRESSION = `=$context.memory.${SESSION_MEMORY_SLUG}.sessionId`;

export const codingAgentInputSchema = z
  .object({
    system: z
      .string()
      .trim()
      .min(1)
      .default('You are a senior Web developer.')
      .meta({
        title: 'System Prompt',
        description:
          "System prompt that sets the coding agent's persona and behavior.",
        ...hideUntilAdded,
      }),
    input_mode: z
      .enum(['prompt', 'history'])
      .default('prompt')
      .meta({
        title: 'Input mode',
        description:
          'Send a direct coding prompt, or build the task from recent conversation history (requires a conversational thread).',
        'ui:widget': 'radio',
        'ui:options': { inline: true },
      }),
    prompt: z
      .string()
      .trim()
      .min(1)
      .default('=$input.text')
      .optional()
      .meta({
        title: 'Prompt',
        description: 'Coding task to give to the sandboxed agent.',
        ...visibleWhen({ field: 'input_mode', equals: 'prompt' }),
      }),
    messages_limit: z
      .int()
      .positive()
      .default(DEFAULT_CODING_MESSAGES_LIMIT)
      .optional()
      .meta({
        title: 'Messages limit',
        description:
          'Number of most recent conversation messages to build the coding task from instead of a prompt.',
        ...optionalWhen({ field: 'input_mode', equals: 'history' }),
      }),
    source_type: z.enum(SOURCE_TYPES).default('github').meta({
      title: 'Source Type',
      description: 'Where the sandbox workspace source should come from.',
    }),
    repository: trimOptional.meta({
      title: 'Repository',
      description:
        'GitHub owner/repo, GitHub URL, or Git URL depending on the selected source type.',
      ...visibleWhen(SOURCE_HAS_REPO),
    }),
    ref: trimOptional.meta({
      title: 'Branch',
      description:
        "Branch, tag, or commit to check out. Defaults to the repository's default branch.",
      ...optionalWhen(SOURCE_HAS_REPO),
    }),
    depth: z
      .union([z.int().positive(), z.literal('full')])
      .default(1)
      .optional()
      .meta({
        title: 'Clone Depth',
        description:
          'Git clone depth. Use 1 for a shallow clone or full for complete history.',
        ...optionalWhen(SOURCE_HAS_REPO),
      }),
    session_id: z
      .string()
      .trim()
      .min(1)
      .default(DEFAULT_SESSION_ID_EXPRESSION)
      .meta({
        title: 'Session ID',
        description:
          'Harness session ID to resume. Defaults to the session persisted in thread-scoped memory by the previous run in this conversation.',
        ...hideUntilAdded,
      }),
  })
  .superRefine((input, ctx) => {
    if (input.source_type !== 'none' && !input.repository) {
      ctx.addIssue({
        code: 'custom',
        path: ['repository'],
        message: 'Repository is required unless source_type is "none".',
      });
    }

    if (input.source_type === 'git' && input.repository) {
      const parsed = parseUrl(input.repository);

      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        ctx.addIssue({
          code: 'custom',
          path: ['repository'],
          message: 'Git source repositories must be valid HTTP(S) URLs.',
        });
      }
    }

    if (input.repository) {
      const parsed = parseUrl(input.repository);

      if (parsed && (parsed.username || parsed.password)) {
        ctx.addIssue({
          code: 'custom',
          path: ['repository'],
          message:
            'Repository URLs must not include embedded credentials. Store secrets as Hexabot credentials instead.',
        });
      }
    }
  });

export const codingAgentSettingsSchema = z.strictObject({
  harness: z.enum(HARNESS_TYPES).default('claude_code').meta({
    title: 'Harness',
    description: 'Coding agent harness to run inside the sandbox.',
  }),
  model: z.string().trim().min(1).default(DEFAULT_CLAUDE_CODE_MODEL).meta({
    title: 'Model',
    description:
      'Harness-specific model identifier. Set a model that matches the selected harness.',
  }),
  agent_api_key: z
    .string()
    .optional()
    .meta({
      title: 'Agent Credential',
      description:
        'Credential injected into the sandbox environment for the selected coding harness.',
      ...credentialFieldMeta,
    }),
  agent_api_key_env: z
    .string()
    .trim()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional()
    .meta({
      title: 'Agent Credential Env',
      description:
        'Environment variable name used for the resolved agent credential. Defaults depend on the selected harness.',
      ...hideUntilAdded,
    }),
  github_token: z
    .string()
    .optional()
    .meta({
      title: 'Git Credential',
      description:
        'Token credential injected into the sandbox to authenticate HTTPS git clone and push against the repository host (GitHub, GitLab, Bitbucket, or self-hosted). Also read by the GitHub CLI to open pull requests when the host is GitHub.',
      ...credentialFieldMeta,
    }),
  github_token_env: z
    .string()
    .trim()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .default(DEFAULT_GITHUB_TOKEN_ENV)
    .meta({
      title: 'Git Credential Env',
      description:
        'Environment variable name for the resolved git token. The git credential helper reads it at push time, and the GitHub CLI reads GH_TOKEN by default.',
      ...hideUntilAdded,
    }),
  git_auth_username: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_GIT_AUTH_USERNAME)
    .meta({
      title: 'Git Auth Username',
      description:
        'Username paired with the token for HTTPS git clone and push. Defaults to x-access-token (GitHub / GitHub App tokens). Use oauth2 for GitLab OAuth tokens or x-token-auth for Bitbucket access tokens.',
      ...hideUntilAdded,
    }),
  git_user_name: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_GIT_USER_NAME)
    .meta({
      title: 'Git User Name',
      description:
        'Git author name configured in the sandbox for commits made by the agent. Applied only when a git credential is provided.',
      ...hideUntilAdded,
    }),
  git_user_email: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_GIT_USER_EMAIL)
    .meta({
      title: 'Git User Email',
      description:
        'Git author email configured in the sandbox for commits made by the agent. Applied only when a git credential is provided.',
      ...hideUntilAdded,
    }),
  install_gh: z
    .boolean()
    .default(false)
    .meta({
      title: 'Install GitHub CLI',
      description:
        'Install the GitHub CLI (gh) during bootstrap so the agent can open pull requests. Requires curl and tar in the Docker image.',
      ...hideUntilAdded,
    }),
  docker_image: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_DOCKER_IMAGE)
    .meta({
      title: 'Docker Image',
      description:
        'Docker image used for the sandbox. Defaults to a Node image with the selected harness CLI installed automatically; override it to bring your own toolchain.',
      ...hideUntilAdded,
    }),
  workspace_root: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_WORKSPACE_ROOT)
    .meta({
      title: 'Workspace Root',
      description: 'Working directory inside the sandbox container.',
      ...hideUntilAdded,
    }),
  package_manager: z
    .enum(PACKAGE_MANAGERS)
    .default('auto')
    .meta({
      title: 'Package Manager',
      description:
        'Package manager hint used while bootstrapping the workspace.',
      ...hideUntilAdded,
    }),
  setup_commands: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Setup Commands',
      description:
        'Commands run while bootstrapping the workspace before the agent starts, and re-run for every run that reuses the sandbox. Empty by default; for example, add npm install to preinstall an existing project. Leave empty when the agent scaffolds or installs dependencies itself.',
      ...hideUntilAdded,
    }),
  scripts: z
    .record(z.string(), z.string().trim().min(1))
    .default({})
    .meta({
      title: 'Scripts',
      description:
        'Named workspace scripts surfaced to the agent and sandbox policy.',
      ...hideUntilAdded,
    }),
  instructions: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta({
      title: 'Instructions',
      description:
        'Optional AGENTS.md-style instructions projected into the sandbox workspace.',
      ...hideUntilAdded,
    }),
  agent_executable: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta({
      title: 'Agent Executable',
      description:
        'Optional executable name or path for the selected harness inside the sandbox.',
      ...hideUntilAdded,
    }),
  opencode_port: z
    .int()
    .positive()
    .default(DEFAULT_OPENCODE_PORT)
    .meta({
      title: 'OpenCode Port',
      description:
        'Port used by the OpenCode in-sandbox server. It is automatically published for OpenCode runs.',
      ...optionalWhen(HARNESS_IS_OPENCODE),
    }),
  publish_ports: z
    .array(z.int().positive())
    .default([])
    .meta({
      title: 'Publish Ports',
      description:
        'Additional container ports to publish to the host for preview or harness access.',
      ...hideUntilAdded,
    }),
  sandbox_lifecycle: z
    .enum(SANDBOX_LIFECYCLES)
    .default('per_thread')
    .meta({
      title: 'Sandbox Lifecycle',
      description:
        'per_thread reuses one sandbox for the whole conversation thread (torn down on thread close, idle timeout, or shutdown); per_run creates a fresh sandbox destroyed after each run. Falls back to per_run when no thread is available.',
      ...hideUntilAdded,
    }),
  snapshot: z
    .enum(['none', 'after-setup', 'after-run'])
    .default('none')
    .meta({
      title: 'Snapshot',
      description: 'When to snapshot the sandbox if the provider supports it.',
      ...hideUntilAdded,
    }),
  keep_alive: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_KEEP_ALIVE)
    .meta({
      title: 'Keep Alive',
      description:
        'Idle window before an unused per_thread sandbox is torn down, such as 30m or 2h.',
      ...hideUntilAdded,
    }),
  session_memory_slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]+$/)
    .default(SESSION_MEMORY_SLUG)
    .meta({
      title: 'Session Memory Slug',
      description:
        'Slug of the thread-scoped memory definition used to persist and resume the harness session ID across runs. The definition must be attached to the workflow.',
      ...hideUntilAdded,
    }),
  plan_mode: z
    .enum(PLAN_MODES)
    .default('optional')
    .meta({
      title: 'Plan Mode',
      description:
        'How the action handles the structured plan/todos contract. "off" neither requests nor requires a plan; "optional" injects the plan contract into the system prompt and reports plan_status; "required" additionally fails the run when no valid plan is emitted, so a workflow can branch on it deterministically.',
      ...hideUntilAdded,
    }),
  policy_default: z
    .enum(POLICY_DECISIONS)
    .default('allow')
    .meta({
      title: 'Default Policy',
      description: 'Policy decision for commands and capabilities not matched.',
      ...hideUntilAdded,
    }),
  allow_commands: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Allow Commands',
      description: 'Command patterns the sandbox policy allows outright.',
      ...hideUntilAdded,
    }),
  ask_commands: z
    .array(z.string().trim().min(1))
    .default([])
    .meta({
      title: 'Ask Commands',
      description:
        'Command patterns requiring approval. Unattended workflows should avoid ask rules.',
      ...hideUntilAdded,
    }),
  deny_commands: z
    .array(z.string().trim().min(1))
    .default(DEFAULT_DENY_COMMANDS)
    .meta({
      title: 'Deny Commands',
      description: 'Command patterns the sandbox policy blocks.',
      ...hideUntilAdded,
    }),
  file_write_policy: z
    .enum(POLICY_DECISIONS)
    .default('allow')
    .meta({
      title: 'File Write Policy',
      description: 'Policy decision for file-modifying tools.',
      ...hideUntilAdded,
    }),
  network_policy: z
    .enum(POLICY_DECISIONS)
    .default('allow')
    .meta({
      title: 'Network Policy',
      description: 'Policy decision for outbound network access.',
      ...hideUntilAdded,
    }),
  collect_file_events: z
    .boolean()
    .default(true)
    .meta({
      title: 'Collect File Events',
      description: 'Whether the sandbox should emit file events.',
      ...hideUntilAdded,
    }),
  collect_diffs: z
    .boolean()
    .default(true)
    .meta({
      title: 'Collect Diffs',
      description: 'Whether the sandbox should emit per-file diff events.',
      ...hideUntilAdded,
    }),
  include_events: z
    .boolean()
    .default(false)
    .meta({
      title: 'Include Events',
      description:
        'Whether to include a compact sanitized event trace in the action output.',
      ...hideUntilAdded,
    }),
  max_events: z
    .int()
    .positive()
    .default(100)
    .meta({
      title: 'Max Events',
      description: 'Maximum number of compact events to include in the output.',
      ...hideUntilAdded,
    }),
  max_text_chars: z
    .int()
    .positive()
    .default(20000)
    .meta({
      title: 'Max Text Chars',
      description: 'Maximum number of text characters returned in the output.',
      ...hideUntilAdded,
    }),
  max_diff_chars: z
    .int()
    .positive()
    .default(20000)
    .meta({
      title: 'Max Diff Chars',
      description: 'Maximum number of diff characters returned per file.',
      ...hideUntilAdded,
    }),
  codex_reasoning_effort: z
    .enum(['minimal', 'low', 'medium', 'high'])
    .optional()
    .meta({
      title: 'Codex Reasoning Effort',
      description: 'Optional Codex model reasoning effort.',
      ...optionalWhen(HARNESS_IS_CODEX),
    }),
});

const codingAgentEventSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  message: z.string().optional(),
  path: z.string().optional(),
  tool: z.string().optional(),
});

export const codingAgentOutputSchema = z.object({
  ok: z.boolean().meta({
    title: 'OK',
    description: 'Whether the agent run completed without a run error event.',
  }),
  harness: z.enum(HARNESS_TYPES),
  model: z.string(),
  provider: z.string(),
  thread_id: z.string(),
  run_id: z.string(),
  session_id: z.string().optional(),
  sandbox_id: z.string().optional(),
  text: z.string(),
  text_truncated: z.boolean(),
  plan_status: z.enum(['ok', 'invalid', 'absent']).meta({
    title: 'Plan Status',
    description:
      'Whether the agent emitted a valid structured plan: "ok" (parsed), "invalid" (a hexabot-state block was present but malformed), or "absent" (no block). Lets a workflow branch on planning compliance deterministically instead of inferring it from an empty plan.',
  }),
  plan_error: z.string().optional().meta({
    title: 'Plan Error',
    description:
      'Reason the structured plan could not be parsed, when plan_status is "invalid" (or when plan_mode is "required" and no plan was emitted).',
  }),
  plan: z.string().optional().meta({
    title: 'Plan',
    description:
      'High-level plan emitted by the agent in a hexabot-state block, when present.',
  }),
  todos: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .optional()
    .meta({
      title: 'Todos',
      description:
        'Structured todo list emitted by the agent in a hexabot-state block, e.g. one entry per component. A workflow loop can iterate these.',
    }),
  finish_reason: z.string().optional(),
  usage: z.record(z.string(), z.any()).optional(),
  event_counts: z.record(z.string(), z.number()),
  events: z.array(codingAgentEventSchema),
  files: z.array(
    z.object({
      path: z.string(),
      type: z.enum(['create', 'change', 'delete']).optional(),
    }),
  ),
  diffs: z.array(
    z.object({
      path: z.string(),
      diff: z.string(),
      truncated: z.boolean(),
    }),
  ),
  error: z.string().optional(),
});

export type CodingAgentInput = z.infer<typeof codingAgentInputSchema>;

export type CodingAgentSettings = z.infer<typeof codingAgentSettingsSchema>;

export type CodingAgentOutput = z.infer<typeof codingAgentOutputSchema>;
