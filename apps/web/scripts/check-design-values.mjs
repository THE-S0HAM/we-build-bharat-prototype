/**
 * Design-value guard for CSS (requirements 12.1, 12.2, 17.2; design.md §6.3).
 *
 * `src/styles/tokens.css` is the only file in the product allowed to hold a
 * design value. Every other stylesheet references tokens through `var(--…)`:
 * "a hex code or pixel size in a component is a defect" (design.md §6.3).
 *
 * Why a script and not a linter plugin: ESLint does not parse CSS, and the CSS
 * languages that plugin into it (`@eslint/css`) or alongside it (Stylelint) are
 * a new toolchain — a parser, a config, a rule set — for what is three regular
 * expressions over eleven files. NFC-2 keeps the dependency surface closed.
 * `npm run lint` runs this after ESLint, so CI enforces it through the existing
 * quality gate (requirement 17.2).
 *
 * The trade-off of not parsing: this reads text, so it strips the two contexts
 * where a literal is legitimate before searching.
 *
 *   1. Comments. `tokens.css` values are quoted all over the codebase in
 *      explanatory comments ("below --bp-md (900px)", contrast tables).
 *   2. At-rule preludes. Media queries cannot read custom properties, so every
 *      breakpoint query repeats its token's number literally — the one
 *      documented exception in the codebase.
 *
 * Both are blanked with spaces rather than removed, so reported line and column
 * numbers still point at the real position in the file.
 *
 * Usage (from apps/web):
 *   node scripts/check-design-values.mjs
 *
 * Exit codes: 0 clean, 1 violations found or nothing scanned.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/web`, resolved from this file so the script runs from any cwd. */
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(PROJECT_ROOT, "src");

/** The single home of design values. Exempt by definition. */
const TOKENS_DIR = join(SOURCE_DIR, "styles");

const CHECKS = [
  {
    pattern: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])/g,
    message:
      "hex colour literal — every colour is a custom property in src/styles/tokens.css (requirement 12.1, design.md §6.3); reference it with var(--…)",
  },
  {
    pattern: /\b(?:rgba?|hsla?)\(/g,
    message:
      "raw colour function — tints and shadows are composed in src/styles/tokens.css (requirement 12.1, design.md §6.3); reference the token with var(--…)",
  },
  {
    pattern: /(?<![\w-])-?(?:\d*\.)?\d+px(?![\w-])/g,
    message:
      "raw px value — type sizes, spacing, radii, borders and control heights are custom properties in src/styles/tokens.css (requirement 12.1, design.md §6.3); use the matching --fs-*, --sp-*, --radius-* or --control-* token. Breakpoint literals inside an @media prelude are the one exception",
  },
];

/** Replace every match with same-length whitespace, keeping newlines in place. */
function blank(source, pattern) {
  return source.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * Remove the two contexts where a literal is legitimate: comments, and the
 * prelude of an at-rule (`@media (max-width: 899px)`, `@import "…"`), which runs
 * from the `@` to the `{` that opens the block or the `;` that ends the rule.
 */
function scannable(source) {
  return blank(blank(source, /\/\*[\s\S]*?\*\//g), /@[\w-]+[^;{]*/g);
}

function positionOf(source, index) {
  const preceding = source.slice(0, index);
  const lastBreak = preceding.lastIndexOf("\n");

  return {
    line: preceding.split("\n").length,
    column: index - lastBreak,
  };
}

function cssFilesIn(directory) {
  const found = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (path !== TOKENS_DIR) {
        found.push(...cssFilesIn(path));
      }
    } else if (entry.name.endsWith(".css")) {
      found.push(path);
    }
  }

  return found;
}

function violationsIn(path) {
  const source = readFileSync(path, "utf8");
  const searchable = scannable(source);
  const found = [];

  for (const { pattern, message } of CHECKS) {
    for (const match of searchable.matchAll(pattern)) {
      const { line, column } = positionOf(source, match.index);

      found.push({ line, column, message: `${message} (found "${match[0].trim()}")` });
    }
  }

  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

const files = cssFilesIn(SOURCE_DIR);

if (files.length === 0) {
  // A guard that silently scans nothing is worse than no guard at all.
  console.error(`No CSS files found under ${SOURCE_DIR}. The design-value guard scanned nothing.`);
  process.exit(1);
}

let total = 0;

for (const path of files) {
  const violations = violationsIn(path);

  if (violations.length === 0) {
    continue;
  }

  total += violations.length;
  console.error(`\n${relative(PROJECT_ROOT, path)}`);

  for (const { line, column, message } of violations) {
    console.error(`  ${line}:${column}  error  ${message}`);
  }
}

if (total > 0) {
  const plural = total === 1 ? "" : "s";
  console.error(
    `\n${total} design-value violation${plural} in CSS. src/styles/tokens.css is the only file design values may live in (design.md §6.3).\n`,
  );
  process.exit(1);
}

console.log(`Design values: ${files.length} CSS files clean, tokens only.`);
