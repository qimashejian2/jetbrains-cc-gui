import { useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CodexFollowUpMode, SendShortcut } from '../types.js';
import {
  claimEnterPress,
  isEnterKey,
  isFollowUpOverrideKey,
  isImeStillHoldingEnter,
  isImeStillComposing,
  isSendKey,
  releaseEnterKeyUp,
  oppositeFollowUpMode,
  triageEnterKeyDown,
} from '../utils/enterKeyGuard.js';
import type { EnterKeyRefs } from '../utils/enterKeyGuard.js';

interface CompletionWithKeyDown {
  isOpen: boolean;
  handleKeyDown: (ev: KeyboardEvent) => boolean;
}

interface InlineCompletionHandler {
  applySuggestion: () => boolean;
}

export interface UseKeyboardHandlerOptions extends EnterKeyRefs {
  sendShortcut: SendShortcut;
  currentProvider?: string;
  codexFollowUpMode?: CodexFollowUpMode;
  fileCompletion: CompletionWithKeyDown;
  commandCompletion: CompletionWithKeyDown;
  agentCompletion: CompletionWithKeyDown;
  promptCompletion: CompletionWithKeyDown;
  dollarCommandCompletion: CompletionWithKeyDown;
  handleMacCursorMovement: (e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  handleHistoryKeyDown: (e: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => boolean;
  /** Inline history completion (Tab to apply) */
  inlineCompletion?: InlineCompletionHandler;
  handleSubmit: (followUpMode?: CodexFollowUpMode) => void;
}

/**
 * useKeyboardHandler - React keyboard event handling for the chat input box
 *
 * Handles:
 * - Completion dropdown navigation
 * - History navigation (when input empty)
 * - Send shortcut (Enter / Cmd+Enter) when native capture did not already send
 * - Preventing IME "confirm enter" false send
 */
export function useKeyboardHandler({
  isComposingRef,
  lastCompositionEndTimeRef,
  sendShortcut,
  currentProvider = 'claude',
  codexFollowUpMode,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  handleMacCursorMovement,
  handleHistoryKeyDown,
  inlineCompletion,
  completionSelectedRef,
  submittedOnEnterRef,
  handleSubmit,
}: UseKeyboardHandlerOptions) {
  const enterKeyRefs = useMemo<EnterKeyRefs>(
    () => ({ submittedOnEnterRef, completionSelectedRef, isComposingRef, lastCompositionEndTimeRef }),
    [submittedOnEnterRef, completionSelectedRef, isComposingRef, lastCompositionEndTimeRef]
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const enterKey = isEnterKey(e.key, e.nativeEvent.keyCode);
      if (enterKey) {
        // Native capture is a JCEF compatibility path. If it already claimed
        // this press, React must not send the same message a second time.
        if (e.defaultPrevented) return;
        // While the IME may still be confirming its candidate, neither the
        // completion menus nor the send path may consume the key.
        const verdict = triageEnterKeyDown(e, e.nativeEvent.isComposing, sendShortcut, enterKeyRefs);
        if (verdict !== 'open') return;
      }
      if (isImeStillComposing(enterKeyRefs, e.nativeEvent.isComposing)) {
        // Shift+Enter may keep its native newline behavior while composing,
        // but must not replace the draft through an open completion menu.
        return;
      }

      if (handleMacCursorMovement(e)) return;

      const isCursorMovementKey =
        e.key === 'Home' ||
        e.key === 'End' ||
        ((e.key === 'a' || e.key === 'A') && e.ctrlKey && !e.metaKey) ||
        ((e.key === 'e' || e.key === 'E') && e.ctrlKey && !e.metaKey);
      if (isCursorMovementKey) return;

      // Menus are consulted in this order; the first open one that handles
      // the key owns it. Enter picked an item, so later Enter events of this
      // press (repeat, beforeinput) must not send.
      const completions = [
        fileCompletion,
        commandCompletion,
        agentCompletion,
        promptCompletion,
        dollarCommandCompletion,
      ];
      for (const completion of completions) {
        if (!completion.isOpen || !completion.handleKeyDown(e.nativeEvent)) continue;
        e.preventDefault();
        e.stopPropagation();
        if (enterKey) completionSelectedRef.current = true;
        return;
      }

      if (currentProvider === 'codex' && codexFollowUpMode && isFollowUpOverrideKey(e.nativeEvent)) {
        if (isImeStillHoldingEnter(
          sendShortcut,
          enterKeyRefs,
          e.nativeEvent.isComposing,
          e.metaKey || e.ctrlKey,
        )) {
          claimEnterPress(e, enterKeyRefs);
          return;
        }
        claimEnterPress(e, enterKeyRefs);
        handleSubmit(oppositeFollowUpMode(codexFollowUpMode));
        return;
      }

      // Handle inline history completion (Tab key)
      if (e.key === 'Tab' && inlineCompletion) {
        const applied = inlineCompletion.applySuggestion();
        if (applied) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (handleHistoryKeyDown(e)) return;

      if (!enterKey || !isSendKey(sendShortcut, e)) return;

      // SDK readiness is judged inside handleSubmit so that this fallback path
      // gives the same toast and install prompt as the native capture path.
      claimEnterPress(e, enterKeyRefs);
      handleSubmit();
    },
    [
      handleMacCursorMovement,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      promptCompletion,
      dollarCommandCompletion,
      handleHistoryKeyDown,
      inlineCompletion,
      sendShortcut,
      currentProvider,
      codexFollowUpMode,
      enterKeyRefs,
      completionSelectedRef,
      handleSubmit,
    ]
  );

  const onKeyUp = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isEnterKey(e.key, e.nativeEvent.keyCode)) return;
      releaseEnterKeyUp(e, sendShortcut, enterKeyRefs);
    },
    [sendShortcut, enterKeyRefs]
  );

  return { onKeyDown, onKeyUp };
}
