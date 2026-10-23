import { describe, expect, it } from 'vitest';
import { shouldRevealThinking } from './thinkingVisibility';

describe('shouldRevealThinking', () => {
  it('reveals a native public summary and hides native text without a summary', () => {
    expect(shouldRevealThinking({ type: 'thinking', native: true, thinking: 'Public summary', text: 'Public summary' })).toBe(true);
    expect(shouldRevealThinking({ type: 'thinking', native: true, text: 'private reasoning' })).toBe(false);
  });
});
