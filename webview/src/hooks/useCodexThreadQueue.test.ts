import { act, renderHook } from '@testing-library/react';
import { useCodexThreadQueue } from './useCodexThreadQueue';

type QueueItem = { id: string; input: Array<{ type: string; text?: string }> };

function queueCall(index: number) {
  const message = vi.mocked(window.sendToJava!).mock.calls[index]?.[0];
  expect(message).toMatch(/^codex_queue_action:/);
  return JSON.parse(message.slice('codex_queue_action:'.length)) as {
    action: string;
    requestId: string;
    threadId: string;
    turnId?: string;
    params?: Record<string, unknown>;
  };
}

async function respond(index: number, result: unknown, success = true) {
  const { requestId } = queueCall(index);
  await act(async () => {
    window.dispatchEvent(new CustomEvent('codex-queue-result', {
      detail: { requestId, success, result, ...(success ? {} : { error: 'native failure' }) },
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function item(id: string, text: string): QueueItem {
  return { id, input: [{ type: 'text', text }] };
}

describe('useCodexThreadQueue', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  afterEach(() => {
    delete window.sendToJava;
  });

  it('clears the old view on thread changes and ignores its late result', async () => {
    const { result, rerender } = renderHook(
      ({ threadId }) => useCodexThreadQueue({ threadId, turnId: null, active: false }),
      { initialProps: { threadId: 'thread-a' } },
    );
    expect(queueCall(0)).toMatchObject({ action: 'list', threadId: 'thread-a' });
    await respond(0, { data: [item('old', 'old thread message')] });
    expect(result.current.queue.map(({ content }) => content)).toEqual(['old thread message']);

    rerender({ threadId: 'thread-b' });
    expect(result.current.queue).toEqual([]);
    expect(queueCall(1)).toMatchObject({ action: 'list', threadId: 'thread-b' });

    await respond(0, { data: [item('stale', 'stale response')] });
    expect(result.current.queue).toEqual([]);
    await respond(1, { data: [item('new', 'new thread message')] });
    expect(result.current.queue.map(({ content }) => content)).toEqual(['new thread message']);
  });

  it('replaces the native snapshot when a matching queue changed event arrives', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [item('one', 'first')] });
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'thread/queue/changed', threadId: 'thread-a',
      payload: { data: [item('two', 'replacement')] },
    } })));
    expect(result.current.queue.map(({ id, content }) => [id, content])).toEqual([['two', 'replacement']]);
  });

  it('keeps a queued item when a native delete fails', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [item('queued-1', 'keep me')] });

    let deleted: boolean | undefined;
    act(() => {
      void result.current.remove('queued-1').then((success) => { deleted = success; });
    });
    expect(queueCall(1)).toMatchObject({
      action: 'delete', threadId: 'thread-a', params: { queuedSubmissionId: 'queued-1' },
    });
    await respond(1, null, false);
    expect(deleted).toBe(false);
    expect(result.current.queue.map(({ content }) => content)).toEqual(['keep me']);
    expect(result.current.error).toBe('native failure');
  });

  it('retries an initial queue read after binding and does not duplicate an in-flight list', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: null, active: false,
    }));
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'threadResumed', threadId: 'thread-a',
    } })));
    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    await respond(0, null, false);
    expect(result.current.error).toBe('native failure');
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'threadResumed', threadId: 'other-thread',
    } })));
    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'threadResumed', threadId: 'thread-a',
    } })));
    expect(queueCall(1)).toMatchObject({ action: 'list', threadId: 'thread-a' });
    await respond(1, { data: [item('saved', 'persisted message')] });
    expect(result.current.queue[0].content).toBe('persisted message');
    expect(result.current.error).toBeNull();
  });

  it('clears an earlier list error when a native queue snapshot arrives', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({ threadId: 'thread-a', turnId: null, active: false }));
    await respond(0, null, false);
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'thread/queue/changed', threadId: 'thread-a', payload: { data: [] },
    } })));
    expect(result.current.error).toBeNull();
  });

  it('uses stable request ids for native enqueue and binds steer to the current turn', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [item('queued-1', 'steer me')] });

    let queued: boolean | undefined;
    act(() => {
      void result.current.enqueue('new message').then((success) => { queued = success; });
    });
    const add = queueCall(1);
    expect(add).toMatchObject({ action: 'add', threadId: 'thread-a', params: { input: [{ type: 'text', text: 'new message' }] } });
    expect(add.requestId).toEqual(expect.any(String));
    await respond(1, { queued: true });
    expect(queued).toBe(true);
    await respond(2, { data: [item('queued-1', 'steer me')] });

    let duplicateSteerResult: boolean | undefined;
    act(() => {
      void result.current.steer('queued-1');
      void result.current.steer('queued-1').then((success) => { duplicateSteerResult = success; });
    });
    const steer = queueCall(3);
    expect(steer).toMatchObject({ action: 'steer', requestId: expect.any(String), threadId: 'thread-a', turnId: 'turn-a' });
    expect(steer.params?.input).toEqual([{ type: 'text', text: 'steer me' }]);
    await act(async () => { await Promise.resolve(); });
    expect(duplicateSteerResult).toBe(false);
    expect(vi.mocked(window.sendToJava!).mock.calls).toHaveLength(4);
  });

  it('removes an item only after steer and native queue confirmation succeed', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [item('queued-1', 'steer me')] });

    let steerResult: boolean | undefined;
    let steerPromise!: Promise<boolean>;
    act(() => { steerPromise = result.current.steer('queued-1'); });
    expect(queueCall(1)).toMatchObject({ action: 'steer', threadId: 'thread-a', turnId: 'turn-a' });
    await respond(1, { steered: true });
    expect(queueCall(2)).toMatchObject({ action: 'delete', params: { queuedSubmissionId: 'queued-1' } });
    await respond(2, null);
    expect(queueCall(3)).toMatchObject({ action: 'list', threadId: 'thread-a' });
    await respond(3, { data: [] });
    await act(async () => { steerResult = await steerPromise; });

    expect(steerResult).toBe(true);
    expect(result.current.queue).toEqual([]);
    expect(result.current.steeringIds.has('queued-1')).toBe(false);
  });

  it('refreshes after a failed steer before allowing a retry', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [item('queued-1', 'retry me')] });

    let steerResult: boolean | undefined;
    let steerPromise!: Promise<boolean>;
    act(() => { steerPromise = result.current.steer('queued-1'); });
    await respond(1, null, false);
    expect(queueCall(2)).toMatchObject({ action: 'list', threadId: 'thread-a' });
    await respond(2, { data: [item('queued-1', 'retry me')] });
    await act(async () => { steerResult = await steerPromise; });

    expect(steerResult).toBe(false);
    expect(result.current.queue.map(({ id }) => id)).toEqual(['queued-1']);
    expect(result.current.retryableSteeringIds.has('queued-1')).toBe(true);
    expect(result.current.error).toBe('native failure');
    act(() => { void result.current.steer('queued-1'); });
    expect(queueCall(3)).toMatchObject({ action: 'steer', turnId: 'turn-a' });
  });

  it('steers composer input directly to the active turn without adding a queue item', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [] });

    let accepted: boolean | undefined;
    let steerPromise!: Promise<boolean>;
    act(() => {
      steerPromise = result.current.steerInput('guide the current answer');
    });
    expect(queueCall(1)).toMatchObject({
      action: 'steer', threadId: 'thread-a', turnId: 'turn-a',
      params: { input: [{ type: 'text', text: 'guide the current answer' }] },
    });
    await respond(1, { steered: true });
    await act(async () => { accepted = await steerPromise; });

    expect(accepted).toBe(true);
    expect(vi.mocked(window.sendToJava!).mock.calls).toHaveLength(2);
  });

  it('rejects non-image attachments for queue and direct steer without sending a partial message', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    await respond(0, { data: [] });
    const pdf = {
      id: 'attachment-1',
      fileName: 'requirements.pdf',
      mediaType: 'application/pdf',
      data: 'cGRm',
    };

    let queued = true;
    await act(async () => { queued = await result.current.enqueue('Review this file', [pdf]); });
    expect(queued).toBe(false);
    expect(result.current.error).toBe('chat.codexQueue.unsupportedAttachment');

    let steered = true;
    await act(async () => { steered = await result.current.steerInput('Review this file', [pdf]); });
    expect(steered).toBe(false);
    expect(result.current.error).toBe('chat.codexQueue.unsupportedAttachment');
    expect(vi.mocked(window.sendToJava!).mock.calls).toHaveLength(1);
  });

  it('does not re-enable a previously acknowledged steer after another item fails', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    const snapshot = { data: [item('one', 'first'), item('two', 'second')] };
    await respond(0, snapshot);

    let firstResult: boolean | undefined;
    let firstPromise!: Promise<boolean>;
    act(() => { firstPromise = result.current.steer('one'); });
    await respond(1, { steered: true });
    await respond(2, null, false);
    await respond(3, snapshot);
    await act(async () => { firstResult = await firstPromise; });
    expect(firstResult).toBe(false);
    expect(result.current.steeringIds.has('one')).toBe(true);

    let secondPromise!: Promise<boolean>;
    act(() => { secondPromise = result.current.steer('two'); });
    await respond(4, null, false);
    await respond(5, snapshot);
    await act(async () => { await secondPromise; });
    expect(result.current.steeringIds.has('one')).toBe(true);
    expect(result.current.retryableSteeringIds.has('two')).toBe(true);

    let duplicateResult: boolean | undefined;
    await act(async () => { duplicateResult = await result.current.steer('one'); });
    expect(duplicateResult).toBe(false);
    expect(vi.mocked(window.sendToJava!).mock.calls).toHaveLength(6);
  });

  it('updates, reorders, pauses and resumes using native queue actions', async () => {
    const { result } = renderHook(() => useCodexThreadQueue({
      threadId: 'thread-a', turnId: 'turn-a', active: true,
    }));
    const image = { type: 'image', url: 'data:image/png;base64,AA==' };
    await respond(0, { data: [
      { id: 'one', input: [{ type: 'text', text: 'old' }, image] },
      item('two', 'second'),
    ] });

    let updateResult: boolean | undefined;
    let updatePromise!: Promise<boolean>;
    act(() => { updatePromise = result.current.update('one', 'edited'); });
    expect(queueCall(1)).toMatchObject({
      action: 'update', params: {
        queuedSubmissionId: 'one',
        input: [{ type: 'image', url: 'data:image/png;base64,AA==' }, { type: 'text', text: 'edited' }],
      },
    });
    await respond(1, null);
    await respond(2, { data: [
      { id: 'one', input: [{ type: 'image', url: 'data:image/png;base64,AA==' }, { type: 'text', text: 'edited' }] },
      item('two', 'second'),
    ] });
    await act(async () => { updateResult = await updatePromise; });
    expect(updateResult).toBe(true);

    act(() => result.current.reorder(['two', 'one']));
    expect(queueCall(3)).toMatchObject({ action: 'reorder', params: { queuedSubmissionIds: ['two', 'one'] } });
    await respond(3, null);
    await respond(4, { data: [item('two', 'second'), { id: 'one', input: [{ type: 'text', text: 'edited' }, image] }] });

    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);
    let resumeResult: boolean | undefined;
    let resumePromise!: Promise<boolean>;
    act(() => { resumePromise = result.current.resume(); });
    expect(queueCall(5)).toMatchObject({ action: 'start', threadId: 'thread-a' });
    await respond(5, { started: true });
    await respond(6, { data: [item('two', 'second'), { id: 'one', input: [{ type: 'text', text: 'edited' }, image] }] });
    await act(async () => { resumeResult = await resumePromise; });
    expect(resumeResult).toBe(true);
    expect(result.current.paused).toBe(false);
  });
});
