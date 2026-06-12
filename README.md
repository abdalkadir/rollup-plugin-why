# rollup-plugin-why

Explains **why** a module ended up in your Rollup or Vite bundle.

Bundle analyzers like `rollup-plugin-visualizer` tell you *what* is in your bundle and how big it is. This plugin answers the question you actually have when tree-shaking lets you down:

- **"Why is this package in my bundle at all?"** → prints the shortest import chain from one of your entry points to the module, including chains that cross dynamic imports.
- **"Why didn't tree-shaking remove this?"** → finds every module whose exports were *all* tree-shaken away but whose code was still kept — i.e. code retained purely for its side effects — and checks how the owning package declares its `sideEffects` field so you know whether the fix is yours or the package maintainer's.

It uses Rollup's own module graph and per-chunk rendering data (`renderedExports` / `removedExports`), so the answers reflect what Rollup actually decided — no heuristics, no source parsing.

## Install

```sh
npm install --save-dev rollup-plugin-why
```

## Usage

### Rollup

```js
// rollup.config.mjs
import why from 'rollup-plugin-why';

export default {
  input: 'src/index.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [
    why({ filter: 'lodash-es' }),
  ],
};
```

### Vite

```js
// vite.config.js
import { defineConfig } from 'vite';
import why from 'rollup-plugin-why';

export default defineConfig({
  plugins: [why({ filter: 'moment' })],
});
```

The plugin only runs during `vite build` (it declares `apply: 'build'`).

## Example output

```
rollup-plugin-why (dist)
────────────────────────────────────────

Why are these modules in the bundle?

  node_modules/lodash-es/cloneDeep.js  4.1 kB  (exports used: default)
    src/index.js → src/utils/clone.js → node_modules/lodash-es/cloneDeep.js

Modules kept only for side effects (no exports used, code still in the bundle)

  node_modules/some-polyfill/index.js  12.3 kB
    src/index.js → node_modules/legacy-widget/index.js → node_modules/some-polyfill/index.js
    package some-polyfill does not declare "sideEffects" — if it is side-effect
    free, ask the maintainer to add "sideEffects": false, or override it via
    your bundler config
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `filter` | `string \| RegExp \| Array \| (id) => boolean` | — | Which modules to explain with an import chain. A string matches as a substring of the module id, so a package name like `'lodash-es'` works. When omitted, only the side-effect report runs. |
| `sideEffects` | `boolean` | `true` | Report modules retained purely by side effects. |
| `limit` | `number` | `20` | Maximum modules printed per section. The JSON report is never truncated. |
| `json` | `string` | — | Also emit the full report as a JSON asset with this file name into the output directory, e.g. `'why-report.json'`. |
| `print` | `boolean` | `true` | Print the report to the terminal. |
| `onReport` | `(report: WhyReport) => void` | — | Receive the report object programmatically (useful in CI: fail the build if an unexpected package sneaks in). |

## The JSON report

```ts
interface WhyReport {
  output: string;
  explained: Array<{
    id: string;
    package: string | null;
    renderedLength: number;       // bytes of this module kept in the output (pre-minification)
    renderedExports: string[];    // exports that survived tree-shaking
    removedExports: string[];     // exports tree-shaking removed
    chunks: string[];
    chain: string[] | null;       // entry-first import chain, null if only reachable non-statically
    dynamic: boolean;             // chain crosses a dynamic import
  }>;
  sideEffectRetained: Array<{
    id: string;
    package: string | null;
    renderedLength: number;
    removedExports: string[];
    sideEffectsField: 'false' | 'true' | 'list' | 'none' | null;
    chain: string[] | null;
    dynamic: boolean;
  }>;
  packages: Record<string, { renderedLength: number; moduleCount: number }>;
}
```

`sideEffectsField` tells you how the owning package's `package.json` declares side effects: `'none'` means the field is absent (the most common cause of bloat — Rollup must assume every module is side-effectful), `'false'` means the package claims to be side-effect free yet Rollup still found side effects in this module, `'list'`/`'true'` mean the retention is declared and probably intentional, and `null` means the module is first-party code.

## CI usage

```js
why({
  print: false,
  onReport(report) {
    const banned = report.explained.find((m) => m.package === 'moment');
    if (banned) throw new Error(`moment is back in the bundle via: ${banned.chain?.join(' → ')}`);
  },
  filter: 'moment',
})
```

## AI / agentic development checks

When code is written or refactored by an AI agent, bundle composition is exactly the kind of thing that regresses silently: the agent reaches for a convenient dependency, swaps a deep import for a barrel import, or adds a top-level side effect — and the bundle quietly grows or stops tree-shaking. Because this plugin reports what Rollup *actually decided* (no heuristics, no source parsing), its output is deterministic and machine-readable, which makes it a good fit for automated loops.

### As a performance gate on agent-generated changes

Run the build in CI (or a pre-merge hook) and fail when a change crosses a size budget, pulls in a banned package, or breaks tree-shaking. `onReport` hands you the full report — throw to fail the build:

```js
why({
  print: false,
  onReport(report) {
    // Per-package size budgets.
    const BUDGETS = { 'lodash-es': 20_000, 'date-fns': 15_000 };
    for (const [pkg, max] of Object.entries(BUDGETS)) {
      const size = report.packages[pkg]?.renderedLength ?? 0;
      if (size > max) throw new Error(`${pkg} is ${size} B, over its ${max} B budget`);
    }
    // Catch tree-shaking regressions: modules kept only for their side effects.
    if (report.sideEffectRetained.length > 0) {
      const ids = report.sideEffectRetained.map((m) => m.id).join(', ');
      throw new Error(`unexpected side-effect-retained modules: ${ids}`);
    }
  },
})
```

### As a feedback signal inside an agent loop

Emit the JSON report and feed it back to the agent so it can see the consequence of its edit and self-correct:

```js
why({ print: false, json: 'why-report.json' })
```

```
build the project → read dist/why-report.json → if a banned package or an
unexpected import chain appears, revise the code and rebuild
```

The report is small, structured JSON (`explained`, `sideEffectRetained`, `packages`), so it drops straight into a tool result or prompt with no post-processing. Crucially, each entry's `chain` field gives the agent the exact import path to fix — e.g. `src/index.js → src/date.js → moment` — instead of a vague "the bundle got bigger" signal it can't act on. Pair it with `filter` to keep the agent focused on the packages you care about, and the output stays stable across runs because it mirrors Rollup's own decisions rather than re-deriving them.

## Notes & limitations

- `renderedLength` is measured before minification, the same number Rollup reports per chunk module.
- Virtual modules (ids starting with `\0`, e.g. CommonJS interop helpers) are excluded from the side-effect report to keep it actionable, but can still appear inside import chains.
- With multiple outputs, the report is produced once per output.
- Works with Rollup 3 and 4, and with Vite (which drives Rollup hooks during `vite build`).

## License

MIT
