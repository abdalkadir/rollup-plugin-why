import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup, type Plugin, type OutputOptions } from 'rollup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import why, { type WhyOptions, type WhyReport } from '../src/index';

const fixture = (p: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', p);

interface BuildOpts {
  input?: string;
  options?: WhyOptions;
  output?: OutputOptions | OutputOptions[];
  plugins?: Plugin[];
}

/**
 * Build a fixture app and capture every report the plugin emits. `onReport`
 * is wired internally so callers always get the report objects back, while a
 * caller-supplied `onReport` is still invoked.
 */
async function build(opts: BuildOpts = {}) {
  const {
    input = 'app/main.js',
    options = {},
    output = { dir: 'out', format: 'es' },
    plugins = [],
  } = opts;

  const reports: WhyReport[] = [];
  const userOnReport = options.onReport;

  const bundle = await rollup({
    input: fixture(input),
    // The graph fixture contains an intentional import cycle; don't let the
    // expected warning clutter test output.
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      warn(warning);
    },
    plugins: [
      nodeResolve(),
      ...plugins,
      why({
        print: false,
        ...options,
        onReport: (r) => {
          reports.push(r);
          userOnReport?.(r);
        },
      }),
    ],
  });

  const outputs = Array.isArray(output) ? output : [output];
  const generated = [];
  for (const o of outputs) {
    const { output: out } = await bundle.generate(o);
    generated.push(out);
  }
  await bundle.close();

  if (reports.length === 0) throw new Error('onReport was never called');
  return { reports, report: reports[0], output: generated[0], outputs: generated };
}

// A virtual module (id starts with \0) that exists only for its side effect.
const virtualEffect = (): Plugin => ({
  name: 'virtual-effect',
  resolveId(id) {
    if (id === 'virtual:effect') return '\0virtual:effect';
    return null;
  },
  load(id) {
    if (id === '\0virtual:effect') return 'globalThis.__VIRTUAL_EFFECT__ = true;';
    return null;
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('filter matching', () => {
  it('matches a package name as a substring (string filter)', async () => {
    const { report } = await build({ options: { filter: 'fake-lib' } });

    const used = report.explained.find((m) => m.id.includes('used.js'));
    expect(used).toBeDefined();
    expect(used!.package).toBe('fake-lib');
    expect(used!.renderedExports).toEqual(['used']);
    // unused.js was fully tree-shaken (sideEffects: false), so it never
    // reaches the output and must not be "explained".
    expect(report.explained.some((m) => m.id.includes('unused.js'))).toBe(false);
  });

  it('matches via a RegExp', async () => {
    const { report } = await build({ options: { filter: /used\.js$/ } });
    expect(report.explained).toHaveLength(1);
    expect(report.explained[0].id.endsWith('used.js')).toBe(true);
  });

  it('matches via an array of strings and RegExps', async () => {
    const { report } = await build({ options: { filter: ['lazy-lib', /used\.js$/] } });
    const ids = report.explained.map((m) => m.id);
    expect(ids.some((id) => id.includes('lazy-lib'))).toBe(true);
    expect(ids.some((id) => id.endsWith('used.js'))).toBe(true);
  });

  it('matches via a predicate function', async () => {
    const { report } = await build({
      options: { filter: (id) => id.includes('used.js') },
    });
    expect(report.explained).toHaveLength(1);
    expect(report.explained[0].id.endsWith('used.js')).toBe(true);
  });

  it('explains nothing when filter is omitted, but still runs the side-effect report', async () => {
    const { report } = await build();
    expect(report.explained).toEqual([]);
    expect(report.sideEffectRetained.length).toBeGreaterThan(0);
  });

  it('sorts explained modules by rendered size, descending', async () => {
    const { report } = await build({ options: { filter: () => true } });
    expect(report.explained.length).toBeGreaterThan(1);
    const sizes = report.explained.map((m) => m.renderedLength);
    const sorted = [...sizes].sort((a, b) => b - a);
    expect(sizes).toEqual(sorted);
  });
});

describe('import chains', () => {
  it('reports the shortest chain, entry first', async () => {
    const { report } = await build({ options: { filter: 'fake-lib' } });
    const used = report.explained.find((m) => m.id.includes('used.js'))!;
    expect(used.chain).toHaveLength(3);
    expect(used.chain![0].endsWith('main.js')).toBe(true);
    expect(used.chain![2].endsWith('used.js')).toBe(true);
    expect(used.dynamic).toBe(false);
    expect(used.chunks.length).toBeGreaterThan(0);
  });

  it('marks chains that cross a dynamic import', async () => {
    const { report } = await build({ options: { filter: 'lazy-lib' } });
    const lazy = report.explained.find((m) => m.package === 'lazy-lib')!;
    expect(lazy).toBeDefined();
    expect(lazy.dynamic).toBe(true);
    expect(lazy.chain![0].endsWith('main.js')).toBe(true);
    expect(lazy.chain![lazy.chain!.length - 1].endsWith('index.js')).toBe(true);
  });

  it('returns a single-element chain when the entry itself matches', async () => {
    const { report } = await build({ options: { filter: 'main.js' } });
    const entry = report.explained.find((m) => m.id.endsWith('main.js'))!;
    expect(entry).toBeDefined();
    expect(entry.chain).toHaveLength(1);
    expect(entry.chain![0].endsWith('main.js')).toBe(true);
    expect(entry.dynamic).toBe(false);
  });
});

describe('shortest-chain BFS on a tangled graph', () => {
  const chainOf = (report: WhyReport, endsWith: string) =>
    report.explained.find((m) => m.id.endsWith(endsWith))!;

  it('picks the shortest of competing static paths (diamond)', async () => {
    // diamond-target is reachable via main → near (short) and
    // main → far1 → far2 (long); BFS must report the short one.
    const { report } = await build({
      input: 'graph/main.js',
      options: { filter: 'diamond-target.js' },
    });
    const m = chainOf(report, 'diamond-target.js');
    expect(m.dynamic).toBe(false);
    expect(m.chain).toHaveLength(3);
    expect(m.chain![1].endsWith('near.js')).toBe(true);
    expect(m.chain!.some((id) => id.endsWith('far2.js'))).toBe(false);
  });

  it('prefers a shorter dynamic path over a longer static one', async () => {
    // dyn-target is reachable via a 3-hop static path and a 2-hop dynamic
    // one; the dynamic shortcut wins and the chain is flagged dynamic.
    const { report } = await build({
      input: 'graph/main.js',
      options: { filter: 'dyn-target.js' },
    });
    const m = chainOf(report, 'dyn-target.js');
    expect(m.dynamic).toBe(true);
    expect(m.chain).toHaveLength(3);
    expect(m.chain![1].includes('dz.js')).toBe(true);
    expect(m.chain!.some((id) => id.endsWith('static2.js'))).toBe(false);
  });

  it('terminates on an import cycle without looping', async () => {
    // cycle-a ↔ cycle-b import each other; the visited set must prevent the
    // BFS from revisiting and the chain must still reach the entry.
    const { report } = await build({
      input: 'graph/main.js',
      options: { filter: 'cycle-b.js' },
    });
    const m = chainOf(report, 'cycle-b.js');
    expect(m.chain![0].endsWith('main.js')).toBe(true);
    expect(m.chain![m.chain!.length - 1].endsWith('cycle-b.js')).toBe(true);
    // No node appears twice despite the cycle.
    expect(new Set(m.chain!).size).toBe(m.chain!.length);
  });
});

describe('side-effect retention', () => {
  it('detects a module kept only for side effects and reads "none"', async () => {
    const { report } = await build();
    const retained = report.sideEffectRetained.find((m) => m.package === 'side-pkg')!;
    expect(retained).toBeDefined();
    expect(retained.renderedLength).toBeGreaterThan(0);
    expect(retained.sideEffectsField).toBe('none');
    expect(retained.chain![0].endsWith('main.js')).toBe(true);
    // Modules whose exports are actually used are not side-effect retained.
    expect(report.sideEffectRetained.some((m) => m.id.includes('used.js'))).toBe(false);
  });

  it('reads sideEffects: true, a glob list, and first-party (null)', async () => {
    const { report } = await build({ input: 'app/features.js' });

    const byPkg = (pkg: string) =>
      report.sideEffectRetained.find((m) => m.package === pkg)!;

    expect(byPkg('effectful-true').sideEffectsField).toBe('true');
    expect(byPkg('effectful-list').sideEffectsField).toBe('list');

    const firstParty = report.sideEffectRetained.find((m) =>
      m.id.endsWith('local-effect.js'),
    )!;
    expect(firstParty).toBeDefined();
    expect(firstParty.package).toBeNull();
    expect(firstParty.sideEffectsField).toBeNull();
  });

  it('records the exports tree-shaking removed from a retained module', async () => {
    const { report } = await build({ input: 'app/features.js' });
    const retained = report.sideEffectRetained.find((m) => m.package === 'effectful-true')!;
    expect(retained.removedExports).toContain('neverUsed');
  });

  it('never lists the entry module as side-effect retained', async () => {
    // main.js has a top-level console.log side effect and no used exports,
    // but entries are excluded by design.
    const { report } = await build();
    expect(report.sideEffectRetained.some((m) => m.id.endsWith('main.js'))).toBe(false);
  });

  it('excludes virtual modules from the side-effect report', async () => {
    const { report } = await build({
      input: 'app/virtual-entry.js',
      plugins: [virtualEffect()],
    });
    expect(report.sideEffectRetained.some((m) => m.id.startsWith('\0'))).toBe(false);
  });

  it('sorts retained modules by rendered size, descending', async () => {
    const { report } = await build({ input: 'app/features.js' });
    expect(report.sideEffectRetained.length).toBeGreaterThan(1);
    const sizes = report.sideEffectRetained.map((m) => m.renderedLength);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('reports nothing as side-effect retained when disabled', async () => {
    const { report } = await build({ options: { sideEffects: false } });
    expect(report.sideEffectRetained).toEqual([]);
  });
});

describe('package size aggregation', () => {
  it('aggregates rendered size and module count per package', async () => {
    const { report } = await build();
    expect(report.packages['fake-lib']).toBeDefined();
    expect(report.packages['fake-lib'].moduleCount).toBeGreaterThanOrEqual(1);
    expect(report.packages['side-pkg'].renderedLength).toBeGreaterThan(0);
  });

  it('keys scoped and deeply-nested packages by their full names', async () => {
    const { report } = await build({ input: 'app/features.js' });
    expect(report.packages['@scope/widget']).toBeDefined();
    // nested-host/node_modules/nested-dep → the *deepest* node_modules wins.
    expect(report.packages['nested-dep']).toBeDefined();
  });

  it('excludes first-party modules from package aggregation', async () => {
    const { report } = await build({ input: 'app/features.js' });
    for (const name of Object.keys(report.packages)) {
      expect(name).not.toMatch(/local-effect|features/);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('JSON report asset', () => {
  it('emits a JSON asset when requested', async () => {
    const { output } = await build({ options: { json: 'why.json' } });
    const asset = output.find((f) => f.fileName === 'why.json');
    expect(asset).toBeDefined();
    expect(asset!.type).toBe('asset');
  });

  it('serializes the same report passed to onReport', async () => {
    const { report, output } = await build({
      input: 'app/features.js',
      options: { json: 'why.json' },
    });
    const asset = output.find((f) => f.fileName === 'why.json') as { source: string };
    const parsed = JSON.parse(asset.source);
    expect(parsed.packages).toEqual(report.packages);
    expect(parsed.sideEffectRetained).toHaveLength(report.sideEffectRetained.length);
    expect(parsed.output).toBe(report.output);
  });

  it('does not truncate the JSON report even when the print limit is small', async () => {
    const { report, output } = await build({
      input: 'app/features.js',
      options: { json: 'why.json', limit: 1 },
    });
    const asset = output.find((f) => f.fileName === 'why.json') as { source: string };
    const parsed = JSON.parse(asset.source);
    expect(parsed.sideEffectRetained).toHaveLength(report.sideEffectRetained.length);
    expect(parsed.sideEffectRetained.length).toBeGreaterThan(1);
  });
});

describe('terminal output', () => {
  it('prints a report when print is enabled', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ options: { print: true, filter: 'fake-lib' } });
    expect(spy).toHaveBeenCalled();
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('rollup-plugin-why');
    expect(out).toContain('Why are these modules in the bundle?');
    expect(out).toContain('used.js');
    // formatBytes renders small modules in bytes.
    expect(out).toMatch(/\d+ B\b/);
  });

  it('does not print the report when print is disabled', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ options: { print: false, filter: 'fake-lib' } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain('rollup-plugin-why');
  });

  it('truncates each section to the limit and notes how many were hidden', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { report } = await build({ options: { print: true, filter: () => true, limit: 1 } });
    expect(report.explained.length).toBeGreaterThan(1);
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/…and \d+ more/);
  });

  it('truncates the package table and side-effect section with an "…and N more" note', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // features.js pulls in 4 packages and 3 side-effect-retained modules, so a
    // limit of 1 truncates both the package summary and the side-effect list.
    const { report } = await build({ input: 'app/features.js', options: { print: true, limit: 1 } });
    expect(Object.keys(report.packages).length).toBeGreaterThan(1);
    expect(report.sideEffectRetained.length).toBeGreaterThan(1);
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect((out.match(/…and \d+ more/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('renders virtual module ids with a [virtual] marker', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({
      input: 'app/virtual-entry.js',
      plugins: [virtualEffect()],
      options: { print: true, filter: 'virtual:effect' },
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('[virtual]');
  });

  it('keeps the [virtual] marker under compactPaths', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({
      input: 'app/virtual-entry.js',
      plugins: [virtualEffect()],
      options: { print: true, filter: 'virtual:effect', compactPaths: true },
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('[virtual]');
  });

  it('prints a clean-bill-of-health line when nothing is retained', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // sideEffects: false skips the retention scan, so the report is empty.
    await build({ options: { print: true, sideEffects: false } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('No modules are retained purely by side effects');
  });
});

describe('deterministic, static-preferring chains', () => {
  it('prefers a static chain over a tied-length dynamic one, stably', async () => {
    // tie-target is reachable via main → tieA (static) and main → ⇢ tieDyn
    // (dynamic), both length 3. The static chain must win and the result must
    // be identical across builds.
    const a = await build({ input: 'graph/main.js', options: { filter: 'tie-target.js' } });
    const b = await build({ input: 'graph/main.js', options: { filter: 'tie-target.js' } });
    const ma = a.report.explained.find((m) => m.id.endsWith('tie-target.js'))!;
    const mb = b.report.explained.find((m) => m.id.endsWith('tie-target.js'))!;
    expect(ma.dynamic).toBe(false);
    expect(ma.chain!.some((id) => id.endsWith('tieA.js'))).toBe(true);
    expect(ma.chain!.some((id) => id.includes('tieDyn.js'))).toBe(false);
    expect(ma.chain).toEqual(mb.chain);
  });
});

describe('initial chunk placement', () => {
  it('marks statically-reachable modules as shipping in the initial chunk', async () => {
    const { report } = await build({ options: { filter: () => true } });
    const used = report.explained.find((m) => m.id.includes('used.js'))!;
    expect(used.initialChunk).toBe(true);
    // lazy-lib is only reachable through a dynamic import, so it lands in a
    // separate chunk that does not ship on first load.
    const lazyLib = report.explained.find((m) => m.package === 'lazy-lib')!;
    expect(lazyLib.initialChunk).toBe(false);
  });

  it('annotates a dynamic chain that still ships in the initial chunk', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { report } = await build({
      input: 'graph/main.js',
      options: { print: true, filter: 'eager-shared.js' },
    });
    const m = report.explained.find((x) => x.id.endsWith('eager-shared.js'))!;
    expect(m.dynamic).toBe(true);
    expect(m.initialChunk).toBe(true);
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('also ships in initial chunk');
  });
});

describe('CommonJS side-effect modules', () => {
  const cjsReal = fixture('app/node_modules/side-pkg/cjs-poly.js');
  const commonjsEffect = (): Plugin => ({
    name: 'commonjs-effect',
    resolveId(id) {
      return id === 'cjs-poly' ? `\0${cjsReal}?commonjs-module` : null;
    },
    load(id) {
      return id.startsWith('\0') && id.includes('?commonjs-module')
        ? 'globalThis.__CJS_POLY__ = true;'
        : null;
    },
  });

  it('excludes CJS-wrapped modules but footnotes the count', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { report } = await build({
      input: 'app/cjs-entry.js',
      plugins: [commonjsEffect()],
      options: { print: true },
    });
    expect(report.sideEffectRetained.some((m) => m.id.includes('cjs-poly'))).toBe(false);
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/CommonJS-wrapped/);
  });

  it('includes them with the real path under includeCommonJS', async () => {
    const { report } = await build({
      input: 'app/cjs-entry.js',
      plugins: [commonjsEffect()],
      options: { includeCommonJS: true },
    });
    const m = report.sideEffectRetained.find((r) => r.id.includes('cjs-poly'));
    expect(m).toBeDefined();
    expect(m!.id.startsWith('\0')).toBe(false);
    expect(m!.id).toBe(cjsReal);
  });

  it('renders the chain node as the real file, not the raw \\0…?commonjs id', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({
      input: 'app/cjs-entry.js',
      plugins: [commonjsEffect()],
      options: { print: true, includeCommonJS: true },
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('side-pkg/cjs-poly.js'); // the real path, in the chain
    expect(out).not.toContain('?commonjs'); // query suffix stripped
    expect(out).not.toContain('\0');
    expect(out).not.toContain('[virtual]'); // it's a real file, not virtual
  });

  it('renders the commonjs chain node cleanly under compactPaths', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({
      input: 'app/cjs-entry.js',
      plugins: [commonjsEffect()],
      options: { print: true, includeCommonJS: true, compactPaths: true },
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('side-pkg › cjs-poly');
    expect(out).not.toContain('?commonjs');
  });
});

describe('package summary and totals', () => {
  it('exposes totalRenderedLength and prints a largest-packages table', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { report } = await build({ options: { print: true } });
    expect(report.totalRenderedLength).toBeGreaterThan(0);
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Largest packages');
    expect(out).toContain('Total analyzed');
  });
});

describe('export list collapsing', () => {
  it('collapses long/minified export lists to a count by default', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ input: 'app/minified-entry.js', options: { print: true, filter: 'minified-lib' } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/\d+ of \d+ exports used/);
  });

  it('collapses a short list of minified-looking names below the count threshold', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Only 4 exports (≤ 8), so collapsing is driven by the minified heuristic.
    await build({ input: 'app/short-entry.js', options: { print: true, filter: 'short-lib' } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('1 of 4 exports used');
  });

  it('enumerates every export under verbose', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({
      input: 'app/minified-entry.js',
      options: { print: true, filter: 'minified-lib', verbose: true },
    });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('exports used: a, b');
  });
});

describe('filter package matching and feedback', () => {
  it('matches an exact package name with { package } and not substrings', async () => {
    const { report } = await build({
      input: 'app/features.js',
      options: { filter: { package: 'effectful-true' } },
    });
    expect(report.explained.length).toBeGreaterThan(0);
    expect(report.explained.every((m) => m.package === 'effectful-true')).toBe(true);
    expect(report.explained.some((m) => m.package === 'effectful-list')).toBe(false);
  });

  it('echoes which packages a string filter matched', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ options: { print: true, filter: 'lib' } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/filter matched:/);
    expect(out).toContain('fake-lib');
    expect(out).toContain('lazy-lib');
  });
});

describe('gzip estimate', () => {
  it('adds gzip lengths to packages and modules when enabled', async () => {
    const { report } = await build({
      input: 'app/features.js',
      options: { gzip: true, filter: () => true },
    });
    expect(Object.values(report.packages).every((p) => typeof p.gzipLength === 'number')).toBe(true);
    expect(Object.values(report.packages).some((p) => (p.gzipLength ?? 0) > 0)).toBe(true);
    expect(report.explained.some((m) => typeof m.gzipLength === 'number')).toBe(true);
  });

  it('omits gzip lengths by default', async () => {
    const { report } = await build({ input: 'app/features.js' });
    for (const p of Object.values(report.packages)) expect(p.gzipLength).toBeUndefined();
  });
});

describe('baseline diff', () => {
  it('diffs the current report against a previous JSON report', async () => {
    const first = await build({ input: 'app/features.js' });
    const tmp = path.join(os.tmpdir(), `why-baseline-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(first.report));
    try {
      const second = await build({ input: 'app/main.js', options: { baseline: tmp } });
      const diff = second.report.diff!;
      expect(diff).toBeDefined();
      expect(diff.baseline).toBe(tmp);
      // features.js and main.js share no packages, so each side fully turns over.
      expect(diff.newPackages).toContain('fake-lib');
      expect(diff.removedPackages).toContain('@scope/widget');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('reports package size deltas, new side-effect retention, and chain flips', async () => {
    // Diff the real report against a hand-crafted baseline that differs in
    // package size, retention, and chain direction — exercising every branch
    // of the diff that two disjoint inputs wouldn't reach.
    const live = await build({ input: 'app/main.js', options: { filter: 'lazy-lib' } });
    const cur = live.report;
    const lazy = cur.explained.find((m) => m.package === 'lazy-lib')!;
    expect(lazy.dynamic).toBe(true);

    const baseline: WhyReport = {
      output: cur.output,
      totalRenderedLength: cur.totalRenderedLength,
      explained: [{ ...lazy, dynamic: false }], // flips static → dynamic
      sideEffectRetained: [], // every current retained module shows as new
      packages: {
        // smaller in the baseline → positive delta now…
        'lazy-lib': { renderedLength: cur.packages['lazy-lib'].renderedLength - 10, moduleCount: 1 },
        // …larger in the baseline → negative delta now.
        'side-pkg': { renderedLength: cur.packages['side-pkg'].renderedLength + 100, moduleCount: 1 },
      },
    };
    const tmp = path.join(os.tmpdir(), `why-baseline-synth-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(baseline));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const next = await build({
        input: 'app/main.js',
        options: { print: true, filter: 'lazy-lib', baseline: tmp },
      });
      const diff = next.report.diff!;
      expect(diff.packageDeltas.find((d) => d.package === 'lazy-lib')?.delta).toBe(10);
      expect(diff.packageDeltas.find((d) => d.package === 'side-pkg')?.delta).toBe(-100);
      expect(diff.newSideEffectRetained.length).toBeGreaterThan(0);
      expect(diff.chainFlips.find((f) => f.id === lazy.id)).toEqual({
        id: lazy.id,
        from: 'static',
        to: 'dynamic',
      });
      expect(diff.newPackages).toContain('fake-lib'); // absent from the baseline packages

      // printDiff rendered the section, including a negative delta.
      const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('Changes since baseline');
      expect(out).toMatch(/-100 B|-0\.1 kB/);
    } finally {
      spy.mockRestore();
      fs.rmSync(tmp, { force: true });
    }
  });

  it('warns and produces no diff when the baseline is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { report } = await build({
      options: { baseline: path.join(os.tmpdir(), 'does-not-exist-why.json') },
    });
    expect(report.diff).toBeUndefined();
    warn.mockRestore();
  });
});

describe('compact paths', () => {
  it('renders node_modules paths package-relative', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await build({ options: { print: true, filter: 'fake-lib', compactPaths: true } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('fake-lib › ');
  });
});

describe('multiple outputs', () => {
  it('produces one report per generated output', async () => {
    const { reports } = await build({
      output: [
        { dir: 'out-a', format: 'es' },
        { dir: 'out-b', format: 'cjs' },
      ],
    });
    expect(reports).toHaveLength(2);
    expect(reports[0].output).toBe('out-a');
    expect(reports[1].output).toBe('out-b');
  });

  it('reports the output file name when one is configured', async () => {
    // features.js has no dynamic import, so it renders to a single file chunk.
    const { report } = await build({
      input: 'app/features.js',
      output: { file: 'bundle.js', format: 'es' },
    });
    expect(report.output).toBe('bundle.js');
  });
});
