import { useEffect, useRef, useState } from 'react';

interface CodexTurnEvent {
  kind?: string;
  threadId?: string | null;
  rootThreadId?: string | null;
  turnId?: string | null;
  payload?: { state?: string };
}

/** Keeps the active native turn id available across initial thread binding. */
export function useCodexActiveTurnId(provider: string, threadId: string | null) {
  const [turnId, setTurnId] = useState<string | null>(null);
  const turnIdsByThreadRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (provider !== 'codex') {
      setTurnId(null);
      return;
    }

    setTurnId(threadId ? turnIdsByThreadRef.current.get(threadId) ?? null : null);

    const onRuntime = (event: Event) => {
      const detail = (event as CustomEvent<CodexTurnEvent>).detail;
      if (detail?.kind === 'runtimeReset'
          || detail?.kind === 'runtimeStateChanged' && detail.payload?.state === 'failed') {
        turnIdsByThreadRef.current.clear();
        setTurnId(null);
        return;
      }

      const eventThreadId = detail?.rootThreadId ?? detail?.threadId;
      if (detail?.threadId && detail.rootThreadId && detail.threadId !== detail.rootThreadId) return;

      if (detail?.kind === 'turnStarted' && detail.turnId) {
        if (eventThreadId) turnIdsByThreadRef.current.set(eventThreadId, detail.turnId);
        if (!threadId || !eventThreadId || eventThreadId === threadId) setTurnId(detail.turnId);
        return;
      }

      if (!['operationDone', 'turnAborted', 'orphanTurnTerminal'].includes(detail?.kind ?? '')) return;
      if (eventThreadId) {
        const currentTurnId = turnIdsByThreadRef.current.get(eventThreadId);
        if (!detail.turnId || !currentTurnId || detail.turnId === currentTurnId) {
          turnIdsByThreadRef.current.delete(eventThreadId);
        }
      }
      if (!threadId || !eventThreadId || eventThreadId === threadId) {
        setTurnId((current) => !detail.turnId || !current || detail.turnId === current ? null : current);
      }
    };

    window.addEventListener('codex-runtime-event', onRuntime);
    return () => window.removeEventListener('codex-runtime-event', onRuntime);
  }, [provider, threadId]);

  return turnId;
}
