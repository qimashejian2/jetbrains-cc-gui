import { act, renderHook } from '@testing-library/react';
import { useCodexActiveTurnId } from './useCodexActiveTurnId';

function emit(detail: Record<string, unknown>) {
  act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail })));
}

describe('useCodexActiveTurnId', () => {
  it('retains a turn that starts before the native thread id is bound', () => {
    const { result, rerender } = renderHook(
      ({ threadId }) => useCodexActiveTurnId('codex', threadId),
      { initialProps: { threadId: null as string | null } },
    );

    emit({ kind: 'turnStarted', rootThreadId: 'thread-a', turnId: 'turn-a' });
    expect(result.current).toBe('turn-a');

    rerender({ threadId: 'thread-a' });
    expect(result.current).toBe('turn-a');
  });

  it('keeps the root turn when a child turn starts before thread binding', () => {
    const { result, rerender } = renderHook(
      ({ threadId }) => useCodexActiveTurnId('codex', threadId),
      { initialProps: { threadId: null as string | null } },
    );

    emit({ kind: 'turnStarted', threadId: 'thread-a', rootThreadId: 'thread-a', turnId: 'turn-a' });
    emit({ kind: 'turnStarted', threadId: 'child-a', rootThreadId: 'thread-a', turnId: 'child-turn' });
    expect(result.current).toBe('turn-a');

    rerender({ threadId: 'thread-a' });
    expect(result.current).toBe('turn-a');
  });

  it.each(['operationDone', 'turnAborted', 'orphanTurnTerminal'])(
    'scopes %s to the actual root thread and matching turn',
    (kind) => {
      const { result } = renderHook(() => useCodexActiveTurnId('codex', 'thread-a'));
      emit({ kind: 'turnStarted', threadId: 'thread-a', rootThreadId: 'thread-a', turnId: 'turn-a' });

      emit({ kind, threadId: 'child-a', rootThreadId: 'thread-a' });
      expect(result.current).toBe('turn-a');

      emit({ kind, threadId: 'thread-a', rootThreadId: 'thread-a', turnId: 'older-turn' });
      expect(result.current).toBe('turn-a');

      emit({ kind, threadId: 'thread-a', rootThreadId: 'thread-a', turnId: 'turn-a' });
      expect(result.current).toBeNull();
    },
  );

  it('ignores another thread and stale terminal events', () => {
    const { result } = renderHook(() => useCodexActiveTurnId('codex', 'thread-a'));
    emit({ kind: 'turnStarted', rootThreadId: 'thread-a', turnId: 'turn-a' });
    emit({ kind: 'turnStarted', rootThreadId: 'thread-b', turnId: 'turn-b' });
    expect(result.current).toBe('turn-a');

    emit({ kind: 'operationDone', rootThreadId: 'thread-a', turnId: 'older-turn' });
    expect(result.current).toBe('turn-a');
    emit({ kind: 'operationDone', rootThreadId: 'thread-a', turnId: 'turn-a' });
    expect(result.current).toBeNull();
  });

  it('clears turn identities after runtime reset', () => {
    const { result } = renderHook(() => useCodexActiveTurnId('codex', 'thread-a'));
    emit({ kind: 'turnStarted', rootThreadId: 'thread-a', turnId: 'turn-a' });
    emit({ kind: 'runtimeReset' });
    expect(result.current).toBeNull();
  });
});
