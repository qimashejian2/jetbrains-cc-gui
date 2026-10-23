import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover } from '@base-ui/react/popover';
import { LoaderCircle } from 'lucide-react';
import type { CodexFollowUpMode, QueuedMessage } from './types.js';
import { createEdgeInsertResolver, useDragSort } from '../settings/hooks/useDragSort';
import { useDragAutoScroll } from './hooks/useDragAutoScroll.js';

/** Exact queued follow-up glyph embedded in the installed VS Code extension bundle. */
function CodexFollowUpIcon() {
  return (
    <svg className="message-queue-leading-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.16675 2.73999C3.53402 2.73999 3.83179 3.03776 3.83179 3.40503V12.7039C3.83192 13.6988 4.6386 14.5056 5.63354 14.5056H15.2361L13.9958 13.2654C13.7362 13.0057 13.7362 12.5837 13.9958 12.324C14.2556 12.0647 14.6777 12.0644 14.9373 12.324L17.1345 14.5222C17.4917 14.8794 17.4914 15.4598 17.1345 15.8171L14.9373 18.0154C14.6776 18.2751 14.2555 18.2751 13.9958 18.0154C13.7362 17.7557 13.7362 17.3337 13.9958 17.074L15.2341 15.8357H5.63354C3.90406 15.8357 2.50185 14.4333 2.50171 12.7039V3.40503C2.50171 3.03776 2.79948 2.73999 3.16675 2.73999Z" fill="currentColor" />
      <path d="M11.6667 9.37671C12.034 9.37677 12.3318 9.67452 12.3318 10.0417C12.3318 10.409 12.034 10.7067 11.6667 10.7068H7.41675C7.04948 10.7068 6.75171 10.409 6.75171 10.0417C6.75171 9.67448 7.04948 9.37671 7.41675 9.37671H11.6667Z" fill="currentColor" />
      <path d="M14.2498 5.09253C14.617 5.0926 14.9148 5.39034 14.9148 5.75757C14.9148 6.1248 14.617 6.42254 14.2498 6.42261H7.41675C7.04948 6.42261 6.75171 6.12484 6.75171 5.75757C6.75171 5.3903 7.04948 5.09253 7.41675 5.09253H14.2498Z" fill="currentColor" />
    </svg>
  );
}

/** Exact primary follow-up action glyph embedded in the installed VS Code extension bundle. */
function CodexSteerActionIcon() {
  return (
    <svg className="message-queue-steer-icon" viewBox="0 0 21 21" aria-hidden="true">
      <path d="M13.1293 7.34753C13.3565 7.12027 13.7081 7.09207 13.9662 7.26257L14.0707 7.34753L18.0707 11.3475C18.3304 11.6072 18.3304 12.0292 18.0707 12.2889L14.0707 16.2889C13.811 16.5486 13.389 16.5486 13.1293 16.2889C12.8696 16.0292 12.8696 15.6072 13.1293 15.3475L15.9935 12.4833H6.59998C4.57585 12.4833 2.93494 10.8424 2.93494 8.81824V5.31824C2.93494 4.95097 3.23271 4.6532 3.59998 4.6532C3.96724 4.6532 4.26501 4.95097 4.26501 5.31824V8.81824C4.26501 10.1078 5.31039 11.1532 6.59998 11.1532H15.9935L13.1293 8.28894L13.0443 8.18445C12.8738 7.92632 12.902 7.5748 13.1293 7.34753Z" fill="currentColor" />
    </svg>
  );
}

function CodexQueueDragIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9.5" cy="5.5" r="1.5" fill="currentColor" />
      <circle cx="9.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="9.5" cy="18.5" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="5.5" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="18.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function CodexQueueDeleteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d="M10.6299 1.33496C12.0335 1.33496 13.2695 2.25996 13.666 3.60645L13.8809 4.33496H17L17.1338 4.34863C17.4369 4.41057 17.665 4.67858 17.665 5C17.665 5.32142 17.4369 5.58943 17.1338 5.65137L17 5.66504H16.6543L15.8574 14.9912C15.7177 16.629 14.3478 17.8877 12.7041 17.8877H7.2959C5.75502 17.8877 4.45439 16.7815 4.18262 15.2939L4.14258 14.9912L3.34668 5.66504H3C2.63273 5.66504 2.33496 5.36727 2.33496 5C2.33496 4.63273 2.63273 4.33496 3 4.33496H6.11914L6.33398 3.60645L6.41797 3.3584C6.88565 2.14747 8.05427 1.33496 9.37012 1.33496H10.6299ZM5.46777 14.8779L5.49121 15.0537C5.64881 15.9161 6.40256 16.5576 7.2959 16.5576H12.7041C13.6571 16.5576 14.4512 15.8275 14.5322 14.8779L15.3193 5.66504H4.68164L5.46777 14.8779ZM7.66797 12.8271V8.66016C7.66797 8.29299 7.96588 7.99528 8.33301 7.99512C8.70028 7.99512 8.99805 8.29289 8.99805 8.66016V12.8271C8.99779 13.1942 8.70012 13.4912 8.33301 13.4912C7.96604 13.491 7.66823 13.1941 7.66797 12.8271ZM11.002 12.8271V8.66016C11.002 8.29289 11.2997 7.99512 11.667 7.99512C12.0341 7.9953 12.332 8.293 12.332 8.66016V12.8271C12.3318 13.1941 12.0339 13.491 11.667 13.4912C11.2999 13.4912 11.0022 13.1942 11.002 12.8271ZM9.37012 2.66504C8.60726 2.66504 7.92938 3.13589 7.6582 3.83789L7.60938 3.98145L7.50586 4.33496H12.4941L12.3906 3.98145C12.1607 3.20084 11.4437 2.66504 10.6299 2.66504H9.37012Z" />
    </svg>
  );
}

function CodexQueueMoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 21 21" aria-hidden="true">
      <path fill="currentColor" d="M15.6981 9.04712C16.5255 9.04712 17.1959 9.71781 17.1961 10.5452C17.1961 11.3727 16.5256 12.0442 15.6981 12.0442C14.8706 12.0442 14.2 11.3727 14.2 10.5452C14.2002 9.71781 14.8707 9.04712 15.6981 9.04712Z" />
      <path fill="currentColor" d="M4.69806 9.04712C5.52546 9.04712 6.19691 9.71781 6.19708 10.5452C6.19708 11.3727 5.52557 12.0442 4.69806 12.0442C3.8707 12.044 3.20001 11.3726 3.20001 10.5452C3.20019 9.71792 3.87081 9.04729 4.69806 9.04712Z" />
      <path fill="currentColor" d="M10.2003 9.04712C11.0276 9.0473 11.6982 9.71792 11.6984 10.5452C11.6984 11.3726 11.0277 12.044 10.2003 12.0442C9.37284 12.0442 8.70132 11.3727 8.70132 10.5452C8.7015 9.71781 9.37295 9.04712 10.2003 9.04712Z" />
    </svg>
  );
}

function CodexQueueEditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M9.41506 2.54535C10.5566 1.516 12.2884 1.57105 13.3399 2.64105C14.4597 3.72222 14.4959 5.5405 13.3467 6.68988L7.75588 12.2797C7.18583 12.8809 6.45561 13.2881 5.6924 13.4653H5.69045L2.59767 14.1762L2.5967 14.1743C2.4644 14.2058 2.19674 14.2328 1.98342 14.02C1.76937 13.8062 1.79632 13.5371 1.82814 13.4047L2.5381 10.3188C2.71723 9.5224 3.12639 8.8269 3.68752 8.26703L9.30568 2.64887L9.41506 2.54535ZM4.4297 9.01019C3.99658 9.44234 3.69398 9.96492 3.56252 10.5512L3.56154 10.5541L2.99513 13.0063L5.45607 12.4418C6.02206 12.3102 6.56957 12.0068 6.99513 11.558L7.00392 11.5483L11.5254 7.02582L8.96877 4.46918L4.4297 9.01019ZM12.5986 3.38422C11.9258 2.69135 10.7787 2.66298 10.0479 3.39203L10.0469 3.39105L9.71193 3.72602L12.2686 6.28266L12.6045 5.94769C13.3406 5.21146 13.3067 4.06829 12.6113 3.39691L12.5986 3.38422Z" />
    </svg>
  );
}

function CodexQueueModeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d="M2.66797 11V3.33301C2.66797 2.96574 2.96574 2.66797 3.33301 2.66797C3.70028 2.66797 3.99805 2.96574 3.99805 3.33301V11C3.99805 11.7109 3.99894 12.2044 4.03027 12.5879C4.06098 12.9634 4.11776 13.175 4.19824 13.333L4.26856 13.459C4.44487 13.7465 4.69781 13.9808 5 14.1348L5.12988 14.1904C5.27366 14.2419 5.46311 14.2797 5.74512 14.3027C6.12864 14.3341 6.62197 14.335 7.33301 14.335H15L15.0674 14.3418L14.1123 13.3867L14.0273 13.2822C13.8571 13.0242 13.8854 12.6735 14.1123 12.4463C14.3397 12.2189 14.6911 12.1906 14.9492 12.3613L15.0537 12.4463L17.1367 14.5293C17.3964 14.7889 17.3963 15.21 17.1367 15.4697L15.0537 17.5537C14.794 17.8134 14.372 17.8134 14.1123 17.5537C13.8526 17.294 13.8526 16.872 14.1123 16.6123L15.0664 15.6582L15 15.665H7.33301C6.64392 15.665 6.08696 15.6647 5.63672 15.6279C5.23614 15.5952 4.87531 15.5309 4.53906 15.3867L4.39649 15.3193C3.87528 15.0538 3.43887 14.6502 3.13477 14.1543L3.0127 13.9365C2.82084 13.5599 2.74153 13.1541 2.7041 12.6963C2.66732 12.2461 2.66797 11.6889 2.66797 11ZM15.665 15C15.665 15.0226 15.6594 15.0444 15.6572 15.0664L15.7256 14.999L15.6572 14.9316C15.6595 14.9541 15.665 14.9769 15.665 15ZM11.666 8.91797L11.8008 8.93164C12.1036 8.99381 12.3311 9.2618 12.3311 9.58301C12.3311 9.90422 12.1036 10.1722 11.8008 10.2344L11.666 10.248H7.5C7.13273 10.248 6.83496 9.95028 6.83496 9.58301C6.83496 9.21574 7.13273 8.91797 7.5 8.91797H11.666ZM14.166 4.33496L14.3008 4.34863C14.6036 4.41083 14.8311 4.67881 14.8311 5C14.8309 5.32109 14.6035 5.58924 14.3008 5.65137L14.166 5.66504H7.5C7.13284 5.66504 6.83514 5.36712 6.83496 5C6.83496 4.63273 7.13273 4.33496 7.5 4.33496H14.166Z" />
    </svg>
  );
}

function CodexQueueResumeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d="M6 14.7227V5.27693C6 4.29057 7.08894 3.6928 7.9211 4.22235L15.3428 8.94526C16.1147 9.43645 16.1147 10.5632 15.3428 11.0544L7.92109 15.7773C7.08894 16.3069 6 15.7091 6 14.7227Z" />
    </svg>
  );
}

function CodexQueuePauseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d="M7.35034 5.16846C8.03037 5.1686 8.58165 5.71988 8.58179 6.3999V13.6001C8.58179 14.2802 8.03045 14.8314 7.35034 14.8315H5.98315C5.30304 14.8314 4.75171 14.2802 4.75171 13.6001V6.3999C4.75185 5.71988 5.30313 5.1686 5.98315 5.16846H7.35034Z" />
      <path fill="currentColor" d="M14.0173 5.16846C14.6971 5.16886 15.2486 5.72004 15.2488 6.3999V13.6001C15.2488 14.2801 14.6972 14.8311 14.0173 14.8315H12.6501C11.97 14.8314 11.4187 14.2802 11.4187 13.6001V6.3999C11.4188 5.71988 11.9701 5.1686 12.6501 5.16846H14.0173Z" />
    </svg>
  );
}

export interface MessageQueueProps {
  /** Queue items */
  queue: QueuedMessage[];
  /** Remove item callback */
  onRemove: (id: string) => void;
  /** Reorder callback (orderedIds[0] executes first); drag is disabled when absent */
  onReorder?: (orderedIds: string[]) => void;
  onUpdate?: (id: string, content: string) => Promise<boolean>;
  onSteer?: (id: string) => void;
  onResume?: () => void;
  paused?: boolean;
  turnActive?: boolean;
  steeringIds?: ReadonlySet<string>;
  retryableSteeringIds?: ReadonlySet<string>;
  followUpMode?: CodexFollowUpMode;
  onToggleFollowUpMode?: (mode: CodexFollowUpMode) => void;
  error?: string | null;
}

function queuedImages(item: QueuedMessage): string[] {
  return (item.input ?? []).flatMap((block) => {
    if (block.type !== 'image') return [];
    const source = block.url ?? block.image_url ?? block.imageUrl ?? block.src;
    return typeof source === 'string' && source ? [source] : [];
  });
}

/**
 * MessageQueue - Displays queued messages above input box in execution order.
 * The next message to execute (queue[0]) is the first row.
 * Drag is initiated only from the gripper handle (pointer-based), so text in the
 * row stays selectable and other controls are unaffected.
 */
export function MessageQueue({
  queue, onRemove, onReorder, onUpdate, onSteer, onResume,
  paused = false, turnActive = false, steeringIds = new Set(), retryableSteeringIds = new Set(),
  followUpMode = 'queue', onToggleFollowUpMode, error,
}: MessageQueueProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  /**
   * Sort callback fired when a drag completes.
   * useDragSort emits orderedIds in real queue order (not display order), so
   * they can be handed straight to the parent reorder.
   */
  const handleSort = useCallback((orderedIds: string[]) => {
    onReorder?.(orderedIds);
  }, [onReorder]);
  /**
   * Keyboard reorder follows the list's execution order: ArrowUp moves the
   * message earlier in the queue and ArrowDown moves it later.
   */
  const handleReorderKeyDown = useCallback((e: KeyboardEvent, id: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const index = queue.findIndex(item => item.id === id);
    const swapIndex = e.key === 'ArrowUp' ? index - 1 : index + 1;
    if (index === -1 || swapIndex < 0 || swapIndex >= queue.length) return;
    const next = [...queue];
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    onReorder?.(next.map(item => item.id));
  }, [queue, onReorder]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!previewId && !menuId) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPreviewId(null);
      setMenuId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewId, menuId]);

  useEffect(() => {
    if (!menuId) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (moreMenuRef.current?.contains(target) || target.closest('.message-queue-more-button')) return;
      setMenuId(null);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [menuId]);

  useEffect(() => {
    if (previewId && !queue.some((item) => item.id === previewId)) setPreviewId(null);
    if (menuId && !queue.some((item) => item.id === menuId)) setMenuId(null);
  }, [menuId, previewId, queue]);

  // Row middle drops 'on' the row (legacy dashed highlight); row edges, gaps
  // and container padding resolve to insert slots. Rows follow queue order.
  const resolveDropTarget = useMemo(
    () => createEdgeInsertResolver(() => containerRef.current),
    [],
  );

  // Only the pointer-based path is used; `queue` (parent state) is the single
  // source of truth for rendering because reorder applies synchronously.
  const { draggedId, dragOverId, dragOverPlacement, handlePointerDown } = useDragSort({
    items: queue,
    onSort: handleSort,
    resolveDropTarget,
    activationDistance: 6,
  });

  // Auto-scroll the viewport-sized list while dragging
  // near its edges so rows outside the viewport can be reached.
  useDragAutoScroll(containerRef, draggedId !== null);

  if (queue.length === 0 && !error) {
    return null;
  }

  const canReorder = typeof onReorder === 'function' && queue.length > 1;

  return (
    <div className="message-queue" ref={containerRef}>
      {error && <div className="codex-queue-error" role="alert">{t(error, { defaultValue: error })}</div>}
      {paused && queue.length > 0 && onResume && (
        <div className="codex-queue-paused">
          <span className="codex-queue-paused-message">
            <CodexQueuePauseIcon />
            <span>{t('chat.codexQueue.paused')}</span>
          </span>
          <button type="button" onClick={onResume}><CodexQueueResumeIcon />{t('chat.codexQueue.resume')}</button>
        </div>
      )}
      {queue.map((item) => {
        // Placement and display both follow queue order.
        const isDragOver = dragOverId === item.id;
        const itemClassName = [
          'message-queue-item',
          draggedId === item.id && 'dragging',
          isDragOver && dragOverPlacement === 'on' && 'drag-over',
          isDragOver && dragOverPlacement === 'after' && 'insert-above',
          isDragOver && dragOverPlacement === 'before' && 'insert-below',
        ].filter(Boolean).join(' ');
        const images = queuedImages(item);
        const sourceId = item.sourceId ?? item.id;
        const isSteering = steeringIds.has(sourceId);
        const isRetryableSteer = retryableSteeringIds.has(sourceId);
        return (
          <div key={item.id} className={itemClassName} data-drag-sort-id={item.id}>
            {canReorder && (
              <div
                className="message-queue-drag-handle"
                data-drag-sort-handle
                role="button"
                tabIndex={0}
                aria-label={t('chat.codexQueue.reorder')}
                title="Drag to reorder, or focus and use arrow keys"
                onKeyDown={(e) => handleReorderKeyDown(e, item.id)}
                onPointerDown={(e) => handlePointerDown(e, item.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
              >
              <CodexQueueDragIcon />
              </div>
            )}
            {isSteering
              ? <LoaderCircle className="message-queue-leading-icon codex-queue-spinner" aria-hidden="true" />
              : <CodexFollowUpIcon />}
            {editingId === item.id ? (
              <div className="message-queue-edit">
                <textarea
                  aria-label={t('chat.codexQueue.editMessage')}
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                />
                <button type="button" disabled={saving} onClick={async () => {
                  if (!onUpdate) return;
                  setSaving(true);
                  const saved = await onUpdate(sourceId, editValue);
                  setSaving(false);
                  if (saved) setEditingId(null);
                }}>{t('chat.codexQueue.save')}</button>
                <button type="button" disabled={saving} onClick={() => setEditingId(null)}>
                  {t('chat.codexQueue.cancel')}
                </button>
              </div>
            ) : (
              <Popover.Root
                open={previewId === item.id}
                onOpenChange={(open) => setPreviewId(open ? item.id : null)}
              >
                <Popover.Trigger
                  render={
                    <button
                      type="button"
                      className="message-queue-content"
                      title={t('chat.codexQueue.preview')}
                      aria-label={t('chat.codexQueue.preview')}
                      onClick={(event) => {
                        if (previewId === item.id) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                    />
                  }
                >
                  {images[0] && (
                    <img
                      className="message-queue-image-preview"
                      src={images[0]}
                      alt={t('chat.userUploadedImage')}
                      draggable={false}
                    />
                  )}
                  <span className="message-queue-content-text">
                    {item.content || t('chat.codexQueue.attachment')}
                  </span>
                </Popover.Trigger>
                <Popover.Portal container={document.body}>
                  <Popover.Positioner
                    side="top"
                    align="start"
                    sideOffset={6}
                    className="message-queue-preview-positioner"
                  >
                    <Popover.Popup
                      className="message-queue-preview"
                      role="dialog"
                      aria-label={t('chat.codexQueue.previewTitle')}
                    >
                      <pre className="message-queue-preview-content" tabIndex={0}>
                        {item.content || t('chat.codexQueue.attachment')}
                      </pre>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
            {onSteer && item.queuedSubmissionId && !isSteering && (
              <button
                type="button"
                className="message-queue-steer-button"
                disabled={!turnActive || isSteering}
                aria-label={isRetryableSteer ? t('chat.codexQueue.retry') : t('chat.codexQueue.steer')}
                title={isRetryableSteer ? t('chat.codexQueue.retry') : t('chat.codexQueue.steer')}
                onClick={() => onSteer(sourceId)}
              >
                <CodexSteerActionIcon />
                <span>{isRetryableSteer
                  ? t('chat.codexQueue.retry')
                  : t('chat.codexQueue.steer')}</span>
              </button>
            )}
            <button
              type="button"
              className="message-queue-remove"
              onClick={() => onRemove(item.id)}
              aria-label={t('chat.codexQueue.remove')}
              title={t('chat.codexQueue.remove')}
            >
              <CodexQueueDeleteIcon />
            </button>
            {(onUpdate || onToggleFollowUpMode) && (
              <div className="message-queue-more-wrap">
                <button
                  type="button"
                  className="message-queue-more-button"
                  aria-label={t('chat.codexQueue.moreOptions')}
                  aria-expanded={menuId === item.id}
                  onClick={() => setMenuId((current) => current === item.id ? null : item.id)}
                ><CodexQueueMoreIcon /></button>
                {menuId === item.id && (
                  <div className="message-queue-more-menu" role="menu" ref={moreMenuRef}>
                    {onUpdate && item.queuedSubmissionId && (
                      <button type="button" role="menuitem" onClick={() => {
                        setEditingId(item.id);
                        setEditValue(item.content);
                        setMenuId(null);
                      }}><CodexQueueEditIcon />{t('chat.codexQueue.edit')}</button>
                    )}
                    {onToggleFollowUpMode && (
                      <button type="button" role="menuitem" onClick={() => {
                        onToggleFollowUpMode(followUpMode === 'queue' ? 'steer' : 'queue');
                        setMenuId(null);
                      }}><CodexQueueModeIcon />{followUpMode === 'queue'
                        ? t('chat.codexQueue.useSteer')
                        : t('chat.codexQueue.useQueue')}</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default MessageQueue;
