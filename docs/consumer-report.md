# Using `rollup-plugin-why` — a consumer's field report

> **Context:** Feedback from wiring `rollup-plugin-why` (v0.1.0) into a from-scratch
> React + Rollup 4 application ([`some-rollup-app`](../../some-rollup-app)) — a moderately
> complex dashboard with code-split views, chart.js, lodash-es, date-fns, and deliberately
> side-effectful imports. The plugin was driven through the `filter`, `json`, `limit`,
> `onReport`, and `print` options, reading both the terminal and JSON output, and used in a
> real diagnose → experiment → re-measure loop. Written 2026-06-15.

I wired this into a real app from scratch, drove it through every documented option, read both
the terminal and JSON output, and ran an actual diagnose→experiment→re-measure loop with it.
This is what that felt like from the outside.

---

## The short version

It does the one thing I most want a bundle tool to do — answer *"why is this here?"* with a
concrete import chain — and the side-effect report is a genuinely novel feature I haven't seen
elsewhere. The JSON output is clean enough that it dropped straight into my analysis scripts
with zero parsing. The rough edges are mostly about **interpretation** (a couple of fields are
easy to misread) and **terminal ergonomics** (I had to write my own scripts to get the summary
view I wanted). Nothing here is a correctness complaint — the data matched on-disk reality every
time I cross-checked it.

---

## What I liked

**1. The import chains are the product.**
`src/index.tsx ⇢ App.tsx ⇢ Analytics.tsx ⇢ react-chartjs-2 ⇢ chart.js (via dynamic import)`
told me in one line what `rollup-plugin-visualizer` never does: not just *that* chart.js is
428 kB, but *how it got in* and that it's behind a dynamic import. That's the difference between
"the bundle is big" and "here's the edge to cut." This is the reason to use the plugin.

**2. The side-effect report is the differentiator.** A side-effectful package showed up with
`sideEffectsField: "none"` and the message *"package … does not declare sideEffects — ask the
maintainer to add `sideEffects: false`."* That's not just a diagnosis, it's a **prescription**,
and it correctly distinguishes "your problem" (first-party `global.css`, `field: null`) from
"the package's problem." I don't know of another tool that classifies retention this way.

**3. `renderedExports` / `removedExports` per module.** Seeing `chart.js` keep 31 exports and
tree-shake 16 (`PieController`, `registerables`, …) let me reason about whether tree-shaking was
even working. This is the data that made the lodash experiment below conclusive.

**4. The JSON report is well-shaped.** `{ explained, sideEffectRetained, packages }` is exactly
the right decomposition. I ran `node -e "require('./dist/why-report.json')..."` a dozen times to
compute per-package shares, chunk placement, and barrel-vs-deep counts — never once had to
massage the data. The `chain`, `dynamic`, `chunks`, `package` fields were all there. That's a
sign the data model was designed, not accreted.

**5. It earns trust.** Every number I spot-checked against `ls -l dist/chunks` lined up. Because
it reads Rollup's own `renderedLength`/`renderedExports` rather than re-parsing source, I
believed the output — which matters, because a bundle tool I don't trust I won't act on.

**6. Zero-friction setup.** Default export, dropped into a stack with babel + commonjs + postcss,
ran at `generateBundle` without interfering with anything. The side-effect report runs with no
options at all. `onReport` gave me the report object for a custom top-5-packages print in about
four lines.

---

## Friction & rough edges (roughly highest-impact first)

**1. `dynamic: true` is easy to misread as "deferred" — it isn't.** This was my biggest
stumble. 238 of 239 explained modules came back `dynamic: true`, including `date-fns`, which
actually sits in the **entry chunk** (`index.js`) and ships on first load. The flag reflects
*the single shortest chain found crossing a dynamic import*, but a module can also be reachable
statically and live in an eager chunk. When a static and dynamic chain tie in length, the plugin
appears to pick the dynamic one, which over-reports "dynamic." I only untangled it by
cross-referencing the `chunks` field myself.
- *Suggestion:* add an `initialChunk: boolean` (or `eager`) derived from chunk placement —
  answers "does this ship on first load?" directly. And/or, on ties, prefer the static chain.
  At minimum, annotate: `(via dynamic import; also present in initial chunk index.js)`.

**2. CommonJS side-effect modules are silently invisible.** A CJS polyfill (17.7 kB, imported
purely for its side effect) never appeared in the side-effect report because it's CJS → `\0`
virtual id → excluded by design. That exclusion is documented and I understand the rationale
(keep it actionable), but as a user hunting bloat, a 17.7 kB side-effect-only polyfill is
*exactly* what I'd want flagged — and it was the one I found last, by accident, via size
attribution.
- *Suggestion:* an opt-in `includeCommonJS: true` that maps the `\0...?commonjs-*` id back to the
  real file, or — cheaper — a one-line footnote: *"N side-effect-only modules excluded because
  they're CommonJS-wrapped (pass includeCommonJS to show them)."* Silent exclusion reads as
  "nothing there" when there's something there.

**3. The terminal output has no package-level summary or totals.** The printed `filter` section
is per-module, which is great for detail but means the "where are my bytes" question requires the
JSON + my own script. I computed total (845 kB) and shares (chart.js 50.6%) myself; `onReport`
made it possible but it should be the default.
- *Suggestion:* a built-in package summary table at the top of the printed report —
  `package · size · % of analyzed · module count`, top N — plus a grand total. That's the first
  thing I want to see, and right now it's the one thing I have to build.

**4. The `exports used:` list becomes noise for pre-bundled deps.** `chart.js/.../helpers.dataset.js`
printed ~110 mangled single-letter export names (`$, A, B, … a$, a0, a1 …`). It's technically
accurate but unreadable and it dominated the terminal.
- *Suggestion:* when the export count is large or names look minified, collapse to
  `114 of 118 exports used` and only enumerate when the names are meaningful (or behind a verbose
  flag).

**5. Chain selection looks non-deterministic on ties.** Related to #1: which of several
equal-length shortest chains gets reported seemed to depend on traversal order. For the CI /
agentic-feedback-loop use case the README pitches, this matters a lot — a `chain` that flips
between two equivalent paths build-to-build will create noise in any diff-based gate, even when
the actual graph didn't change.
- *Suggestion:* document and enforce a stable tie-break (prefer static; then shortest; then
  lexicographically smallest chain). Stability is a feature for the exact workflow you're selling.

**6. `filter` substring matching is convenient but a little blind.** `'lodash'` matching
`lodash-es` was what I wanted, but a substring like `'react'` would quietly match `react-dom`,
`react-chartjs-2`, etc. It's documented, but there's no feedback confirming what matched.
- *Suggestion:* echo `filter 'lodash' matched: lodash-es` once, and/or support
  `{ package: 'lodash-es' }` for exact package-name matching.

---

## Feature requests

**A. Baseline / diff mode — the one I'd want most.** The README pitches CI gates and agentic
loops via `onReport`, but I had to hand-roll the comparison (I literally diffed `128047 bytes`
against a previous run by eye). A first-class `why({ baseline: 'why-report.json' })` that prints
*what changed* — new packages, per-package size deltas, newly side-effect-retained modules,
chains that flipped static↔dynamic — would turn this from "a report I read" into "a guardrail
that catches regressions." This is the highest-leverage thing you could add, and it's squarely in
the niche you've already chosen.

**B. Transfer-size estimate (min+gzip), not just `renderedLength`.** `renderedLength` is
pre-minification, and I kept having to mentally discount it. chart.js at 428 kB raw is a very
different decision than its gzipped reality. Even a rough estimate per package would make the
numbers decision-grade. (I realize this is harder because you run before minification — but a
heuristic, clearly labeled, beats a number I have to caveat in my head.)

**C. "Explain one module, all chains."** The report gives the *shortest* chain, but the shortest
importer often isn't the one I can remove. A query mode — `why({ explain: 'date-fns' })` printing
*every* chain and *every* chunk for matching modules — would let me find the importer I can
actually cut. Even `maxChains: 3` on the existing output would help.

**D. Surface "this won't help."** My most instructive result was a non-result: switching all
lodash-es barrel imports to per-method deep imports changed the bundle by **zero bytes**
(128047 → 128047), because Rollup already tree-shakes the `sideEffects: false` barrel optimally.
The plugin's data let me *prove* that and avoid a pointless refactor — but I had to run the
experiment to learn it. If the report could hint "all of this package's retained modules are
internally shared; per-method imports won't reduce it," that's the kind of insight that saves
people the experiment. (Acknowledged: hard to compute reliably — lower priority, but it's where
the real value ceiling is.)

**E. Minor: compact path rendering.** Long `node_modules/date-fns/_lib/format/formatters.mjs`
chains wrap in the terminal. An option to render package-relative paths
(`date-fns › _lib/format/formatters`) would tighten the output.

---

## Bottom line

I'd reach for this again, specifically for the two questions it answers that other tools don't:
*why is this module here* and *why didn't it tree-shake.* The side-effect classification is a
real differentiator and the JSON model is clean enough to build on. The work I'd prioritize is
**(1) making `dynamic`/eager unambiguous**, **(2) a built-in package summary with totals in the
terminal**, and **(3) baseline-diff mode** — together those would take it from "an excellent
ad-hoc diagnostic" to "a thing I'd put in CI and trust to catch regressions." The fact that my
sharpest finding was the plugin *talking me out of* an optimization says a lot about how
trustworthy the underlying data is.
