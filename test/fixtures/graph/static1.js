// Long static path to dyn-target: main → static1 → static2 → dyn-target.
import { s2 } from './static2.js';

export const sFar = `s1:${s2}`;
