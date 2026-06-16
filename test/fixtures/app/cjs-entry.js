// Imports a CommonJS-wrapped module purely for its side effect. The test
// plugin resolves `cjs-poly` to a `\0…?commonjs-module` virtual id.
import 'cjs-poly';

console.log('cjs entry');
