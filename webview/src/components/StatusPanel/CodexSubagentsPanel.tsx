import { useTranslation } from 'react-i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import SubagentList from './SubagentList';

interface CodexSubagentsPanelProps {
  subagents: SubagentInfo[];
  histories?: Record<string, SubagentHistoryResponse>;
  currentSessionId?: string | null;
  isStreaming?: boolean;
  onClose: () => void;
}

export function CodexSubagentsPanel({
  subagents,
  histories,
  currentSessionId,
  isStreaming,
  onClose,
}: CodexSubagentsPanelProps) {
  const { t } = useTranslation();

  return (
    <aside className="codex-subagents-panel" aria-label={t('chat.codexSubagents.title')}>
      <div className="codex-subagents-panel-header">
        <h2>{t('chat.codexSubagents.title')}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={t('common.close')}
          data-tooltip={t('common.close')}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      <SubagentList
        subagents={subagents}
        histories={histories}
        currentSessionId={currentSessionId}
        currentProvider="codex"
        isStreaming={isStreaming}
      />
    </aside>
  );
}
