import type { TFunction } from 'i18next';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatHeader } from './ChatHeader';

const createProps = (overrides: Partial<React.ComponentProps<typeof ChatHeader>> = {}) => ({
  currentView: 'chat' as const,
  sessionTitle: 'Conversation',
  t: ((key: string) => key) as unknown as TFunction,
  onBack: vi.fn(),
  onNewSession: vi.fn(),
  onNewTab: vi.fn(),
  onHistory: vi.fn(),
  onSettings: vi.fn(),
  ...overrides,
});

describe('ChatHeader Codex subagent action', () => {
  it('opens the subagent panel for Codex', () => {
    const onOpenSubagents = vi.fn();
    render(<ChatHeader {...createProps({ currentProvider: 'codex', onOpenSubagents })} />);

    fireEvent.click(screen.getByRole('button', { name: 'chat.codexSubagents.title' }));

    expect(onOpenSubagents).toHaveBeenCalledTimes(1);
  });

  it('does not show the Codex subagent action for other providers', () => {
    render(<ChatHeader {...createProps({ currentProvider: 'claude', onOpenSubagents: vi.fn() })} />);

    expect(screen.queryByRole('button', { name: 'chat.codexSubagents.title' })).toBeNull();
  });
});
