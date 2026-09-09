/*
 * Copyright ScyllaDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import js from "@eslint/js";
import licenseHeaderPlugin from "eslint-plugin-license-header";
import globals from "globals";
import tseslint from "typescript-eslint";

const tsFiles = ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "vitest.integration.config.ts", "tsup.config.ts"];
const jsFiles = ["*.js", "scripts/**/*.mjs"];
const licenseHeader = [
  "/*",
  " * Copyright ScyllaDB, Inc.",
  " *",
  " * Licensed under the Apache License, Version 2.0 (the \"License\");",
  " * you may not use this file except in compliance with the License.",
  " * You may obtain a copy of the License at",
  " *",
  " * http://www.apache.org/licenses/LICENSE-2.0",
  " *",
  " * Unless required by applicable law or agreed to in writing, software",
  " * distributed under the License is distributed on an \"AS IS\" BASIS,",
  " * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
  " * See the License for the specific language governing permissions and",
  " * limitations under the License.",
  " */",
];

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,ts}"],
    plugins: {
      "license-header": licenseHeaderPlugin,
    },
    rules: {
      "license-header/header": ["error", licenseHeader],
    },
  },
  {
    ...js.configs.recommended,
    files: jsFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: tsFiles,
  })),
  {
    files: tsFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
);
