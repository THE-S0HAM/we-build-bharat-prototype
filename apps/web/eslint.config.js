import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Design-system guard for TypeScript and JSX (requirements 12.1, 12.2, 17.2;
 * design.md §6.3).
 *
 * Every entry is an AST selector rather than a text search, so it reports the
 * offending node's own line and cannot be defeated by formatting. The matching
 * guard for `.css` files lives in `scripts/check-design-values.mjs`, which
 * `npm run lint` runs after ESLint — ESLint does not parse CSS, and a CSS
 * plugin is a new toolchain for two regular expressions.
 */
const designSystemGuards = [
  {
    // `style={{ color: "red" }}` — any entry that is not a CSS custom property.
    // §6.3 allows exactly one dynamic-value escape hatch: token-backed custom
    // properties set on the element, e.g. `style={{ "--bar-width": pct }}`. That
    // form is a string-literal key beginning with `--`, so it is excluded here
    // and everything else — shorthand keys, computed keys, spreads — is not.
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > ObjectExpression > *:not(Property[key.value=/^--/])',
    message:
      "Inline style literals are the root cause of the 'eight templates' problem (requirement 12.2, design.md §6.3). Put the rule in the component's CSS file and apply a class. A genuinely dynamic value passes through a token-backed CSS custom property: style={{ \"--bar-width\": `${pct}%` }}.",
  },
  {
    // `style={someObject}` — hoisting the object out of the JSX would leave the
    // rule above with nothing to match, so the attribute only accepts a literal.
    selector:
      'JSXAttribute[name.name="style"] > JSXExpressionContainer > *:not(ObjectExpression)',
    message:
      "A `style` attribute may carry only a literal object of `--custom-property` entries (requirement 12.2, design.md §6.3). Moving the object into a variable does not make it a class.",
  },
  {
    // `"#0b6b5b"`, `"#fff"`. Template literals and JSX text are not covered; the
    // CSS guard catches the file where a colour would actually be applied.
    selector: "Literal[value=/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])/]",
    message:
      "Hex colour literal. Every colour in the product is a custom property in src/styles/tokens.css — the only file design values may live in (requirement 12.1, design.md §6.3). Reference it with var(--…) from a CSS class.",
  },
  {
    // `"14px"`, `"0 1px 2px"`.
    selector: "Literal[value=/[0-9](?:\\.[0-9]+)?px/]",
    message:
      "Raw px value. Type sizes, spacing, radii and control heights are custom properties in src/styles/tokens.css (requirement 12.1, design.md §6.3). Use the matching --fs-*, --sp-* or --control-* token from a CSS class.",
  },
];

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "*.tsbuildinfo"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // A leading underscore marks a binding that exists for its type or
      // position but is intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Application source. `src/styles/**` holds the token definitions and is the
    // one place a design value is allowed, so it is deliberately out of scope —
    // it contains no TypeScript today, and the exclusion states the rule anyway.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/styles/**"],
    rules: {
      "no-restricted-syntax": ["error", ...designSystemGuards],
    },
  },
  {
    // Node-executed tooling, not browser code. The design-value guards do not
    // apply here: `scripts/check-design-values.mjs` holds the patterns it
    // searches for, and would flag itself.
    files: ["scripts/**/*.mjs", "*.config.{js,ts}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
);
