import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(IfStatement, ConditionalExpression, LogicalExpression, SwitchCase) CallExpression[callee.name='expect']",
          message:
            "Do not place expect() behind conditionals; assertions must execute deterministically.",
        },
        {
          selector:
            "CallExpression[callee.name=/^(it|test)$/] > :matches(FunctionExpression, ArrowFunctionExpression):not(:has(CallExpression[callee.name='expect'])):not(:has(CallExpression[callee.object.name='expect'][callee.property.name='hasAssertions'])):not(:has(CallExpression[callee.object.name='expect'][callee.property.name='assertions']))",
          message:
            "Each test block must contain at least one assertion or explicit expect.hasAssertions()/expect.assertions().",
        },
      ],
    },
  },
);
