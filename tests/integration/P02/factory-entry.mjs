import { createFileSystemError } from "@p01/native-filesystem-contracts";
import { createNodeExecutionAdapter } from "@p01/native-execution";
import { createNodeFileSystemAdapter } from "@p01/native-filesystem";
import { createModelAdapter } from "@p01/native-model-factory";
import { createRuntimeAiSdkModelExecutionConfig } from "@p01/native-model-config";
import {
  addZCodePluginMarketplace,
  installZCodeMarketplacePlugin,
  listZCodePlugins,
  setZCodePluginEnabled,
} from "@p01/native-plugin-api";
import { createZCodeApp as nativeCreateZCodeApp } from "@p01/native-app";
import { getCurrentModelInvocationContext } from "@p01/native-invocation-context";
import { createDurableHost } from "./durable-host.mjs";
import { createTurnEventCollector } from "@p01/turn-projection";
import { parseProfileV1, resolveOwnedProfilePaths } from "@p01/profile";
import { authorizeCredentialReference } from "@p01/secrets";
import { createU10ProtocolFactory } from "../P01/factory.mjs";

export const createZCodeApp = createU10ProtocolFactory({
  nativeCreateZCodeApp,
  nativeModules: {
    createNodeExecutionAdapter,
    createNodeFileSystemAdapter,
    createFileSystemError,
    createModelAdapter,
    createRuntimeAiSdkModelExecutionConfig,
    pluginApi: {
      addZCodePluginMarketplace,
      installZCodeMarketplacePlugin,
      listZCodePlugins,
      setZCodePluginEnabled,
    },
    getCurrentModelInvocationContext,
    createXiadieZCodeApp: createDurableHost,
    createTurnEventCollector,
    profile: { parseProfileV1, resolveOwnedProfilePaths },
    secrets: { authorizeCredentialReference },
  },
  repositoryRoot: __P01_REPOSITORY_ROOT__,
  nodeExecutable: __P01_NODE_EXECUTABLE__,
  electronPath: __P01_ELECTRON_EXECUTABLE__,
});
