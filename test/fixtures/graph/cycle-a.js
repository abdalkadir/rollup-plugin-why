// cycle-a ↔ cycle-b form an import cycle; BFS must terminate via `visited`.
import { pong } from './cycle-b.js';

export const sink = `a:${pong}`;
export const fromA = 'fromA';
