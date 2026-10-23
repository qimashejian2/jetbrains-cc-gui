import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';
import { buildCodexQueueInput, hasUnsupportedCodexQueueAttachment } from './useMessageSender';
import { sendBridgeEvent } from '../utils/bridge';

export interface CodexQueueInput {
  type: string;
  [key: string]: unknown;
}

export interface CodexQueuedMessage {
  id: string;
  queuedSubmissionId: string;
  content: string;
  input: CodexQueueInput[];
  attachments?: Attachment[];
  queuedAt: number;
}

interface QueueScope {
  threadId: string | null;
}

interface QueueActionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  threadId: string;
  action: string;
  resolve: (result: QueueActionResult) => void;
}

interface QueueResultEvent {
  requestId?: string;
  success?: boolean;
  result?: unknown;
  error?: unknown;
  code?: string;
}

interface CodexRuntimeEvent {
  kind?: string;
  threadId?: string | null;
  rootThreadId?: string | null;
  payload?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const entry = record(value);
  return typeof entry?.message === 'string' ? entry.message : undefined;
}

function queueItemsFrom(value: unknown): CodexQueuedMessage[] | null {
  const envelope = record(value);
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.data) ? envelope.data
      : Array.isArray(envelope?.queue) ? envelope.queue
        : Array.isArray(envelope?.items) ? envelope.items
          : Array.isArray(envelope?.queuedSubmissions) ? envelope.queuedSubmissions
            : Array.isArray(envelope?.queuedUserMessages) ? envelope.queuedUserMessages
              : null;
  if (!rawItems) return null;

  return rawItems.flatMap((rawItem) => {
    const item = record(rawItem);
    const input = Array.isArray(item?.input)
      ? item.input.filter((block): block is CodexQueueInput => Boolean(record(block))) as CodexQueueInput[]
      : [];
    const id = item?.queuedSubmissionId ?? item?.id ?? item?.clientUserMessageId;
    if (typeof id !== 'string' || !id) return [];
    return [{
      id,
      queuedSubmissionId: id,
      input,
      content: input.flatMap((block) =>
        (block.type === 'text' || block.type === 'inputText') && typeof block.text === 'string'
          ? [block.text]
          : []).join('\n'),
      queuedAt: typeof item?.queuedAt === 'number' ? item.queuedAt
        : typeof item?.createdAt === 'number' ? item.createdAt : Date.now(),
    }];
  });
}

function requestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `codex-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface UseCodexThreadQueueOptions {
  threadId: string | null;
  turnId: string | null;
  active: boolean;
}

export interface UseCodexThreadQueueReturn {
  queue: CodexQueuedMessage[];
  refresh: () => Promise<boolean>;
  enqueue: (content: string, attachments?: Attachment[]) => Promise<boolean>;
  steerInput: (content: string, attachments?: Attachment[]) => Promise<boolean>;
  steer: (id: string) => Promise<boolean>;
  update: (id: string, content: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  reorder: (orderedIds: string[]) => void;
  resume: () => Promise<boolean>;
  pause: () => void;
  paused: boolean;
  steeringIds: ReadonlySet<string>;
  retryableSteeringIds: ReadonlySet<string>;
  error: string | null;
}

/** Uses the Codex app-server queue as the source of truth for one native thread. */
export function useCodexThreadQueue({ threadId, turnId, active }: UseCodexThreadQueueOptions): UseCodexThreadQueueReturn {
  const [queueState, setQueueState] = useState<CodexQueuedMessage[]>([]);
  const [queueScope, setQueueScope] = useState<QueueScope>({ threadId: null });
  const [paused, setPaused] = useState(false);
  const [steeringIds, setSteeringIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryableSteeringIds, setRetryableSteeringIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const scopeRef = useRef<QueueScope>({ threadId });
  const latestListRef = useRef(0);
  const steeringRef = useRef(new Set<string>());
  const retryableSteeringRef = useRef(new Set<string>());
  const confirmedSteeredRef = useRef(new Set<string>());
  const directSteerPendingRef = useRef(false);
  const turnRef = useRef({ turnId, active });
  scopeRef.current = { threadId };
  turnRef.current = { turnId, active };

  const request = useCallback((action: string, params: Record<string, unknown> = {}, bindTurn = false): Promise<QueueActionResult> => {
    const requestThreadId = scopeRef.current.threadId;
    if (!requestThreadId) {
      return Promise.resolve<QueueActionResult>({ success: false, error: 'Codex thread is unavailable' });
    }
    const id = requestId();
    const payload = {
      action,
      requestId: id,
      threadId: requestThreadId,
      ...(bindTurn && turnRef.current.turnId ? { turnId: turnRef.current.turnId } : {}),
      params,
    };
    return new Promise<QueueActionResult>((resolve) => {
      pendingRef.current.set(id, { threadId: requestThreadId, action, resolve });
      if (!sendBridgeEvent('codex_queue_action', JSON.stringify(payload))) {
        pendingRef.current.delete(id);
        resolve({ success: false, error: 'Native Codex bridge is unavailable' });
      }
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!threadId) return false;
    const version = ++latestListRef.current;
    const response = await request('list');
    if (!response.success) {
      if (scopeRef.current.threadId === threadId) setError(response.error ?? 'Unable to load Codex queue');
      return false;
    }
    const items = queueItemsFrom(response.result);
    if (items && scopeRef.current.threadId === threadId && version === latestListRef.current) {
      setQueueScope({ threadId });
      setQueueState(items);
      const present = new Set(items.map((item) => item.id));
      for (const id of confirmedSteeredRef.current) {
        if (!present.has(id)) confirmedSteeredRef.current.delete(id);
      }
      for (const id of retryableSteeringRef.current) {
        if (!present.has(id)) retryableSteeringRef.current.delete(id);
      }
      setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
      setRetryableSteeringIds(new Set(retryableSteeringRef.current));
      setError(null);
      if (items.length === 0) setPaused(false);
    }
    return true;
  }, [request, threadId]);

  const finishMutation = useCallback(async (action: string, params: Record<string, unknown> = {}) => {
    setError(null);
    const response = await request(action, params);
    if (!response.success) {
      if (scopeRef.current.threadId === threadId) setError(response.error ?? `Codex queue ${action} failed`);
      return false;
    }
    await refresh();
    return true;
  }, [refresh, request, threadId]);

  const enqueue = useCallback(async (content: string, attachments?: Attachment[]) => {
    if (hasUnsupportedCodexQueueAttachment(attachments)) {
      if (scopeRef.current.threadId === threadId) setError('chat.codexQueue.unsupportedAttachment');
      return false;
    }
    const input = buildCodexQueueInput(content, attachments);
    if (!input.length) return false;
    const response = await request('add', { input });
    if (!response.success) {
      if (scopeRef.current.threadId === threadId) setError(response.error ?? 'Unable to add message to Codex queue');
      return false;
    }
    void refresh();
    return true;
  }, [refresh, request, threadId]);

  const steerInput = useCallback(async (content: string, attachments?: Attachment[]) => {
    if (hasUnsupportedCodexQueueAttachment(attachments)) {
      if (scopeRef.current.threadId === threadId) setError('chat.codexQueue.unsupportedAttachment');
      return false;
    }
    const currentTurn = turnRef.current;
    const input = buildCodexQueueInput(content, attachments);
    if (!input.length || !currentTurn.active || !currentTurn.turnId || directSteerPendingRef.current) return false;

    directSteerPendingRef.current = true;
    setError(null);
    try {
      const response = await request('steer', { input }, true);
      if (!response.success) {
        if (scopeRef.current.threadId === threadId) {
          setError(response.error ?? 'Unable to steer the active Codex turn');
        }
        return false;
      }
      return true;
    } finally {
      directSteerPendingRef.current = false;
    }
  }, [request, threadId]);

  const remove = useCallback((id: string) => {
    const item = queueState.find((entry) => entry.id === id);
    if (!item) return Promise.resolve(false);
    return finishMutation('delete', { queuedSubmissionId: item.queuedSubmissionId });
  }, [finishMutation, queueState]);

  const update = useCallback((id: string, content: string) => {
    const item = queueState.find((entry) => entry.id === id);
    if (!item) return Promise.resolve(false);
    const textInput = buildCodexQueueInput(content).filter((entry) => entry.type === 'text');
    const input = [...item.input.filter((entry) => entry.type !== 'text' && entry.type !== 'inputText'), ...textInput];
    if (!input.length) return Promise.resolve(false);
    return finishMutation('update', { queuedSubmissionId: item.queuedSubmissionId, input });
  }, [finishMutation, queueState]);

  const reorder = useCallback((orderedIds: string[]) => {
    const queuedSubmissionIds = orderedIds.map((id) =>
      queueState.find((item) => item.id === id)?.queuedSubmissionId).filter((id): id is string => Boolean(id));
    if (queuedSubmissionIds.length !== queueState.length) return;
    void finishMutation('reorder', { queuedSubmissionIds });
  }, [finishMutation, queueState]);

  const resume = useCallback(async () => {
    const started = await finishMutation('start');
    if (started) setPaused(false);
    return started;
  }, [finishMutation]);

  const pause = useCallback(() => setPaused(true), []);

  const steer = useCallback(async (id: string) => {
    const item = queueState.find((entry) => entry.id === id);
    const currentTurn = turnRef.current;
    if (!item || !currentTurn.active || !currentTurn.turnId || steeringRef.current.has(id)
        || confirmedSteeredRef.current.has(id)) return false;
    steeringRef.current.add(id);
    retryableSteeringRef.current.delete(id);
    setRetryableSteeringIds(new Set(retryableSteeringRef.current));
    setSteeringIds(new Set(steeringRef.current));
    setError(null);
    const response = await request('steer', { input: item.input }, true);
    if (!response.success) {
      await refresh();
      if (scopeRef.current.threadId === threadId) setError(response.error ?? 'Unable to steer the active Codex turn');
      steeringRef.current.delete(id);
      retryableSteeringRef.current.add(id);
      setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
      setRetryableSteeringIds(new Set(retryableSteeringRef.current));
      return false;
    }

    confirmedSteeredRef.current.add(id);
    setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
    const deleted = await request('delete', { queuedSubmissionId: item.queuedSubmissionId });
    if (!deleted.success) {
      await refresh();
      if (scopeRef.current.threadId === threadId) setError(deleted.error ?? 'Message was steered but remains in the native queue');
      steeringRef.current.delete(id);
      setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
      return false;
    }
    await refresh();
    steeringRef.current.delete(id);
    setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
    return true;
  }, [queueState, refresh, request, threadId]);

  useEffect(() => {
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<QueueResultEvent>).detail;
      if (!detail?.requestId) return;
      const pending = pendingRef.current.get(detail.requestId);
      if (!pending) return;
      pendingRef.current.delete(detail.requestId);
      if (scopeRef.current.threadId !== pending.threadId) {
        pending.resolve({ success: false, error: 'Codex thread changed' });
        return;
      }
      const responseError = detail.error ?? record(detail.result)?.error;
      pending.resolve({
        success: detail.success !== false && responseError == null,
        result: detail.result,
        error: errorMessage(responseError) ?? (typeof detail.code === 'string' ? detail.code : undefined),
      });
    };

    const onRuntime = (event: Event) => {
      const detail = (event as CustomEvent<CodexRuntimeEvent>).detail;
      if (!detail || !['thread/queue/changed', 'threadStarted', 'threadResumed', 'threadRelationVerified'].includes(detail.kind ?? '')) return;
      const eventThreadId = detail.threadId ?? detail.rootThreadId
        ?? (typeof detail.payload?.threadId === 'string' ? detail.payload.threadId : undefined);
      if (!eventThreadId || eventThreadId !== scopeRef.current.threadId) return;
      if (detail.kind !== 'thread/queue/changed') {
        // Preconnect can emit a binding event while the initial list is still
        // pending. That list already waits for preconnect before reading.
        if (![...pendingRef.current.values()].some((pending) =>
          pending.threadId === eventThreadId && pending.action === 'list')) void refresh();
        return;
      }
      const snapshot = queueItemsFrom(detail.payload);
      if (snapshot) {
        latestListRef.current += 1;
        setQueueScope({ threadId: eventThreadId });
        setQueueState(snapshot);
        setError(null);
        const present = new Set(snapshot.map((item) => item.id));
        for (const id of confirmedSteeredRef.current) {
          if (!present.has(id)) confirmedSteeredRef.current.delete(id);
        }
        for (const id of retryableSteeringRef.current) {
          if (!present.has(id)) retryableSteeringRef.current.delete(id);
        }
        setSteeringIds(new Set([...steeringRef.current, ...confirmedSteeredRef.current]));
        setRetryableSteeringIds(new Set(retryableSteeringRef.current));
        if (snapshot.length === 0) setPaused(false);
      } else {
        void refresh();
      }
    };
    window.addEventListener('codex-queue-result', onResult);
    window.addEventListener('codex-runtime-event', onRuntime);
    return () => {
      window.removeEventListener('codex-queue-result', onResult);
      window.removeEventListener('codex-runtime-event', onRuntime);
    };
  }, [refresh]);

  useEffect(() => {
    setQueueState([]);
    setQueueScope({ threadId });
    setPaused(false);
    setError(null);
    steeringRef.current.clear();
    retryableSteeringRef.current.clear();
    confirmedSteeredRef.current.clear();
    setSteeringIds(new Set());
    setRetryableSteeringIds(new Set());
    directSteerPendingRef.current = false;
    latestListRef.current += 1;
    for (const pending of pendingRef.current.values()) {
      pending.resolve({ success: false, error: 'Codex thread changed' });
    }
    pendingRef.current.clear();
    if (threadId) void refresh();
  }, [threadId, refresh]);

  const queue = queueScope.threadId === threadId ? queueState : [];
  return {
    queue, refresh, enqueue, steerInput, steer, update, remove, reorder, resume, pause, paused,
    steeringIds, retryableSteeringIds, error,
  };
}
