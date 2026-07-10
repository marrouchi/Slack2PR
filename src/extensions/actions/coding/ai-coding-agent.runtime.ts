/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { WorkflowRuntimeContext } from '@hexabot-ai/api';
import type { ChatStream, StreamChunk } from '@tanstack/ai';
import type { SandboxDefinition, WorkspaceSource } from '@tanstack/ai-sandbox';

import {
  DEFAULT_GIT_REMOTE_ORIGIN,
  GH_INSTALL_COMMAND,
  harnessSetupCommands,
  OPENCODE_STALE_SERVER_KILL_COMMAND,
} from './ai-coding-agent.constants';
import type { TanstackModules } from './ai-coding-agent.modules';
import type {
  CodingAgentInput,
  CodingAgentOutput,
  CodingAgentSettings,
} from './ai-coding-agent.schemas';
import {
  appendText,
  maybe,
  parseUrl,
  shellQuote,
  truncateText,
} from './ai-coding-agent.utils';

export async function resolveCredentialValue(
  context: WorkflowRuntimeContext,
  credentialId: string | undefined,
  label: string,
) {
  if (!credentialId) {
    return undefined;
  }

  const value = await context.services.credentials.findOneValue(credentialId);

  if (!value) {
    throw new Error(`Unable to resolve ${label} credential.`);
  }

  return value;
}

/**
 * Origin (scheme + host [+ port]) of the workspace repository, used to scope the
 * git credential helper so pushes authenticate against the actual host — GitHub,
 * GitLab, Bitbucket, or self-hosted. Returns undefined when there is no repo
 * (source_type "none") or a GitHub shorthand cannot be resolved to a URL, in
 * which case the bootstrap falls back to {@link DEFAULT_GIT_REMOTE_ORIGIN}.
 */
export function resolveGitRemoteOrigin(
  input: CodingAgentInput,
): string | undefined {
  if (input.source_type === 'none' || !input.repository) {
    return undefined;
  }

  const parsed = parseUrl(input.repository);

  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return parsed.origin;
  }

  // GitHub shorthand (owner/repo) resolves to github.com; anything else is left
  // to the bootstrap fallback.
  return input.source_type === 'github' ? DEFAULT_GIT_REMOTE_ORIGIN : undefined;
}

function resolveWorkspaceSource(
  input: CodingAgentInput,
  modules: TanstackModules,
  githubToken: string | undefined,
  authUsername: string,
): WorkspaceSource {
  if (input.source_type === 'none') {
    return { type: 'none' };
  }

  const depth = input.depth ?? 1;
  const ref = input.ref;
  // Cloning private repos over HTTPS needs credentials; reuse the git token with
  // the configured username (host-specific: x-access-token, oauth2, …).
  const auth = githubToken
    ? { username: authUsername, token: githubToken }
    : undefined;

  if (!input.repository) {
    throw new Error('Repository is required unless source_type is "none".');
  }

  if (input.source_type === 'git') {
    return modules.sandbox.gitSource({
      url: input.repository,
      ...maybe({ ref, depth, auth }),
    });
  }

  return modules.sandbox.githubRepo({
    repo: input.repository,
    ...maybe({ ref, depth, auth }),
  });
}

/**
 * Build the git bootstrap setup commands run once before the agent starts.
 *
 * Clone auth is one-shot in TanStack (the token is only wired into the clone,
 * never persisted), so a later `git push` from inside the sandbox would have no
 * credentials. When a git token is present we therefore configure a persistent
 * credential helper scoped to the repository's host (`remoteOrigin`) that reads
 * the token from the sandbox env at push time — the token itself is never
 * written to git config — plus a commit identity and a safe.directory entry.
 * `gh` is installed when requested so the agent can open pull requests (GitHub
 * only). Returns an empty list when no token is configured (and `install_gh` is
 * off), leaving setup untouched.
 */
export function buildGitBootstrapCommands(
  settings: CodingAgentSettings,
  hasGithubToken: boolean,
  remoteOrigin: string | undefined,
): string[] {
  const commands: string[] = [];

  if (hasGithubToken) {
    const host = remoteOrigin ?? DEFAULT_GIT_REMOTE_ORIGIN;
    const helper = `!f() { echo username=${settings.git_auth_username}; echo "password=$${settings.github_token_env}"; }; f`;

    commands.push(
      `git config --global --add safe.directory ${shellQuote(settings.workspace_root)}`,
      `git config --global user.name ${shellQuote(settings.git_user_name)}`,
      `git config --global user.email ${shellQuote(settings.git_user_email)}`,
      `git config --global ${shellQuote(`credential.${host}.helper`)} ${shellQuote(helper)}`,
    );
  }

  if (settings.install_gh) {
    commands.push(GH_INSTALL_COMMAND);
  }

  return commands;
}

function resolvePublishPorts(settings: CodingAgentSettings) {
  const ports = new Set(settings.publish_ports);

  if (settings.harness === 'opencode') {
    ports.add(settings.opencode_port);
  }

  return [...ports];
}

/**
 * Resolve the effective sandbox lifecycle. `per_thread` reuse only makes sense
 * when a thread id is available; otherwise we fall back to a fresh, self-cleaning
 * `per_run` sandbox.
 */
export function resolveEffectiveLifecycle(
  settings: CodingAgentSettings,
  threadId: string | null | undefined,
): 'per_thread' | 'per_run' {
  return settings.sandbox_lifecycle === 'per_thread' && threadId
    ? 'per_thread'
    : 'per_run';
}

/**
 * Narrow view of the sandbox handle the onReady hook receives. `process` is
 * optional only to keep test doubles light; the real handle always has it.
 */
type ReadySandboxHandle = {
  id: string;
  provider: string;
  process?: { exec: (command: string) => Promise<unknown> };
};

export function createSandboxDefinition(
  input: CodingAgentInput,
  settings: CodingAgentSettings,
  modules: TanstackModules,
  secrets: ReturnType<TanstackModules['sandbox']['createSecrets']> | undefined,
  onReady: (handle: ReadySandboxHandle) => void,
  threadId: string | null | undefined,
  githubToken: string | undefined,
): SandboxDefinition {
  const effectiveLifecycle = resolveEffectiveLifecycle(settings, threadId);
  const reuse = effectiveLifecycle === 'per_thread' ? 'thread' : 'none';
  const destroyOnComplete = effectiveLifecycle !== 'per_thread';
  const source = resolveWorkspaceSource(
    input,
    modules,
    githubToken,
    settings.git_auth_username,
  );
  // Assemble the workspace setup: the git auth/identity (and optional gh
  // install) bootstrap so pushes and pull requests work, then the idempotent
  // harness CLI install so the selected harness is available even on a generic
  // image, then the user's own setup commands. The push credential helper is
  // scoped to the repository's host so it works with any HTTPS git remote, not
  // just github.com.
  const setup = [
    ...buildGitBootstrapCommands(
      settings,
      Boolean(githubToken),
      resolveGitRemoteOrigin(input),
    ),
    ...harnessSetupCommands[settings.harness],
    ...settings.setup_commands,
  ];
  const workspace = modules.sandbox.defineWorkspace({
    source,
    packageManager: settings.package_manager,
    setup,
    scripts: settings.scripts,
    ...(settings.instructions ? { instructions: settings.instructions } : {}),
    ...(secrets ? { secrets } : {}),
    root: settings.workspace_root,
  });
  const policy = modules.sandbox.defineSandboxPolicy({
    commands: {
      allow: settings.allow_commands,
      ask: settings.ask_commands,
      deny: settings.deny_commands,
    },
    capabilities: {
      fileWrite: settings.file_write_policy,
      network: settings.network_policy,
    },
    default: settings.policy_default,
  });
  const provider = modules.docker.dockerSandbox({
    image: settings.docker_image,
    workdir: settings.workspace_root,
    publishPorts: resolvePublishPorts(settings),
  });

  return modules.sandbox.defineSandbox({
    id: 'hexabot-coding-agent',
    provider,
    workspace,
    policy,
    lifecycle: {
      reuse,
      snapshot: settings.snapshot,
      destroyOnComplete,
    },
    fileEvents: settings.collect_file_events
      ? { diff: settings.collect_diffs }
      : false,
    hooks: {
      // Runs on every run — including sandbox reuse, where workspace setup is
      // skipped — right before the harness starts. The OpenCode adapter spawns
      // `opencode serve` on a fixed in-sandbox port each run without stopping
      // the previous one, so clear any stale server or every later run in a
      // reused sandbox dies at startup with "… ServeError".
      onReady: async (handle: ReadySandboxHandle) => {
        if (settings.harness === 'opencode') {
          await handle.process
            ?.exec(OPENCODE_STALE_SERVER_KILL_COMMAND)
            .catch(() => undefined);
        }

        onReady(handle);
      },
    },
  });
}

function createHarnessAdapter(
  settings: CodingAgentSettings,
  modules: TanstackModules,
): unknown {
  const executable = settings.agent_executable;

  switch (settings.harness) {
    case 'claude_code':
      return modules.claudeCode.claudeCodeText(settings.model, {
        cwd: settings.workspace_root,
        permissionMode: 'bypassPermissions',
        ...(executable ? { claudeExecutable: executable } : {}),
      });
    case 'grok_build':
      return modules.grokBuild.grokBuildText(settings.model, {
        cwd: settings.workspace_root,
        permissionMode: 'bypassPermissions',
        ...(executable ? { grokExecutable: executable } : {}),
      });
    case 'opencode':
      return modules.opencode.opencodeText(settings.model, {
        directory: settings.workspace_root,
        port: settings.opencode_port,
        permissionMode: 'bypassPermissions',
      });
    case 'codex':
    default:
      return modules.codex.codexText(settings.model, {
        cwd: settings.workspace_root,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: settings.network_policy !== 'deny',
        ...(settings.codex_reasoning_effort
          ? { modelReasoningEffort: settings.codex_reasoning_effort }
          : {}),
        ...(executable ? { codexExecutable: executable } : {}),
      });
  }
}

function getEventKey(chunk: StreamChunk) {
  if (chunk.type === 'CUSTOM') {
    return `${chunk.type}:${chunk.name}`;
  }

  return chunk.type;
}

function getRunErrorMessage(chunk: StreamChunk) {
  if (chunk.type !== 'RUN_ERROR') {
    return undefined;
  }

  return chunk.message || chunk.error?.message || 'Coding agent run failed.';
}

function summarizeEvent(
  chunk: StreamChunk,
): CodingAgentOutput['events'][number] {
  if (chunk.type === 'CUSTOM') {
    const value = chunk.value as Record<string, unknown> | undefined;
    const path = typeof value?.path === 'string' ? value.path : undefined;

    return {
      type: chunk.type,
      name: chunk.name,
      ...(path ? { path } : {}),
    };
  }

  if (chunk.type === 'RUN_ERROR') {
    return {
      type: chunk.type,
      message: getRunErrorMessage(chunk),
    };
  }

  if (chunk.type === 'TOOL_CALL_START') {
    return {
      type: chunk.type,
      tool: chunk.toolCallName ?? chunk.toolName,
    };
  }

  return {
    type: chunk.type,
  };
}

function collectCustomEvent(
  chunk: StreamChunk,
  output: Pick<
    CodingAgentOutput,
    'files' | 'diffs' | 'events' | 'event_counts'
  > & {
    session_id?: string;
  },
  settings: CodingAgentSettings,
) {
  if (chunk.type !== 'CUSTOM') {
    return;
  }

  const value = chunk.value as Record<string, unknown> | undefined;

  if (chunk.name.endsWith('.session-id')) {
    const sessionId = value?.sessionId;

    if (typeof sessionId === 'string' && sessionId) {
      output.session_id = sessionId;
    }
  }

  if (chunk.name === 'sandbox.file') {
    const path = value?.path;
    const type = value?.type;

    if (
      typeof path === 'string' &&
      (type === 'create' || type === 'change' || type === 'delete')
    ) {
      const existing = output.files.find((file) => file.path === path);

      if (existing) {
        existing.type = type;
      } else {
        output.files.push({ path, type });
      }
    }
  }

  if (chunk.name === 'sandbox.file.diff' || chunk.name === 'file.changed') {
    const path = value?.path;
    const diff = value?.diff;

    if (typeof path === 'string' && typeof diff === 'string') {
      const truncated = truncateText(diff, settings.max_diff_chars);

      output.diffs.push({
        path,
        diff: truncated.value,
        truncated: truncated.truncated,
      });
    }
  }
}

export type ResolvedRunIdentifiers = {
  threadId: string;
  runId: string;
  sessionId?: string;
};

/**
 * Prompt payload assembled by the action ahead of the run: the effective system
 * prompt (persona + working memory + optional plan contract) and the model
 * messages, built from either a direct prompt or conversation history.
 */
export type PreparedPrompt = {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export async function runTanstackChat(
  prompt: PreparedPrompt,
  settings: CodingAgentSettings,
  modules: TanstackModules,
  sandbox: SandboxDefinition,
  signal: AbortSignal,
  ids: ResolvedRunIdentifiers,
): Promise<
  Pick<
    CodingAgentOutput,
    | 'ok'
    | 'text'
    | 'text_truncated'
    | 'finish_reason'
    | 'usage'
    | 'event_counts'
    | 'events'
    | 'files'
    | 'diffs'
    | 'error'
    | 'session_id'
    | 'thread_id'
    | 'run_id'
  >
> {
  const { threadId, runId, sessionId } = ids;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort(signal.reason);

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const adapter = createHarnessAdapter(settings, modules);
  const stream = modules.ai.chat({
    adapter,
    messages: prompt.messages,
    ...(prompt.system ? { systemPrompts: [prompt.system] } : {}),
    middleware: [modules.sandbox.withSandbox(sandbox)],
    threadId,
    runId,
    abortController,
    ...(sessionId ? { modelOptions: { sessionId } } : {}),
  } as never) as ChatStream;
  const output: Pick<
    CodingAgentOutput,
    | 'ok'
    | 'text'
    | 'text_truncated'
    | 'finish_reason'
    | 'usage'
    | 'event_counts'
    | 'events'
    | 'files'
    | 'diffs'
    | 'error'
    | 'session_id'
    | 'thread_id'
    | 'run_id'
  > = {
    ok: true,
    text: '',
    text_truncated: false,
    event_counts: {} as Record<string, number>,
    events: [] as CodingAgentOutput['events'],
    files: [] as CodingAgentOutput['files'],
    diffs: [] as CodingAgentOutput['diffs'],
    session_id: sessionId,
    thread_id: threadId,
    run_id: runId,
  };

  try {
    for await (const chunk of stream) {
      const eventKey = getEventKey(chunk);
      output.event_counts[eventKey] = (output.event_counts[eventKey] ?? 0) + 1;

      if (
        settings.include_events &&
        output.events.length < settings.max_events
      ) {
        output.events.push(summarizeEvent(chunk));
      }

      if (chunk.type === 'TEXT_MESSAGE_CONTENT') {
        if (typeof chunk.content === 'string') {
          const truncated = truncateText(
            chunk.content,
            settings.max_text_chars,
          );

          output.text = truncated.value;
          output.text_truncated = output.text_truncated || truncated.truncated;
        } else if (typeof chunk.delta === 'string') {
          const appended = appendText(
            output.text,
            chunk.delta,
            settings.max_text_chars,
          );

          output.text = appended.value;
          output.text_truncated = output.text_truncated || appended.truncated;
        }
      } else if (chunk.type === 'RUN_FINISHED') {
        output.finish_reason = chunk.finishReason ?? undefined;
        output.usage = chunk.usage as Record<string, unknown> | undefined;
      } else if (chunk.type === 'RUN_ERROR') {
        output.ok = false;
        output.error = getRunErrorMessage(chunk);
      } else {
        collectCustomEvent(chunk, output, settings);
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  return output;
}
