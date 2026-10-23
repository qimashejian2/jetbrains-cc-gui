import { useTranslation } from 'react-i18next';
import { ChatHeader } from './ChatHeader';
import { CODEX_SUBAGENTS_PANEL_TOGGLE_EVENT } from './StatusPanel/codexSubagentsPanelEvent';
import { sendBridgeEvent } from '../utils/bridge';
import { useSession } from '../contexts/SessionContext';
import { useUIState } from '../contexts/UIStateContext';

interface AppHeaderProps {
  currentProvider: string;
  sessionTitle: string;
  onNewSession: () => void;
  onUpdateHistoryTitle: (sessionId: string, newTitle: string) => void;
}

/**
 * Header region extracted from App.tsx — wires view navigation, session
 * actions, and inline title editing into ChatHeader. View/session state is
 * consumed from contexts directly (same convention as ChatScreen).
 */
export const AppHeader = ({ currentProvider, sessionTitle, onNewSession, onUpdateHistoryTitle }: AppHeaderProps) => {
  const { t } = useTranslation();
  const {
    currentView, setCurrentView,
    setSettingsInitialTab, setSettingsProviderSubTab,
    setSearchOpen,
  } = useUIState();
  const { currentSessionId, setCustomSessionTitle } = useSession();

  return (
    <ChatHeader
      currentProvider={currentProvider}
      currentView={currentView}
      sessionTitle={sessionTitle}
      t={t}
      onBack={() => setCurrentView('chat')}
      onNewSession={onNewSession}
      onNewTab={() => sendBridgeEvent('create_new_tab')}
      onHistory={() => setCurrentView('history')}
      onSettings={() => {
        setSettingsInitialTab(undefined);
        setSettingsProviderSubTab(undefined);
        setCurrentView('settings');
      }}
      onOpenSearch={() => setSearchOpen(true)}
      onOpenSubagents={() => window.dispatchEvent(new Event(CODEX_SUBAGENTS_PANEL_TOGGLE_EVENT))}
      titleEditable
      onTitleChange={(newTitle) => {
        setCustomSessionTitle(newTitle);
        if (currentSessionId) {
          onUpdateHistoryTitle(currentSessionId, newTitle);
        }
      }}
    />
  );
};
