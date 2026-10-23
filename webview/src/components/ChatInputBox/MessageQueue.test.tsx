import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueue } from './MessageQueue';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('MessageQueue', () => {
  it('renders in execution order without numbered badges and reorders by keyboard', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <MessageQueue
        queue={[
          { id: 'next', content: 'Next message', queuedAt: 1 },
          { id: 'later', content: 'Later message', queuedAt: 2 },
        ]}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    );

    const rows = container.querySelectorAll('.message-queue-item');
    expect(rows[0]?.textContent).toContain('Next message');
    expect(rows[1]?.textContent).toContain('Later message');
    expect(container.querySelector('.message-queue-number')).toBeNull();

    const reorderHandles = screen.getAllByLabelText('chat.codexQueue.reorder');
    fireEvent.keyDown(reorderHandles[1]!, { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['later', 'next']);
  });

  it('opens a full queued message preview and closes it with Escape', () => {
    const text = 'First line\n\nA complete queued message';
    render(
      <MessageQueue queue={[{
        id: 'preview', content: text, queuedAt: 1,
        input: [{ type: 'image', url: 'data:image/png;base64,fixture' }],
      }]} onRemove={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.preview' }));
    expect(screen.getByRole('dialog', { name: 'chat.codexQueue.previewTitle' }).querySelector('pre')?.textContent).toBe(text);
    expect(screen.getByRole('img', { name: 'chat.userUploadedImage' }).getAttribute('src'))
      .toBe('data:image/png;base64,fixture');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps editing and follow-up behavior under the more menu', () => {
    const onUpdate = vi.fn();
    const onToggleFollowUpMode = vi.fn();
    render(
      <MessageQueue
        queue={[{ id: 'queued', queuedSubmissionId: 'queued', content: 'Edit me', queuedAt: 1 }]}
        onRemove={vi.fn()}
        onUpdate={onUpdate}
        onToggleFollowUpMode={onToggleFollowUpMode}
        followUpMode="queue"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.moreOptions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.codexQueue.useSteer' }));
    expect(onToggleFollowUpMode).toHaveBeenCalledWith('steer');

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.moreOptions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.codexQueue.edit' }));
    expect(screen.getByRole('textbox', { name: 'chat.codexQueue.editMessage' })).toBeTruthy();
  });

  it('labels an unacknowledged failed steer as Retry', () => {
    const onSteer = vi.fn();
    render(
      <MessageQueue
        queue={[{ id: 'native:queued', source: 'native', sourceId: 'queued', queuedSubmissionId: 'queued', content: 'Retry me', queuedAt: 1 }]}
        onRemove={vi.fn()}
        onSteer={onSteer}
        turnActive
        retryableSteeringIds={new Set(['queued'])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.retry' }));
    expect(onSteer).toHaveBeenCalledWith('queued');
  });

  it('uses a source id for native row actions and keeps the display id for removal', async () => {
    const onRemove = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn();
    render(
      <MessageQueue
        queue={[{
          id: 'native:queued', source: 'native', sourceId: 'queued',
          queuedSubmissionId: 'queued', content: 'Edit me', queuedAt: 1,
        }]}
        onRemove={onRemove}
        onUpdate={onUpdate}
        onSteer={onSteer}
        turnActive
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.moreOptions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'chat.codexQueue.edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'chat.codexQueue.editMessage' }), { target: { value: 'Updated' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.save' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith('queued', 'Updated'));

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexQueue.remove' }));
    expect(onRemove).toHaveBeenCalledWith('native:queued');
  });
});
