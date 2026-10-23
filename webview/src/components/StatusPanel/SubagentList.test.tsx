import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import SubagentList from './SubagentList';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: sendBridgeEventMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('SubagentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads Codex history with provider and agent path', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'audit',
      description: 'Review anchors',
      prompt: 'Review anchors',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      agentPath: 'audit_ui',
    };

    render(
      <SubagentList
        subagents={[subagent]}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        agentPath: 'audit_ui',
        description: 'Review anchors',
        toolUseId: 'call-spawn',
      }),
    ));
  });

  it('loads the full transcript when only a lightweight status snapshot exists', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'audit',
      description: 'Review anchors',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      agentPath: 'audit_ui',
    };
    const histories: Record<string, SubagentHistoryResponse> = {
      'call-spawn': {
        success: true,
        completed: false,
        status: 'running',
        toolUseId: 'call-spawn',
        agentId: 'agent-resolved',
        agentPath: '/root/audit_ui',
      },
    };

    render(
      <SubagentList
        subagents={[subagent]}
        histories={histories}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        agentId: 'agent-resolved',
        agentPath: '/root/audit_ui',
        description: 'Review anchors',
        toolUseId: 'call-spawn',
      }),
    ));
  });

  it('groups Codex waiting agents with Active and keeps completed agents under Done', () => {
    const subagents: SubagentInfo[] = [
      { id: 'running', type: 'Explore', description: 'Inspect code', status: 'running', isAsync: true, messageIndex: 0 },
      { id: 'waiting', type: 'Plan', description: 'Check plan', status: 'waiting', isAsync: true, messageIndex: 1 },
      { id: 'done', type: 'Build', description: 'Build plugin', status: 'completed', isAsync: true, messageIndex: 2 },
    ];

    const { container } = render(
      <SubagentList subagents={subagents} currentProvider="codex" currentSessionId="session-1" />,
    );

    const groups = container.querySelectorAll('.subagent-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute('aria-label')).toBe('chat.codexSubagents.active');
    expect(groups[0]?.textContent).toContain('chat.codexSubagents.status.waiting');
    expect(groups[1]?.getAttribute('aria-label')).toBe('chat.codexSubagents.done');
    expect(groups[1]?.textContent).toContain('Build plugin');
  });

  it('opens the selected Codex child transcript and returns to the subagent groups', () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'Explore',
      description: 'Inspect the renderer',
      status: 'completed',
      isAsync: true,
      messageIndex: 0,
      nativeTaskId: 'task-current',
    };
    const histories: Record<string, SubagentHistoryResponse> = {
      'call-spawn': {
        success: true,
        nativeTaskId: 'task-current',
        messages: [
          { type: 'user', raw: { uuid: 'user-message', message: { content: [
            { type: 'text', text: 'Inspect the renderer' },
            { type: 'image', source: { type: 'url', url: 'data:image/png;base64,fixture' }, alt: 'Screenshot' },
          ] } } },
          { type: 'assistant', raw: { uuid: 'assistant-message', message: { content: [{ type: 'text', text: 'Child transcript answer' }] } } },
        ],
      },
    };
    const { container } = render(
      <SubagentList
        subagents={[subagent]}
        histories={histories}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Inspect the renderer/ }));
    expect(screen.getByRole('region', { name: 'subagent.transcript.title' })).toBeTruthy();
    expect(screen.getByText('Child transcript answer')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Screenshot' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'subagent.transcript.back' }));
    expect(container.querySelector('.codex-subagent-list')).toBeTruthy();
  });

  it('does not display a previous child task transcript for a resumed task', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'Explore',
      description: 'Inspect the renderer again',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      nativeTaskId: 'task-new',
    };
    const histories: Record<string, SubagentHistoryResponse> = {
      'call-spawn': {
        success: true,
        nativeTaskId: 'task-old',
        agentId: 'agent-old',
        agentPath: '/root/old-audit',
        messages: [{ type: 'assistant', content: 'Stale answer' }],
      },
    };

    render(
      <SubagentList
        subagents={[subagent]}
        histories={histories}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Inspect the renderer again/ }));

    expect(screen.queryByText('Stale answer')).toBeNull();
    expect(screen.getByText('subagent.transcript.loading')).toBeTruthy();
    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'load_subagent_session',
      JSON.stringify({
        sessionId: 'session-1',
        provider: 'codex',
        nativeTaskId: 'task-new',
        description: 'Inspect the renderer again',
        toolUseId: 'call-spawn',
      }),
    ));
  });

  it('keeps the non-Codex subagent list flat', () => {
    const subagents: SubagentInfo[] = [
      { id: 'running', type: 'Explore', description: 'Inspect code', status: 'running', isAsync: true, messageIndex: 0 },
      { id: 'done', type: 'Build', description: 'Build plugin', status: 'completed', isAsync: true, messageIndex: 1 },
    ];

    const { container } = render(
      <SubagentList subagents={subagents} currentProvider="claude" currentSessionId="session-1" />,
    );

    expect(container.querySelector('.codex-subagent-list')).toBeNull();
    expect(container.querySelector('.subagent-group')).toBeNull();
    expect(container.querySelectorAll('.subagent-item')).toHaveLength(2);
  });

  it('reloads a cached partial Codex transcript once when the child completes', async () => {
    const running: SubagentInfo = {
      id: 'call-spawn',
      type: 'Explore',
      description: 'Inspect the renderer',
      status: 'running',
      isAsync: true,
      messageIndex: 0,
      nativeTaskId: 'task-current',
    };
    const partialHistory: SubagentHistoryResponse = {
      success: true,
      completed: false,
      status: 'running',
      latestTurnId: 'turn-current',
      latestTurnStatus: 'inProgress',
      nativeTaskId: 'task-current',
      messages: [{ type: 'assistant', raw: {
        uuid: 'partial-message',
        codexTurnId: 'turn-current',
        codexTurnStatus: 'inProgress',
        message: { content: [{ type: 'text', text: 'Partial answer' }] },
      } }],
    };
    const { rerender } = render(
      <SubagentList
        subagents={[running]}
        histories={{ 'call-spawn': partialHistory }}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Inspect the renderer/ }));
    expect(sendBridgeEventMock).not.toHaveBeenCalled();

    const completed = { ...running, status: 'completed' as const };
    rerender(
      <SubagentList
        subagents={[completed]}
        histories={{ 'call-spawn': { ...partialHistory, completed: true, status: 'completed', latestTurnStatus: 'completed' } }}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledTimes(1));

    rerender(
      <SubagentList
        subagents={[completed]}
        histories={{ 'call-spawn': {
          ...partialHistory,
          completed: true,
          status: 'completed',
          latestTurnStatus: 'completed',
          messages: [
            ...partialHistory.messages!,
            { type: 'assistant', raw: {
              uuid: 'final-message',
              codexTurnId: 'turn-current',
              codexTurnStatus: 'completed',
              message: { content: [{ type: 'text', text: 'Final answer' }] },
            } },
          ],
        } }}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );

    expect(screen.getByText('Final answer')).toBeTruthy();
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
  });

  it('loads a final Codex transcript when first opening cached partial messages after completion', async () => {
    const subagent: SubagentInfo = {
      id: 'call-spawn',
      type: 'Explore',
      description: 'Inspect the renderer',
      status: 'completed',
      isAsync: true,
      messageIndex: 0,
      nativeTaskId: 'task-current',
    };
    const histories: Record<string, SubagentHistoryResponse> = {
      'call-spawn': {
        success: true,
        completed: true,
        status: 'completed',
        latestTurnId: 'turn-current',
        latestTurnStatus: 'completed',
        nativeTaskId: 'task-current',
        messages: [{ type: 'assistant', raw: {
          uuid: 'partial-message',
          codexTurnId: 'turn-current',
          codexTurnStatus: 'inProgress',
          message: { content: [{ type: 'text', text: 'Cached partial answer' }] },
        } }],
      },
    };

    render(
      <SubagentList
        subagents={[subagent]}
        histories={histories}
        currentSessionId="session-1"
        currentProvider="codex"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Inspect the renderer/ }));

    await waitFor(() => expect(sendBridgeEventMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Cached partial answer')).toBeTruthy();
  });

  it('keeps Claude transcript expansion from requesting a Codex-style terminal refresh', () => {
    const subagent: SubagentInfo = {
      id: 'claude-agent',
      type: 'Explore',
      description: 'Inspect the renderer',
      status: 'completed',
      isAsync: true,
      messageIndex: 0,
      agentId: 'agent-1',
    };

    render(
      <SubagentList
        subagents={[subagent]}
        histories={{ 'claude-agent': {
          success: true,
          agentId: 'agent-1',
          messages: [{ type: 'assistant', content: 'Claude final answer' }],
        } }}
        currentSessionId="session-1"
        currentProvider="claude"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Inspect the renderer/ }));

    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });
});
