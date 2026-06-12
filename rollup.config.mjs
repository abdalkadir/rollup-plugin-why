import typescript from '@rollup/plugin-typescript';
import { dts } from 'rollup-plugin-dts';

const external = ['picocolors', /^node:/];

export default [
  {
    input: 'src/index.ts',
    external,
    plugins: [typescript()],
    output: [
      { file: 'dist/index.js', format: 'es' },
      { file: 'dist/index.cjs', format: 'cjs', exports: 'named' },
    ],
  },
  {
    input: 'src/index.ts',
    external,
    plugins: [dts()],
    output: { file: 'dist/index.d.ts', format: 'es' },
  },
];
