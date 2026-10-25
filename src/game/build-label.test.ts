import { describe, expect, it } from 'vitest';
import { formatBuildLabel } from './build-label';

describe('formatBuildLabel', () => {
  it('shows the release tag', () => {
    expect(formatBuildLabel('v0.1.0')).toBe('v0.1.0');
  });

  it('falls back to dev when no tag is set', () => {
    expect(formatBuildLabel('')).toBe('dev');
    expect(formatBuildLabel('  ')).toBe('dev');
  });
});
