/** Preference schema kept independent of save/unlocks so save repair can import it safely. */
export type GoalId = 'nodeath' | 'par' | 'shards' | 'relic';
export type GoalPreference = GoalId | 'auto' | 'free';

const PREFERENCES: ReadonlySet<string> = new Set(['nodeath', 'par', 'shards', 'relic', 'auto', 'free']);
const RESERVED_IDS: ReadonlySet<string> = new Set([
  'prototype', ...Object.getOwnPropertyNames(Object.prototype).map((key) => key.toLowerCase()),
]);
const MAX_TARGETS = 128;

function isPreference(value: unknown): value is GoalPreference {
  return typeof value === 'string' && PREFERENCES.has(value);
}

/** Copy at most 128 valid own entries, dropping malformed ids and values without coercion. */
export function normalizeGoalTargets(raw: unknown): Record<string, GoalPreference> {
  const out: Record<string, GoalPreference> = Object.create(null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;

  let accepted = 0;
  for (const id of Object.keys(raw)) {
    if (!id.length || id.length > 48 || /[^a-z0-9_-]/.test(id) || RESERVED_IDS.has(id)) continue;
    // Settings are data: inspecting the descriptor avoids running an imported accessor.
    const value: unknown = Object.getOwnPropertyDescriptor(raw, id)?.value;
    if (!isPreference(value)) continue;
    out[id] = value;
    if (++accepted === MAX_TARGETS) break;
  }
  return out;
}
