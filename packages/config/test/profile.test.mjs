import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEEPSEEK_MODEL_IDS,
  EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE,
  buildChildEnvironment,
  createDefaultProfile,
  exportPortableProfile,
  importPortableProfile,
  parseProfileV1,
  resolveOwnedProfilePaths,
} from "../../../dist/packages/config/src/index.js";

function makeOwnedRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p01-u08-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("default profile is offline, no-key, versioned and limited to the official model IDs", () => {
  const profile = createDefaultProfile();
  assert.deepEqual(profile, {
    schemaVersion: 1,
    providerId: "deepseek-official",
    modelId: "deepseek-flash",
    networkMode: "offline",
  });
  assert.deepEqual(DEEPSEEK_MODEL_IDS, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(Object.hasOwn(profile, "credentialRef"), false);
  assert.equal(parseProfileV1(profile).networkMode, "offline");
});

test("profile schema rejects secrets, arbitrary credential references, paths and persisted authorization", () => {
  const canary = "U08_PROFILE_SECRET_CANARY";
  const base = createDefaultProfile();
  for (const extra of [
    { apiKey: canary },
    { credentialRef: canary },
    { authorization: { allowed: true } },
    { root: "C:\\Users\\somewhere" },
    { networkMode: "online" },
  ]) {
    assert.throws(() => parseProfileV1({ ...base, ...extra }), /Invalid P01 profile/);
  }
});

test("portable export/import carries only validated non-secret settings across independent roots", (t) => {
  const profile = {
    ...createDefaultProfile(),
    modelId: "deepseek-v4-pro",
    credentialRef: EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE,
  };
  const portable = exportPortableProfile(profile);
  assert.deepEqual(importPortableProfile(JSON.parse(JSON.stringify(portable))), portable);
  assert.equal(JSON.stringify(portable).includes("C:\\"), false);
  assert.equal(JSON.stringify(portable).includes("apiKey"), false);
  assert.equal(JSON.stringify(portable).includes("authorization"), false);

  const firstPaths = resolveOwnedProfilePaths(makeOwnedRoot(t));
  const secondPaths = resolveOwnedProfilePaths(makeOwnedRoot(t));
  for (const key of ["root", "profileFile", "home", "data", "temp", "workspace", "storage", "userData", "sessionData"]) {
    assert.notEqual(firstPaths[key], secondPaths[key]);
  }
});

test("owned profile paths derive every app directory beneath the isolated root", (t) => {
  const root = makeOwnedRoot(t);
  const paths = resolveOwnedProfilePaths(root);
  assert.equal(paths.root, fs.realpathSync.native(root));
  for (const value of Object.values(paths)) {
    const relative = path.relative(paths.root, value);
    assert.equal(path.isAbsolute(relative), false);
    assert.notEqual(relative, "..");
    assert.equal(relative.startsWith(`..${path.sep}`), false);
  }
  assert.equal(paths.profileFile, path.join(paths.root, "profile.json"));
  assert.equal(paths.appData, path.join(paths.home, "AppData", "Roaming"));
  assert.equal(paths.localAppData, path.join(paths.home, "AppData", "Local"));
});

test("owned paths reject a linked root and a junction or symlink escaping to another profile", (t) => {
  const parent = makeOwnedRoot(t);
  const root = path.join(parent, "owned");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);

  const junctionRoot = path.join(parent, "root-link");
  try {
    fs.symlinkSync(root, junctionRoot, "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => resolveOwnedProfilePaths(junctionRoot), /link|physical directory/i);

  fs.symlinkSync(outside, path.join(root, "home"), "junction");
  assert.throws(() => resolveOwnedProfilePaths(root), /link|outside/i);
});

test("child environment preserves only the system allowlist and owned profile paths", (t) => {
  const canary = "U08_PARENT_KEY_CANARY_DO_NOT_COPY";
  const paths = resolveOwnedProfilePaths(makeOwnedRoot(t));
  const env = buildChildEnvironment(paths, {
    endpointOrigin: "http://127.0.0.1:43127",
    systemEnv: {
      Path: "C:\\node;C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE",
      OPENAI_API_KEY: canary,
      DEEPSEEK_API_KEY: canary,
      NODE_OPTIONS: canary,
      HTTP_PROXY: canary,
    },
  });
  assert.equal(env.PATH, "C:\\node;C:\\Windows\\System32");
  assert.equal(env.HOME, paths.home);
  assert.equal(env.USERPROFILE, paths.home);
  assert.equal(env.APPDATA, paths.appData);
  assert.equal(env.LOCALAPPDATA, paths.localAppData);
  assert.equal(env.TEMP, paths.temp);
  assert.equal(env.TMP, paths.temp);
  assert.equal(env.ZCODE_DATA_BASE_DIR, paths.data);
  assert.equal(env.ZCODE_STORAGE_DIR, paths.storage);
  assert.equal(env.ZCODE_DESKTOP_HOME_DIR, paths.home);
  assert.equal(env.ZCODE_DESKTOP_USER_DATA_DIR, paths.userData);
  assert.equal(env.ZCODE_DESKTOP_SESSION_DATA_DIR, paths.sessionData);
  assert.equal(env.ZCODE_ENDPOINT_ORIGIN, "http://127.0.0.1:43127");
  assert.equal(env.ZCODE_BASE_URL, env.ZCODE_ENDPOINT_ORIGIN);
  assert.equal(env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT, "1");
  assert.equal(JSON.stringify(env).includes(canary), false);
  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATHEXT", "PATH", "SYSTEMROOT", "TEMP", "TMP",
    "USERPROFILE", "WINDIR", "ZCODE_BASE_URL", "ZCODE_DATA_BASE_DIR", "ZCODE_DESKTOP_HOME_DIR",
    "ZCODE_DESKTOP_SESSION_DATA_DIR", "ZCODE_DESKTOP_USER_DATA_DIR", "ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT",
    "ZCODE_ENDPOINT_ORIGIN", "ZCODE_STORAGE_DIR",
  ].sort());
});

test("child environment requires an OS-assigned loopback origin and refuses fixed 9229", (t) => {
  const paths = resolveOwnedProfilePaths(makeOwnedRoot(t));
  for (const endpointOrigin of [
    "http://127.0.0.1:0",
    "http://127.0.0.1:9229",
    "https://127.0.0.1:43127",
    "http://example.com:43127",
    "http://127.0.0.1:43127/path",
    "http://user@127.0.0.1:43127",
  ]) {
    assert.throws(
      () => buildChildEnvironment(paths, { endpointOrigin, systemEnv: {} }),
      /assigned loopback HTTP origin/,
      endpointOrigin,
    );
  }
});
