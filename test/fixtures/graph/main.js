// A deliberately tangled graph used to exercise shortestChain's BFS:
//
//  - diamond-target.js is reachable by a SHORT path (main → near) and a
//    LONG path (main → far1 → far2). BFS must report the short one.
//  - dyn-target.js is reachable by a LONG static path (main → static1 →
//    static2) and a SHORT dynamic one (main → ⇢ dz). The short dynamic path
//    must win and mark the chain dynamic.
//  - cycle-a.js ↔ cycle-b.js import each other; the BFS must not loop.
//  - tie-target.js is reachable by a static path (main → tieA) and a dynamic
//    one (main → ⇢ tieDyn) of EQUAL length. The static chain must win on the
//    tie, deterministically.
//  - eager-shared.js is reachable by a SHORT dynamic chain (main → ⇢
//    eager-shared) and a LONGER static one (main → eagerStatic → eager-shared).
//    The dynamic chain wins, yet the module still ships in the initial chunk.
import { near } from './near.js';
import { far } from './far1.js';
import { sFar } from './static1.js';
import { sink } from './cycle-a.js';
import { a } from './tieA.js';
import { es } from './eagerStatic.js';

import('./dyn/dz.js').then((m) => m.run());
import('./tieDyn.js').then((m) => m.run());
import('./eager-shared.js').then((m) => m);

console.log(near, far, sFar, sink, a, es);
