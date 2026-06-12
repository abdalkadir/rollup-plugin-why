import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';
import { describe, expect, it } from 'vitest';
import why, { type WhyOptions, type WhyReport } from '../src/index';

const fixture = (p: string) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', p);

async function buildApp(options: WhyOptions = {}) {
  let report: WhyReport | undefined;
  const bundle = await rollup({
    input: fixture('app/main.js'),
    plugins: [
      nodeResolve(),
      why({ print: false, onReport: (r) => (report = r), ...options }),
    ],
  });
  const { output } = await bundle.generate({ dir: 'out', format: 'es' });
  await bundle.close();
  if (!report) throw new Error('onReport was not called');
  return { report, output };
}

describe('rollup-plugin-why', () => {
  it('explains a filtered module with the shortest import chain from an entry', async () => {
    const { report } = await buildApp({ filter: 'fake-lib' });

    const used = report.explained.find((m) => m.id.includes('used.js'));
    expect(used).toBeDefined();
    expect(used!.package).toBe('fake-lib');
    expect(used!.renderedExports).toEqual(['used']);
    expect(used!.chain).toHaveLength(3);
    expect(used!.chain![0].endsWith('main.js')).toBe(true);
    expect(used!.chain![2].endsWith('used.js')).toBe(true);
    expect(used!.dynamic).toBe(false);

    // unused.js was fully tree-shaken (sideEffects: false), so it never
    // reaches the output and must not be "explained".
    expect(report.explained.some((m) => m.id.includes('unused.js'))).toBe(false);
  });

  it('marks chains that cross a dynamic import', async () => {
    const { report } = await buildApp({ filter: 'lazy-lib' });

    const lazy = report.explained.find((m) => m.package === 'lazy-lib');
    expect(lazy).toBeDefined();
    expect(lazy!.dynamic).toBe(true);
    expect(lazy!.chain![0].endsWith('main.js')).toBe(true);
  });

  it('detects modules retained purely by side effects and reads the sideEffects field', async () => {
    const { report } = await buildApp();

    const retained = report.sideEffectRetained.find((m) => m.package === 'side-pkg');
    expect(retained).toBeDefined();
    expect(retained!.renderedLength).toBeGreaterThan(0);
    expect(retained!.sideEffectsField).toBe('none');
    expect(retained!.chain![0].endsWith('main.js')).toBe(true);

    // Modules whose exports are actually used are not side-effect retained.
    expect(report.sideEffectRetained.some((m) => m.id.includes('used.js'))).toBe(false);
  });

  it('aggregates rendered size per package', async () => {
    const { report } = await buildApp();

    expect(report.packages['fake-lib']).toBeDefined();
    expect(report.packages['fake-lib'].moduleCount).toBeGreaterThanOrEqual(1);
    expect(report.packages['side-pkg'].renderedLength).toBeGreaterThan(0);
  });

  it('emits a JSON report asset when requested', async () => {
    const { output } = await buildApp({ json: 'why.json' });

    const asset = output.find((f) => f.fileName === 'why.json');
    expect(asset).toBeDefined();
    expect(asset!.type).toBe('asset');
    const parsed = JSON.parse((asset as { source: string }).source);
    expect(parsed).toHaveProperty('sideEffectRetained');
    expect(parsed).toHaveProperty('packages');
  });

  it('reports nothing as side-effect retained when disabled', async () => {
    const { report } = await buildApp({ sideEffects: false });
    expect(report.sideEffectRetained).toEqual([]);
  });
});
