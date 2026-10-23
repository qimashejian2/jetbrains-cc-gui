import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { hasSubagentTranscript, isSubagentHistoryCurrent } from '../../utils/subagentResult';
import MarkdownBlock from '../MarkdownBlock';
import { ImageBlock } from '../MessageItem/blocks/ImageBlock';
import { subagentStatusIconMap } from './types';
import SubagentProcessDetails from './SubagentProcessDetails';

interface SubagentListProps {
  subagents: SubagentInfo[];
  histories?: Record<string, SubagentHistoryResponse>;
  currentSessionId?: string | null;
  currentProvider: string;
  isStreaming?: boolean;
}

interface SubagentRowProps {
  subagent: SubagentInfo;
  isExpanded: boolean;
  codexLayout: boolean;
  history: SubagentHistoryResponse | undefined;
  canLoad: boolean;
  onToggle: (id: string) => void;
  t: TFunction;
}

const SubagentRow = memo(({ subagent, isExpanded, codexLayout, history, canLoad, onToggle, t }: SubagentRowProps) => {
  const statusIcon = subagentStatusIconMap[subagent.status] ?? 'codicon-circle-outline';
  const statusClass = `status-${subagent.status}`;

  const handleClick = useCallback(() => {
    onToggle(subagent.id);
  }, [onToggle, subagent.id]);

  return (
    <div className={`subagent-item-wrapper ${statusClass}`}>
      <button
        type="button"
        className={`subagent-item ${statusClass}`}
        aria-expanded={isExpanded}
        onClick={handleClick}
      >
        <span className={`subagent-status-icon ${statusClass}`}>
          <span className={`codicon ${statusIcon}`} />
        </span>
        <span className="subagent-type">{subagent.type || t('statusPanel.subagentTab')}</span>
        <span className="subagent-description" title={subagent.prompt}>
          {codexLayout
            ? subagent.description || subagent.prompt?.slice(0, 60) || subagent.resultText?.slice(0, 60)
            : subagent.description || subagent.prompt?.slice(0, 50)}
        </span>
        {codexLayout && (
          <span className="subagent-status-label">
            {t(`chat.codexSubagents.status.${subagent.status}`)}
          </span>
        )}
        <span className={`subagent-chevron codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
      </button>

      {isExpanded && !codexLayout && (
        <SubagentProcessDetails
          agentId={history?.agentId ?? subagent.agentId}
          agentPath={history?.agentPath ?? subagent.agentPath}
          totalDurationMs={subagent.totalDurationMs}
          totalTokens={subagent.totalTokens}
          totalToolUseCount={subagent.totalToolUseCount}
          resultText={subagent.resultText}
          prompt={subagent.prompt}
          history={history}
          canLoad={canLoad}
        />
      )}
    </div>
  );
});

SubagentRow.displayName = 'SubagentRow';
const EMPTY_HISTORIES: SubagentListProps['histories'] = {};

interface TranscriptPart {
  kind: 'markdown' | 'tool' | 'image';
  content: string;
  title?: string;
}

interface TranscriptMessage {
  id: string;
  role: 'assistant' | 'user' | 'tool';
  parts: TranscriptPart[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textFromToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((entry) => {
    const block = asRecord(entry);
    return typeof block?.text === 'string' ? [block.text] : [];
  }).join('\n');
}

function imagePart(value: unknown): TranscriptPart | null {
  const block = asRecord(value);
  if (block?.type !== 'image') return null;
  const source = asRecord(block.source);
  let src = typeof block.src === 'string' ? block.src : '';
  if (!src && source?.type === 'url' && typeof source.url === 'string') src = source.url;
  if (!src && source?.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    src = `data:${mediaType};base64,${source.data}`;
  }
  return src ? { kind: 'image', content: src, title: typeof block.alt === 'string' ? block.alt : undefined } : null;
}

function transcriptMessage(value: unknown, index: number): TranscriptMessage | null {
  const entry = asRecord(value);
  const raw = asRecord(entry?.raw);
  const rawMessage = asRecord(raw?.message);
  const blocks = Array.isArray(rawMessage?.content) ? rawMessage.content : [];
  const parts: TranscriptPart[] = [];
  let hasToolResult = false;

  blocks.forEach((valueBlock) => {
    const block = asRecord(valueBlock);
    if (!block) return;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ kind: 'markdown', content: block.text });
    } else if (block.type === 'image') {
      const image = imagePart(block);
      if (image) parts.push(image);
    } else if (block.type === 'thinking' && block.native === true && typeof block.text === 'string' && block.text) {
      parts.push({ kind: 'markdown', content: block.text, title: 'thinking' });
    } else if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      let input = '';
      try { input = JSON.stringify(block.input ?? {}, null, 2); } catch { input = String(block.input ?? ''); }
      parts.push({ kind: 'tool', title: name, content: input });
    } else if (block.type === 'tool_result') {
      const output = textFromToolResult(block.content);
      parts.push({ kind: 'tool', title: 'tool-output', content: output || '' });
      if (Array.isArray(block.content)) {
        for (const contentBlock of block.content) {
          const image = imagePart(contentBlock);
          if (image) parts.push(image);
        }
      }
      hasToolResult = true;
    }
  });

  if (parts.length === 0 && typeof entry?.content === 'string' && entry.content) {
    parts.push({ kind: 'markdown', content: entry.content });
  }
  if (parts.length === 0) return null;
  const role: TranscriptMessage['role'] = hasToolResult ? 'tool'
    : entry?.type === 'assistant' ? 'assistant' : 'user';
  const id = typeof raw?.uuid === 'string' ? raw.uuid
    : typeof raw?.codexItemId === 'string' ? raw.codexItemId : `message-${index}`;
  return { id, role, parts };
}

const TERMINAL_CODEX_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted']);

function hasCompleteCodexTranscript(history: SubagentHistoryResponse | undefined): boolean {
  if (!Array.isArray(history?.messages)) return false;

  let hasCodexTurnMetadata = false;
  for (let index = history.messages.length - 1; index >= 0; index--) {
    const raw = asRecord(asRecord(history.messages[index])?.raw);
    const turnId = typeof raw?.codexTurnId === 'string' ? raw.codexTurnId : undefined;
    const turnStatus = typeof raw?.codexTurnStatus === 'string' ? raw.codexTurnStatus : undefined;
    if (turnId || turnStatus) hasCodexTurnMetadata = true;
    if (history.latestTurnId && turnId === history.latestTurnId) {
      return TERMINAL_CODEX_TURN_STATUSES.has(turnStatus ?? '');
    }
    if (!history.latestTurnId && turnStatus) {
      return TERMINAL_CODEX_TURN_STATUSES.has(turnStatus);
    }
  }

  // A lightweight terminal status can overwrite the history-level fields while
  // leaving messages from an earlier partial read in place. Native item turn
  // metadata lets us distinguish that cache from a transcript read at terminal.
  if (history.latestTurnId && hasCodexTurnMetadata) return false;
  return history.completed !== false && history.status !== 'running' && history.status !== 'waiting';
}

function CodexSubagentTranscript({
  subagent,
  history,
  onBack,
  onRetry,
}: {
  subagent: SubagentInfo;
  history?: SubagentHistoryResponse;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const messages = Array.isArray(history?.messages)
    ? history.messages.map(transcriptMessage).filter((message): message is TranscriptMessage => message !== null)
    : null;

  return (
    <section className="codex-subagent-transcript" aria-label={t('subagent.transcript.title')}>
      <div className="codex-subagent-transcript-header">
        <button type="button" className="codex-subagent-back" onClick={onBack}>
          <span className="codicon codicon-arrow-left" />
          {t('subagent.transcript.back')}
        </button>
        <div className="codex-subagent-transcript-title">
          <span>{subagent.type || t('statusPanel.subagentTab')}</span>
          <small>{subagent.description || subagent.prompt}</small>
        </div>
        <span className={`subagent-status-label status-${subagent.status}`}>
          {t(`chat.codexSubagents.status.${subagent.status}`)}
        </span>
      </div>
      {history?.success === false ? (
        <div className="codex-subagent-transcript-state" role="alert">
          <div>{t('subagent.transcript.failed', { error: history.error ?? '' })}</div>
          <button type="button" className="codex-subagent-back" onClick={onRetry}>{t('subagent.transcript.retry')}</button>
        </div>
      ) : messages === null ? (
        <div className="codex-subagent-transcript-state" role="status">{t('subagent.transcript.loading')}</div>
      ) : messages.length === 0 ? (
        <div className="codex-subagent-transcript-state">{t('subagent.transcript.empty')}</div>
      ) : (
        <div className="codex-subagent-transcript-messages">
          {messages.map((message) => (
            <article key={message.id} className={`codex-subagent-transcript-message role-${message.role}`}>
              <div className="codex-subagent-message-role">{t(`subagent.transcript.${message.role}`)}</div>
              {message.parts.map((part, partIndex) => part.kind === 'markdown' ? (
                <div key={`${message.id}-part-${partIndex}`} className="codex-subagent-transcript-markdown">
                  {part.title === 'thinking' && <div className="codex-subagent-message-note">{t('subagent.transcript.summary')}</div>}
                  <MarkdownBlock content={part.content} />
                </div>
              ) : part.kind === 'image' ? (
                <div key={`${message.id}-part-${partIndex}`} className="codex-subagent-transcript-image">
                  <ImageBlock
                    block={{ type: 'image', src: part.content, alt: part.title }}
                    messageType={message.role === 'user' ? 'user' : 'assistant'}
                    t={t}
                  />
                </div>
              ) : (
                <details key={`${message.id}-part-${partIndex}`} className="codex-subagent-transcript-tool">
                  <summary>{part.title === 'tool-output' ? t('subagent.transcript.tool') : part.title}</summary>
                  {part.content ? <pre>{part.content}</pre> : <div>{t('subagent.transcript.emptyToolOutput')}</div>}
                </details>
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const SubagentList = memo(({ subagents, histories = EMPTY_HISTORIES, currentSessionId, currentProvider }: SubagentListProps) => {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCodexTask, setSelectedCodexTask] = useState<{
    id: string;
    sessionId: string;
    provider: string;
    nativeTaskId?: string;
  } | null>(null);
  const codexLayout = currentProvider === 'codex';

  // Keep latest subagents/histories in refs so the polling effect can read fresh
  // values without re-running (and rebuilding the interval) on every change.
  const subagentsRef = useRef(subagents);
  const historiesRef = useRef(histories);
  useEffect(() => { subagentsRef.current = subagents; }, [subagents]);
  useEffect(() => { historiesRef.current = histories; }, [histories]);

  const requestHistory = useCallback((subagent: SubagentInfo) => {
    if (!currentSessionId) return;
    const candidate = historiesRef.current[subagent.id]
      ?? (subagent.agentId ? historiesRef.current[subagent.agentId] : undefined);
    const history = isSubagentHistoryCurrent(candidate, subagent.nativeTaskId) ? candidate : undefined;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      provider: currentProvider,
      agentId: history?.agentId ?? subagent.agentId,
      agentPath: history?.agentPath ?? subagent.agentPath,
      nativeTaskId: subagent.nativeTaskId,
      nativeTaskPreviousTurnId: subagent.nativeTaskPreviousTurnId,
      description: subagent.description,
      toolUseId: subagent.id,
    }));
  }, [currentProvider, currentSessionId]);

  const terminalTranscriptRequestsRef = useRef({
    sessionId: currentSessionId,
    provider: currentProvider,
    taskKeys: new Set<string>(),
  });
  const requestTerminalHistoryOnce = useCallback((subagent: SubagentInfo) => {
    if (!currentSessionId) return;
    let requestState = terminalTranscriptRequestsRef.current;
    if (requestState.sessionId !== currentSessionId || requestState.provider !== currentProvider) {
      requestState = { sessionId: currentSessionId, provider: currentProvider, taskKeys: new Set<string>() };
      terminalTranscriptRequestsRef.current = requestState;
    }
    const taskKey = JSON.stringify([
      subagent.id,
      subagent.nativeTaskId ?? null,
      subagent.agentId ?? null,
      subagent.agentPath ?? null,
    ]);
    if (requestState.taskKeys.has(taskKey)) return;
    requestState.taskKeys.add(taskKey);
    requestHistory(subagent);
  }, [currentProvider, currentSessionId, requestHistory]);

  // Track the expanded row's status so the polling effect re-runs (and clears
  // its interval) when it transitions out of "running", instead of leaving a
  // no-op interval firing every 2 s until the row is collapsed.
  const selectedCandidate = codexLayout && selectedCodexTask
    && selectedCodexTask.sessionId === currentSessionId
    && selectedCodexTask.provider === currentProvider
    ? subagents.find((item) => item.id === selectedCodexTask.id) : undefined;
  const selectedSubagent = selectedCandidate
    && selectedCandidate.nativeTaskId === selectedCodexTask?.nativeTaskId ? selectedCandidate : undefined;
  const activeExpandedId = codexLayout ? selectedSubagent?.id ?? null : expandedId;
  const expandedStatus = subagents.find((item) => item.id === activeExpandedId)?.status;

  useEffect(() => {
    if (!activeExpandedId) return;
    const subagent = subagentsRef.current.find((item) => item.id === activeExpandedId);
    if (!subagent || !currentSessionId) return;
    const candidate = historiesRef.current[activeExpandedId]
      ?? (subagent.agentId ? historiesRef.current[subagent.agentId] : undefined);
    const history = isSubagentHistoryCurrent(candidate, subagent.nativeTaskId) ? candidate : undefined;
    const terminal = subagent.status === 'completed' || subagent.status === 'error';
    if (!hasSubagentTranscript(history)
      || codexLayout && terminal && !hasCompleteCodexTranscript(history)) {
      if (codexLayout && terminal) requestTerminalHistoryOnce(subagent);
      else requestHistory(subagent);
    }
    if (!currentSessionId || subagent.status !== 'running') return;
    const timer = window.setInterval(() => {
      const current = subagentsRef.current.find((item) => item.id === activeExpandedId);
      if (!current || current.status !== 'running') return;
      requestHistory(current);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [currentSessionId, activeExpandedId, requestHistory, requestTerminalHistoryOnce, expandedStatus, codexLayout]);

  const historyById = useMemo(() => histories, [histories]);

  const handleToggleRow = useCallback((id: string) => {
    if (codexLayout) {
      if (selectedCodexTask?.id === id) {
        setSelectedCodexTask(null);
        return;
      }
      const subagent = subagents.find((item) => item.id === id);
      if (!subagent || !currentSessionId) return;
      setSelectedCodexTask({
        id,
        sessionId: currentSessionId,
        provider: currentProvider,
        nativeTaskId: subagent.nativeTaskId,
      });
      return;
    }
    setExpandedId((prev) => (prev === id ? null : id));
  }, [codexLayout, currentProvider, currentSessionId, selectedCodexTask?.id, subagents]);
  useEffect(() => {
    setExpandedId(null);
    setSelectedCodexTask(null);
  }, [currentSessionId, currentProvider]);

  const canLoad = Boolean(currentSessionId);
  if (subagents.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noSubagents')}</div>;
  }

  const renderRows = (agents: SubagentInfo[]) => agents.map((subagent, index) => {
    const candidate = historyById[subagent.id] ?? (subagent.agentId ? historyById[subagent.agentId] : undefined);
    const history = isSubagentHistoryCurrent(candidate, subagent.nativeTaskId) ? candidate : undefined;
    // Index fallback guards against rare cases where the bridge emits a
    // subagent without a stable id; without it React surfaces a duplicate-key
    // warning and may miscompare rows during streaming updates.
    return (
      <SubagentRow
        key={subagent.id ?? `subagent-${index}`}
        subagent={subagent}
        isExpanded={codexLayout ? selectedSubagent?.id === subagent.id : expandedId === subagent.id}
        codexLayout={codexLayout}
        history={history}
        canLoad={canLoad}
        onToggle={handleToggleRow}
        t={t}
      />
    );
  });

  if (selectedSubagent) {
    const candidate = historyById[selectedSubagent.id]
      ?? (selectedSubagent.agentId ? historyById[selectedSubagent.agentId] : undefined);
    const history = isSubagentHistoryCurrent(candidate, selectedSubagent.nativeTaskId) ? candidate : undefined;
    return (
      <CodexSubagentTranscript
        subagent={selectedSubagent}
        history={history}
        onBack={() => setSelectedCodexTask(null)}
        onRetry={() => requestHistory(selectedSubagent)}
      />
    );
  }

  if (!codexLayout) {
    return <div className="subagent-list">{renderRows(subagents)}</div>;
  }

  const activeAgents = subagents.filter((item) => item.status === 'running' || item.status === 'waiting');
  const doneAgents = subagents.filter((item) => item.status === 'completed' || item.status === 'error');

  return (
    <div className="subagent-list codex-subagent-list">
      {activeAgents.length > 0 && (
        <section className="subagent-group" aria-label={t('chat.codexSubagents.active')}>
          <div className="subagent-group-heading">{t('chat.codexSubagents.active')} · {activeAgents.length}</div>
          {renderRows(activeAgents)}
        </section>
      )}
      {doneAgents.length > 0 && (
        <section className="subagent-group" aria-label={t('chat.codexSubagents.done')}>
          <div className="subagent-group-heading">{t('chat.codexSubagents.done')} · {doneAgents.length}</div>
          {renderRows(doneAgents)}
        </section>
      )}
    </div>
  );
});

SubagentList.displayName = 'SubagentList';

export default SubagentList;
