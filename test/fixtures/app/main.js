import { used } from 'fake-lib';
import 'side-pkg';

import('./lazy.js').then((m) => m.run());

console.log(used());
