import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCodexTurnActivity } from './useCodexTurnActivity';

function emit(detail: Record<string, unknown>) {
  act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail })));
}

afterEach(() => vi.useRealTimers());

describe('useCodexTurnActivity', () => {
  it('tracks thinking, tools, planning, approval, and returns to thinking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
    const { result } = renderHook(() => useCodexTurnActivity('codex', 'root'));
    emit({ kind: 'operationQueued', clientOperationId: 'op', rootThreadId: 'root' });
    expect(result.current).toMatchObject({ active: true, threadId: 'root', phase: 'running', startedAt: null });

    emit({ kind: 'turnStarted', clientOperationId: 'op', threadId: 'root', rootThreadId: 'root', turnId: 'turn-1' });
    expect(result.current).toMatchObject({
      active: true, threadId: 'root', turnId: 'turn-1', phase: 'thinking', startedAt: Date.now(),
    });
    emit({ kind: 'itemStarted', threadId: 'root', turnId: 'turn-1', payload: { item: { type: 'commandExecution' } } });
    expect(result.current.phase).toBe('tool');
    emit({ kind: 'planUpdated', threadId: 'root', turnId: 'turn-1', payload: { item: { type: 'plan' } } });
    expect(result.current.phase).toBe('planning');
    emit({ kind: 'turn/plan/updated', threadId: 'root', turnId: 'turn-1', payload: {
      plan: [{ step: 'done', status: 'completed' }],
    } });
    expect(result.current.phase).toBe('thinking');
    emit({ kind: 'turn/plan/updated', threadId: 'root', turnId: 'turn-1', payload: {
      plan: [{ step: 'run', status: 'inProgress' }],
    } });
    expect(result.current.phase).toBe('planning');
    emit({ kind: 'interactionRequested', threadId: 'root', turnId: 'turn-1', payload: {
      method: 'item/commandExecution/requestApproval', params: {}, rpcId: 'approval-1',
    } });
    expect(result.current.phase).toBe('approval');
    emit({ kind: 'interactionRequested', threadId: 'root', turnId: 'turn-1', payload: {
      method: 'item/fileChange/requestApproval', params: {}, rpcId: 'approval-2',
    } });
    emit({ kind: 'interactionRequested', threadId: 'root', turnId: 'turn-1', payload: {
      method: 'item/tool/requestUserInput', params: { isBlocking: false },
    } });
    expect(result.current.phase).toBe('approval');
    emit({ kind: 'interactionResolved', threadId: 'root', turnId: 'turn-1', payload: { rpcId: 'approval-1' } });
    expect(result.current.phase).toBe('approval');
    emit({ kind: 'interactionResolved', threadId: 'root', turnId: 'turn-1', payload: { rpcId: 'approval-2' } });
    expect(result.current.phase).toBe('thinking');
    emit({ kind: 'operationDone', clientOperationId: 'op', threadId: 'root', turnId: 'turn-1', payload: { outcome: 'completed' } });
    expect(result.current).toEqual({ active: false, threadId: null, turnId: null, phase: null, startedAt: null });
  });

  it('uses thread status active flags for approval and ignores stale thread or turn events', () => {
    const { result } = renderHook(() => useCodexTurnActivity('codex', 'root'));
    emit({ kind: 'operationQueued', clientOperationId: 'op', rootThreadId: 'root' });
    emit({ kind: 'turnStarted', clientOperationId: 'op', threadId: 'root', rootThreadId: 'root', turnId: 'turn-2' });
    emit({ kind: 'thread/status/changed', threadId: 'root', payload: { status: {
      type: 'active', activeFlags: ['waitingOnApproval'],
    } } });
    expect(result.current.phase).toBe('approval');

    emit({ kind: 'itemStarted', threadId: 'other', rootThreadId: 'other', turnId: 'turn-2',
      payload: { item: { type: 'commandExecution' } } });
    emit({ kind: 'orphanTurnTerminal', threadId: 'root', rootThreadId: 'root', turnId: 'older-turn' });
    emit({ kind: 'thread/status/changed', threadId: 'root', payload: { status: {
      type: 'active', activeFlags: [],
    } } });
    expect(result.current).toMatchObject({ active: true, turnId: 'turn-2', phase: 'thinking' });
  });

  it('keeps an unbound operation across initial thread binding and ignores stale operations after switching roots', () => {
    const { result, rerender } = renderHook(({ threadId }) => useCodexTurnActivity('codex', threadId), {
      initialProps: { threadId: null as string | null },
    });
    emit({ kind: 'operationQueued', clientOperationId: 'old', rootThreadId: 'root' });
    rerender({ threadId: 'root' });
    expect(result.current.active).toBe(true);
    rerender({ threadId: 'other-root' });
    expect(result.current.active).toBe(false);
    emit({ kind: 'operationQueued', clientOperationId: 'new', rootThreadId: 'other-root' });
    emit({ kind: 'operationDone', clientOperationId: 'old', threadId: 'root', rootThreadId: 'root' });
    expect(result.current.active).toBe(true);
    emit({ kind: 'operationDone', clientOperationId: 'new', threadId: 'other-root', rootThreadId: 'other-root' });
    expect(result.current.active).toBe(false);
    rerender({ threadId: null });
    expect(result.current.active).toBe(false);
  });

  it.each(['failed', 'interrupted', 'cancelled'])('clears activity after %s operations', (outcome) => {
    const { result } = renderHook(() => useCodexTurnActivity('codex', 'root'));
    emit({ kind: 'operationQueued', clientOperationId: 'op', rootThreadId: 'root' });
    emit({ kind: 'turnStarted', clientOperationId: 'op', threadId: 'root', rootThreadId: 'root', turnId: 'turn' });
    emit({ kind: 'operationDone', clientOperationId: 'op', threadId: 'root', turnId: 'turn', payload: { outcome } });
    expect(result.current.active).toBe(false);
    expect(result.current.startedAt).toBeNull();
  });

  it('clears activity when the native runtime resets', () => {
    const { result } = renderHook(() => useCodexTurnActivity('codex', 'root'));
    emit({ kind: 'operationQueued', clientOperationId: 'op', rootThreadId: 'root' });
    emit({ kind: 'turnStarted', clientOperationId: 'op', threadId: 'root', rootThreadId: 'root', turnId: 'turn' });
    emit({ kind: 'runtimeReset' });
    expect(result.current).toEqual({ active: false, threadId: null, turnId: null, phase: null, startedAt: null });
  });
});
