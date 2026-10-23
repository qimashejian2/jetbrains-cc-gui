import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppChatController } from './useAppChatController';
import { useSubmitHandler } from './components/ChatInputBox/hooks/useSubmitHandler';

const mocks = vi.hoisted(() => ({
  state: {
    loading: false,
    turnActive: true,
    planPending: false,
    compactionPending: false,
  },
  queueIsLoading: false,
  localQueue: [] as Array<{ id: string; content: string; queuedAt: number; source?: string; sourceId?: string }>,
  nativeQueueItems: [] as Array<{ id: string; queuedSubmissionId: string; content: string; input: Array<{ type: string; text?: string }>; queuedAt: number }>,
  nativeQueueEnqueue: vi.fn(() => Promise.resolve(true)),
  nativeQueueSteer: vi.fn(() => Promise.resolve(true)),
  nativeQueueRemove: vi.fn(() => Promise.resolve(true)),
  nativeQueueReorder: vi.fn(),
  hookSubmit: vi.fn(),
  addToast: vi.fn(),
  setCurrentView: vi.fn(),
  setMessages: vi.fn(),
  handleModeSelect: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./contexts/DialogContext', () => ({
  useDialogs: () => ({
    ...Object.fromEntries([
      'openPermissionDialog', 'openAskUserQuestionDialog', 'openPlanApprovalDialog',
      'forceClosePermissionDialog', 'forceCloseAskUserQuestionDialog', 'forceClosePlanApprovalDialog',
      'openContextUsageDialog', 'updateContextUsageData', 'closeContextUsageDialog',
      'setRewindDialogOpen', 'setCurrentRewindRequest', 'setIsRewinding', 'setRewindSelectDialogOpen',
    ].map((key) => [key, () => undefined])),
    isRewinding: false,
  }),
}));

vi.mock('./contexts/MessagesContext', () => ({
  useMessages: () => ({
    messages: [], setMessages: mocks.setMessages, subagentHistories: new Map(),
    setSubagentHistories: () => undefined, setStatus: () => undefined,
    loading: mocks.state.loading, setLoading: () => undefined, setLoadingStartTime: () => undefined,
    setIsThinking: () => undefined, streamingActive: false, setStreamingActive: () => undefined,
  }),
}));

vi.mock('./contexts/SessionContext', () => ({
  useSession: () => ({
    currentSessionId: 'thread-1', setCurrentSessionId: () => undefined,
    customSessionTitle: null, setCustomSessionTitle: () => undefined,
    restoredSessionTitle: null, setRestoredSessionTitle: () => undefined,
    historyData: [], setHistoryData: () => undefined,
    currentSessionIdRef: { current: 'thread-1' }, customSessionTitleRef: { current: null },
  }),
}));

vi.mock('./contexts/UIStateContext', () => ({
  useUIState: () => ({
    currentView: 'chat', setCurrentView: mocks.setCurrentView,
    setSettingsInitialTab: () => undefined, addToast: mocks.addToast,
    clearToasts: () => undefined, setContextInfo: () => undefined,
  }),
}));

vi.mock('./contexts/SubagentContext', () => ({
  useSetTaskEvents: () => () => undefined,
  useSubagentContextValues: () => ({ subagentHistoryCtxValue: {}, sessionIdCtxValue: {} }),
}));

vi.mock('./hooks', async () => {
  const noop = () => undefined;
  const ref = () => ({ current: null });
  const methods = (...names: string[]) => Object.fromEntries(names.map((name) => [name, noop]));
  const { useMessageQueue: useRealMessageQueue } = await vi.importActual<typeof import('./hooks/useMessageQueue')>('./hooks/useMessageQueue');
  return {
    useScrollBehavior: () => ({
      messagesContainerRef: ref(), messagesEndRef: ref(), inputAreaRef: ref(),
      isUserAtBottomRef: ref(), isAutoScrollingRef: ref(), userPausedRef: ref(),
    }),
    useSessionManagement: () => ({
      showNewSessionConfirm: false, showInterruptConfirm: false, suppressNextStatusToastRef: ref(),
      ...methods('createNewSession', 'forceCreateNewSession', 'forceCreateNewSessionWithProvider',
        'handleConfirmNewSession', 'handleCancelNewSession', 'handleConfirmInterrupt',
        'handleCancelInterrupt', 'loadHistorySession', 'deleteHistorySession', 'deleteHistorySessions',
        'exportHistorySession', 'toggleFavoriteSession', 'updateHistoryTitle', 'applyHistoryTitleLocal',
        'convertToCliSession'),
    }),
    useStreamingMessages: () => ({
      streamingContentRef: ref(), streamingThinkingRef: ref(), isStreamingRef: ref(),
      useBackendStreamingRenderRef: ref(), streamingMessageIndexRef: ref(),
      contentUpdateTimeoutRef: ref(), thinkingUpdateTimeoutRef: ref(), lastContentUpdateRef: ref(),
      lastThinkingUpdateRef: ref(), autoExpandedThinkingKeysRef: ref(), streamingTurnIdRef: ref(),
      turnIdCounterRef: ref(), ...methods('recordStreamingBlockReset', 'clearStreamingBlockResets',
        'findLastAssistantIndex', 'extractRawBlocks', 'getOrCreateStreamingAssistantIndex',
        'patchAssistantForStreaming'),
    }),
    useWindowCallbacks: noop,
    useRewindHandlers: () => methods('handleRewindConfirm', 'handleRewindCancel',
      'handleOpenRewindSelectDialog', 'handleRewindSelect', 'handleRewindSelectCancel'),
    useHistoryLoader: noop,
    useMessageQueue: (options: { isLoading: boolean; onExecute: (content: string, attachments?: any[]) => void }) => {
      const { isLoading } = options;
      mocks.queueIsLoading = isLoading;
      const queue = useRealMessageQueue(options);
      mocks.localQueue = queue.queue;
      return queue;
    },
    useMessageProcessing: () => ({
      getMessageText: () => '', getContentBlocks: () => [], mergedMessages: [],
      sentAttachmentsRef: { current: new Map() },
    }),
    useMessageSender: () => ({ handleSubmit: mocks.hookSubmit, interruptSession: noop }),
    useChatComputations: () => ({
      findToolResult: noop, getToolResultRaw: noop,
      fileChangeMgmt: methods('handleUndoFile', 'handleDiscardAll', 'handleKeepAll'),
      filteredFileChanges: [], subagents: [], allSubagents: [], globalTodos: [],
      rewindableMessages: [], sessionTitle: '',
    }),
  };
});

vi.mock('./hooks/useCodexTurnActivity', () => ({
  useCodexTurnActivity: () => ({ active: mocks.state.turnActive, phase: 'thinking', startedAt: 1 }),
}));
vi.mock('./hooks/useCodexActiveTurnId', () => ({ useCodexActiveTurnId: () => mocks.state.turnActive ? 'turn-1' : null }));
vi.mock('./hooks/useCodexThreadQueue', () => ({
  useCodexThreadQueue: () => ({
    queue: mocks.nativeQueueItems, enqueue: mocks.nativeQueueEnqueue, steerInput: mocks.nativeQueueSteer,
    pause: () => undefined, remove: mocks.nativeQueueRemove, reorder: mocks.nativeQueueReorder,
    update: () => Promise.resolve(true), steer: () => Promise.resolve(true), resume: () => Promise.resolve(true),
    paused: false, steeringIds: new Set(), retryableSteeringIds: new Set(), error: null,
  }),
}));
vi.mock('./hooks/useCodexCompactionStatus', () => ({
  useCodexCompactionStatus: () => ({ pending: mocks.state.compactionPending, startedAt: null, startCompaction: () => undefined }),
}));
vi.mock('./hooks/useCodexPlanState', () => ({
  useCodexPlanState: () => ({ plan: null, executionPending: mocks.state.planPending, executePlan: () => undefined }),
}));

function makeModel(currentProvider = 'codex') {
  const noop = () => undefined;
  return {
    currentProvider, selectedModel: 'codex-model', permissionMode: 'default', selectedAgent: null,
    sdkStatusLoading: false, currentSdkInstalled: true, codexNativeAutoReviewAvailable: false,
    reasoningEffort: 'medium', codexFastMode: false, codexCollaborationMode: 'default',
    codexApprovalPreset: 'request', codexSandboxSelection: 'workspace-write', dshPreset: '',
    longContextEnabled: false, handleModeSelect: mocks.handleModeSelect, handleProviderSelect: noop,
    currentProviderRef: { current: currentProvider }, syncActiveProviderModelMapping: noop,
    setPermissionMode: noop, setCurrentProvider: noop, setClaudePermissionMode: noop,
    setCodexPermissionMode: noop, setSelectedClaudeModel: noop, setSelectedCodexModel: noop,
    setLongContextEnabled: noop, setReasoningEffort: noop, setCodexFastMode: noop,
    setProviderConfigVersion: noop, setActiveProviderConfig: noop,
    setClaudeSettingsAlwaysThinkingEnabled: noop, setStreamingEnabledSetting: noop,
    setSendShortcut: noop, setAutoOpenFileEnabled: noop, setSdkStatus: noop,
    setSdkStatusLoaded: noop, setSdkStatusError: noop, setSelectedAgent: noop,
    setUsagePercentage: noop, setUsageUsedTokens: noop, setUsageMaxTokens: noop,
  } as any;
}

function renderController() {
  return renderHook(() => useAppChatController({
    model: makeModel(), applyHistoryModel: () => undefined, setPermissionDialogTimeoutSeconds: () => undefined,
  }));
}

describe('useAppChatController Codex busy command routing', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.assign(mocks.state, { loading: false, turnActive: true, planPending: false, compactionPending: false });
    mocks.queueIsLoading = false;
    mocks.localQueue = [];
    mocks.nativeQueueItems = [];
    vi.clearAllMocks();
  });

  it('sends normal busy follow-ups through the selected native queue or steer route', async () => {
    const queued = renderController();
    await act(async () => { await queued.result.current.handleSubmit('queued follow-up'); });
    expect(mocks.nativeQueueEnqueue).toHaveBeenCalledWith('queued follow-up', undefined);
    expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();
    expect(mocks.queueIsLoading).toBe(true);

    queued.unmount();
    window.localStorage.setItem('ccgui.codexFollowUpMode', 'steer');
    const steered = renderController();
    await act(async () => { await steered.result.current.handleSubmit('steered follow-up'); });
    expect(mocks.nativeQueueSteer).toHaveBeenCalledWith('steered follow-up', undefined);
    expect(mocks.localQueue).toEqual([]);
  });

  it.each(['/plan inspect the workspace', '/init', '/compact', '/compact extra', '/review', '/review extra'])(
    'rejects %s while the Codex turn is active and preserves the draft', (command) => {
      const { result } = renderController();

      let accepted: unknown;
      act(() => { accepted = result.current.handleSubmit(command); });

      expect(accepted).toBe(false);
      expect(result.current.preserveInputUntilSubmitAccepted).toBe(true);
      expect(mocks.addToast).toHaveBeenCalledWith('chat.codexCommandBusy', 'warning');
      expect(mocks.nativeQueueEnqueue).not.toHaveBeenCalled();
      expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();
      expect(mocks.localQueue).toEqual([]);
      expect(mocks.hookSubmit).not.toHaveBeenCalled();
    },
  );

  it('keeps a rejected busy command in the real input submit flow', async () => {
    vi.useFakeTimers();
    const clearInput = vi.fn();
    const content = '/init';
    try {
      const { result } = renderHook(() => {
        const controller = useAppChatController({
          model: makeModel(), applyHistoryModel: () => undefined, setPermissionDialogTimeoutSeconds: () => undefined,
        });
        const submit = useSubmitHandler({
          getTextContent: () => content, invalidateCache: vi.fn(), attachments: [],
          sdkStatusLoading: false, sdkInstalled: true, currentProvider: 'codex', clearInput,
          externalAttachments: undefined, setInternalAttachments: vi.fn(),
          fileCompletion: { close: vi.fn() }, commandCompletion: { close: vi.fn() },
          agentCompletion: { close: vi.fn() }, promptCompletion: { close: vi.fn() },
          dollarCommandCompletion: { close: vi.fn() }, recordInputHistory: vi.fn(),
          onSubmit: controller.handleSubmit,
          preserveInputUntilSubmitAccepted: controller.preserveInputUntilSubmitAccepted,
          t: (key) => key,
        });
        return { controller, submit };
      });

      act(() => { result.current.submit(); });
      await act(async () => { vi.advanceTimersByTime(20); await Promise.resolve(); });

      expect(result.current.controller.preserveInputUntilSubmitAccepted).toBe(true);
      expect(clearInput).not.toHaveBeenCalled();
      expect(mocks.addToast).toHaveBeenCalledExactlyOnceWith('chat.codexCommandBusy', 'warning');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps bare /plan and existing workspace/settings reads out of the message queue', () => {
    const { result } = renderController();

    let accepted: unknown;
    act(() => { accepted = result.current.handleSubmit('/plan'); });
    expect(accepted).toBe(true);
    expect(mocks.hookSubmit).toHaveBeenCalledWith('/plan', undefined);
    expect(mocks.nativeQueueEnqueue).not.toHaveBeenCalled();
    expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();

    for (const command of ['/diff', '/approvals']) {
      act(() => { accepted = result.current.handleSubmit(command); });
      expect(accepted).toBe(true);
      expect(mocks.hookSubmit).toHaveBeenLastCalledWith(command, undefined);
    }
    expect(mocks.nativeQueueEnqueue).not.toHaveBeenCalled();
    expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', { loading: true, turnActive: false }],
    ['plan execution', { planPending: true, turnActive: false }],
    ['compaction', { compactionPending: true, turnActive: false }],
  ])('blocks turn commands during %s and keeps input acceptance pending', (_name, state) => {
    Object.assign(mocks.state, state);
    const { result } = renderController();

    let accepted: unknown;
    act(() => { accepted = result.current.handleSubmit('/init'); });

    expect(accepted).toBe(false);
    expect(result.current.preserveInputUntilSubmitAccepted).toBe(true);
    expect(mocks.localQueue).toEqual([]);
    expect(mocks.nativeQueueEnqueue).not.toHaveBeenCalled();
    expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();
    expect(mocks.hookSubmit).not.toHaveBeenCalled();
    expect(mocks.queueIsLoading).toBe(true);
  });

  it('uses the ordinary message queue when Codex is loading without an active turn id', async () => {
    Object.assign(mocks.state, { loading: true, turnActive: false });
    const { result } = renderController();

    await act(async () => { await result.current.handleSubmit('queued during bootstrap'); });

    expect(result.current.messageQueue).toEqual([
      expect.objectContaining({ content: 'queued during bootstrap', source: 'local' }),
    ]);
    expect(mocks.nativeQueueEnqueue).not.toHaveBeenCalled();
    expect(mocks.nativeQueueSteer).not.toHaveBeenCalled();
  });

  it('shows local fallbacks after native items, waits for native priority, and splits mixed actions by source', () => {
    Object.assign(mocks.state, { loading: false, turnActive: false, planPending: false, compactionPending: false });
    mocks.nativeQueueItems = [
      { id: 'native-1', queuedSubmissionId: 'native-1', content: 'native one', input: [{ type: 'text', text: 'native one' }], queuedAt: 1 },
      { id: 'native-2', queuedSubmissionId: 'native-2', content: 'native two', input: [{ type: 'text', text: 'native two' }], queuedAt: 2 },
    ];
    const { result, rerender } = renderController();

    act(() => {
      result.current.handleSubmit('local one');
      result.current.handleSubmit('local two');
    });

    expect(mocks.queueIsLoading).toBe(true);
    expect(mocks.hookSubmit).not.toHaveBeenCalled();
    expect(result.current.messageQueue.map(({ source, content }) => [source, content])).toEqual([
      ['native', 'native one'], ['native', 'native two'],
      ['local', 'local one'], ['local', 'local two'],
    ]);

    const visible = result.current.messageQueue;
    const nativeOne = visible.find((item) => item.content === 'native one')!;
    const nativeTwo = visible.find((item) => item.content === 'native two')!;
    const localOne = visible.find((item) => item.content === 'local one')!;
    const localTwo = visible.find((item) => item.content === 'local two')!;
    act(() => result.current.reorderMessageQueue([localTwo.id, nativeTwo.id, localOne.id, nativeOne.id]));
    expect(mocks.nativeQueueReorder).toHaveBeenCalledWith(['native-2', 'native-1']);
    expect(result.current.messageQueue.slice(2).map((item) => item.sourceId)).toEqual([
      localTwo.sourceId, localOne.sourceId,
    ]);

    act(() => result.current.dequeueMessage(nativeOne.id));
    expect(mocks.nativeQueueRemove).toHaveBeenCalledWith('native-1');
    act(() => result.current.dequeueMessage(localTwo.id));
    expect(result.current.messageQueue.some((item) => item.sourceId === localTwo.sourceId)).toBe(false);

    mocks.nativeQueueItems = [];
    act(() => rerender());
    expect(mocks.queueIsLoading).toBe(false);
    expect(mocks.hookSubmit).toHaveBeenCalledWith('local one', undefined);
  });
});
