import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WaitingIndicator } from './WaitingIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { time?: string }) =>
    options?.time ? `${key}:${options.time}` : key }),
}));

describe('WaitingIndicator', () => {
  it('can omit elapsed time until the native turn start is known', () => {
    render(<WaitingIndicator label="Thinking" showElapsed={false} />);
    expect(document.querySelector('.waiting-text')?.textContent).toMatch(/^Thinking/);
    expect(document.querySelector('.waiting-seconds')).toBeNull();
  });

  it('keeps the normal elapsed timer for other loading states', () => {
    render(<WaitingIndicator label="Generating" startTime={Date.now() - 5_000} />);
    expect(document.querySelector('.waiting-seconds')?.textContent).toContain('chat.elapsedTime');
  });
});
