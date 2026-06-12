import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Plugin, PluginContext } from 'rollup';

export interface WhyOptions {
  /**
   * Which modules to explain with an import chain. A string matches as a
   * substring of the module id (so a package name like `'lodash-es'` works),
   * a RegExp is tested against the id, an array matches if any entry matches,
   * and a function receives the id and returns whether to explain it.
   * When omitted, only the side-effect retention report is produced.
   */
  filter?: string | RegExp | Array<string | RegExp> | ((id: string) => boolean);
  /**
   * Report modules that were kept in the output even though none of their
   * exports are used, i.e. modules retained purely for their side effects.
   * @default true
   */
  sideEffects?: boolean;
  /**
   * Maximum number of modules listed per report section.
   * @default 20
   */
  limit?: number;
  /**
   * Emit the full report as a JSON asset with this file name into the
   * output directory.
   */
  json?: string;
  /**
   * Print the report to the terminal.
   * @default true
   */
  print?: boolean;
  /**
   * Receive the report object programmatically. Called once per output.
   */
  onReport?: (report: WhyReport) => void;
}

export interface ExplainedModule {
  id: string;
  package: string | null;
  renderedLength: number;
  renderedExports: string[];
  removedExports: string[];
  chunks: string[];
  /** Import chain from an entry module to this module, entry first. */
  chain: string[] | null;
  /** Whether the chain crosses a dynamic import. */
  dynamic: boolean;
}

export interface RetainedModule {
  id: string;
  package: string | null;
  renderedLength: number;
  removedExports: string[];
  /**
   * How the owning package declares side effects in its package.json:
   * `"false"` (claims side-effect free), `"true"`, `"list"` (a glob list),
   * `"none"` (field absent), or `null` when the module is not inside a
   * package (first-party code or a virtual module).
   */
  sideEffectsField: 'false' | 'true' | 'list' | 'none' | null;
  chain: string[] | null;
  dynamic: boolean;
}

export interface WhyReport {
  /** Output directory or file this report describes. */
  output: string;
  explained: ExplainedModule[];
  sideEffectRetained: RetainedModule[];
  /** Rendered bytes and module counts aggregated per npm package. */
  packages: Record<string, { renderedLength: number; moduleCount: number }>;
}

interface RenderedInfo {
  id: string;
  renderedLength: number;
  renderedExports: Set<string>;
  removedExports: Set<string>;
  chunks: string[];
}

function makeMatcher(filter: WhyOptions['filter']): (id: string) => boolean {
  if (filter == null) return () => false;
  if (typeof filter === 'function') return filter;
  const list = Array.isArray(filter) ? filter : [filter];
  return (id) =>
    list.some((f) => (typeof f === 'string' ? id.includes(f) : f.test(id)));
}

function packageNameOf(id: string): string | null {
  const idx = id.lastIndexOf('node_modules');
  if (idx === -1) return null;
  const rest = id.slice(idx + 'node_modules'.length + 1);
  const parts = rest.split(/[\\/]/);
  if (parts[0]?.startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

const sideEffectsCache = new Map<string, RetainedModule['sideEffectsField']>();

function sideEffectsFieldOf(id: string): RetainedModule['sideEffectsField'] {
  if (id.startsWith('\0') || !path.isAbsolute(id)) return null;
  if (id.lastIndexOf('node_modules') === -1) return null;
  let dir = path.dirname(id.split('?')[0]);
  for (let i = 0; i < 30; i++) {
    const cached = sideEffectsCache.get(dir);
    if (cached !== undefined) return cached;
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        const field: RetainedModule['sideEffectsField'] =
          pkg.sideEffects === false
            ? 'false'
            : pkg.sideEffects === true
              ? 'true'
              : Array.isArray(pkg.sideEffects)
                ? 'list'
                : 'none';
        sideEffectsCache.set(dir, field);
        return field;
      }
    } catch {
      // no package.json at this level, keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir || path.basename(dir) === 'node_modules') break;
    dir = parent;
  }
  sideEffectsCache.set(dir, null);
  return null;
}

function shortestChain(
  ctx: PluginContext,
  id: string,
): { chain: string[]; dynamic: boolean } | null {
  const visited = new Set([id]);
  let queue = [{ id, trail: [id], dynamic: false }];
  while (queue.length > 0) {
    const next: typeof queue = [];
    for (const node of queue) {
      const info = ctx.getModuleInfo(node.id);
      if (!info) continue;
      if (info.isEntry) {
        return { chain: node.trail.slice().reverse(), dynamic: node.dynamic };
      }
      for (const importer of info.importers) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        next.push({ id: importer, trail: [...node.trail, importer], dynamic: node.dynamic });
      }
      for (const importer of info.dynamicImporters) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        next.push({ id: importer, trail: [...node.trail, importer], dynamic: true });
      }
    }
    queue = next;
  }
  return null;
}

function displayId(id: string): string {
  const clean = id.startsWith('\0') ? `[virtual] ${id.slice(1)}` : id;
  const rel = path.isAbsolute(clean) ? path.relative(process.cwd(), clean) : clean;
  return rel.startsWith('..') ? clean : rel;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} kB`;
}

function printChain(chain: string[] | null, dynamic: boolean, indent: string): string {
  if (!chain) return `${indent}${pc.dim('(no static path from an entry module)')}`;
  const arrow = dynamic ? pc.yellow(' ⇢ ') : pc.dim(' → ');
  return (
    indent +
    chain.map((id, i) => (i === chain.length - 1 ? pc.cyan(displayId(id)) : displayId(id))).join(arrow) +
    (dynamic ? pc.yellow('  (via dynamic import)') : '')
  );
}

function printReport(report: WhyReport, limit: number): void {
  const lines: string[] = [];
  const header = `rollup-plugin-why ${pc.dim(`(${report.output})`)}`;
  lines.push('', pc.bold(header), pc.dim('─'.repeat(40)));

  if (report.explained.length > 0) {
    lines.push('', pc.bold('Why are these modules in the bundle?'), '');
    for (const mod of report.explained.slice(0, limit)) {
      const used =
        mod.renderedExports.length > 0
          ? `exports used: ${mod.renderedExports.join(', ')}`
          : 'no exports used';
      const removed =
        mod.removedExports.length > 0
          ? pc.dim(`, tree-shaken: ${mod.removedExports.join(', ')}`)
          : '';
      lines.push(
        `  ${pc.cyan(displayId(mod.id))}  ${pc.bold(formatBytes(mod.renderedLength))}  ${pc.dim(`(${used})`)}${removed}`,
      );
      lines.push(printChain(mod.chain, mod.dynamic, '    '));
      lines.push('');
    }
    if (report.explained.length > limit) {
      lines.push(pc.dim(`  …and ${report.explained.length - limit} more (raise \`limit\` or use \`json\`)`), '');
    }
  }

  if (report.sideEffectRetained.length > 0) {
    lines.push(
      '',
      pc.bold('Modules kept only for side effects') +
        pc.dim(' (no exports used, code still in the bundle)'),
      '',
    );
    for (const mod of report.sideEffectRetained.slice(0, limit)) {
      lines.push(`  ${pc.yellow(displayId(mod.id))}  ${pc.bold(formatBytes(mod.renderedLength))}`);
      lines.push(printChain(mod.chain, mod.dynamic, '    '));
      const hint =
        mod.sideEffectsField === 'none'
          ? `package ${pc.bold(mod.package ?? '?')} does not declare "sideEffects" — if it is side-effect free, ask the maintainer to add ${pc.bold('"sideEffects": false')}, or override it via your bundler config`
          : mod.sideEffectsField === 'false'
            ? `package ${pc.bold(mod.package ?? '?')} claims "sideEffects": false, but Rollup still found side effects in this module`
            : mod.sideEffectsField === 'list' || mod.sideEffectsField === 'true'
              ? `package ${pc.bold(mod.package ?? '?')} declares this module as having side effects`
              : 'first-party module — check whether the side effects at module top level are intentional';
      lines.push(`    ${pc.dim(hint)}`, '');
    }
    if (report.sideEffectRetained.length > limit) {
      lines.push(
        pc.dim(`  …and ${report.sideEffectRetained.length - limit} more (raise \`limit\` or use \`json\`)`),
        '',
      );
    }
  } else {
    lines.push('', pc.green('No modules are retained purely by side effects. ✔'), '');
  }

  console.log(lines.join('\n'));
}

export function why(options: WhyOptions = {}): Plugin {
  const { sideEffects = true, limit = 20, json, print = true, onReport } = options;
  const matches = makeMatcher(options.filter);

  return {
    name: 'why',
    // Only meaningful for production builds when used with Vite.
    apply: 'build',

    generateBundle(outputOptions, bundle) {
      const rendered = new Map<string, RenderedInfo>();
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        for (const [id, mod] of Object.entries(file.modules)) {
          let info = rendered.get(id);
          if (!info) {
            info = {
              id,
              renderedLength: 0,
              renderedExports: new Set(),
              removedExports: new Set(),
              chunks: [],
            };
            rendered.set(id, info);
          }
          info.renderedLength += mod.renderedLength;
          info.chunks.push(file.fileName);
          for (const e of mod.renderedExports) info.renderedExports.add(e);
          for (const e of mod.removedExports) info.removedExports.add(e);
        }
      }

      const packages: WhyReport['packages'] = {};
      for (const info of rendered.values()) {
        const name = packageNameOf(info.id);
        if (!name) continue;
        const entry = (packages[name] ??= { renderedLength: 0, moduleCount: 0 });
        entry.renderedLength += info.renderedLength;
        entry.moduleCount += 1;
      }

      const explained: ExplainedModule[] = [];
      for (const info of rendered.values()) {
        if (!matches(info.id)) continue;
        const found = shortestChain(this, info.id);
        explained.push({
          id: info.id,
          package: packageNameOf(info.id),
          renderedLength: info.renderedLength,
          renderedExports: [...info.renderedExports],
          removedExports: [...info.removedExports],
          chunks: info.chunks,
          chain: found?.chain ?? null,
          dynamic: found?.dynamic ?? false,
        });
      }
      explained.sort((a, b) => b.renderedLength - a.renderedLength);

      const sideEffectRetained: RetainedModule[] = [];
      if (sideEffects) {
        for (const info of rendered.values()) {
          if (info.renderedLength === 0 || info.renderedExports.size > 0) continue;
          if (info.id.startsWith('\0')) continue;
          const modInfo = this.getModuleInfo(info.id);
          if (modInfo?.isEntry) continue;
          const found = shortestChain(this, info.id);
          sideEffectRetained.push({
            id: info.id,
            package: packageNameOf(info.id),
            renderedLength: info.renderedLength,
            removedExports: [...info.removedExports],
            sideEffectsField: sideEffectsFieldOf(info.id),
            chain: found?.chain ?? null,
            dynamic: found?.dynamic ?? false,
          });
        }
        sideEffectRetained.sort((a, b) => b.renderedLength - a.renderedLength);
      }

      const report: WhyReport = {
        output: outputOptions.dir ?? outputOptions.file ?? '',
        explained,
        sideEffectRetained,
        packages,
      };

      if (print) printReport(report, limit);
      if (json) {
        this.emitFile({
          type: 'asset',
          fileName: json,
          source: JSON.stringify(report, null, 2),
        });
      }
      onReport?.(report);
    },
  } as Plugin;
}

export default why;
