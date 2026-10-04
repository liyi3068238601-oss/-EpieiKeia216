"use strict";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const electron = require("electron");
const {
  installDefaultProtocolClientGuard,
  installRegistryWriteGuard,
} = require("./registry-write-guard.cjs");

// These observed startup side effects run in Electron main. P02 blocks them at
// their call sites before OS/native effects; this is harness instrumentation,
// not a machine-wide or operating-system sandbox.
installRegistryWriteGuard({ childProcess, env: process.env, processInfo: process });
installDefaultProtocolClientGuard({ app: electron.app, env: process.env, processInfo: process });
syncBuiltinESMExports();
require(path.resolve(__dirname, "../P01/electron-network-guard.cjs"));
