// Uses two exports of a many-export package; the rest are tree-shaken, so the
// report should collapse the export list to `2 of 26 exports used`.
import { a, b } from 'minified-lib';

console.log(a, b);
