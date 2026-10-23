import { fireEvent, render, screen } from '@testing-library/react';
import { CodexSubagentsPanel } from './CodexSubagentsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('CodexSubagentsPanel', () => {
  it('renders the standalone subagent view and closes from its header', () => {
    const onClose = vi.fn();
    render(<CodexSubagentsPanel subagents={[]} onClose={onClose} />);

    expect(screen.getByRole('complementary', { name: 'chat.codexSubagents.title' })).toBeTruthy();
    expect(screen.getByText('statusPanel.noSubagents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
