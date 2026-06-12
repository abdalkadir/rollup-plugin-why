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

  it('prints a clean-bill-of-health line when nothing is retained', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // sideEffects: false skips the retention scan, so the report is empty.
    await build({ options: { print: true, sideEffects: false } });
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('No modules are retained purely by side effects');
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
