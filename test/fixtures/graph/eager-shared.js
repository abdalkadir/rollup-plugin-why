// Reachable by a SHORT dynamic chain (main → ⇢ eager-shared) and a LONGER
// static one (main → eagerStatic → eager-shared). The dynamic chain wins
// (shorter), so `dynamic` is true — yet the static path keeps the module in the
// eager entry chunk, so `initialChunk` is also true.
export const ed = 'ed';
