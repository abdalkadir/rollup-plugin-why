// Static importer of eager-shared, statically imported by main — this is
// what pins eager-shared into the initial chunk.
import { ed } from './eager-shared.js';

export const es = `es:${ed}`;
