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

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [mode, ...argumentsList] = process.argv.slice(2);

try {
  if (mode === "owner") {
    await runOwner(argumentsList);
  } else if (mode === "serve") {
    await runMarkedServer(argumentsList);
  } else {
    throw new Error(`Unknown CCM hard-kill fixture mode: ${String(mode)}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}

async function runOwner(argumentsList) {
  if (argumentsList.length !== 4) {
    throw new Error("owner mode requires core bundle, root, ready, and server-ready paths");
  }
  const [coreBundle, root, readyPath, serverReadyPath] = argumentsList;
  const core = await import(pathToFileURL(coreBundle).href);
  const spec = new core.ClusterSpec()
    .withTopology(core.ClusterTopology.singleDatacenter(1))
    .withTransports(core.AlternatorTransport.HTTP);
  const state = await core.CcmRunState.openDefault(
    () => Promise.reject(new Error("Owner fixture must not recover stale state")),
    { root },
  );
  const instanceId = `alternator-js-hard-kill-${process.pid}`;
  const ownership = await state.beginCluster(instanceId, spec, false);
  const clustersDirectory = join(state.runDirectory, "clusters");
  const ccmDirectory = join(clustersDirectory, instanceId);
  const clusterDirectory = join(ccmDirectory, instanceId);
  await makePrivateDirectory(clustersDirectory);
  await makePrivateDirectory(ccmDirectory);
  await makePrivateDirectory(clusterDirectory);
  await writeFile(
    join(clusterDirectory, "cluster.conf"),
    `name: ${instanceId}\nnodes:\n  - node1\nseeds:\n  - node1\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const commandLog = join(ccmDirectory, "ccm-command-hard-kill.log");
  await writeFile(commandLog, "> fake-ccm create\nFAKE-CCM-COMMAND create\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  const address = `127.0.${ownership.ccmId}.1`;
  const server = spawn(
    process.execPath,
    [process.argv[1], "serve", address, "8080", serverReadyPath],
    {
      detached: true,
      env: { ...process.env, SCYLLA_CCM_RUN_DIR: state.runDirectory },
      shell: false,
      stdio: "ignore",
    },
  );
  if (server.pid === undefined) {
    throw new Error("Marked fake CCM server has no process ID");
  }
  await waitForFile(serverReadyPath, 10_000);
  const serverStartTicks = await processStartTicks(server.pid);
  await publishJson(readyPath, {
    ccmId: ownership.ccmId,
    commandLog,
    instanceId,
    manifestPath: join(state.runDirectory, "owned", `${instanceId}.json`),
    reservationPath: join(root, "reservations", String(ownership.ccmId)),
    runDirectory: state.runDirectory,
    serverPid: server.pid,
    serverStartTicks,
  });

  await new Promise(() => undefined);
}

async function runMarkedServer(argumentsList) {
  if (argumentsList.length !== 3) {
    throw new Error("serve mode requires address, port, and ready path");
  }
  const [address, portText, readyPath] = argumentsList;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid fake CCM server port: ${portText}`);
  }
  const server = createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await publishJson(readyPath, { pid: process.pid, startTicks: await processStartTicks(process.pid) });
}

async function makePrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function publishJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

async function processStartTicks(pid) {
  const contents = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = contents.lastIndexOf(")");
  const startTicks = contents.slice(closing + 2).trim().split(/\s+/u)[19];
  if (closing < 0 || startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) {
    throw new Error(`Malformed process identity for PID ${pid}`);
  }
  return startTicks;
}
