import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "../.runtime-cache", "test-results"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["load/**/*.js"],
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __VU: "readonly",
        __ITER: "readonly",
        open: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["tests/**/*.ts", "**/*.{test,spec}.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(IfStatement, ConditionalExpression, LogicalExpression, SwitchCase) CallExpression:matches([callee.name='expect'], [callee.name='assert'], [callee.object.name='assert'])",
          message:
            "Do not place assertions behind conditionals; assertions must execute deterministically.",
        },
        {
          selector:
            "CallExpression[callee.name=/^(it|test)$/] > :matches(FunctionExpression, ArrowFunctionExpression):not(:has(CallExpression[callee.name='expect'])):not(:has(CallExpression[callee.name='assert'])):not(:has(CallExpression[callee.object.name='assert'])):not(:has(CallExpression[callee.object.name='expect'][callee.property.name='hasAssertions'])):not(:has(CallExpression[callee.object.name='expect'][callee.property.name='assertions']))",
          message:
            "Each test block must contain at least one assert/expect assertion or explicit expect.hasAssertions()/expect.assertions().",
        },
      ],
    },
  },
);
