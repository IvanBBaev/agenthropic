import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE_NAME } from '../src/index';

describe('@agenthropic/core placeholder', () => {
  it('exports the package name', () => {
    expect(CORE_PACKAGE_NAME).toBe('@agenthropic/core');
  });
});
