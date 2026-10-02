import assert from "node:assert/strict";
import test from "node:test";
import {
  EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE,
  createDefaultProfile,
} from "../../../dist/packages/config/src/index.js";
import {
  authorizeCredentialReference,
  withAuthorizedCredential,
} from "../../../dist/packages/secrets/src/index.js";

const reference = EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE;
const profileWithoutReference = createDefaultProfile();
const profileWithReference = { ...profileWithoutReference, credentialRef: reference };

test("no-key, offline and denied decisions do not call the parent resolver", async () => {
  let resolverCalls = 0;
  const resolver = () => {
    resolverCalls += 1;
    throw new Error("must not resolve before authorization");
  };
  const use = () => "used";

  assert.deepEqual(authorizeCredentialReference(profileWithoutReference, { kind: "authorized", credentialRef: reference }), {
    decision: "no-key",
  });
  assert.deepEqual(authorizeCredentialReference(profileWithReference, { kind: "offline" }), {
    decision: "offline",
  });
  assert.deepEqual(authorizeCredentialReference(profileWithReference, { kind: "denied" }), {
    decision: "denied",
  });
  assert.deepEqual(authorizeCredentialReference(profileWithReference, { kind: "authorized", credentialRef: "other" }), {
    decision: "denied",
  });
  assert.deepEqual(authorizeCredentialReference({ ...profileWithReference, apiKey: "secret" }, { kind: "authorized", credentialRef: reference }), {
    decision: "denied",
  });
  let getterCalls = 0;
  const accessorAuthorization = {};
  Object.defineProperty(accessorAuthorization, "kind", {
    get() {
      getterCalls += 1;
      return "authorized";
    },
  });
  assert.deepEqual(authorizeCredentialReference(profileWithReference, accessorAuthorization), {
    decision: "denied",
  });
  assert.equal(getterCalls, 0);

  for (const [profile, authorization] of [
    [profileWithoutReference, { kind: "authorized", credentialRef: reference }],
    [profileWithReference, { kind: "offline" }],
    [profileWithReference, { kind: "denied" }],
    [profileWithReference, { kind: "authorized", credentialRef: "other" }],
  ]) {
    const result = await withAuthorizedCredential(profile, authorization, resolver, use);
    assert.notEqual(result.decision.decision, "authorized");
    assert.equal(Object.hasOwn(result, "result"), false);
  }
  assert.equal(resolverCalls, 0);
});

test("an offline profile requires a fresh per-call authorization before resolving in parent memory", async () => {
  const secret = "PARENT_MEMORY_ONLY_CANARY";
  let resolverCalls = 0;
  let callbackCalls = 0;
  const result = await withAuthorizedCredential(
    profileWithReference,
    { kind: "authorized", credentialRef: reference },
    (requestedReference) => {
      resolverCalls += 1;
      assert.equal(requestedReference, reference);
      return secret;
    },
    (credential, requestedReference) => {
      callbackCalls += 1;
      assert.equal(requestedReference, reference);
      return credential === secret;
    },
  );
  assert.deepEqual(result, {
    decision: { decision: "authorized", credentialRef: reference },
    result: true,
  });
  assert.equal(resolverCalls, 1);
  assert.equal(callbackCalls, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("resolver failures are sanitized without the original message, stack or cause", async () => {
  const secret = "RESOLVER_EXCEPTION_SECRET_CANARY";
  const resolverError = new Error(`resolver failed with ${secret}`);
  resolverError.stack = `Sensitive stack ${secret}`;

  await assert.rejects(
    withAuthorizedCredential(
      profileWithReference,
      { kind: "authorized", credentialRef: reference },
      () => { throw resolverError; },
      () => assert.fail("callback must not run when resolution fails"),
    ),
    (error) => {
      assert.equal(error.message, "Credential resolution failed");
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(secret), false);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("credential-use throws and rejected promises are sanitized without message, stack or cause", async () => {
  const secret = "CALLBACK_EXCEPTION_SECRET_CANARY";
  const error = new Error(`callback failed with ${secret}`);
  error.stack = `Sensitive callback stack ${secret}`;
  error.cause = new Error(`nested cause ${secret}`);
  const authorized = { kind: "authorized", credentialRef: reference };
  const resolver = () => secret;

  for (const useCredential of [
    () => { throw error; },
    async () => { throw error; },
  ]) {
    await assert.rejects(
      withAuthorizedCredential(profileWithReference, authorized, resolver, useCredential),
      (rejected) => {
        assert.equal(rejected.message, "Credential use failed");
        assert.equal(rejected.cause, undefined);
        assert.equal(rejected.stack.includes(secret), false);
        assert.equal(rejected.message.includes(secret), false);
        return true;
      },
    );
  }
});

test("empty or missing parent credentials fail with the same generic diagnostic", async () => {
  for (const resolver of [() => undefined, () => ""]) {
    await assert.rejects(
      withAuthorizedCredential(
        profileWithReference,
        { kind: "authorized", credentialRef: reference },
        resolver,
        () => assert.fail("callback must not run without a credential"),
      ),
      { message: "Credential resolution failed" },
    );
  }
});
