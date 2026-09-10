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

import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { t as listTarball } from "tar";

const invocationDirectory = process.cwd();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (npmCli === undefined || !existsSync(npmCli)) {
  throw new Error("npm_execpath is unavailable; run this check through npm run test:package");
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "alternator-client-package-"));
const packageDirectory = join(temporaryRoot, "package");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  mkdirSync(packageDirectory);
  const tarball = stageTarball(resolveTarball(process.argv[2]));
  const manifest = inspectTarball(tarball);
  installConsumer(manifest);
  testRuntimeImports();
  testTypeScriptImports();
  testBrowserBundle();
  console.log(`Package smoke test passed: ${manifest.name}@${manifest.version}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function stageTarball(tarball) {
  const candidate = join(packageDirectory, "candidate.tgz");
  if (resolve(tarball) !== candidate) {
    copyFileSync(tarball, candidate);
  }
  return candidate;
}

function resolveTarball(requestedPackage) {
  if (requestedPackage !== undefined) {
    const possiblePath = isAbsolute(requestedPackage)
      ? requestedPackage
      : resolve(invocationDirectory, requestedPackage);
    if (existsSync(possiblePath) && statSync(possiblePath).isFile()) {
      return possiblePath;
    }
    if (requestedPackage.endsWith(".tgz")) {
      throw new Error(`Package tarball does not exist: ${possiblePath}`);
    }
    return pack(requestedPackage);
  }

  // Prove that prepack creates dist from a clean checkout.
  rmSync(join(repositoryRoot, "dist"), { recursive: true, force: true });
  return pack(repositoryRoot);
}

function pack(packageSpec) {
  const output = captureNpm([
    "pack",
    packageSpec,
    "--pack-destination",
    packageDirectory,
    "--silent",
  ]);
  const filename = output.trim().split(/\r?\n/u).at(-1);
  if (!filename) {
    throw new Error(`npm pack did not return a tarball name for ${packageSpec}`);
  }
  const tarball = join(packageDirectory, filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create expected tarball: ${tarball}`);
  }
  return tarball;
}

function inspectTarball(tarball) {
  const entries = new Set();
  const manifestChunks = [];
  listTarball({
    file: tarball,
    sync: true,
    onReadEntry(entry) {
      entries.add(entry.path);
      if (entry.path === "package/package.json") {
        entry.on("data", (chunk) => {
          manifestChunks.push(chunk);
        });
      }
    },
  });
  const requiredFiles = [
    "package/LICENSE",
    "package/README.md",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.cjs",
    "package/dist/index.d.ts",
    "package/dist/index.d.cts",
    "package/dist/edge.js",
    "package/dist/edge.d.ts",
    "package/dist/document.js",
    "package/dist/document.cjs",
    "package/dist/document.d.ts",
    "package/dist/document.d.cts",
    "package/dist/document-edge.js",
    "package/dist/document-edge.d.ts",
  ];
  const missingFiles = requiredFiles.filter((entry) => !entries.has(entry));
  if (missingFiles.length > 0) {
    throw new Error(`Package is missing required files:\n${missingFiles.join("\n")}`);
  }

  if (manifestChunks.length === 0) {
    throw new Error("Package manifest is empty");
  }
  const manifestJson = Buffer.concat(manifestChunks).toString("utf8");
  const manifest = JSON.parse(manifestJson);
  if (manifest.name !== "@scylladb/alternator-client") {
    throw new Error(`Unexpected package name: ${String(manifest.name)}`);
  }
  return manifest;
}

function installConsumer(manifest) {
  mkdirSync(consumerDirectory);
  const sourceLock = JSON.parse(
    readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"),
  );
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [
      name,
      lockedDependencyVersion(sourceLock, name, range),
    ]),
  );

  const documentPeer = "@aws-sdk/lib-dynamodb";
  const documentPeerRange = manifest.peerDependencies?.[documentPeer];
  if (typeof documentPeerRange !== "string") {
    throw new Error(`Package must declare ${documentPeer} as a peer dependency`);
  }
  dependencies[documentPeer] = lockedDependencyVersion(
    sourceLock,
    documentPeer,
    documentPeerRange,
  );
  dependencies[manifest.name] = "file:../package/candidate.tgz";

  const consumerManifest = {
    name: "alternator-client-package-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  };
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  );

  sourceLock.name = consumerManifest.name;
  sourceLock.version = consumerManifest.version;
  sourceLock.packages[""] = consumerManifest;
  writeFileSync(
    join(consumerDirectory, "package-lock.json"),
    `${JSON.stringify(sourceLock, null, 2)}\n`,
  );

  runNpm(
    [
      "install",
      "--package-lock-only",
      "--offline",
      "--ignore-scripts",
      "--strict-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
    consumerDirectory,
  );
  runNpm(
    [
      "ci",
      "--ignore-scripts",
      "--strict-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
    consumerDirectory,
  );
}

function lockedDependencyVersion(lock, name, range) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (typeof version !== "string") {
    throw new Error(`Package lock does not contain ${name}`);
  }
  if (typeof range !== "string" || !semver.satisfies(version, range)) {
    throw new Error(`Locked ${name}@${version} does not satisfy ${String(range)}`);
  }
  return version;
}

function testRuntimeImports() {
  const esmTest = join(consumerDirectory, "runtime.mjs");
  writeFileSync(
    esmTest,
    `import { AlternatorDynamoDBClient } from "@scylladb/alternator-client";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";
import { AlternatorDynamoDBClient as EdgeClient } from "@scylladb/alternator-client/edge";
import { AlternatorDynamoDBDocumentClient as EdgeDocumentClient } from "@scylladb/alternator-client/document/edge";

for (const exportedClass of [
  AlternatorDynamoDBClient,
  AlternatorDynamoDBDocumentClient,
  EdgeClient,
  EdgeDocumentClient,
]) {
  if (typeof exportedClass !== "function") throw new Error("Expected ESM class export");
}
`,
  );

  const cjsTest = join(consumerDirectory, "runtime.cjs");
  writeFileSync(
    cjsTest,
    `const { AlternatorDynamoDBClient } = require("@scylladb/alternator-client");
const { AlternatorDynamoDBDocumentClient } = require("@scylladb/alternator-client/document");

for (const exportedClass of [AlternatorDynamoDBClient, AlternatorDynamoDBDocumentClient]) {
  if (typeof exportedClass !== "function") throw new Error("Expected CommonJS class export");
}
`,
  );

  run(process.execPath, [esmTest], consumerDirectory);
  run(process.execPath, [cjsTest], consumerDirectory);
}

function testTypeScriptImports() {
  writeFileSync(
    join(consumerDirectory, "consumer.mts"),
    `import {
  AlternatorDynamoDBClient,
  type AlternatorDynamoDBClientConfig,
} from "@scylladb/alternator-client";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";
import {
  AlternatorDynamoDBClient as AlternatorEdgeClient,
  type AlternatorEdgeDynamoDBClientConfig,
} from "@scylladb/alternator-client/edge";
import { AlternatorDynamoDBDocumentClient as AlternatorEdgeDocumentClient } from "@scylladb/alternator-client/document/edge";

const config: AlternatorDynamoDBClientConfig = { seeds: ["127.0.0.1"] };
const edgeConfig: AlternatorEdgeDynamoDBClientConfig = {
  seeds: ["127.0.0.1"],
  runtime: "edge",
};
void new AlternatorDynamoDBClient(config);
void AlternatorDynamoDBDocumentClient.fromConfig(config);
void new AlternatorEdgeClient(edgeConfig);
void AlternatorEdgeDocumentClient.fromConfig(edgeConfig);
`,
  );
  writeFileSync(
    join(consumerDirectory, "consumer.cts"),
    `import {
  AlternatorDynamoDBClient,
  type AlternatorDynamoDBClientConfig,
} from "@scylladb/alternator-client";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";

const config: AlternatorDynamoDBClientConfig = { seeds: ["127.0.0.1"] };
void new AlternatorDynamoDBClient(config);
void AlternatorDynamoDBDocumentClient.fromConfig(config);
`,
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["consumer.mts", "consumer.cts"],
      },
      null,
      2,
    )}\n`,
  );

  const typeScript = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [typeScript, "--project", "tsconfig.json"], consumerDirectory);
}

function testBrowserBundle() {
  const browserEntry = join(consumerDirectory, "browser.mjs");
  writeFileSync(
    browserEntry,
    `import { AlternatorDynamoDBClient } from "@scylladb/alternator-client";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";

console.log(AlternatorDynamoDBClient, AlternatorDynamoDBDocumentClient);
`,
  );

  buildSync({
    entryPoints: [browserEntry],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: join(consumerDirectory, "browser-bundle.js"),
    logLevel: "warning",
  });
}

function runNpm(args, cwd = repositoryRoot) {
  run(process.execPath, [npmCli, ...args], cwd);
}

function captureNpm(args, cwd = repositoryRoot) {
  return capture(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd = repositoryRoot) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function capture(command, args, cwd = repositoryRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}
