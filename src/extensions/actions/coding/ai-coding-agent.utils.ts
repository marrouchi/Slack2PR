/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { randomUUID } from 'crypto';

import {
  AGENT_STATE_FENCE,
  DEFAULT_IDLE_TTL_MS,
} from './ai-coding-agent.constants';

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parse a human duration such as `30m`, `2h`, `90s`, or `500ms` into
 * milliseconds. Falls back to {@link DEFAULT_IDLE_TTL_MS} for unparseable input.
 */
export function parseDurationMs(
  value: string | undefined,
  fallback = DEFAULT_IDLE_TTL_MS,
): number {
  if (!value) {
    return fallback;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);

  if (!match) {
    return fallback;
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const ms = amount * DURATION_UNIT_MS[unit];

  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

/**
 * POSIX single-quote escape so a value is passed literally to the sandbox shell
 * (wrap in `'…'`, escaping embedded single quotes). Used when composing the git
 * bootstrap setup commands so identities, paths, and credential helpers cannot
 * break out of their argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function maybe<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function makeRunIdentifier(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Normalize the optional session id override coming from the action input. The
 * input default is a workflow expression (`=$context.memory…`) that the runner
 * resolves before the action runs; when the field is left untouched it resolves
 * to nothing (empty) or, for non-UI-authored workflows that omit the field
 * entirely, arrives as the unresolved literal. Both mean "no override", letting
 * the action fall back to the session persisted in thread-scoped memory.
 */
export function resolveSessionOverride(
  value: string | undefined,
): string | undefined {
  if (!value || value.startsWith('=')) {
    return undefined;
  }

  return value;
}

export function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }

  return {
    value: value.slice(0, maxChars),
    truncated: true,
  };
}

export function appendText(current: string, next: string, maxChars: number) {
  return truncateText(`${current}${next}`, maxChars);
}

/** A single unit of work parsed from a harness structured state block. */
export type AgentTodo = {
  title: string;
  description?: string;
  status?: string;
};

/** Optional structured state a harness can emit alongside its text response. */
export type AgentState = {
  plan?: string;
  todos?: AgentTodo[];
};

function normalizeTodo(entry: unknown): AgentTodo | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }

  const record = entry as Record<string, unknown>;
  // Accept `title` or `name` so planner prompts that phrase components either
  // way still yield a usable todo.
  const rawTitle =
    typeof record.title === 'string'
      ? record.title
      : typeof record.name === 'string'
        ? record.name
        : '';
  const title = rawTitle.trim();

  if (!title) {
    return undefined;
  }

  const todo: AgentTodo = { title };

  if (typeof record.description === 'string' && record.description.trim()) {
    todo.description = record.description.trim();
  }

  if (typeof record.status === 'string' && record.status.trim()) {
    todo.status = record.status.trim();
  }

  return todo;
}

/**
 * Outcome of parsing the structured state block, so the action can report a
 * deterministic `plan_status` to workflows instead of a silent `undefined`:
 * - `absent`: no `hexabot-state` block was emitted.
 * - `invalid`: a block was emitted but was not valid JSON or lacked a usable
 *   `plan`/`todos`.
 * - `ok`: a valid block was parsed into {@link AgentState}.
 */
export type AgentStateResult =
  | { status: 'absent' }
  | { status: 'invalid'; error: string }
  | { status: 'ok'; state: AgentState };

/**
 * Extract the structured state a coding agent appends to its response as a
 * fenced block tagged {@link AGENT_STATE_FENCE} whose body is JSON with `plan`
 * and/or `todos`. The last matching block wins so a later run can refine the
 * plan or the todo list.
 *
 * Unlike a best-effort parse, this distinguishes "no block" from "malformed
 * block" so the action can turn planning into a real contract: request it in the
 * system prompt and surface whether the agent complied.
 */
export function extractAgentState(text: string | undefined): AgentStateResult {
  if (!text) {
    return { status: 'absent' };
  }

  const fence = new RegExp(
    '```' + AGENT_STATE_FENCE + '\\s*\\n([\\s\\S]*?)```',
    'g',
  );
  let match: RegExpExecArray | null;
  let body: string | undefined;

  while ((match = fence.exec(text)) !== null) {
    body = match[1];
  }

  if (body === undefined) {
    return { status: 'absent' };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return {
      status: 'invalid',
      error: `The ${AGENT_STATE_FENCE} block did not contain valid JSON.`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 'invalid',
      error: `The ${AGENT_STATE_FENCE} block must be a JSON object.`,
    };
  }

  const record = parsed as Record<string, unknown>;
  const state: AgentState = {};

  if (typeof record.plan === 'string' && record.plan.trim()) {
    state.plan = record.plan.trim();
  }

  if (Array.isArray(record.todos)) {
    const todos = record.todos
      .map(normalizeTodo)
      .filter((todo): todo is AgentTodo => todo !== undefined);

    if (todos.length > 0) {
      state.todos = todos;
    }
  }

  if (state.plan === undefined && state.todos === undefined) {
    return {
      status: 'invalid',
      error: `The ${AGENT_STATE_FENCE} block must include a "plan" string or a non-empty "todos" array.`,
    };
  }

  return { status: 'ok', state };
}
