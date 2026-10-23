import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, HistoryData, SubagentHistoryResponse, TaskEventMap } from '../types';
import { sendBridgeEvent } from '../utils/bridge';
import { getSkipNewSessionConfirm } from '../utils/skipNewSessionConfirm';
import { clearAllPersistedExpanded } from '../utils/expandedState';
import { normalizeClaudeModelForBridge } from '../utils/customClaudeModels';
import { sumKnownHistoryMessages } from '../utils/historyMessageCount';

type ViewMode = 'chat' | 'history' | 'settings';

type ToastType = 'info' | 'success' | 'warning' | 'error';

const CODEX_FORK_PENDING_TIMEOUT_MS = 130_000;

const createSessionTransitionToken = () =>
  `transition-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function createCodexForkRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `codex-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function forkResultThreadId(value: unknown): string | null {
  const result = record(value);
  const threadId = record(result?.thread)?.id;
  return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : null;
}

function forkErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const error = record(value);
  return typeof error?.message === 'string' ? error.message : undefined;
}

interface UseSessionManagementOptions {
  messages: ClaudeMessage[];
  loading: boolean;
  historyData: HistoryData | null;
  currentSessionId: string | null;
  currentSessionIdRef?: React.MutableRefObject<string | null>;
  currentProvider?: string;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setCurrentView: (view: ViewMode) => void;
  setCurrentSessionId: (id: string | null) => void;
  setCustomSessionTitle: (title: string | null) => void;
  setUsagePercentage: (percent: number) => void;
  setUsageUsedTokens: (tokens: number | undefined) => void;
  setUsageMaxTokens: (tokens: number | undefined) => void;
  setStatus: (status: string) => void;
  setLoading: (loading: boolean) => void;
  setIsThinking: (thinking: boolean) => void;
  setStreamingActive: (active: boolean) => void;
  /** Clears async subagent task events so stale completions cannot leak across sessions. */
  setTaskEvents?: React.Dispatch<React.SetStateAction<TaskEventMap>>;
  /** Clears polled sidechain histories so stale transcripts cannot leak across sessions. */
  setSubagentHistories?: React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>;
  clearToasts: () => void;
  addToast: (message: string, type?: ToastType) => void;
  t: TFunction;
  /**
   * Apply model (and optional agent) from a history row so the input bar
   * matches the session being opened.
   */
  applyHistoryModel?: (provider: string, model: string, agent?: string | null) => void;
  /**
   * Discards messages still waiting in the send queue. Queued messages belong
   * to the session they were typed in, so they must not leak into the next
   * session when the user switches away.
   */
  clearQueuedMessages?: () => void;
}

interface UseSessionManagementReturn {
  showNewSessionConfirm: boolean;
  showInterruptConfirm: boolean;
  suppressNextStatusToastRef: React.MutableRefObject<boolean>;
  createNewSession: () => void;
  forceCreateNewSession: () => void;
  forceCreateNewSessionWithProvider: (providerId: string) => void;
  handleConfirmNewSession: () => void;
  handleCancelNewSession: () => void;
  handleConfirmInterrupt: () => void;
  handleCancelInterrupt: () => void;
  loadHistorySession: (sessionId: string, provider?: string, model?: string, agent?: string) => void;
  deleteHistorySession: (sessionId: string) => void;
  deleteHistorySessions: (sessionIds: string[]) => void;
  exportHistorySession: (sessionId: string, title: string) => void;
  toggleFavoriteSession: (sessionId: string) => void;
  updateHistoryTitle: (sessionId: string, newTitle: string) => void;
  applyHistoryTitleLocal: (sessionId: string, newTitle: string) => void;
  convertToCliSession: (sessionId: string) => void;
}

/**
 * Hook for managing session operations (create, load, delete, export, etc.)
 */
export function useSessionManagement({
  messages,
  loading,
  historyData,
  currentSessionId,
  currentSessionIdRef,
  currentProvider,
  setHistoryData,
  setMessages,
  setCurrentView,
  setCurrentSessionId,
  setCustomSessionTitle,
  setUsagePercentage,
  setUsageUsedTokens,
  setUsageMaxTokens,
  setStatus,
  setLoading: setLoadingState,
  setIsThinking,
  setStreamingActive,
  setTaskEvents,
  setSubagentHistories,
  clearToasts,
  addToast,
  t,
  applyHistoryModel,
  clearQueuedMessages,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const pendingActionRef = useRef<'newSession' | null>(null);
  const suppressNextStatusToastRef = useRef(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyDataRef = useRef(historyData);
  useEffect(() => {
    historyDataRef.current = historyData;
  }, [historyData]);
  const showSessionDeletedToast = useCallback((afterSessionTransition = false) => {
    const toast = { message: t('history.sessionDeleted'), type: 'success' as const };
    if (afterSessionTransition) {
      window.__pendingSessionTransitionToast = toast;
      return;
    }
    addToast(toast.message, toast.type);
  }, [addToast, t]);

  const beginSessionTransition = useCallback((nextSessionId: string | null, nextTitle: string | null) => {
    window.__sessionTransitioning = true;
    window.__sessionTransitionToken = createSessionTransitionToken();
    // Discard any deferred snapshot from a prior transition / outgoing session.
    window.__deferredTransitionUpdateMessages = null;
    // Clear expand/collapse cache on session switch to avoid unbounded growth
    clearAllPersistedExpanded();
    // Use the single cleanup entry point exposed by useWindowCallbacks.
    // This clears both React state AND internal streaming refs in one shot.
    if (typeof window.__resetTransientUiState === 'function') {
      window.__resetTransientUiState();
    } else {
      // Fallback if useWindowCallbacks hasn't mounted yet (e.g. during SSR/tests)
      clearToasts();
      setStatus('');
      setLoadingState(false);
      setIsThinking(false);
      setStreamingActive(false);
    }
    setMessages([]);
    // Queued messages were typed against the outgoing session — dropping them
    // here keeps them from firing into the freshly opened one. The reset via
    // window.__resetTransientUiState above already clears the queue too (it
    // also covers the Java-driven clearMessages path); this explicit call only
    // guards the fallback branch where that global isn't registered yet.
    // A plain interrupt (no transition) intentionally keeps the queue so the
    // pending messages still get sent once the turn ends.
    if (clearQueuedMessages) {
      clearQueuedMessages();
    }
    // Drop async subagent events from the prior session: tool_use_ids are
    // globally unique so stale entries cannot mislabel the new session's
    // agents, but leaving them would grow the map without bound.
    if (setTaskEvents) {
      setTaskEvents({});
    }
    // Sidechain histories carry full transcript arrays (potentially large).
    // Clear them on session switch for the same unbounded-growth reason; an
    // expanded card will re-fetch the sidechain it actually needs via polling.
    if (setSubagentHistories) {
      setSubagentHistories({});
    }
    if (currentSessionIdRef) {
      currentSessionIdRef.current = nextSessionId;
    }
    setCurrentSessionId(nextSessionId);
    setCustomSessionTitle(nextTitle);
    setUsagePercentage(0);
    setUsageUsedTokens(undefined);
    setUsageMaxTokens(undefined);

    // FIX: Safety timeout to auto-release the session transition guard.
    // If the backend's historyLoadComplete signal is lost (e.g., JCEF IPC failure
    // during webview reload, or a backend error that prevents the callback),
    // __sessionTransitioning would remain true permanently, silently dropping ALL
    // message callbacks (updateMessages, onContentDelta, onStreamStart, etc.).
    // This makes the webview appear "dead" while the backend continues working.
    if (transitionTimeoutRef.current !== null) {
      clearTimeout(transitionTimeoutRef.current);
    }
    const token = window.__sessionTransitionToken;
    transitionTimeoutRef.current = setTimeout(() => {
      transitionTimeoutRef.current = null;
      if (window.__sessionTransitioning && window.__sessionTransitionToken === token) {
        console.warn('[SessionManagement] Transition guard timed out — auto-releasing');
        window.__sessionTransitioning = false;
        window.__sessionTransitionToken = null;
        // Apply any history snapshot that arrived while the guard was stuck.
        if (typeof window.__flushDeferredTransitionUpdateMessages === 'function') {
          window.__flushDeferredTransitionUpdateMessages();
        }
      }
    }, 15_000); // 15 seconds — generous enough for slow history loads
  }, [clearToasts, currentSessionIdRef, setStatus, setLoadingState, setIsThinking, setStreamingActive, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens, setTaskEvents, setSubagentHistories, clearQueuedMessages]);

  // Create new session
  const createNewSession = useCallback(() => {
    // [FIX] Prioritize loading check - if AI is responding, must interrupt first
    // This prevents creating new session without stopping the current conversation
    if (loading) {
      // If loading (AI is responding), show interrupt confirmation.
      // NOTE: The "don't ask again" preference deliberately does NOT apply here —
      // interrupting an in-progress AI response is a more dangerous operation
      // and must always require explicit confirmation.
      pendingActionRef.current = 'newSession';
      setShowInterruptConfirm(true);
    } else if (messages.length > 0) {
      // If the user previously ticked "don't ask again", skip the dialog and
      // proceed directly. Preference is read fresh each call so the setting
      // page toggle takes effect immediately.
      if (getSkipNewSessionConfirm()) {
        beginSessionTransition(null, null);
        sendBridgeEvent('create_new_session');
        return;
      }
      // If there are messages but not loading, show new session confirmation
      pendingActionRef.current = 'newSession';
      setShowNewSessionConfirm(true);
    } else {
      // If empty and not loading, directly create new session
      beginSessionTransition(null, null);
      sendBridgeEvent('create_new_session');
    }
  }, [beginSessionTransition, messages.length, loading]);

  // Force create new session (no confirmation, used by /clear /new /reset commands)
  const forceCreateNewSession = useCallback(() => {
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
  }, [beginSessionTransition, loading]);

  const forceCreateNewSessionWithProvider = useCallback((providerId: string) => {
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(null, null);
    sendBridgeEvent('set_provider', providerId);
    sendBridgeEvent('create_new_session');
  }, [beginSessionTransition, loading]);

  // Confirm new session
  const handleConfirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    // [FIX] Safety check: if loading started while dialog was open, send interrupt first
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [beginSessionTransition, loading]);

  // Cancel new session
  const handleCancelNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    pendingActionRef.current = null;
  }, []);

  // Confirm interrupt
  const handleConfirmInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    // Send interrupt signal and create new session
    sendBridgeEvent('interrupt_session');
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [beginSessionTransition]);

  // Cancel interrupt
  const handleCancelInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    pendingActionRef.current = null;
  }, []);

  // Load history session
  const loadHistorySession = useCallback((
    sessionId: string,
    provider?: string,
    model?: string,
    agent?: string,
  ) => {
    const session = historyDataRef.current?.sessions?.find(s => s.sessionId === sessionId);
    const effectiveProvider = provider || session?.provider || currentProvider || 'claude';
    const effectiveModel = (model || session?.model || '').trim();
    const effectiveAgent = (agent || session?.agent || '').trim();

    // Restore the session's model/agent in the UI before (or with) the load so
    // the next send continues with the same selection the history used.
    if (effectiveModel && applyHistoryModel) {
      applyHistoryModel(effectiveProvider, effectiveModel, effectiveAgent || null);
    }

    // Java stores the payload model verbatim, so normalize it here where the
    // custom model list lives: custom ids stay untouched, retired built-in ids
    // are mapped to their live replacement (same rule applyHistoryModel uses).
    const bridgeModel = effectiveModel
      ? (effectiveProvider === 'claude' ? normalizeClaudeModelForBridge(effectiveModel) : effectiveModel)
      : '';

    // Re-opening the session already active: soft-reload only — do NOT
    // beginSessionTransition (which clears messages and holds the transition
    // guard). Backend routes same-session to reloadActiveSessionMessages.
    // Codex still uses a full transition: its loadCodexSession path is separate
    // and mid-stream soft-reload without interrupt can clearMessages under the
    // live reply.
    const isSameSession = sessionId === currentSessionId;
    if (isSameSession && effectiveProvider !== 'codex') {
      sendBridgeEvent('load_session', JSON.stringify({
        sessionId,
        provider: effectiveProvider,
        ...(bridgeModel ? { model: bridgeModel } : {}),
      }));
      setCurrentView('chat');
      return;
    }

    // Switching to a different session (or Codex same-session): interrupt first
    // if the AI is mid-reply, then do a full session swap.
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(sessionId, session?.title ?? null);
    sendBridgeEvent('load_session', JSON.stringify({
      sessionId,
      provider: effectiveProvider,
      ...(bridgeModel ? { model: bridgeModel } : {}),
    }));
    setCurrentView('chat');
  }, [applyHistoryModel, beginSessionTransition, currentProvider, loading, setCurrentView, currentSessionId]);

  // Fork requests are emitted from MessageItem so the message list does not
  // need another prop chain. Results are correlated by requestId and only a
  // returned native thread id can enter the existing load_session flow.
  const forkSessionScopeRef = useRef({ currentSessionId, currentProvider, messages, loading, loadHistorySession });
  forkSessionScopeRef.current = { currentSessionId, currentProvider, messages, loading, loadHistorySession };
  const pendingForksRef = useRef(new Map<string, {
    sourceThreadId: string;
    lastTurnId: string;
    sourceMessages: ClaudeMessage[];
    timeoutId: ReturnType<typeof setTimeout>;
  }>());

  useEffect(() => {
    const finishRequest = (requestId: string) => {
      const pending = pendingForksRef.current.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      pendingForksRef.current.delete(requestId);
    };

    const onForkMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: unknown; lastTurnId?: unknown }>).detail;
      const threadId = typeof detail?.threadId === 'string' ? detail.threadId.trim() : '';
      const lastTurnId = typeof detail?.lastTurnId === 'string' ? detail.lastTurnId.trim() : '';
      const scope = forkSessionScopeRef.current;
      if (scope.loading) {
        addToast(t('chat.codexFork.busy'), 'warning');
        return;
      }
      if (scope.currentProvider !== 'codex' || !scope.currentSessionId
          || threadId !== scope.currentSessionId || !lastTurnId) return;
      if ([...pendingForksRef.current.values()].some((pending) => pending.sourceThreadId === threadId
          && pending.lastTurnId === lastTurnId)) return;

      const requestId = createCodexForkRequestId();
      const timeoutId = setTimeout(() => {
        finishRequest(requestId);
        addToast(t('chat.codexFork.failed', { error: t('chat.codexFork.timeout') }), 'error');
      }, CODEX_FORK_PENDING_TIMEOUT_MS);
      pendingForksRef.current.set(requestId, {
        sourceThreadId: threadId, lastTurnId, sourceMessages: scope.messages, timeoutId,
      });

      const payload = {
        requestId,
        action: 'fork',
        threadId,
        params: { threadId, lastTurnId },
      };
      if (!sendBridgeEvent('codex_queue_action', JSON.stringify(payload))) {
        finishRequest(requestId);
        addToast(t('chat.codexFork.failed', { error: t('chat.codexFork.unavailable') }), 'error');
      }
    };

    const onQueueResult = (event: Event) => {
      const detail = (event as CustomEvent<{
        requestId?: string;
        success?: boolean;
        result?: unknown;
        error?: unknown;
      }>).detail;
      if (!detail?.requestId || !pendingForksRef.current.has(detail.requestId)) return;
      const pending = pendingForksRef.current.get(detail.requestId)!;
      const threadId = forkResultThreadId(detail.result);
      const scope = forkSessionScopeRef.current;
      const succeeded = detail.success === true && !detail.error && Boolean(threadId);
      if (!succeeded) {
        finishRequest(detail.requestId);
        const error = forkErrorMessage(detail.error) ?? t('chat.codexFork.noThreadId');
        addToast(t('chat.codexFork.failed', { error }), 'error');
        return;
      }
      if (scope.currentProvider !== 'codex' || scope.currentSessionId !== pending.sourceThreadId) {
        finishRequest(detail.requestId);
        return;
      }
      finishRequest(detail.requestId);
      if (scope.loading || scope.messages !== pending.sourceMessages) {
        addToast(t('chat.codexFork.createdInHistory'), 'info');
        return;
      }
      scope.loadHistorySession(threadId!, 'codex');
    };

    const onRuntimeEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        kind?: string;
        threadId?: string | null;
        rootThreadId?: string | null;
        turnId?: string | null;
        payload?: Record<string, unknown>;
      }>).detail;
      if (detail?.kind !== 'operationDone') return;
      const scope = forkSessionScopeRef.current;
      const eventThreadId = detail.rootThreadId ?? detail.threadId;
      const turnId = detail.turnId;
      const status = detail.payload?.outcome;
      if (scope.currentProvider !== 'codex' || !scope.currentSessionId
          || eventThreadId !== scope.currentSessionId || !turnId
          || !['completed', 'failed', 'interrupted'].includes(String(status))) return;

      setMessages((previous) => previous.map((message) => {
        const raw = record(message.raw);
        if (message.type !== 'assistant' || !raw || raw.codexThreadId !== eventThreadId || raw.codexTurnId !== turnId) {
          return message;
        }
        return { ...message, raw: { ...raw, codexTurnStatus: status } };
      }));
    };

    window.addEventListener('codex-fork-message', onForkMessage);
    window.addEventListener('codex-queue-result', onQueueResult);
    window.addEventListener('codex-runtime-event', onRuntimeEvent);
    return () => {
      window.removeEventListener('codex-fork-message', onForkMessage);
      window.removeEventListener('codex-queue-result', onQueueResult);
      window.removeEventListener('codex-runtime-event', onRuntimeEvent);
      for (const [requestId, pending] of pendingForksRef.current) {
        clearTimeout(pending.timeoutId);
        pendingForksRef.current.delete(requestId);
      }
    };
  }, [addToast, setMessages, t]);

  // Delete history session
  const deleteHistorySession = useCallback((sessionId: string) => {
    // Send delete request to Java backend
    sendBridgeEvent('delete_session', sessionId);
    let startedSessionTransition = false;

    // Immediately update frontend state, remove session from history list
    if (historyData && historyData.sessions) {
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const deletedSession = prevHistoryData.sessions.find(s => s.sessionId === sessionId);
        const sessions = prevHistoryData.sessions.filter(s => s.sessionId !== sessionId);
        return {
          ...prevHistoryData,
          sessions,
          total: prevHistoryData.source === 'native' ? sumKnownHistoryMessages(sessions)
            : Math.max(0, (prevHistoryData.total || 0) - (deletedSession?.messageCount || 0))
        };
      });

      // If deleted session is current session, clear messages and reset state
      if (sessionId === currentSessionId) {
        // [FIX] Send interrupt signal if AI is responding
        if (loading) {
          sendBridgeEvent('interrupt_session');
        }
        beginSessionTransition(null, null);
        startedSessionTransition = true;
        // Set flag to suppress next updateStatus toast
        suppressNextStatusToastRef.current = true;
        sendBridgeEvent('create_new_session');
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, showSessionDeletedToast]);

  // Batch delete history sessions
  const deleteHistorySessions = useCallback((sessionIds: string[]) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    sendBridgeEvent('delete_sessions', JSON.stringify(uniqueSessionIds));
    let startedSessionTransition = false;

    if (historyData && historyData.sessions) {
      const deletedSessionIds = new Set(uniqueSessionIds);
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const deletedMessageCount = prevHistoryData.sessions.reduce((sum, session) => (
          deletedSessionIds.has(session.sessionId) ? sum + (session.messageCount || 0) : sum
        ), 0);
        const sessions = prevHistoryData.sessions.filter(session => !deletedSessionIds.has(session.sessionId));

        return {
          ...prevHistoryData,
          sessions,
          total: prevHistoryData.source === 'native' ? sumKnownHistoryMessages(sessions)
            : Math.max(0, (prevHistoryData.total || 0) - deletedMessageCount)
        };
      });

      if (currentSessionId && deletedSessionIds.has(currentSessionId)) {
        if (loading) {
          sendBridgeEvent('interrupt_session');
        }
        beginSessionTransition(null, null);
        startedSessionTransition = true;
        suppressNextStatusToastRef.current = true;
        sendBridgeEvent('create_new_session');
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, beginSessionTransition, showSessionDeletedToast]);

  // Export history session
  const exportHistorySession = useCallback((sessionId: string, title: string) => {
    const session = historyDataRef.current?.sessions?.find(s => s.sessionId === sessionId);
    const exportData = JSON.stringify({
      sessionId,
      title,
      provider: session?.provider || currentProvider || 'claude',
    });
    sendBridgeEvent('export_session', exportData);
  }, [currentProvider]);

  // Toggle favorite status
  const toggleFavoriteSession = useCallback((sessionId: string) => {
    // Send favorite toggle request to backend
    sendBridgeEvent('toggle_favorite', sessionId);

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      // Counts may arrive before React commits another render, so edit the latest rows.
      setHistoryData(previous => {
        if (!previous?.sessions) return previous;
        const sessions = previous.sessions.map(session => {
          if (session.sessionId !== sessionId) return session;
          const isFavorited = !session.isFavorited;
          return { ...session, isFavorited, favoritedAt: isFavorited ? Date.now() : undefined };
        });
        return { ...previous, sessions };
      });

      // Show toast
      const session = historyData.sessions.find(s => s.sessionId === sessionId);
      if (session?.isFavorited) {
        addToast(t('history.unfavorited'), 'success');
      } else {
        addToast(t('history.favorited'), 'success');
      }
    }
  }, [historyData, setHistoryData, addToast, t]);

  // Update session title
  const updateHistoryTitle = useCallback((sessionId: string, newTitle: string) => {
    // Send update title request to backend
    const updateData = JSON.stringify({ sessionId, customTitle: newTitle });
    sendBridgeEvent('update_title', updateData);

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      setHistoryData(previous => previous?.sessions ? {
        ...previous,
        sessions: previous.sessions.map(session => session.sessionId === sessionId ? { ...session, title: newTitle } : session),
      } : previous);

      // Show success toast
      addToast(t('history.titleUpdated'), 'success');
    }
  }, [historyData, setHistoryData, addToast, t]);

  // AI-generated titles are already persisted by saveAiTitle to the JSONL
  // session file. This skips the round-trip through the customTitle endpoint,
  // which would otherwise reject titles over its length limit.
  const applyHistoryTitleLocal = useCallback((sessionId: string, newTitle: string) => {
    setHistoryData(previous => previous?.sessions ? {
      ...previous,
      sessions: previous.sessions.map(session => session.sessionId === sessionId ? { ...session, title: newTitle } : session),
    } : previous);
  }, [setHistoryData]);

  // Convert SDK-created session to CLI-recognizable session.
  // The backend sends an onConversionResult callback with success/failure;
  // the registered handler in sessionCallbacks shows the appropriate toast
  // and triggers a deep-search reload on failure to restore the correct state.
  // We optimistically change the entrypoint from 'sdk-cli' to 'cli' so the badge disappears
  // immediately.  Functional update avoids depending on historyData directly,
  // keeping the callback reference stable across renders.
  const convertToCliSession = useCallback((sessionId: string) => {
    sendBridgeEvent('convert_to_cli_session', sessionId);

    // Optimistically change entrypoint while the backend works.
    setHistoryData(prev => {
      if (!prev?.sessions) return prev;
      return {
        ...prev,
        sessions: prev.sessions.map(s =>
          s.sessionId === sessionId ? { ...s, entrypoint: 'cli' } : s
        ),
      };
    });
  }, [setHistoryData]);

  return {
    showNewSessionConfirm,
    showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession,
    forceCreateNewSession,
    forceCreateNewSessionWithProvider,
    handleConfirmNewSession,
    handleCancelNewSession,
    handleConfirmInterrupt,
    handleCancelInterrupt,
    loadHistorySession,
    deleteHistorySession,
    deleteHistorySessions,
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
    applyHistoryTitleLocal,
    convertToCliSession,
  };
}
