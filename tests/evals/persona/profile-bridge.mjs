import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_MODEL_IDS,
  EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE,
  buildChildEnvironment,
  createDefaultProfile,
  exportPortableProfile,
  resolveOwnedProfilePaths,
} from "../../../dist/packages/config/src/index.js";
import { authorizeCredentialReference } from "../../../dist/packages/secrets/src/index.js";

const SYSTEM_ENV_KEYS = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBridgeSpec(spec) {
  if (!isRecord(spec)) throw new Error("invalid_spec");
  const allowed = new Set(["mode", "model", "scenario", "profile_root", "relay_origin", "output_dir", "system_env"]);
  if (Object.keys(spec).some((key) => !allowed.has(key))) throw new Error("invalid_spec");
  if (spec.mode !== "mock" && spec.mode !== "real") throw new Error("invalid_mode");
  if (!DEEPSEEK_MODEL_IDS.includes(spec.model)) throw new Error("invalid_model");
  if (typeof spec.profile_root !== "string" || !path.isAbsolute(spec.profile_root)) throw new Error("invalid_profile_root");
  if (typeof spec.relay_origin !== "string") throw new Error("invalid_relay_origin");
  if (!isRecord(spec.system_env) || Object.keys(spec.system_env).some((key) => !SYSTEM_ENV_KEYS.has(key.toUpperCase()))) {
    throw new Error("invalid_system_environment");
  }
  if (spec.scenario !== undefined && !isRecord(spec.scenario)) throw new Error("invalid_scenario");
  if (spec.output_dir !== undefined && (typeof spec.output_dir !== "string" || !path.isAbsolute(spec.output_dir))) {
    throw new Error("invalid_output_dir");
  }
  return spec;
}

/** Build U08-owned paths and a per-call credential decision without resolving any secret. */
export async function createProfileBridgePayload(value) {
  const spec = validateBridgeSpec(value);
  await mkdir(spec.profile_root, { recursive: true });
  const rootInfo = await lstat(spec.profile_root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("invalid_profile_root");

  const paths = resolveOwnedProfilePaths(spec.profile_root);
  for (const [key, directory] of Object.entries(paths)) {
    if (key === "profileFile") continue;
    await mkdir(directory, { recursive: true });
  }

  const profileValue = {
    ...createDefaultProfile(),
    modelId: spec.model,
    ...(spec.mode === "real" ? { credentialRef: EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE } : {}),
  };
  const profile = exportPortableProfile(profileValue);
  const authorization = spec.mode === "real"
    ? { kind: "authorized", credentialRef: EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE }
    : { kind: "offline" };
  const credentialDecision = authorizeCredentialReference(profile, authorization);
  if (spec.mode === "real" && credentialDecision.decision !== "authorized") throw new Error("credential_not_authorized");
  if (spec.mode === "mock" && credentialDecision.decision !== "no-key") throw new Error("mock_credential_not_offline");

  const env = buildChildEnvironment(paths, {
    endpointOrigin: spec.relay_origin,
    systemEnv: spec.system_env,
  });
  await writeFile(paths.profileFile, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    env,
    profile,
    credential_decision: credentialDecision,
    paths,
  };
}

async function main(argv) {
  if (argv.length !== 2) throw new Error("usage");
  const [specPath, outputPath] = argv;
  if (!path.isAbsolute(specPath) || !path.isAbsolute(outputPath)) throw new Error("paths_must_be_absolute");
  const spec = JSON.parse(await (await import("node:fs/promises")).readFile(specPath, "utf8"));
  const result = await createProfileBridgePayload(spec);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("P01_PROFILE_BRIDGE_REJECTED\n");
    process.exitCode = 1;
  });
}
