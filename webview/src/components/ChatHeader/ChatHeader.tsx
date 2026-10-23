import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { ArrowLeft, Check, History, PanelLeft, Pencil, Plus, Search, Settings2, X } from 'lucide-react';

import { BackIcon } from '../Icons';

export interface ChatHeaderProps {
  currentProvider?: string;
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onOpenSubagents?: () => void;
  /**
   * Opens the in-conversation search panel. Only rendered when provided.
   * Wired up by App.tsx via UIStateContext.setSearchOpen.
   */
  onOpenSearch?: () => void;
  onTitleChange?: (newTitle: string) => void;
  titleEditable?: boolean;
}

export function ChatHeader({
  currentProvider = 'claude',
  currentView,
  sessionTitle,
  t,
  onBack,
  onNewSession,
  onNewTab,
  onHistory,
  onSettings,
  onOpenSubagents,
  onOpenSearch,
  onTitleChange,
  titleEditable = false,
}: ChatHeaderProps): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isCodex = currentProvider === 'codex';

  // Render-time adjustment: stop editing when the title becomes non-editable
  // (same reset the old prop-change effect performed, without an extra commit).
  if (!titleEditable && editing) {
    setEditing(false);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!titleEditable || !onTitleChange) return;
    setEditValue(sessionTitle);
    setEditing(true);
  }, [titleEditable, onTitleChange, sessionTitle]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim().slice(0, 50);
    if (trimmed && trimmed !== sessionTitle && onTitleChange) {
      onTitleChange(trimmed);
    }
  }, [editValue, sessionTitle, onTitleChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // If focus moves to save/cancel button inside edit container, let that button handle it
    const editContainer = e.currentTarget.closest('.session-title-edit-mode');
    if (editContainer && editContainer.contains(e.relatedTarget as Node)) {
      return;
    }
    commitEdit();
  }, [commitEdit]);

  if (currentView === 'settings') {
    return null;
  }

  return (
    <div className={`header${isCodex ? ' codex-header' : ''}`}>
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            {isCodex ? <ArrowLeft aria-hidden="true" /> : <BackIcon />} {t('common.back')}
          </button>
        ) : editing ? (
          <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              type="text"
              className="session-title-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              maxLength={50}
              spellCheck={false}
              aria-label="Session title"
            />
            <button className="session-title-save-btn" onClick={commitEdit} aria-label="Save title">
              {isCodex ? <Check aria-hidden="true" /> : <span className="codicon codicon-check" />}
            </button>
            <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="Cancel editing">
              {isCodex ? <X aria-hidden="true" /> : <span className="codicon codicon-close" />}
            </button>
          </div>
        ) : (
          <div className="session-title-wrapper">
            <div className="session-title">
              {sessionTitle}
            </div>
            {titleEditable && (
              <button className="session-title-edit-btn" onClick={startEditing} aria-label="Edit session title">
                {isCodex ? <Pencil aria-hidden="true" /> : <span className="codicon codicon-edit" />}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')} aria-label={t('common.newSession')}>
              {isCodex ? <Plus aria-hidden="true" /> : <span className="codicon codicon-plus" />}
            </button>
            <button
              className="icon-button"
              onClick={onNewTab}
              data-tooltip={t('common.newTab')}
              aria-label={t('common.newTab')}
            >
              {isCodex ? <PanelLeft aria-hidden="true" /> : <span className="codicon codicon-split-horizontal" />}
            </button>
            {onOpenSearch && (
              <button
                className="icon-button"
                onClick={onOpenSearch}
                data-tooltip={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
                aria-label={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
              >
                {isCodex ? <Search aria-hidden="true" /> : <span className="codicon codicon-search" />}
              </button>
            )}
            {isCodex && onOpenSubagents && (
              <button
                className="icon-button"
                onClick={onOpenSubagents}
                data-tooltip={t('chat.codexSubagents.title')}
                aria-label={t('chat.codexSubagents.title')}
              >
                <span className="codicon codicon-hubot" aria-hidden="true" />
              </button>
            )}
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
              aria-label={t('common.history')}
            >
              {isCodex ? <History aria-hidden="true" /> : <span className="codicon codicon-history" />}
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
              aria-label={t('common.settings')}
            >
              {isCodex ? <Settings2 aria-hidden="true" /> : <span className="codicon codicon-settings-gear" />}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
