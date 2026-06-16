import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import pc from 'picocolors';
import type { Plugin, PluginContext } from 'rollup';

/** A single filter entry. `{ package }` matches an exact npm package name. */
export type FilterEntry = string | RegExp | { package: string };

export interface WhyOptions {
  /**
   * Which modules to explain with an import chain. A string matches as a
   * substring of the module id (so a package name like `'lodash-es'` works),
   * a RegExp is tested against the id, `{ package: 'name' }` matches the exact
   * npm package name, an array matches if any entry matches, and a function
   * receives the id and returns whether to explain it. When omitted, only the
   * side-effect retention report is produced.
   */
  filter?: FilterEntry | FilterEntry[] | ((id: string) => boolean);
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
  /**
   * Include CommonJS-wrapped modules (virtual `\0…?commonjs-*` ids) in the
   * side-effect report, mapping each back to its real file. When false, such
   * modules are excluded but their count is noted as a footnote.
   * @default false
   */
  includeCommonJS?: boolean;
  /**
   * Always enumerate every export name, even for modules with many or
   * minified-looking exports (which are otherwise collapsed to a count).
   * @default false
   */
  verbose?: boolean;
  /**
   * Path to a previous JSON report to diff against. The report gains a `diff`
   * field and the terminal output gains a "Changes since baseline" section.
   */
  baseline?: string;
  /**
   * Estimate transfer size by gzipping each module's rendered code. Adds a
   * `gzipLength` to packages and module entries. The estimate is of the
   * pre-minification code Rollup rendered, so treat it as a rough signal.
   * @default false
   */
  gzip?: boolean;
  /**
   * Render node_modules paths package-relative in the terminal, e.g.
   * `date-fns › _lib/format/formatters` instead of the full path.
   * @default false
   */
  compactPaths?: boolean;
}

export interface ExplainedModule {
  id: string;
  package: string | null;
  renderedLength: number;
  /** Estimated gzip size of this module's rendered code (only when `gzip`). */
  gzipLength?: number;
  renderedExports: string[];
  removedExports: string[];
  chunks: string[];
  /** Whether this module ships in a chunk loaded on first page load. */
  initialChunk: boolean;
  /** Import chain from an entry module to this module, entry first. */
  chain: string[] | null;
  /** Whether the chain crosses a dynamic import. */
  dynamic: boolean;
}

export interface RetainedModule {
  id: string;
  package: string | null;
  renderedLength: number;
  /** Estimated gzip size of this module's rendered code (only when `gzip`). */
  gzipLength?: number;
  removedExports: string[];
  /**
   * How the owning package declares side effects in its package.json:
   * `"false"` (claims side-effect free), `"true"`, `"list"` (a glob list),
   * `"none"` (field absent), or `null` when the module is not inside a
   * package (first-party code or a virtual module).
   */
  sideEffectsField: 'false' | 'true' | 'list' | 'none' | null;
  /** Whether this module ships in a chunk loaded on first page load. */
  initialChunk: boolean;
  chain: string[] | null;
  dynamic: boolean;
}

export interface WhyDiff {
  /** The baseline report path this diff was computed against. */
  baseline: string;
  newPackages: string[];
  removedPackages: string[];
  packageDeltas: Array<{ package: string; before: number; after: number; delta: number }>;
  newSideEffectRetained: string[];
  chainFlips: Array<{ id: string; from: 'static' | 'dynamic'; to: 'static' | 'dynamic' }>;
}

export interface WhyReport {
  /** Output directory or file this report describes. */
  output: string;
  /** Sum of every rendered module's `renderedLength`, the "% of analyzed" base. */
  totalRenderedLength: number;
  explained: ExplainedModule[];
  sideEffectRetained: RetainedModule[];
  /** Rendered bytes and module counts aggregated per npm package. */
  packages: Record<string, { renderedLength: number; moduleCount: number; gzipLength?: number }>;
  /** Comparison against the `baseline` report, when one was provided. */
  diff?: WhyDiff;
}

interface RenderedInfo {
  id: string;
  renderedLength: number;
  renderedExports: Set<string>;
  removedExports: Set<string>;
  chunks: string[];
  /** Concatenated rendered code, accumulated only when `gzip` is enabled. */
  code: string;
}

function makeMatcher(filter: WhyOptions['filter']): (id: string) => boolean {
  if (filter == null) return () => false;
  if (typeof filter === 'function') return filter;
  const list = Array.isArray(filter) ? filter : [filter];
  return (id) =>
    list.some((f) => {
      if (typeof f === 'string') return id.includes(f);
      if (f instanceof RegExp) return f.test(id);
      return packageNameOf(id) === f.package;
    });
}

function packageNameOf(id: string): string | null {
  const idx = id.lastIndexOf('node_modules');
  if (idx === -1) return null;
  const rest = id.slice(idx + 'node_modules'.length + 1);
  const parts = rest.split(/[\\/]/);
  if (parts[0]?.startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] || null;
}

/**
 * Maps a CommonJS-wrapped virtual id (`\0/abs/file.js?commonjs-*`) back to its
 * real file path, or null when the id is a genuine virtual module.
 */
function realCommonJsPath(id: string): string | null {
  if (!id.startsWith('\0') || !/\?commonjs-/.test(id)) return null;
  const real = id.slice(1).split('?')[0];
  return path.isAbsolute(real) ? real : null;
}

function gzipSize(code: string): number {
  return zlib.gzipSync(Buffer.from(code), { level: 9 }).length;
}

/** Heuristic: most export names are 1-2 chars, so they're likely minified. */
function looksMinified(names: string[]): boolean {
  if (names.length === 0) return false;
  return names.filter((n) => n.length <= 2).length / names.length > 0.5;
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

interface ChainCand {
  trail: string[];
  dynamic: boolean;
}

/**
 * Orders two candidate chains of equal length so selection is stable: prefer a
 * fully-static chain, then the lexicographically smallest one (entry first).
 * Returns true when `a` should be preferred over `b`.
 */
function chainLess(a: ChainCand, b: ChainCand): boolean {
  if (a.dynamic !== b.dynamic) return !a.dynamic;
  const { trail: ta } = a;
  const { trail: tb } = b;
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    // Compare entry-first (trails are stored target-first).
    const ea = ta[ta.length - 1 - i];
    const eb = tb[tb.length - 1 - i];
    if (ea !== eb) return ea < eb;
  }
  return ta.length < tb.length;
}

/**
 * Shortest import chain from an entry to `id`, via a level-synchronised BFS.
 * All equal-distance parents compete for each node, so the result is
 * deterministic and prefers static chains over dynamic ones on ties.
 */
function shortestChain(
  ctx: PluginContext,
  id: string,
): { chain: string[]; dynamic: boolean } | null {
  let frontier = new Map<string, ChainCand>([[id, { trail: [id], dynamic: false }]]);
  const visited = new Set<string>([id]);
  while (frontier.size > 0) {
    // Return as soon as the frontier reaches an entry, picking the best one.
    let best: ChainCand | null = null;
    for (const [nid, cand] of frontier) {
      if (ctx.getModuleInfo(nid)?.isEntry && (!best || chainLess(cand, best))) best = cand;
    }
    if (best) return { chain: best.trail.slice().reverse(), dynamic: best.dynamic };

    const next = new Map<string, ChainCand>();
    for (const [nid, cand] of frontier) {
      const info = ctx.getModuleInfo(nid);
      if (!info) continue;
      const edges: Array<[string, boolean]> = [];
      for (const imp of info.importers) edges.push([imp, false]);
      for (const imp of info.dynamicImporters) edges.push([imp, true]);
      for (const [imp, edgeDynamic] of edges) {
        if (visited.has(imp)) continue;
        const candNext: ChainCand = {
          trail: [...cand.trail, imp],
          dynamic: cand.dynamic || edgeDynamic,
        };
        const existing = next.get(imp);
        if (!existing || chainLess(candNext, existing)) next.set(imp, candNext);
      }
    }
    for (const k of next.keys()) visited.add(k);
    frontier = next;
  }
  return null;
}

function displayId(id: string, compact = false): string {
  // Render a CommonJS-wrapped chain node as its real file (matching how the
  // module's own id is reported), not the raw `\0…?commonjs-*` graph id.
  const real = realCommonJsPath(id);
  const virtual = !real && id.startsWith('\0');
  const base = real ?? (virtual ? id.slice(1) : id);
  const mark = (s: string) => (virtual ? `[virtual] ${s}` : s);
  if (compact) {
    const pkg = packageNameOf(base);
    const idx = base.lastIndexOf('node_modules');
    if (pkg && idx !== -1) {
      const after = base.slice(idx + 'node_modules'.length + 1);
      const rel = (after.startsWith(`${pkg}/`) ? after.slice(pkg.length + 1) : after).replace(
        /\.(mjs|cjs|jsx?|tsx?)$/,
        '',
      );
      return mark(rel ? `${pkg} › ${rel}` : pkg);
    }
  }
  const rel = path.isAbsolute(base) ? path.relative(process.cwd(), base) : base;
  return mark(rel.startsWith('..') ? base : rel);
}

function formatBytes(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  return `${sign}${(abs / 1024).toFixed(1)} kB`;
}

function printChain(
  chain: string[] | null,
  dynamic: boolean,
  initialChunk: boolean,
  indent: string,
  compact: boolean,
): string {
  if (!chain) return `${indent}${pc.dim('(no static path from an entry module)')}`;
  const arrow = dynamic ? pc.yellow(' ⇢ ') : pc.dim(' → ');
  const body = chain
    .map((id, i) => (i === chain.length - 1 ? pc.cyan(displayId(id, compact)) : displayId(id, compact)))
    .join(arrow);
  const note = dynamic
    ? pc.yellow(initialChunk ? '  (via dynamic import; also ships in initial chunk)' : '  (via dynamic import)')
    : '';
  return indent + body + note;
}

interface PrintMeta {
  limit: number;
  verbose: boolean;
  compact: boolean;
  matchedPackages: string[] | null;
  commonJsExcluded: number;
}

function printReport(report: WhyReport, meta: PrintMeta): void {
  const { limit, verbose, compact, matchedPackages, commonJsExcluded } = meta;
  const lines: string[] = [];
  const header = `rollup-plugin-why ${pc.dim(`(${report.output})`)}`;
  lines.push('', pc.bold(header), pc.dim('─'.repeat(40)));

  if (matchedPackages) {
    lines.push(
      '',
      pc.dim(`filter matched: ${matchedPackages.length ? matchedPackages.join(', ') : '(no node_modules packages)'}`),
    );
  }

  if (report.diff) printDiff(report.diff, limit, compact, lines);

  const pkgEntries = Object.entries(report.packages).sort(
    (a, b) => b[1].renderedLength - a[1].renderedLength,
  );
  if (pkgEntries.length > 0) {
    lines.push('', pc.bold('Largest packages'), '');
    for (const [name, p] of pkgEntries.slice(0, limit)) {
      const pct =
        report.totalRenderedLength > 0 ? (p.renderedLength / report.totalRenderedLength) * 100 : 0;
      const gz = p.gzipLength != null ? pc.dim(`  ~${formatBytes(p.gzipLength)} gzip`) : '';
      lines.push(
        `  ${pc.cyan(name)}  ${pc.bold(formatBytes(p.renderedLength))}  ${pc.dim(
          `${pct.toFixed(1)}%`,
        )}  ${pc.dim(`${p.moduleCount} module${p.moduleCount === 1 ? '' : 's'}`)}${gz}`,
      );
    }
    if (pkgEntries.length > limit) {
      lines.push(pc.dim(`  …and ${pkgEntries.length - limit} more`));
    }
    const depBytes = pkgEntries.reduce((s, [, p]) => s + p.renderedLength, 0);
    const depModules = pkgEntries.reduce((s, [, p]) => s + p.moduleCount, 0);
    lines.push(
      '',
      pc.dim(
        `Total analyzed: ${formatBytes(report.totalRenderedLength)} ` +
          `(${formatBytes(depBytes)} in ${depModules} node_modules module${depModules === 1 ? '' : 's'} ` +
          `across ${pkgEntries.length} package${pkgEntries.length === 1 ? '' : 's'})`,
      ),
    );
  }

  if (report.explained.length > 0) {
    lines.push('', pc.bold('Why are these modules in the bundle?'), '');
    for (const mod of report.explained.slice(0, limit)) {
      const names = [...mod.renderedExports, ...mod.removedExports];
      const collapse = !verbose && (names.length > 8 || looksMinified(names));
      const used =
        mod.renderedExports.length > 0
          ? collapse
            ? `${mod.renderedExports.length} of ${names.length} exports used`
            : `exports used: ${mod.renderedExports.join(', ')}`
          : 'no exports used';
      const removed =
        mod.removedExports.length > 0
          ? pc.dim(
              collapse
                ? `, ${mod.removedExports.length} tree-shaken`
                : `, tree-shaken: ${mod.removedExports.join(', ')}`,
            )
          : '';
      const gz = mod.gzipLength != null ? pc.dim(`  ~${formatBytes(mod.gzipLength)} gzip`) : '';
      lines.push(
        `  ${pc.cyan(displayId(mod.id, compact))}  ${pc.bold(formatBytes(mod.renderedLength))}${gz}  ${pc.dim(
          `(${used})`,
        )}${removed}`,
      );
      lines.push(printChain(mod.chain, mod.dynamic, mod.initialChunk, '    ', compact));
      lines.push('');
    }
    if (report.explained.length > limit) {
      lines.push(pc.dim(`  …and ${report.explained.length - limit} more (raise \`limit\` or use \`json\`)`), '');
    }
  }

  const hasRetained = report.sideEffectRetained.length > 0;
  if (hasRetained || commonJsExcluded > 0) {
    lines.push(
      '',
      pc.bold('Modules kept only for side effects') +
        pc.dim(' (no exports used, code still in the bundle)'),
      '',
    );
    for (const mod of report.sideEffectRetained.slice(0, limit)) {
      const gz = mod.gzipLength != null ? pc.dim(`  ~${formatBytes(mod.gzipLength)} gzip`) : '';
      lines.push(`  ${pc.yellow(displayId(mod.id, compact))}  ${pc.bold(formatBytes(mod.renderedLength))}${gz}`);
      lines.push(printChain(mod.chain, mod.dynamic, mod.initialChunk, '    ', compact));
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
    if (commonJsExcluded > 0) {
      const s = commonJsExcluded === 1;
      lines.push(
        pc.dim(
          `  ${commonJsExcluded} side-effect-only module${s ? '' : 's'} excluded because ${
            s ? 'it is' : 'they are'
          } CommonJS-wrapped (pass includeCommonJS to show ${s ? 'it' : 'them'}).`,
        ),
        '',
      );
    }
  } else {
    lines.push('', pc.green('No modules are retained purely by side effects. ✔'), '');
  }

  console.log(lines.join('\n'));
}

function printDiff(d: WhyDiff, limit: number, compact: boolean, lines: string[]): void {
  lines.push('', pc.bold('Changes since baseline') + pc.dim(` (${d.baseline})`), '');
  let any = false;
  if (d.newPackages.length) {
    lines.push(`  ${pc.green('+ new packages:')} ${d.newPackages.join(', ')}`);
    any = true;
  }
  if (d.removedPackages.length) {
    lines.push(`  ${pc.red('- removed packages:')} ${d.removedPackages.join(', ')}`);
    any = true;
  }
  for (const pd of d.packageDeltas.slice(0, limit)) {
    const col = pd.delta > 0 ? pc.red : pc.green;
    const sign = pd.delta > 0 ? '+' : '';
    lines.push(
      `  ${pc.cyan(pd.package)}  ${col(`${sign}${formatBytes(pd.delta)}`)}  ${pc.dim(
        `(${formatBytes(pd.before)} → ${formatBytes(pd.after)})`,
      )}`,
    );
    any = true;
  }
  if (d.newSideEffectRetained.length) {
    lines.push(
      `  ${pc.yellow('newly side-effect retained:')} ${d.newSideEffectRetained
        .map((id) => displayId(id, compact))
        .join(', ')}`,
    );
    any = true;
  }
  for (const f of d.chainFlips) {
    lines.push(`  ${pc.yellow('chain flipped')} ${displayId(f.id, compact)}: ${f.from} → ${f.to}`);
    any = true;
  }
  if (!any) lines.push(pc.dim('  no changes'));
  lines.push('');
}

function computeDiff(prev: WhyReport, cur: WhyReport, baseline: string): WhyDiff {
  const prevPkgs = prev.packages ?? {};
  const curPkgs = cur.packages ?? {};
  const newPackages = Object.keys(curPkgs)
    .filter((p) => !(p in prevPkgs))
    .sort();
  const removedPackages = Object.keys(prevPkgs)
    .filter((p) => !(p in curPkgs))
    .sort();

  const packageDeltas: WhyDiff['packageDeltas'] = [];
  for (const name of new Set([...Object.keys(prevPkgs), ...Object.keys(curPkgs)])) {
    const before = prevPkgs[name]?.renderedLength ?? 0;
    const after = curPkgs[name]?.renderedLength ?? 0;
    if (before !== after) packageDeltas.push({ package: name, before, after, delta: after - before });
  }
  packageDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const prevRetained = new Set((prev.sideEffectRetained ?? []).map((m) => m.id));
  const newSideEffectRetained = cur.sideEffectRetained
    .filter((m) => !prevRetained.has(m.id))
    .map((m) => m.id);

  const prevDynamic = new Map((prev.explained ?? []).map((m) => [m.id, m.dynamic]));
  const chainFlips: WhyDiff['chainFlips'] = [];
  for (const m of cur.explained) {
    const was = prevDynamic.get(m.id);
    if (was !== undefined && was !== m.dynamic) {
      chainFlips.push({ id: m.id, from: was ? 'dynamic' : 'static', to: m.dynamic ? 'dynamic' : 'static' });
    }
  }

  return { baseline, newPackages, removedPackages, packageDeltas, newSideEffectRetained, chainFlips };
}

export function why(options: WhyOptions = {}): Plugin {
  const {
    sideEffects = true,
    limit = 20,
    json,
    print = true,
    onReport,
    includeCommonJS = false,
    verbose = false,
    baseline,
    gzip = false,
    compactPaths = false,
  } = options;
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
              code: '',
            };
            rendered.set(id, info);
          }
          info.renderedLength += mod.renderedLength;
          info.chunks.push(file.fileName);
          if (gzip) info.code += mod.code ?? '';
          for (const e of mod.renderedExports) info.renderedExports.add(e);
          for (const e of mod.removedExports) info.removedExports.add(e);
        }
      }

      // Chunks reachable from an entry chunk through *static* imports ship on
      // first load; a module in any of them is in the initial chunk set.
      const eagerChunks = new Set<string>();
      const chunkQueue: string[] = [];
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry && !eagerChunks.has(file.fileName)) {
          eagerChunks.add(file.fileName);
          chunkQueue.push(file.fileName);
        }
      }
      while (chunkQueue.length > 0) {
        const chunk = bundle[chunkQueue.shift()!];
        if (chunk?.type !== 'chunk') continue;
        for (const imp of chunk.imports) {
          if (!eagerChunks.has(imp)) {
            eagerChunks.add(imp);
            chunkQueue.push(imp);
          }
        }
      }
      const isInitial = (chunks: string[]) => chunks.some((c) => eagerChunks.has(c));

      let totalRenderedLength = 0;
      for (const info of rendered.values()) totalRenderedLength += info.renderedLength;

      const packages: WhyReport['packages'] = {};
      const packageCode = gzip ? new Map<string, string[]>() : null;
      for (const info of rendered.values()) {
        const name = packageNameOf(info.id);
        if (!name) continue;
        const entry = (packages[name] ??= { renderedLength: 0, moduleCount: 0 });
        entry.renderedLength += info.renderedLength;
        entry.moduleCount += 1;
        if (packageCode) {
          const codes = packageCode.get(name);
          if (codes) codes.push(info.code);
          else packageCode.set(name, [info.code]);
        }
      }
      if (packageCode) {
        for (const [name, codes] of packageCode) packages[name].gzipLength = gzipSize(codes.join('\n'));
      }

      const explained: ExplainedModule[] = [];
      for (const info of rendered.values()) {
        if (!matches(info.id)) continue;
        const found = shortestChain(this, info.id);
        explained.push({
          id: info.id,
          package: packageNameOf(info.id),
          renderedLength: info.renderedLength,
          ...(gzip ? { gzipLength: gzipSize(info.code) } : {}),
          renderedExports: [...info.renderedExports],
          removedExports: [...info.removedExports],
          chunks: info.chunks,
          initialChunk: isInitial(info.chunks),
          chain: found?.chain ?? null,
          dynamic: found?.dynamic ?? false,
        });
      }
      explained.sort((a, b) => b.renderedLength - a.renderedLength);

      const sideEffectRetained: RetainedModule[] = [];
      let commonJsExcluded = 0;
      if (sideEffects) {
        const seenCjs = new Set<string>();
        for (const info of rendered.values()) {
          if (info.renderedLength === 0 || info.renderedExports.size > 0) continue;
          let reportId = info.id;
          if (info.id.startsWith('\0')) {
            const real = realCommonJsPath(info.id);
            if (!real) continue; // genuine virtual module
            if (seenCjs.has(real)) continue;
            seenCjs.add(real);
            if (!includeCommonJS) {
              commonJsExcluded += 1;
              continue;
            }
            reportId = real;
          }
          const modInfo = this.getModuleInfo(info.id);
          if (modInfo?.isEntry) continue;
          const found = shortestChain(this, info.id);
          sideEffectRetained.push({
            id: reportId,
            package: packageNameOf(reportId),
            renderedLength: info.renderedLength,
            ...(gzip ? { gzipLength: gzipSize(info.code) } : {}),
            removedExports: [...info.removedExports],
            sideEffectsField: sideEffectsFieldOf(reportId),
            initialChunk: isInitial(info.chunks),
            chain: found?.chain ?? null,
            dynamic: found?.dynamic ?? false,
          });
        }
        sideEffectRetained.sort((a, b) => b.renderedLength - a.renderedLength);
      }

      const report: WhyReport = {
        output: outputOptions.dir ?? outputOptions.file ?? '',
        totalRenderedLength,
        explained,
        sideEffectRetained,
        packages,
      };

      if (baseline) {
        try {
          const prev = JSON.parse(fs.readFileSync(baseline, 'utf8')) as WhyReport;
          report.diff = computeDiff(prev, report, baseline);
        } catch (e) {
          this.warn(`why: could not read baseline '${baseline}': ${(e as Error).message}`);
        }
      }

      if (print) {
        const matchedPackages =
          options.filter != null
            ? [...new Set(explained.map((m) => m.package).filter((p): p is string => p != null))].sort()
            : null;
        printReport(report, { limit, verbose, compact: compactPaths, matchedPackages, commonJsExcluded });
      }
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
