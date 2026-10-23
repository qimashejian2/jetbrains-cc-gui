import { useEffect, useRef, useState } from 'react';

export type CodexTurnPhase = 'thinking' | 'tool' | 'approval' | 'planning' | 'running' | null;

export interface CodexTurnActivity {
  active: boolean;
  threadId: string | null;
  turnId: string | null;
  phase: CodexTurnPhase;
  startedAt: number | null;
}

interface CodexRuntimeEvent {
  kind?: string;
  clientOperationId?: string | null;
  threadId?: string | null;
  rootThreadId?: string | null;
  turnId?: string | null;
  payload?: {
    state?: string;
    outcome?: string;
    method?: string;
    rpcId?: string | number;
    plan?: unknown;
    status?: { type?: string; activeFlags?: string[] };
    params?: { isBlocking?: boolean };
    item?: NativeItem;
  };
}

interface NativeItem {
  type?: string;
  itemType?: string;
}

interface OperationIdentity {
  threadId: string | null;
  turnId: string | null;
}

const EMPTY_ACTIVITY: CodexTurnActivity = {
  active: false,
  threadId: null,
  turnId: null,
  phase: null,
  startedAt: null,
};

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

function phaseForItem(item?: NativeItem): Exclude<CodexTurnPhase, null> {
  const type = item?.type ?? item?.itemType;
  if (type === 'reasoning') return 'thinking';
  if (type === 'plan') return 'planning';
  if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall', 'imageView', 'tool'].includes(type ?? '')) {
    return 'tool';
  }
  return 'running';
}

/** Tracks native Codex turn activity without inferring elapsed time before turn/start. */
export function useCodexTurnActivity(provider: string, threadId: string | null): CodexTurnActivity {
  const operationsRef = useRef(new Map<string, OperationIdentity>());
  const pendingInteractionsRef = useRef(new Set<string>());
  const scopeRef = useRef({ provider, threadId });
  const activityRef = useRef(EMPTY_ACTIVITY);
  const [activity, setActivity] = useState(EMPTY_ACTIVITY);

  useEffect(() => {
    const previous = scopeRef.current;
    // First native root binding keeps its queued operation; leaving a root resets its activity.
    if (previous.provider !== provider || (previous.threadId && previous.threadId !== threadId)) {
      operationsRef.current.clear();
      pendingInteractionsRef.current.clear();
      activityRef.current = EMPTY_ACTIVITY;
      setActivity(EMPTY_ACTIVITY);
    }
    scopeRef.current = { provider, threadId };
  }, [provider, threadId]);

  useEffect(() => {
    if (provider !== 'codex') return;
    const onRuntime = (event: Event) => {
      const detail = (event as CustomEvent<CodexRuntimeEvent>).detail;
      if (!detail) return;

      const eventThreadId = detail.threadId ?? null;
      const eventRootId = detail.rootThreadId ?? eventThreadId;
      const current = activityRef.current;
      if (threadId && eventRootId && eventRootId !== threadId) return;
      if (!threadId && current.threadId && eventRootId && eventRootId !== current.threadId) return;

      const publish = (next: CodexTurnActivity) => {
        activityRef.current = next;
        setActivity(next);
      };
      const isCurrentTurn = (!current.threadId || !eventThreadId || current.threadId === eventThreadId)
        && (!current.turnId || !detail.turnId || current.turnId === detail.turnId);
      const active = operationsRef.current.size > 0;

      if (detail.kind === 'runtimeReset'
          || detail.kind === 'runtimeStateChanged' && detail.payload?.state === 'failed') {
        operationsRef.current.clear();
        pendingInteractionsRef.current.clear();
        publish(EMPTY_ACTIVITY);
        return;
      }

      if (detail.kind === 'operationQueued' && detail.clientOperationId) {
        operationsRef.current.set(detail.clientOperationId, { threadId: eventRootId, turnId: null });
        publish({
          ...current,
          active: true,
          threadId: current.threadId ?? eventRootId,
          phase: current.phase ?? 'running',
        });
        return;
      }

      if (detail.kind === 'turnStarted') {
        // Child-thread turns share a root id but must not replace the root chat's status.
        if (threadId && eventThreadId && eventThreadId !== threadId) return;
        if (detail.clientOperationId) {
          operationsRef.current.set(detail.clientOperationId, { threadId: eventThreadId ?? eventRootId, turnId: detail.turnId ?? null });
        }
        publish({
          active: operationsRef.current.size > 0 || Boolean(detail.turnId),
          threadId: eventThreadId ?? eventRootId,
          turnId: detail.turnId ?? null,
          phase: 'thinking',
          startedAt: Date.now(),
        });
        return;
      }

      if (detail.kind === 'operationDone' && detail.clientOperationId) {
        const operation = operationsRef.current.get(detail.clientOperationId);
        const matchesOperation = !operation
          || (!operation.threadId || !eventThreadId || operation.threadId === eventThreadId)
            && (!operation.turnId || !detail.turnId || operation.turnId === detail.turnId);
        if (!matchesOperation) return;
        operationsRef.current.delete(detail.clientOperationId);
        const operationOwnsCurrentTurn = !operation || operation.turnId === current.turnId;
        if (isCurrentTurn && operationOwnsCurrentTurn) {
          pendingInteractionsRef.current.clear();
          publish(operationsRef.current.size === 0 ? EMPTY_ACTIVITY : {
            active: true,
            threadId: current.threadId ?? eventRootId,
            turnId: null,
            phase: 'running',
            startedAt: null,
          });
        }
        return;
      }

      if (detail.kind === 'turnAborted' || detail.kind === 'orphanTurnTerminal') {
        if (isCurrentTurn && eventThreadId === current.threadId) {
          pendingInteractionsRef.current.clear();
          if (detail.clientOperationId) operationsRef.current.delete(detail.clientOperationId);
          publish(operationsRef.current.size > 0 ? { ...current, active: true } : EMPTY_ACTIVITY);
        }
        return;
      }

      if (detail.kind === 'interactionRequested') {
        if (!isCurrentTurn || detail.payload?.params?.isBlocking === false) return;
        if (detail.payload?.method && !APPROVAL_METHODS.has(detail.payload.method)) return;
        const rpcId = detail.payload?.rpcId;
        if (rpcId !== undefined) pendingInteractionsRef.current.add(String(rpcId));
        publish({ ...current, active: active || current.active, phase: 'approval' });
        return;
      }

      if (detail.kind === 'interactionResolved') {
        if (isCurrentTurn && current.active) {
          const rpcId = detail.payload?.rpcId;
          if (rpcId === undefined) pendingInteractionsRef.current.clear();
          else pendingInteractionsRef.current.delete(String(rpcId));
          publish({ ...current, phase: pendingInteractionsRef.current.size > 0 ? 'approval' : 'thinking' });
        }
        return;
      }

      if (detail.kind === 'thread/status/changed') {
        if (!current.active || !eventThreadId || eventThreadId !== current.threadId) return;
        const activeFlags = detail.payload?.status?.activeFlags ?? [];
        if (activeFlags.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) {
          publish({ ...current, phase: 'approval' });
        } else if (current.phase === 'approval') {
          pendingInteractionsRef.current.clear();
          publish({ ...current, phase: 'thinking' });
        }
        return;
      }

      if (detail.kind === 'itemStarted' || detail.kind === 'itemUpdated') {
        if (!isCurrentTurn || threadId && eventThreadId && eventThreadId !== threadId) return;
        const phase = phaseForItem(detail.payload?.item);
        publish({ ...current, active: active || current.active, phase });
        return;
      }

      if (detail.kind === 'item/reasoning/summaryTextDelta') {
        if (isCurrentTurn && current.active && (!threadId || !eventThreadId || threadId === eventThreadId)) {
          publish({ ...current, phase: 'thinking' });
        }
        return;
      }

      if (detail.kind === 'itemCompleted') {
        if (isCurrentTurn && current.active && (!threadId || !eventThreadId || threadId === eventThreadId)) {
          publish({ ...current, phase: 'thinking' });
        }
        return;
      }

      if (detail.kind === 'planUpdated' || detail.kind === 'turn/plan/updated') {
        if (isCurrentTurn && current.active && (!threadId || !eventThreadId || threadId === eventThreadId)) {
          publish({ ...current, phase: detail.kind === 'planUpdated' ? 'planning'
            : nativePlanIsComplete(detail.payload?.plan) ? 'thinking' : 'planning' });
        }
      }
    };

    window.addEventListener('codex-runtime-event', onRuntime);
    return () => window.removeEventListener('codex-runtime-event', onRuntime);
  }, [provider, threadId]);

  return activity;
}

function nativePlanIsComplete(plan: unknown): boolean {
  return Array.isArray(plan) && plan.length > 0
    && plan.every(step => step && typeof step === 'object' && (step as { status?: unknown }).status === 'completed');
}
