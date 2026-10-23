import { act, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { useSubmitHandler } from './useSubmitHandler.js';
import { useCodexThreadQueue } from '../../../hooks/useCodexThreadQueue.js';

it.each(['/compact', '/review', '/diff', '/approvals'])('dispatches Codex control %s while CLI discovery is pending', (command) => {
  vi.useFakeTimers();
  try {
    const onSubmit = vi.fn();
    const addToast = vi.fn();
    const close = vi.fn();
    const { result } = renderHook(() => useSubmitHandler({
      getTextContent: () => command, invalidateCache: vi.fn(), attachments: [],
      sdkStatusLoading: true, sdkInstalled: false, currentProvider: 'codex', clearInput: vi.fn(),
      externalAttachments: undefined, setInternalAttachments: vi.fn(),
      fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
      promptCompletion: { close }, dollarCommandCompletion: { close }, recordInputHistory: vi.fn(),
      onSubmit, addToast, t: (key) => key,
    }));
    result.current();
    vi.runAllTimers();
    expect(onSubmit).toHaveBeenCalledWith(command, undefined);
    expect(addToast).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

function createAttachment(id: string): Attachment {
  return { id, fileName: `${id}.txt`, mediaType: 'text/plain', data: 'ZGF0YQ==' };
}

function createImageAttachment(id: string): Attachment {
  return { id, fileName: `${id}.png`, mediaType: 'image/png', data: 'aW1hZ2U=' };
}

function queueCall(index: number) {
  const message = vi.mocked(window.sendToJava!).mock.calls[index]?.[0];
  expect(message).toMatch(/^codex_queue_action:/);
  return JSON.parse(message.slice('codex_queue_action:'.length)) as {
    action: string;
    requestId: string;
  };
}

async function respondToQueueCall(index: number, result: unknown, success = true) {
  const { requestId } = queueCall(index);
  await act(async () => {
    window.dispatchEvent(new CustomEvent('codex-queue-result', {
      detail: { requestId, success, result, ...(success ? {} : { error: 'native failure' }) },
    }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderSubmitWithNativeQueue(content: string, attachments: Attachment[] = []) {
  const clearInput = vi.fn();
  const currentDraft = { current: content };
  const currentScope = { current: 'session-a' };
  const common = {
    sdkStatusLoading: false,
    sdkInstalled: true,
    currentProvider: 'codex',
    clearInput,
    externalAttachments: undefined,
    setInternalAttachments: vi.fn(),
    fileCompletion: { close: vi.fn() },
    commandCompletion: { close: vi.fn() },
    agentCompletion: { close: vi.fn() },
    promptCompletion: { close: vi.fn() },
    dollarCommandCompletion: { close: vi.fn() },
    recordInputHistory: vi.fn(),
    t: (key: string) => key,
  };
  const hook = renderHook(({ draft, files }: { draft: string; files: Attachment[] }) => {
    currentDraft.current = draft;
    const queue = useCodexThreadQueue({ threadId: 'thread-submit', turnId: 'turn-submit', active: true });
    const submit = useSubmitHandler({
      ...common,
      getTextContent: () => currentDraft.current,
      invalidateCache: vi.fn(),
      attachments: files,
      onSubmit: (text, submittedFiles) => queue.enqueue(text, submittedFiles),
      preserveInputUntilSubmitAccepted: true,
      draftScopeKey: currentScope.current,
    });
    return { queue, submit };
  }, { initialProps: { draft: content, files: attachments } });
  return { ...hook, clearInput, common, currentScope };
}

describe('useSubmitHandler', () => {
  it('coalesces duplicate retained-draft submits and releases a failed native add for retry', async () => {
    vi.useFakeTimers();
    window.sendToJava = vi.fn();
    try {
      const { result, clearInput, common } = renderSubmitWithNativeQueue('same draft', [createImageAttachment('image-1')]);
      await respondToQueueCall(0, { data: [] });

      let firstSubmission!: Promise<boolean | void>;
      let duplicateSubmission!: Promise<boolean | void>;
      act(() => {
        firstSubmission = result.current.submit()!;
        duplicateSubmission = result.current.submit()!;
      });
      expect(duplicateSubmission).toBe(firstSubmission);
      expect(common.recordInputHistory).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(queueCall(1).action).toBe('add');
      expect(vi.mocked(window.sendToJava)).toHaveBeenCalledTimes(2);

      await respondToQueueCall(1, null, false);
      await act(async () => { await firstSubmission; });
      expect(clearInput).not.toHaveBeenCalled();

      let retry!: Promise<boolean | void>;
      act(() => { retry = result.current.submit()!; });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(queueCall(2).action).toBe('add');
      await respondToQueueCall(2, { queued: true });
      await act(async () => { await retry; });
      expect(clearInput).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      delete window.sendToJava;
    }
  });

  it('does not let an earlier native acknowledgement clear a newer draft', async () => {
    vi.useFakeTimers();
    window.sendToJava = vi.fn();
    try {
      const { result, rerender, clearInput } = renderSubmitWithNativeQueue('first draft');
      await respondToQueueCall(0, { data: [] });

      let firstSubmission!: Promise<boolean | void>;
      act(() => { firstSubmission = result.current.submit()!; });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(queueCall(1).action).toBe('add');

      rerender({ draft: 'new draft', files: [] });
      let secondSubmission!: Promise<boolean | void>;
      act(() => { secondSubmission = result.current.submit()!; });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(queueCall(2).action).toBe('add');

      await respondToQueueCall(1, { queued: true });
      await act(async () => { await firstSubmission; });
      expect(clearInput).not.toHaveBeenCalled();

      await respondToQueueCall(2, { queued: true });
      await act(async () => { await secondSubmission; });
      expect(clearInput).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      delete window.sendToJava;
    }
  });

  it('does not clear an identical draft after its session changes', async () => {
    vi.useFakeTimers();
    window.sendToJava = vi.fn();
    try {
      const { result, rerender, clearInput, currentScope } = renderSubmitWithNativeQueue('same text');
      await respondToQueueCall(0, { data: [] });

      let submission!: Promise<boolean | void>;
      act(() => { submission = result.current.submit()!; });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(queueCall(1).action).toBe('add');

      currentScope.current = 'session-b';
      rerender({ draft: 'same text', files: [] });
      await respondToQueueCall(1, { queued: true });
      await act(async () => { await submission; });
      expect(clearInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      delete window.sendToJava;
    }
  });

  it('does nothing when input is empty and no attachments', () => {
    const clearInput = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => '',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(recordInputHistory).not.toHaveBeenCalled();
  });

  it('blocks submit when SDK status is loading', () => {
    const addToast = vi.fn();
    const clearInput = vi.fn();
    const close = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: true,
        sdkInstalled: false,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
  });

  it('sends while the shared SDK query is still loading when this provider is already installed', () => {
    vi.useFakeTimers();
    const addToast = vi.fn();
    const onSubmit = vi.fn();
    const close = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: true,
        sdkInstalled: true,
        currentProvider: 'grok',
        clearInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory: vi.fn(),
        onSubmit,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    vi.advanceTimersByTime(20);
    expect(addToast).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('hello', undefined);
    vi.useRealTimers();
  });

  it('prompts install when SDK is missing', () => {
    const addToast = vi.fn();
    const onInstallSdk = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        sdkStatusLoading: false,
        sdkInstalled: false,
        currentProvider: 'codex',
        clearInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close: vi.fn() },
        commandCompletion: { close: vi.fn() },
        agentCompletion: { close: vi.fn() },
        promptCompletion: { close: vi.fn() },
        dollarCommandCompletion: { close: vi.fn() },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        onInstallSdk,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(onInstallSdk).toHaveBeenCalled();
  });

  it.each(['prompt', ''])('preserves the %s draft while image attachments are pending', (content) => {
    const clearInput = vi.fn();
    const setInternalAttachments = vi.fn();
    const invalidateImagePastes = vi.fn();
    const addToast = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn();
    const { result } = renderHook(() => useSubmitHandler({
      getTextContent: () => content,
      invalidateCache: vi.fn(), attachments: [], sdkStatusLoading: false, sdkInstalled: true,
      currentProvider: 'claude', clearInput, externalAttachments: undefined,
      setInternalAttachments, hasPendingImagePastes: () => true, invalidateImagePastes,
      fileCompletion: { close }, commandCompletion: { close }, agentCompletion: { close },
      promptCompletion: { close }, dollarCommandCompletion: { close },
      recordInputHistory, onSubmit, addToast, t: (key) => key,
    }));

    result.current();

    expect(addToast).toHaveBeenCalledWith('chat.pasteImagePreparing', 'info');
    expect(clearInput).not.toHaveBeenCalled();
    expect(setInternalAttachments).not.toHaveBeenCalled();
    expect(invalidateImagePastes).not.toHaveBeenCalled();
    expect(recordInputHistory).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits content, closes completions, records history, and clears input', () => {
    vi.useFakeTimers();
    const clearInput = vi.fn();
    const recordInputHistory = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const invalidateCache = vi.fn();
    const invalidateImagePastes = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache,
        attachments: [createAttachment('a1')],
        hasPendingImagePastes: () => false,
        invalidateImagePastes,
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(invalidateCache).toHaveBeenCalled();
    expect(invalidateImagePastes).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(5);
    expect(recordInputHistory).toHaveBeenCalledWith('hello');
    expect(clearInput).toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello', [createAttachment('a1')]);
    vi.useRealTimers();
  });
});
