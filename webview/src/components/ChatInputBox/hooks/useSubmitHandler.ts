import { useCallback, useRef } from 'react';
import type { Attachment, CodexFollowUpMode } from '../types.js';
import type { Dispatch, SetStateAction } from 'react';
import { parseCodexCommand } from '../../../hooks/codexCommandDispatcher';

interface CompletionLike {
  close: () => void;
}

export interface UseSubmitHandlerOptions {
  getTextContent: () => string;
  attachments: Attachment[];
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  currentProvider: string;
  clearInput: () => void;
  /** Invalidate text content cache to force fresh DOM read on submit */
  invalidateCache: () => void;
  externalAttachments: Attachment[] | undefined;
  setInternalAttachments: Dispatch<SetStateAction<Attachment[]>>;
  /** Clear the webview's attachment draft from sessionStorage. */
  clearAttachmentsDraft?: () => void;
  /** Pending image reads/comparisons must finish before the draft can be submitted. */
  hasPendingImagePastes?: () => boolean;
  /** Successful submission closes the previous draft's clipboard replay window. */
  invalidateImagePastes?: () => void;
  fileCompletion: CompletionLike;
  commandCompletion: CompletionLike;
  agentCompletion: CompletionLike;
  promptCompletion: CompletionLike;
  dollarCommandCompletion: CompletionLike;
  recordInputHistory: (text: string) => void;
  onSubmit?: (content: string, attachmentsToSend?: Attachment[], followUpMode?: CodexFollowUpMode) => void | boolean | Promise<boolean | void>;
  preserveInputUntilSubmitAccepted?: boolean;
  /** Session identity prevents a late acknowledgement from clearing another session's draft. */
  draftScopeKey?: string;
  onInstallSdk?: () => void;
  addToast?: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * useSubmitHandler - Submit logic for the chat input box
 *
 * - Validates SDK state and empty input
 * - Records input history
 * - Clears input/attachments for responsiveness
 * - Defers onSubmit to allow UI update
 */
export function useSubmitHandler({
  getTextContent,
  attachments,
  sdkStatusLoading,
  sdkInstalled,
  currentProvider,
  clearInput,
  invalidateCache,
  externalAttachments,
  setInternalAttachments,
  clearAttachmentsDraft,
  hasPendingImagePastes,
  invalidateImagePastes,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  recordInputHistory,
  onSubmit,
  preserveInputUntilSubmitAccepted = false,
  draftScopeKey,
  onInstallSdk,
  addToast,
  t,
}: UseSubmitHandlerOptions) {
  const attachmentsRef = useRef(attachments);
  const draftScopeRef = useRef(draftScopeKey);
  const pendingSubmissionsRef = useRef(new Map<string, Promise<boolean | void>>());
  attachmentsRef.current = attachments;
  draftScopeRef.current = draftScopeKey;

  return useCallback((followUpMode?: CodexFollowUpMode) => {
    // Force fresh DOM read to avoid stale cache (e.g., after paste)
    invalidateCache();
    const content = getTextContent();
    const cleanContent = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    const command = currentProvider === 'codex' ? parseCodexCommand(cleanContent) : null;
    // Native controls have their own backend capability/access gate. Waiting
    // for SDK discovery here can swallow /compact during a provider switch.
    const isCodexControl = ['compact', 'review', 'diff', 'approvals'].includes(command?.kind ?? '');

    // CLI providers are already known-installed. The global npm SDK query can
    // still be in flight; waiting on it only toasts "Checking SDK status...".
    if (!isCodexControl && sdkStatusLoading && !sdkInstalled) {
      addToast?.(t('chat.sdkStatusLoading'), 'info');
      return;
    }

    if (!isCodexControl && !sdkInstalled) {
      addToast?.(
        t('chat.sdkNotInstalled', {
          provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code',
        }) +
          ' ' +
          t('chat.goInstallSdk'),
        'warning'
      );
      onInstallSdk?.();
      return;
    }

    // Preserve the whole draft instead of sending a partial attachment list and refilling it later.
    if (hasPendingImagePastes?.()) {
      addToast?.(t('chat.pasteImagePreparing'), 'info');
      return;
    }

    if (!cleanContent && attachments.length === 0) return;

    const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;
    const submittedAttachmentIds = attachments.map((attachment) => attachment.id);
    const pendingKey = JSON.stringify([draftScopeKey, currentProvider, content, submittedAttachmentIds, followUpMode ?? null]);
    if (preserveInputUntilSubmitAccepted) {
      const pending = pendingSubmissionsRef.current.get(pendingKey);
      if (pending) return pending;
    }

    // Close completions
    fileCompletion.close();
    commandCompletion.close();
    agentCompletion.close();
    promptCompletion.close();
    dollarCommandCompletion.close();

    // Record input history
    recordInputHistory(content);

    const clearDraft = () => {
      invalidateImagePastes?.();
      clearInput();
      if (externalAttachments === undefined) {
        setInternalAttachments([]);
        clearAttachmentsDraft?.();
      }
    };

    if (!preserveInputUntilSubmitAccepted) {
      // clearInput also drops any queued draft notification, so a stale debounced
      // value cannot refill the input after submit.
      clearDraft();
    }

    // Call onSubmit even when loading - let parent handle queueing.
    // The retained-draft path keeps one pending request per exact draft identity,
    // so native capture, React keyboard, IDE shortcut, and button submits share
    // the same in-flight request until it is accepted or rejected.
    if (!preserveInputUntilSubmitAccepted) {
      setTimeout(() => {
        if (followUpMode === undefined) onSubmit?.(content, attachmentsToSend);
        else onSubmit?.(content, attachmentsToSend, followUpMode);
      }, 10);
      return;
    }

    const submission = new Promise<boolean | void>((resolve, reject) => {
      setTimeout(() => {
        try {
          const submitted = followUpMode === undefined
            ? onSubmit?.(content, attachmentsToSend)
            : onSubmit?.(content, attachmentsToSend, followUpMode);
          Promise.resolve(submitted).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      }, 10);
    });
    pendingSubmissionsRef.current.set(pendingKey, submission);

    void submission.then((accepted) => {
      if (accepted === false) return;
      invalidateCache();
      const currentAttachmentIds = attachmentsRef.current.map((attachment) => attachment.id);
      if (draftScopeRef.current === draftScopeKey
          && getTextContent() === content
          && currentAttachmentIds.length === submittedAttachmentIds.length
          && currentAttachmentIds.every((id, index) => id === submittedAttachmentIds[index])) {
        clearDraft();
      }
    }).catch(() => {
      // Keep the draft intact so a failed native queue request can be retried.
    }).finally(() => {
      if (pendingSubmissionsRef.current.get(pendingKey) === submission) {
        pendingSubmissionsRef.current.delete(pendingKey);
      }
    });
    return submission;
  }, [
    getTextContent,
    invalidateCache,
    attachments,
    sdkStatusLoading,
    sdkInstalled,
    currentProvider,
    clearInput,
    externalAttachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    hasPendingImagePastes,
    invalidateImagePastes,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    recordInputHistory,
    onSubmit,
    preserveInputUntilSubmitAccepted,
    draftScopeKey,
    onInstallSdk,
    addToast,
    t,
  ]);
}
