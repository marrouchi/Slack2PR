/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { ActionService, WorkflowRuntimeContext } from '@hexabot-ai/api';
import { ModuleRef } from '@nestjs/core';

import {
  AiCodingAgentAction,
  resetTanstackModuleLoaderForTesting,
  setTanstackModuleLoaderForTesting,
} from './ai-coding-agent.action';
import { OPENCODE_STALE_SERVER_KILL_COMMAND } from './ai-coding-agent.constants';

describe('AiCodingAgentAction', () => {
  let action: AiCodingAgentAction;
  let context: WorkflowRuntimeContext;
  let logger: {
    debug: jest.Mock;
    warn: jest.Mock;
  };
  let credentials: {
    findOneValue: jest.Mock;
  };
  let memoryUpdate: jest.Mock;
  let memoryStore: {
    raw: Record<string, unknown>;
    definitionCache: Map<string, unknown>;
    update: jest.Mock;
  };
  let memoryDefinitions: {
    findBySlug: jest.Mock;
    create: jest.Mock;
  };
  let moduleRef: ModuleRef;
  let mocks: ReturnType<typeof createTanstackMocks>;

  const createContext = (
    overrides: Partial<Record<string, unknown>> = {},
  ): WorkflowRuntimeContext =>
    ({
      services: {
        logger,
        credentials,
      },
      threadId: 'thread-1',
      runId: 'run-1',
      memoryStore,
      ...overrides,
    }) as unknown as WorkflowRuntimeContext;

  beforeEach(() => {
    jest.clearAllMocks();
    memoryDefinitions = {
      findBySlug: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    };
    moduleRef = {
      get: jest.fn().mockReturnValue(memoryDefinitions),
    } as unknown as ModuleRef;
    action = new AiCodingAgentAction(
      { register: jest.fn() } as unknown as ActionService,
      moduleRef,
    );
    logger = {
      debug: jest.fn(),
      warn: jest.fn(),
    };
    credentials = {
      findOneValue: jest.fn().mockResolvedValue('agent-secret'),
    };
    memoryUpdate = jest.fn().mockResolvedValue({});
    memoryStore = {
      raw: {},
      definitionCache: new Map<string, unknown>([['ai_coding_agent', {}]]),
      update: memoryUpdate,
    };
    context = createContext();
    mocks = createTanstackMocks();
    setTanstackModuleLoaderForTesting(async () => mocks.modules as never);
  });

  afterEach(async () => {
    // Tear down any leased sandbox timers/handles created during the test.
    await action.onModuleDestroy();
    resetTanstackModuleLoaderForTesting();
  });

  it('wires a GitHub workspace, Docker sandbox, harness credential, and streamed output', async () => {
    const result = await action.run(
      {
        prompt: 'Fix the failing test',
        repository: 'owner/repo',
        ref: 'main',
      },
      context,
      {
        harness: 'codex',
        model: 'gpt-5.3-codex',
        agent_api_key: 'credential-id',
        setup_commands: ['corepack enable', 'pnpm install'],
        scripts: { test: 'pnpm test' },
        include_events: true,
      },
    );

    expect(credentials.findOneValue).toHaveBeenCalledWith('credential-id');
    expect(mocks.createSecrets).toHaveBeenCalledWith({
      CODEX_API_KEY: 'agent-secret',
    });
    expect(mocks.githubRepo).toHaveBeenCalledWith({
      repo: 'owner/repo',
      ref: 'main',
      depth: 1,
    });
    expect(mocks.defineWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        packageManager: 'auto',
        setup: [
          'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex',
          'corepack enable',
          'pnpm install',
        ],
        scripts: { test: 'pnpm test' },
        root: '/workspace',
      }),
    );
    expect(mocks.dockerSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'node:24',
        workdir: '/workspace',
        publishPorts: [],
      }),
    );
    expect(mocks.codexText).toHaveBeenCalledWith(
      'gpt-5.3-codex',
      expect.objectContaining({
        cwd: '/workspace',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
      }),
    );
    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Fix the failing test' }],
        threadId: 'thread-1',
        runId: 'run-1',
      }),
    );
    expect(mocks.withSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'hexabot-coding-agent',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      harness: 'codex',
      model: 'gpt-5.3-codex',
      provider: 'docker',
      thread_id: 'thread-1',
      run_id: 'run-1',
      session_id: 'session-1',
      sandbox_id: 'sandbox-1',
      text: 'Done.',
      text_truncated: false,
      finish_reason: 'stop',
      usage: { totalTokens: 10 },
      files: [{ path: 'src/index.ts', type: 'change' }],
      diffs: [
        {
          path: 'src/index.ts',
          diff: 'diff --git a/src/index.ts b/src/index.ts',
          truncated: false,
        },
      ],
    });
    expect(result.event_counts).toMatchObject({
      RUN_STARTED: 1,
      TEXT_MESSAGE_CONTENT: 2,
      'CUSTOM:codex.session-id': 1,
      'CUSTOM:sandbox.file': 1,
      'CUSTOM:sandbox.file.diff': 1,
      RUN_FINISHED: 1,
    });
    expect(result.events.length).toBeGreaterThan(0);
  });

  it('injects GitHub push auth, commit identity, and gh install when a credential is configured', async () => {
    await action.run(
      {
        prompt: 'Open a PR',
        repository: 'owner/repo',
      },
      context,
      {
        github_token: 'github-cred-id',
        install_gh: true,
        setup_commands: ['pnpm install'],
      },
    );

    expect(credentials.findOneValue).toHaveBeenCalledWith('github-cred-id');
    // Token is exposed to the sandbox under the GitHub credential env var.
    expect(mocks.createSecrets).toHaveBeenCalledWith({
      GH_TOKEN: 'agent-secret',
    });
    // Clone uses the token so private repositories resolve.
    expect(mocks.githubRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/repo',
        auth: { username: 'x-access-token', token: 'agent-secret' },
      }),
    );

    const workspace = mocks.defineWorkspace.mock.calls[0][0] as {
      setup: string[];
    };

    expect(workspace.setup).toEqual([
      "git config --global --add safe.directory '/workspace'",
      "git config --global user.name 'Hexabot Coding Agent'",
      "git config --global user.email 'coding-agent@hexabot.ai'",
      `git config --global 'credential.https://github.com.helper' '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
      expect.stringContaining('cli/cli/releases/download'),
      'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code',
      'pnpm install',
    ]);
  });

  it('scopes push auth to the repository host for non-GitHub git remotes', async () => {
    await action.run(
      {
        prompt: 'Open a merge request',
        source_type: 'git',
        repository: 'https://gitlab.com/owner/repo.git',
      },
      context,
      { github_token: 'git-cred-id' },
    );

    // Clone uses the token with the default username so private repos resolve.
    expect(mocks.gitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://gitlab.com/owner/repo.git',
        auth: { username: 'x-access-token', token: 'agent-secret' },
      }),
    );

    const workspace = mocks.defineWorkspace.mock.calls[0][0] as {
      setup: string[];
    };

    // The push credential helper is scoped to the actual host, not github.com.
    expect(workspace.setup).toContain(
      `git config --global 'credential.https://gitlab.com.helper' '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
    );
  });

  it('uses the configured git auth username for clone and push', async () => {
    await action.run(
      {
        prompt: 'Open a merge request',
        source_type: 'git',
        repository: 'https://gitlab.com/owner/repo.git',
      },
      context,
      { github_token: 'git-cred-id', git_auth_username: 'oauth2' },
    );

    expect(mocks.gitSource).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { username: 'oauth2', token: 'agent-secret' },
      }),
    );

    const workspace = mocks.defineWorkspace.mock.calls[0][0] as {
      setup: string[];
    };

    expect(workspace.setup).toContain(
      `git config --global 'credential.https://gitlab.com.helper' '!f() { echo username=oauth2; echo "password=$GH_TOKEN"; }; f'`,
    );
  });

  it('adds no git bootstrap or clone auth without a GitHub credential', async () => {
    await action.run(
      { prompt: 'Fix the bug', repository: 'owner/repo' },
      context,
      { setup_commands: ['pnpm install'] },
    );

    expect(mocks.githubRepo).toHaveBeenCalledWith({
      repo: 'owner/repo',
      depth: 1,
    });
    // No git-config bootstrap is added; only the idempotent harness CLI install
    // (claude_code by default) precedes the user's own setup commands.
    expect(mocks.defineWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: [
          'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code',
          'pnpm install',
        ],
      }),
    );
  });

  it('prepends the matching harness CLI install to the workspace setup', async () => {
    await action.run({ prompt: 'Fix the bug', source_type: 'none' }, context, {
      harness: 'claude_code',
      setup_commands: ['pnpm install'],
    });

    const workspace = mocks.defineWorkspace.mock.calls[0][0] as {
      setup: string[];
    };

    expect(workspace.setup).toEqual([
      'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code',
      'pnpm install',
    ]);
  });

  it('kills a stale opencode server from the sandbox onReady hook', async () => {
    await action.run({ prompt: 'Fix the bug', source_type: 'none' }, context, {
      harness: 'opencode',
      model: 'google/gemini-3.1-pro-preview',
    });

    const definition = mocks.defineSandbox.mock.calls[0][0] as {
      hooks: { onReady: (handle: unknown) => Promise<void> };
    };
    const exec = jest.fn().mockResolvedValue({ exitCode: 0 });

    await definition.hooks.onReady({
      id: 'sandbox-2',
      provider: 'docker',
      process: { exec },
    });

    expect(exec).toHaveBeenCalledWith(OPENCODE_STALE_SERVER_KILL_COMMAND);
  });

  it('does not run the stale-server kill for non-opencode harnesses', async () => {
    await action.run({ prompt: 'Fix the bug', source_type: 'none' }, context, {
      harness: 'claude_code',
    });

    const definition = mocks.defineSandbox.mock.calls[0][0] as {
      hooks: { onReady: (handle: unknown) => Promise<void> };
    };
    const exec = jest.fn().mockResolvedValue({ exitCode: 0 });

    await definition.hooks.onReady({
      id: 'sandbox-2',
      provider: 'docker',
      process: { exec },
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it('defaults thread and run ids to the workflow context', async () => {
    const result = await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        runId: 'run-1',
      }),
    );
    expect(result).toMatchObject({ thread_id: 'thread-1', run_id: 'run-1' });
  });

  it('applies the default system prompt and injects the plan contract', async () => {
    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    const call = (
      mocks.chat.mock.calls[0] as unknown as [{ systemPrompts: string[] }]
    )[0];

    expect(call.systemPrompts).toHaveLength(1);
    expect(call.systemPrompts[0]).toContain('You are a senior Web developer.');
    // The action owns the plan convention: it injects the hexabot-state
    // contract into the system prompt rather than relying on a workflow prompt.
    expect(call.systemPrompts[0]).toContain('Plan reporting contract');
    expect(call.systemPrompts[0]).toContain('hexabot-state');
  });

  it('omits the plan contract when plan mode is off', async () => {
    await action.run({ prompt: 'Fix the bug', source_type: 'none' }, context, {
      plan_mode: 'off',
    });

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompts: ['You are a senior Web developer.'],
      }),
    );
  });

  it('resumes the harness session id from thread-scoped memory', async () => {
    memoryStore.raw = { ai_coding_agent: { sessionId: 'previous-session' } };

    await action.run({ prompt: 'Continue', source_type: 'none' }, context, {});

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: { sessionId: 'previous-session' },
      }),
    );
  });

  it('uses an explicit session id override and ignores memory', async () => {
    memoryStore.raw = { ai_coding_agent: { sessionId: 'previous-session' } };

    await action.run(
      { prompt: 'Continue', source_type: 'none', session_id: 'explicit' },
      context,
      {},
    );

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: { sessionId: 'explicit' },
      }),
    );
  });

  it('ignores an unresolved session id expression and falls back to memory', async () => {
    memoryStore.raw = { ai_coding_agent: { sessionId: 'previous-session' } };

    await action.run(
      {
        prompt: 'Continue',
        source_type: 'none',
        session_id: '=$context.memory.ai_coding_agent.sessionId',
      },
      context,
      {},
    );

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: { sessionId: 'previous-session' },
      }),
    );
  });

  it('persists the returned session id to thread-scoped memory', async () => {
    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    expect(memoryUpdate).toHaveBeenCalledWith({
      ai_coding_agent: { sessionId: 'session-1' },
    });
  });

  it('parses a hexabot-state block into plan/todos and persists it with the session', async () => {
    mocks.chat.mockReturnValueOnce(
      (async function* () {
        yield { type: 'RUN_STARTED' };
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: [
            'Here is the component breakdown.',
            '```hexabot-state',
            JSON.stringify({
              plan: 'Build a Button and a Card component.',
              todos: [
                { title: 'Button', description: 'Primary button' },
                { name: 'Card', status: 'pending' },
                { description: 'no title, dropped' },
              ],
            }),
            '```',
          ].join('\n'),
        };
        yield {
          type: 'CUSTOM',
          name: 'claude_code.session-id',
          value: { sessionId: 'session-1' },
        };
        yield {
          type: 'RUN_FINISHED',
          finishReason: 'stop',
          usage: { totalTokens: 10 },
        };
      })(),
    );

    const result = await action.run(
      { prompt: 'Build a small UI', source_type: 'none' },
      context,
      {},
    );

    expect(result).toMatchObject({
      plan_status: 'ok',
      plan: 'Build a Button and a Card component.',
      todos: [
        { title: 'Button', description: 'Primary button' },
        { title: 'Card', status: 'pending' },
      ],
    });
    expect(memoryUpdate).toHaveBeenCalledWith({
      ai_coding_agent: {
        sessionId: 'session-1',
        plan: 'Build a Button and a Card component.',
        todos: [
          { title: 'Button', description: 'Primary button' },
          { title: 'Card', status: 'pending' },
        ],
      },
    });
  });

  it('reports plan_status "absent" when no hexabot-state block is emitted', async () => {
    const result = await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    expect(result).toMatchObject({ ok: true, plan_status: 'absent' });
    expect(result.plan_error).toBeUndefined();
  });

  it('reports plan_status "invalid" with an error for a malformed block', async () => {
    mocks.chat.mockReturnValueOnce(
      (async function* () {
        yield { type: 'RUN_STARTED' };
        yield {
          type: 'TEXT_MESSAGE_CONTENT',
          delta: ['```hexabot-state', '{ not valid json', '```'].join('\n'),
        };
        yield {
          type: 'CUSTOM',
          name: 'claude_code.session-id',
          value: { sessionId: 'session-1' },
        };
        yield {
          type: 'RUN_FINISHED',
          finishReason: 'stop',
          usage: { totalTokens: 10 },
        };
      })(),
    );

    const result = await action.run(
      { prompt: 'Build a small UI', source_type: 'none' },
      context,
      {},
    );

    expect(result).toMatchObject({ ok: true, plan_status: 'invalid' });
    expect(result.plan_error).toContain('valid JSON');
    // A malformed plan is never persisted to thread memory.
    expect(memoryUpdate).toHaveBeenCalledWith({
      ai_coding_agent: { sessionId: 'session-1' },
    });
  });

  it('fails the run in "required" plan mode when no valid plan is emitted', async () => {
    const result = await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      { plan_mode: 'required' },
    );

    expect(result).toMatchObject({
      ok: false,
      plan_status: 'absent',
    });
    expect(result.plan_error).toContain('requires a structured plan');
    expect(result.error).toBe(result.plan_error);
    expect(logger.warn).toHaveBeenCalledWith(
      'ai_coding_agent required a plan but none was emitted',
      expect.objectContaining({ plan_status: 'absent' }),
    );
  });

  it('builds the coding task from conversation history in history mode', async () => {
    const findLastMessages = jest.fn().mockResolvedValue([
      {
        sender: 'subscriber-1',
        createdAt: new Date('2024-01-01T09:00:00Z'),
        message: { type: 'text', data: { text: 'Add a login form' } },
      },
      {
        sender: 'bot',
        createdAt: new Date('2024-01-01T09:01:00Z'),
        message: { type: 'text', data: { text: 'On it' } },
      },
    ]);
    const historyContext = createContext({
      initiatorId: 'subscriber-1',
      services: {
        logger,
        credentials,
        message: { findLastMessages },
      },
    });

    await action.run(
      { input_mode: 'history', messages_limit: 2, source_type: 'none' },
      historyContext,
      {},
    );

    expect(findLastMessages).toHaveBeenCalledWith({ id: 'thread-1' }, 2);
    expect(mocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'Add a login form' },
          { role: 'assistant', content: 'On it' },
        ],
      }),
    );
  });

  it('skips session persistence when the memory definition is not attached', async () => {
    memoryStore.definitionCache = new Map();

    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    expect(memoryUpdate).not.toHaveBeenCalled();
  });

  it('uses a per_thread sandbox and tears it down when the thread closes', async () => {
    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    expect(mocks.defineSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          reuse: 'thread',
          destroyOnComplete: false,
        }),
      }),
    );

    await action.handleThreadClosed({
      entity: { id: 'thread-1', status: 'closed' },
    });

    expect(mocks.dockerDestroy).toHaveBeenCalledWith({ id: 'sandbox-1' });

    // A second close is a no-op once the lease has been evicted.
    mocks.dockerDestroy.mockClear();
    await action.handleThreadClosed({
      entity: { id: 'thread-1', status: 'closed' },
    });
    expect(mocks.dockerDestroy).not.toHaveBeenCalled();
  });

  it('falls back to a per_run sandbox and no lease when there is no thread', async () => {
    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      createContext({ threadId: null }),
      {},
    );

    expect(mocks.defineSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          reuse: 'none',
          destroyOnComplete: true,
        }),
      }),
    );

    await action.onModuleDestroy();
    expect(mocks.dockerDestroy).not.toHaveBeenCalled();
    expect(memoryUpdate).not.toHaveBeenCalled();
  });

  it('registers no lease for the per_run lifecycle', async () => {
    await action.run({ prompt: 'Fix the bug', source_type: 'none' }, context, {
      sandbox_lifecycle: 'per_run',
    });

    expect(mocks.defineSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          reuse: 'none',
          destroyOnComplete: true,
        }),
      }),
    );

    await action.handleThreadClosed({
      entity: { id: 'thread-1', status: 'closed' },
    });
    expect(mocks.dockerDestroy).not.toHaveBeenCalled();
  });

  it('tears down all live sandboxes on shutdown', async () => {
    await action.run(
      { prompt: 'Fix the bug', source_type: 'none' },
      context,
      {},
    );

    await action.onModuleDestroy();

    expect(mocks.dockerDestroy).toHaveBeenCalledWith({ id: 'sandbox-1' });
  });

  it('seeds the session memory definition on bootstrap when missing', async () => {
    await action.onApplicationBootstrap();

    expect(memoryDefinitions.findBySlug).toHaveBeenCalledWith(
      'ai_coding_agent',
    );
    expect(memoryDefinitions.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'ai_coding_agent', scope: 'thread' }),
    );
  });

  it('does not re-create the session memory definition when it exists', async () => {
    memoryDefinitions.findBySlug.mockResolvedValue({ slug: 'ai_coding_agent' });

    await action.onApplicationBootstrap();

    expect(memoryDefinitions.create).not.toHaveBeenCalled();
  });

  it('does not throw when session memory seeding fails', async () => {
    (moduleRef.get as jest.Mock).mockImplementation(() => {
      throw new Error('service unavailable');
    });

    await expect(action.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('returns a failure payload when the harness emits a run error', async () => {
    mocks.chat.mockReturnValueOnce(
      (async function* () {
        yield {
          type: 'RUN_ERROR',
          message: 'codex executable not found',
        };
      })(),
    );

    const result = await action.run(
      {
        prompt: 'Fix the bug',
        source_type: 'none',
      },
      context,
      {},
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'codex executable not found',
      text: '',
      files: [],
      diffs: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'ai_coding_agent completed with a run error',
      expect.objectContaining({
        error: 'codex executable not found',
      }),
    );
  });

  it('rejects repository URLs that embed credentials', async () => {
    await expect(
      action.run(
        {
          prompt: 'Fix the bug',
          source_type: 'git',
          repository: 'https://token@example.com/owner/repo.git',
        },
        context,
        {},
      ),
    ).rejects.toThrow('Repository URLs must not include embedded credentials');
  });

  it('requires a repository for git-backed source types', async () => {
    await expect(
      action.run(
        {
          prompt: 'Fix the bug',
          source_type: 'github',
        },
        context,
        {},
      ),
    ).rejects.toThrow('Repository is required');
  });
});

function createTanstackMocks() {
  const chat = jest.fn(() =>
    (async function* () {
      yield { type: 'RUN_STARTED' };
      yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Done' };
      yield { type: 'TEXT_MESSAGE_CONTENT', delta: '.' };
      yield {
        type: 'CUSTOM',
        name: 'codex.session-id',
        value: { sessionId: 'session-1' },
      };
      yield {
        type: 'CUSTOM',
        name: 'sandbox.file',
        value: { type: 'change', path: 'src/index.ts' },
      };
      yield {
        type: 'CUSTOM',
        name: 'sandbox.file.diff',
        value: {
          path: 'src/index.ts',
          diff: 'diff --git a/src/index.ts b/src/index.ts',
        },
      };
      yield {
        type: 'RUN_FINISHED',
        finishReason: 'stop',
        usage: { totalTokens: 10 },
      };
    })(),
  );
  const withSandbox = jest.fn((definition) => {
    definition.hooks?.onReady?.({ id: 'sandbox-1', provider: 'docker' });

    return { definition };
  });
  const defineSandbox = jest.fn((definition) => definition);
  const defineWorkspace = jest.fn((definition) => definition);
  const githubRepo = jest.fn((input) => ({ type: 'github', ...input }));
  const gitSource = jest.fn((input) => ({ type: 'git', ...input }));
  const createSecrets = jest.fn((input) => ({ secrets: input }));
  const defineSandboxPolicy = jest.fn((policy) => policy);
  // Shared across every provider instance so teardown assertions are simple.
  const dockerDestroy = jest.fn().mockResolvedValue(undefined);
  const dockerSandbox = jest.fn((config) => ({
    name: 'docker',
    config,
    destroy: dockerDestroy,
  }));
  const codexText = jest.fn(() => ({ name: 'codex' }));
  const claudeCodeText = jest.fn(() => ({ name: 'claude-code' }));
  const grokBuildText = jest.fn(() => ({ name: 'grok-build' }));
  const opencodeText = jest.fn(() => ({ name: 'opencode' }));

  return {
    chat,
    withSandbox,
    defineSandbox,
    defineWorkspace,
    githubRepo,
    gitSource,
    createSecrets,
    defineSandboxPolicy,
    dockerSandbox,
    dockerDestroy,
    codexText,
    claudeCodeText,
    grokBuildText,
    opencodeText,
    modules: {
      ai: { chat },
      sandbox: {
        withSandbox,
        defineSandbox,
        defineWorkspace,
        githubRepo,
        gitSource,
        createSecrets,
        defineSandboxPolicy,
      },
      docker: { dockerSandbox },
      codex: { codexText },
      claudeCode: { claudeCodeText },
      grokBuild: { grokBuildText },
      opencode: { opencodeText },
    },
  };
}
