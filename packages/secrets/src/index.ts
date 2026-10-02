import {
  EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE,
  parseProfileV1,
  type CredentialReference,
} from "../../config/src/index.js";

export interface AuthorizedCredentialUse {
  readonly kind: "authorized";
  readonly credentialRef: CredentialReference;
}

export type CredentialAuthorization =
  | AuthorizedCredentialUse
  | { readonly kind: "offline" }
  | { readonly kind: "denied" };

export type CredentialDecision =
  | { readonly decision: "authorized"; readonly credentialRef: CredentialReference }
  | { readonly decision: "no-key" }
  | { readonly decision: "offline" }
  | { readonly decision: "denied" };

export type ParentCredentialResolver = (reference: CredentialReference) => string | undefined;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (!record(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.includes(key)) && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function decision(value: CredentialDecision): CredentialDecision {
  return Object.freeze(value);
}

/** Resolve authorization for this invocation only; profile data cannot grant network access. */
export function authorizeCredentialReference(
  profileValue: unknown,
  authorizationValue: unknown,
): CredentialDecision {
  let profile;
  try {
    profile = parseProfileV1(profileValue);
  } catch {
    return decision({ decision: "denied" });
  }

  if (profile.credentialRef === undefined) return decision({ decision: "no-key" });
  if (!record(authorizationValue) || Object.getOwnPropertySymbols(authorizationValue).length > 0) {
    return decision({ decision: "denied" });
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(authorizationValue, "kind");
  if (kindDescriptor === undefined || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") {
    return decision({ decision: "denied" });
  }
  const kind = kindDescriptor.value;
  if (kind === "offline") {
    return exactDataRecord(authorizationValue, ["kind"])
      ? decision({ decision: "offline" })
      : decision({ decision: "denied" });
  }
  if (kind === "denied") {
    return decision({ decision: "denied" });
  }
  if (
    kind !== "authorized" ||
    !exactDataRecord(authorizationValue, ["kind", "credentialRef"]) ||
    authorizationValue.credentialRef !== EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE
  ) {
    return decision({ decision: "denied" });
  }
  return decision({ decision: "authorized", credentialRef: EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE });
}

/**
 * Use a parent-process credential only after this call's authorization has been checked.
 * Resolver failures are replaced with a fixed error that carries no original cause or text.
 */
export async function withAuthorizedCredential<T>(
  profileValue: unknown,
  authorizationValue: unknown,
  resolver: ParentCredentialResolver,
  useCredential: (credential: string, reference: CredentialReference) => T | Promise<T>,
): Promise<{ readonly decision: CredentialDecision; readonly result?: T }> {
  const authorization = authorizeCredentialReference(profileValue, authorizationValue);
  if (authorization.decision !== "authorized") {
    return Object.freeze({ decision: authorization });
  }

  let credential: string | undefined;
  try {
    credential = resolver(authorization.credentialRef);
  } catch {
    throw new Error("Credential resolution failed");
  }
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error("Credential resolution failed");
  }

  let result: T;
  try {
    result = await useCredential(credential, authorization.credentialRef);
  } catch {
    throw new Error("Credential use failed");
  }
  return Object.freeze({ decision: authorization, result });
}
