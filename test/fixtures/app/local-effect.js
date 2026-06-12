// First-party module imported only for its top-level side effect.
globalThis.__LOCAL_EFFECT__ = true;

export function unusedLocal() {
  return 'unused';
}
