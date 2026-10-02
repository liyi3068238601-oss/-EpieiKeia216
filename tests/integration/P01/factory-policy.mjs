const APPROVED_MODEL_ID = "deepseek-flash";
const SYNTHETIC_API_KEY = "p01-u09-loopback-only";

export function resolveGateMode(value) {
  if (value === undefined || value === "") return "enabled";
  if (value === "enabled" || value === "disabled") return value;
  throw new Error("P01_U10_GATE_MODE must be enabled or disabled");
}

export function validateLoopbackOrigin(value) {
  let endpoint;
  try { endpoint = new URL(value); }
  catch { throw new Error("P01 relay must use an assigned loopback HTTP origin"); }
  const hostname = endpoint.hostname.toLowerCase();
  const port = Number(endpoint.port);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(hostname) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || port === 9229 ||
      endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("P01 relay must use an assigned loopback HTTP origin");
  }
  return endpoint.origin;
}

export function assertQualifiedModel(options, { endpointOrigin }) {
  if (options?.modelId !== APPROVED_MODEL_ID) throw new Error("P01 model is not qualified");
  const access = options?.providerConfig?.access;
  const apiKey = access?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("P01 model credential is unavailable");
  }
  if (apiKey !== SYNTHETIC_API_KEY) throw new Error("P01 candidate rejects external credentials");
  const relay = validateLoopbackOrigin(endpointOrigin);
  if (options?.providerConfig?.api?.baseUrl !== `${relay}/v1`) {
    throw new Error("P01 mock provider is not the assigned loopback fixture");
  }
  if (options?.requestDependencies?.requestAuth) {
    throw new Error("P01 candidate rejects external request authentication");
  }
}

function guardModel(delegate, modelOptions, policy) {
  const wrapped = Object.create(delegate);
  Object.defineProperties(wrapped, {
    generateText: {
      value: (...args) => {
        assertQualifiedModel(modelOptions, policy);
        return delegate.generateText.apply(delegate, args);
      },
    },
    streamText: {
      value: (...args) => {
        assertQualifiedModel(modelOptions, policy);
        return delegate.streamText.apply(delegate, args);
      },
    },
    bind: {
      value: (...args) => guardModel(delegate.bind.apply(delegate, args), modelOptions, policy),
    },
  });
  return wrapped;
}

/** Keep native model construction/warmup intact; refuse unqualified execution at inference. */
export function createQualifiedModelAdapter(delegate, policy) {
  return {
    createModel(modelOptions) {
      const model = delegate.createModel.call(delegate, modelOptions);
      return guardModel(model, modelOptions, policy);
    },
    addStatusSink(sink) {
      return delegate.addStatusSink.call(delegate, sink);
    },
    setModelIoFullRetentionEnabled(enabled) {
      return delegate.setModelIoFullRetentionEnabled.call(delegate, enabled);
    },
  };
}

export function createOwnedExecutionLifecycle(executionPort) {
  let closePromise;
  return {
    close() {
      closePromise ??= Promise.resolve().then(() => executionPort.close?.());
      return closePromise;
    },
    get closed() { return closePromise !== undefined; },
  };
}

