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

filter matched: lodash-es

Largest packages

  lodash-es  18.4 kB  44.2%  6 modules
  some-polyfill  12.3 kB  29.6%  1 module

Total analyzed: 41.6 kB (30.7 kB in 7 node_modules modules across 2 packages)

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

The **Largest packages** table and grand total print whenever the build has dependencies — they answer "where are my bytes?" without a custom script.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `filter` | `string \| RegExp \| { package } \| Array \| (id) => boolean` | — | Which modules to explain with an import chain. A string matches as a substring of the module id, so a package name like `'lodash-es'` works; `{ package: 'lodash-es' }` matches the *exact* package name. When omitted, only the side-effect report runs. When a filter is set, the terminal echoes which packages it matched. |
| `sideEffects` | `boolean` | `true` | Report modules retained purely by side effects. |
| `limit` | `number` | `20` | Maximum modules printed per section. The JSON report is never truncated. |
| `json` | `string` | — | Also emit the full report as a JSON asset with this file name into the output directory, e.g. `'why-report.json'`. |
| `print` | `boolean` | `true` | Print the report to the terminal. |
| `onReport` | `(report: WhyReport) => void` | — | Receive the report object programmatically (useful in CI: fail the build if an unexpected package sneaks in). |
| `baseline` | `string` | — | Path to a previous JSON report. The report gains a `diff` field and the terminal shows a "Changes since baseline" section (new/removed packages, per-package size deltas, newly side-effect-retained modules, chains that flipped static↔dynamic). |
| `gzip` | `boolean` | `false` | Add a `gzipLength` estimate to packages and modules by gzipping the rendered (pre-minification) code. A rough, clearly-labeled signal — see Notes. |
| `includeCommonJS` | `boolean` | `false` | Include CommonJS-wrapped modules (virtual `\0…?commonjs-*` ids) in the side-effect report, mapped back to their real files. When off, they're excluded but their count is footnoted. |
| `compactPaths` | `boolean` | `false` | Render `node_modules` paths package-relative in the terminal, e.g. `date-fns › _lib/format/formatters`. |
| `verbose` | `boolean` | `false` | Always enumerate every export name, even for modules with many or minified-looking exports (otherwise collapsed to a count like `2 of 26 exports used`). |

## The JSON report

```ts
interface WhyReport {
  output: string;
  totalRenderedLength: number;    // sum of every rendered module — the "% of analyzed" base
  explained: Array<{
    id: string;
    package: string | null;
    renderedLength: number;       // bytes of this module kept in the output (pre-minification)
    gzipLength?: number;          // estimated gzip size (only when `gzip: true`)
    renderedExports: string[];    // exports that survived tree-shaking
    removedExports: string[];     // exports tree-shaking removed
    chunks: string[];
    initialChunk: boolean;        // ships in a chunk loaded on first page load
    chain: string[] | null;       // entry-first import chain, null if only reachable non-statically
    dynamic: boolean;             // chain crosses a dynamic import
  }>;
  sideEffectRetained: Array<{
    id: string;
    package: string | null;
    renderedLength: number;
    gzipLength?: number;
    removedExports: string[];
    sideEffectsField: 'false' | 'true' | 'list' | 'none' | null;
    initialChunk: boolean;
    chain: string[] | null;
    dynamic: boolean;
  }>;
  packages: Record<string, { renderedLength: number; moduleCount: number; gzipLength?: number }>;
  diff?: {                        // present only when `baseline` is set
    baseline: string;
    newPackages: string[];
    removedPackages: string[];
    packageDeltas: Array<{ package: string; before: number; after: number; delta: number }>;
    newSideEffectRetained: string[];
    chainFlips: Array<{ id: string; from: 'static' | 'dynamic'; to: 'static' | 'dynamic' }>;
  };
}
```

`dynamic` answers "is the *shortest* import chain via a dynamic import?" — it does **not** mean the module is deferred. A module can sit behind a dynamic import yet still ship eagerly because it's also reached statically. Use **`initialChunk`** to answer "does this ship on first load?" directly; it's derived from chunk placement, independent of the chain flag.

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

### As a regression guard against a committed baseline

Commit a `why-report.json` and point `baseline` at it. The report's `diff` field (and a "Changes since baseline" terminal section) tells you exactly *what changed* — new packages, per-package size deltas, newly side-effect-retained modules, and chains that flipped static↔dynamic — instead of leaving you to diff two reports by eye:

```js
why({
  json: 'why-report.json',          // refresh the baseline on the main branch
  baseline: 'why-report.json',      // and diff every build against it
  onReport(report) {
    const grew = report.diff?.packageDeltas.filter((d) => d.delta > 10_000) ?? [];
    if (grew.length) {
      throw new Error(`packages grew >10 kB: ${grew.map((d) => `${d.package} +${d.delta}B`).join(', ')}`);
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

- `renderedLength` is measured before minification, the same number Rollup reports per chunk module. `gzipLength` (when `gzip: true`) gzips that same pre-minification code — a rough transfer-size signal, not a true min+gzip number; gzip's fixed overhead can make tiny modules report *larger* than their raw size.
- **Chain selection is deterministic.** Among equal-length shortest chains the plugin prefers a fully-static chain, then the lexicographically smallest one, so the reported `chain` is stable build-to-build (important for diff-based CI gates).
- `dynamic` reflects the shortest chain crossing a dynamic import; `initialChunk` reflects actual chunk placement. A module can be `dynamic: true` and `initialChunk: true` at once — the terminal annotates this as *"(via dynamic import; also ships in initial chunk)"*.
- CommonJS-wrapped modules (virtual `\0…?commonjs-*` ids) are excluded from the side-effect report by default to keep it actionable, but their count is footnoted; pass `includeCommonJS: true` to list them mapped back to their real files. Other virtual modules can still appear inside import chains.
- With multiple outputs, the report is produced once per output.
- Works with Rollup 3 and 4, and with Vite (which drives Rollup hooks during `vite build`).

## License

MIT
