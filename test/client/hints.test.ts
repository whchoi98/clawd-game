/**
 * Death-cause hints (P5-5): the pure cause → re-hint mapping the shell's
 * `rehint` consumes, with the bubble foe's family added. Everything here is
 * plain string data — no DOM, no bindings.
 */
import { describe, expect, it } from 'vitest';
import {
  DEATH_LINE_BUBBLE, REHINT_BUBBLE, REHINT_BY_KIND, REHINT_HAZARD, REHINT_PIT, deathHint, hasRawKeyName, rehintKind, renderHint,
} from '../../src/client/ui/hints.js';

describe('death-cause hints (P5-5 bubble)', () => {
  it('cause "bubble" gives the bubble hint: land on it from above, side contact kills', () => {
    expect(rehintKind('bubble')).toBe('bubble');
    expect(deathHint('bubble')).toBe(REHINT_BUBBLE);
    expect(REHINT_BUBBLE).toBe('거품은 위에서 밟아라 · 옆에서 닿으면 죽는다');
    expect(REHINT_BUBBLE).toContain('위에서 밟');
    expect(REHINT_BUBBLE).toContain('옆에서 닿으면');
    expect(DEATH_LINE_BUBBLE).toMatch(/거품/);
  });

  it('the existing families are unchanged and causes no hint helps with give null', () => {
    expect(rehintKind('pit')).toBe('pit');
    expect(deathHint('pit')).toBe(REHINT_PIT);
    expect(rehintKind('spike')).toBe('hazard');
    expect(rehintKind('saw')).toBe('hazard');
    expect(deathHint('spike')).toBe(REHINT_HAZARD);
    expect(deathHint('saw')).toBe(REHINT_HAZARD);
    for (const cause of ['retry', 'tide', 'bolt', 'foe', 'switch', 'hit', '', 'BUBBLE']) {
      expect(rehintKind(cause), cause).toBeNull();
      expect(deathHint(cause), cause).toBeNull();
    }
    expect(Object.keys(REHINT_BY_KIND).sort()).toEqual(['bubble', 'hazard', 'pit']);
    expect(REHINT_BY_KIND.bubble).toBe(REHINT_BUBBLE);
  });

  it('the bubble hint is device-neutral: no raw key names, no tokens, identical on every device', () => {
    expect(hasRawKeyName(REHINT_BUBBLE)).toBe(false);
    expect(REHINT_BUBBLE).not.toMatch(/\{[a-z]+\}/);
    for (const device of ['keyboard', 'touch', 'gamepad'] as const) expect(renderHint(REHINT_BUBBLE, device)).toBe(REHINT_BUBBLE);
  });
});
