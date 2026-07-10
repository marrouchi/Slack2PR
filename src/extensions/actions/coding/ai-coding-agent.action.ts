/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import {
  ActionService,
  BaseAction,
  buildPrompt,
  ExecArgs,
  LoggerService,
  MemoryDefinitionService,
  resolveMemoryBindingSlugs,
  WorkflowRuntimeContext,
} from '@hexabot-ai/api';
// The "memory" binding kind is registered via a global declaration merge that
// is not reachable from the package root export, so include it explicitly.
// Runtime registration is handled by the BindingsModule glob discovery.
import type {} from '@hexabot-ai/api/dist/extensions/actions/ai/memory.binding';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { OnEvent } from '@nestjs/event-emitter';

import {
  AGENT_STATE_CONTRACT_PROMPT,
  harnessCredentialEnv,
  SESSION_MEMORY_DEFINITION,
} from './ai-coding-agent.constants';
import {
  loadTanstackModulesForRun,
  type TanstackModules,
} from './ai-coding-agent.modules';
import {
  createSandboxDefinition,
  resolveCredentialValue,
  resolveEffectiveLifecycle,
  runTanstackChat,
  type PreparedPrompt,
} from './ai-coding-agent.runtime';
import {
  codingAgentInputSchema,
  codingAgentOutputSchema,
  codingAgentSettingsSchema,
  type CodingAgentInput,
  type CodingAgentOutput,
  type CodingAgentSettings,
} from './ai-coding-agent.schemas';
import {
  extractAgentState,
  makeRunIdentifier,
  maybe,
  parseDurationMs,
  resolveSessionOverride,
  type AgentState,
} from './ai-coding-agent.utils';

export {
  resetTanstackModuleLoaderForTesting,
  setTanstackModuleLoaderForTesting,
} from './ai-coding-agent.modules';

/**
 * A live per-thread sandbox that outlives a single run. The idle timer tears it
 * down if the thread never formally closes (thread closure is lazy in Hexabot).
 */
type SandboxLease = {
  containerId: string;
  destroy: () => Promise<void>;
  idleTimer: NodeJS.Timeout | null;
};

/** Narrow view of the `hook:thread:postUpdate` event payload. */
type ThreadUpdateEvent = {
  entity?: { id?: string; status?: string } | null;
};

/**
 * Runs a TanStack AI coding harness inside a Docker sandbox.
 *
 * Sandbox reuse relies on TanStack's in-process registry, which is correct for
 * Hexabot's single-process API. Reuse and the teardown below are NOT shared
 * across processes: running the API with more than one replica would break reuse
 * and can orphan containers. Multi-process support would require providing a
 * distributed `SandboxStoreCapability` (e.g. Redis) — tracked as a follow-up.
 */
@Injectable()
export class AiCodingAgentAction
  extends BaseAction<
    CodingAgentInput,
    CodingAgentOutput,
    WorkflowRuntimeContext,
    CodingAgentSettings
  >
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /**
   * Live per-thread sandboxes keyed by thread id. Process-wide because the
   * action is a NestJS singleton.
   */
  private readonly leases = new Map<string, SandboxLease>();

  private readonly bootstrapLogger = new Logger(AiCodingAgentAction.name);

  constructor(
    actionService: ActionService,
    private readonly moduleRef: ModuleRef,
  ) {
    super(
      {
        name: 'ai_coding_agent',
        description:
          'Runs an AI coding harness inside a Docker sandbox to perform coding tasks against a workspace.',
        group: 'dev',
        icon: 'Terminal',
        color: '#0f766e',
        inputSchema: codingAgentInputSchema,
        outputSchema: codingAgentOutputSchema,
        settingsSchema: codingAgentSettingsSchema,
        // Lets a workflow attach the thread-scoped memory definition used to
        // persist/resume the harness session id.
        supportedBindings: ['memory'],
      },
      actionService,
    );
  }

  /**
   * Seed the thread-scoped memory definition used to persist the harness session
   * id, so workflows can attach it without a separate manual seeding step.
   * `MemoryDefinitionService` lives in the (non-global) WorkflowModule, so it is
   * resolved lazily via ModuleRef rather than constructor injection.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const memoryDefinitions = this.moduleRef.get(MemoryDefinitionService, {
        strict: false,
      });
      const existing = await memoryDefinitions.findBySlug(
        SESSION_MEMORY_DEFINITION.slug,
      );

      if (!existing) {
        await memoryDefinitions.create(SESSION_MEMORY_DEFINITION);
      }
    } catch (error) {
      // Seeding is best-effort; the action still runs without session memory.
      this.bootstrapLogger.warn(
        `Could not seed the "${SESSION_MEMORY_DEFINITION.slug}" memory definition: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async execute({
    input,
    context,
    settings,
    bindings,
    signal,
  }: ExecArgs<CodingAgentInput, WorkflowRuntimeContext, CodingAgentSettings>) {
    const logger = context.services.logger;
    // Build the model request the same way the AI actions do: resolve the
    // memory bindings, then build the prompt from a direct prompt or recent
    // conversation history, injecting selected working memory into the system
    // prompt. Done before the sandbox is created so a misconfigured history
    // request fails fast without spinning up a container.
    const preparedPrompt = await this.buildCodingPrompt(
      input,
      context,
      settings,
      bindings,
    );
    const modules = await loadTanstackModulesForRun();
    const agentCredential = await resolveCredentialValue(
      context,
      settings.agent_api_key,
      'agent API key',
    );
    const githubToken = await resolveCredentialValue(
      context,
      settings.github_token,
      'GitHub token',
    );
    const secretValues: Record<string, string> = {};

    if (agentCredential) {
      secretValues[
        settings.agent_api_key_env ?? harnessCredentialEnv[settings.harness]
      ] = agentCredential;
    }

    if (githubToken) {
      secretValues[settings.github_token_env] = githubToken;
    }

    const secrets =
      Object.keys(secretValues).length > 0
        ? modules.sandbox.createSecrets(secretValues)
        : undefined;
    const memorySlug = settings.session_memory_slug;
    // The real conversation thread (may be absent for non-conversational runs).
    // It drives sandbox reuse and teardown; a fallback id is only for
    // correlation when no thread exists.
    const contextThreadId = context.threadId ?? null;
    const threadId = contextThreadId ?? makeRunIdentifier('thread');
    const runId = context.runId ?? makeRunIdentifier('run');
    const sessionId =
      resolveSessionOverride(input.session_id) ??
      this.readSessionFromMemory(context, memorySlug);

    let sandboxId: string | undefined;
    let sandboxProvider = 'docker';
    const sandbox = createSandboxDefinition(
      input,
      settings,
      modules,
      secrets,
      (handle) => {
        sandboxId = handle.id;
        sandboxProvider = handle.provider;
      },
      contextThreadId,
      githubToken,
    );

    logger.debug('Starting ai_coding_agent sandbox run', {
      harness: settings.harness,
      model: settings.model,
      source_type: input.source_type,
      repository: input.repository,
      ref: input.ref,
      docker_image: settings.docker_image,
      sandbox_lifecycle: resolveEffectiveLifecycle(settings, contextThreadId),
    });

    try {
      const result = await runTanstackChat(
        preparedPrompt,
        settings,
        modules,
        sandbox,
        signal ?? new AbortController().signal,
        { threadId, runId, sessionId },
      );

      if (!result.ok) {
        logger.warn('ai_coding_agent completed with a run error', {
          harness: settings.harness,
          model: settings.model,
          error: result.error,
        });
      }

      // Parse the structured plan/todos the harness appends to its response to
      // drive multi-step workflows (plan → implement loop → test → PR). The
      // result is a real contract: plan_status reports whether the agent
      // complied, and in "required" mode a missing/invalid plan fails the run.
      const stateResult = extractAgentState(result.text);
      const state = stateResult.status === 'ok' ? stateResult.state : undefined;
      const planStatus = stateResult.status;
      let planError =
        stateResult.status === 'invalid' ? stateResult.error : undefined;
      let ok = result.ok;
      let error = result.error;

      if (settings.plan_mode === 'required' && planStatus !== 'ok') {
        planError =
          planError ??
          'ai_coding_agent requires a structured plan, but the run did not emit a valid hexabot-state block.';
        ok = false;
        error = error ?? planError;
        logger.warn('ai_coding_agent required a plan but none was emitted', {
          harness: settings.harness,
          plan_status: planStatus,
        });
      }

      await this.persistThreadState(
        context,
        memorySlug,
        { sessionId: result.session_id, ...(state ?? {}) },
        logger,
      );

      // Keep the container alive for the thread and schedule idle teardown.
      if (
        sandboxId &&
        contextThreadId &&
        resolveEffectiveLifecycle(settings, contextThreadId) === 'per_thread'
      ) {
        this.registerLease(
          contextThreadId,
          sandboxId,
          settings,
          modules,
          logger,
        );
      }

      return {
        ...result,
        ...(state ?? {}),
        ok,
        error,
        harness: settings.harness,
        model: settings.model,
        provider: sandboxProvider,
        sandbox_id: sandboxId,
        plan_status: planStatus,
        plan_error: planError,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown coding agent error';

      logger.warn('ai_coding_agent failed', {
        harness: settings.harness,
        model: settings.model,
        error: message,
      });

      return {
        ok: false,
        harness: settings.harness,
        model: settings.model,
        provider: sandboxProvider,
        thread_id: threadId,
        run_id: runId,
        session_id: sessionId,
        sandbox_id: sandboxId,
        text: '',
        text_truncated: false,
        plan_status: 'absent' as const,
        event_counts: {},
        events: [],
        files: [],
        diffs: [],
        error: message,
      };
    }
  }

  /**
   * Assemble the model request the same way the AI actions do: resolve selected
   * memory bindings, build the prompt from either a direct prompt or recent
   * conversation history (with working memory injected into the system prompt),
   * then, unless plan mode is off, append the plan-reporting contract so the
   * action itself requests the structured plan rather than leaving it to a
   * workflow prompt convention.
   */
  private async buildCodingPrompt(
    input: CodingAgentInput,
    context: WorkflowRuntimeContext,
    settings: CodingAgentSettings,
    bindings: { memory?: Parameters<typeof resolveMemoryBindingSlugs>[1] },
  ): Promise<PreparedPrompt> {
    const selectedMemorySlugs = resolveMemoryBindingSlugs(
      context,
      bindings?.memory,
    );
    const payload = await buildPrompt(input, context, selectedMemorySlugs);
    const messages =
      'messages' in payload
        ? (payload.messages as PreparedPrompt['messages'])
        : [{ role: 'user' as const, content: payload.prompt }];
    const system =
      settings.plan_mode === 'off'
        ? payload.system
        : [payload.system, AGENT_STATE_CONTRACT_PROMPT]
            .filter((part): part is string => Boolean(part))
            .join('\n\n');

    return {
      ...(system ? { system } : {}),
      messages,
    };
  }

  /**
   * Destroys the thread's sandbox when the conversation thread is closed.
   */
  @OnEvent('hook:thread:postUpdate')
  async handleThreadClosed(event: ThreadUpdateEvent): Promise<void> {
    const thread = event?.entity;

    if (
      thread?.status === 'closed' &&
      thread.id &&
      this.leases.has(thread.id)
    ) {
      await this.evict(thread.id);
    }
  }

  /**
   * Best-effort teardown of every live sandbox so an API restart does not orphan
   * containers.
   */
  async onModuleDestroy(): Promise<void> {
    const threadIds = [...this.leases.keys()];

    await Promise.all(threadIds.map((threadId) => this.evict(threadId)));
  }

  private readSessionFromMemory(
    context: WorkflowRuntimeContext,
    slug: string,
  ): string | undefined {
    const raw = context.memoryStore?.raw as
      | Record<string, { sessionId?: unknown } | undefined>
      | undefined;
    const sessionId = raw?.[slug]?.sessionId;

    return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
  }

  private async persistThreadState(
    context: WorkflowRuntimeContext,
    slug: string,
    patch: { sessionId?: string } & AgentState,
    logger: LoggerService,
  ): Promise<void> {
    const store = context.memoryStore;
    // Drop undefined keys so we never overwrite an existing plan/todos with a
    // run that did not emit one; the memory store deep-merges the rest.
    const value = maybe(patch);

    // Silently skip when the definition is not attached, there is no thread to
    // scope the record to, or there is nothing to persist; this is best-effort.
    if (
      !store?.definitionCache?.has(slug) ||
      !context.threadId ||
      Object.keys(value).length === 0
    ) {
      return;
    }

    try {
      await store.update({ [slug]: value });
    } catch (error) {
      logger.debug('ai_coding_agent could not persist thread state', {
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerLease(
    threadId: string,
    containerId: string,
    settings: CodingAgentSettings,
    modules: TanstackModules,
    logger: LoggerService,
  ): void {
    const provider = modules.docker.dockerSandbox({
      image: settings.docker_image,
      workdir: settings.workspace_root,
      publishPorts: [],
    });
    const destroy = async () => {
      try {
        await provider.destroy({ id: containerId });
      } catch (error) {
        logger.debug('ai_coding_agent sandbox teardown failed', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    this.clearTimer(threadId);

    const idleTimer = setTimeout(() => {
      void this.evict(threadId);
    }, parseDurationMs(settings.keep_alive));

    idleTimer.unref?.();

    this.leases.set(threadId, { containerId, destroy, idleTimer });
  }

  private async evict(threadId: string): Promise<void> {
    const lease = this.leases.get(threadId);

    if (!lease) {
      return;
    }

    this.clearTimer(threadId);
    this.leases.delete(threadId);
    await lease.destroy();
  }

  private clearTimer(threadId: string): void {
    const lease = this.leases.get(threadId);

    if (lease?.idleTimer) {
      clearTimeout(lease.idleTimer);
      lease.idleTimer = null;
    }
  }
}

export default AiCodingAgentAction;
