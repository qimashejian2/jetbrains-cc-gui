import type { TFunction } from 'i18next';
import type { Attachment, CodexFollowUpMode, SelectedAgent, QueuedMessage } from './types.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { MessageQueue } from './MessageQueue.js';
import { OpenSourceBanner } from './OpenSourceBanner.js';
import { SdkStatusBar } from './SdkStatusBar.js';

export function ChatInputBoxHeader({
  sdkStatusLoading,
  sdkStatusError,
  sdkInstalled,
  currentProvider,
  onRetrySdkStatus,
  onInstallSdk,
  t,
  attachments,
  onRemoveAttachment,
  activeFile,
  selectedLines,
  usagePercentage,
  usageUsedTokens,
  usageMaxTokens,
  showUsage,
  onClearContext,
  onAddAttachment,
  selectedAgent,
  onClearAgent,
  hasMessages,
  onRewind,
  statusPanelExpanded,
  onToggleStatusPanel,
  messageQueue,
  onRemoveFromQueue,
  onReorderQueue,
  onUpdateQueueItem,
  onSteerQueueItem,
  onResumeQueue,
  queuePaused,
  queueTurnActive,
  steeringQueueIds,
  retryableSteeringQueueIds,
  queueError,
  codexFollowUpMode = 'queue',
  onCodexFollowUpModeChange,
  showOpenSourceBanner,
  onDismissOpenSourceBanner,
  autoOpenFileEnabled,
  onRequestEnableFileContext,
}: {
  sdkInstalled: boolean;
  sdkStatusLoading: boolean;
  sdkStatusError: boolean;
  currentProvider: string;
  onRetrySdkStatus?: () => void;
  onInstallSdk?: () => void;
  t: TFunction;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  activeFile?: string;
  selectedLines?: string;
  usagePercentage: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
  showUsage: boolean;
  onClearContext?: () => void;
  onAddAttachment: (files: FileList) => void;
  selectedAgent?: SelectedAgent | null;
  onClearAgent: () => void;
  hasMessages: boolean;
  onRewind?: () => void;
  statusPanelExpanded: boolean;
  onToggleStatusPanel?: () => void;
  messageQueue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  onReorderQueue?: (orderedIds: string[]) => void;
  onUpdateQueueItem?: (id: string, content: string) => Promise<boolean>;
  onSteerQueueItem?: (id: string) => void;
  onResumeQueue?: () => void;
  queuePaused?: boolean;
  queueTurnActive?: boolean;
  steeringQueueIds?: ReadonlySet<string>;
  retryableSteeringQueueIds?: ReadonlySet<string>;
  queueError?: string | null;
  codexFollowUpMode?: CodexFollowUpMode;
  onCodexFollowUpModeChange?: (mode: CodexFollowUpMode) => void;
  showOpenSourceBanner?: boolean;
  onDismissOpenSourceBanner?: () => void;
  autoOpenFileEnabled?: boolean;
  onRequestEnableFileContext?: () => void;
}) {
  return (
    <>
      {/* Open source banner */}
      {currentProvider !== 'codex' && (
        <OpenSourceBanner
          show={showOpenSourceBanner}
          onDismiss={onDismissOpenSourceBanner}
          t={t}
        />
      )}

      {/* SDK status loading, query error, or not installed warning bar */}
      {currentProvider !== 'codex' && (
        <SdkStatusBar
          sdkStatusLoading={sdkStatusLoading}
          sdkStatusError={sdkStatusError}
          sdkInstalled={sdkInstalled}
          currentProvider={currentProvider}
          onRetrySdkStatus={onRetrySdkStatus}
          onInstallSdk={onInstallSdk}
          t={t}
        />
      )}

      {/* Message queue */}
      {((messageQueue && messageQueue.length > 0) || queueError) && (
        <MessageQueue
          queue={messageQueue ?? []}
          onRemove={onRemoveFromQueue ?? (() => {})}
          onReorder={onReorderQueue}
          onUpdate={onUpdateQueueItem}
          onSteer={onSteerQueueItem}
          onResume={onResumeQueue}
          paused={queuePaused}
          turnActive={queueTurnActive}
          steeringIds={steeringQueueIds}
          retryableSteeringIds={retryableSteeringQueueIds}
          followUpMode={codexFollowUpMode}
          onToggleFollowUpMode={onCodexFollowUpModeChange}
          error={queueError}
        />
      )}

      {/* Attachment list */}
      {attachments.length > 0 && (
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />
      )}

      {/* Context bar (Top Control Bar) */}
      <ContextBar
        activeFile={activeFile}
        selectedLines={selectedLines}
        percentage={usagePercentage}
        usedTokens={usageUsedTokens}
        maxTokens={usageMaxTokens}
        showUsage={showUsage}
        onClearFile={onClearContext}
        onAddAttachment={onAddAttachment}
        selectedAgent={selectedAgent}
        onClearAgent={onClearAgent}
        currentProvider={currentProvider}
        hasMessages={hasMessages}
        onRewind={onRewind}
        statusPanelExpanded={statusPanelExpanded}
        onToggleStatusPanel={onToggleStatusPanel}
        autoOpenFileEnabled={autoOpenFileEnabled}
        onRequestEnableFileContext={onRequestEnableFileContext}
      />
    </>
  );
}
