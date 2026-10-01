import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCoreImportBoundaries } from "../../../tools/check-import-boundaries.mjs";
import { selectTests } from "../../../tools/run-tests.mjs";

const TEMP_PREFIX = "xiadie-p01-u03-boundary-";

function withFixture(writeFiles, run) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    fs.writeFileSync(
      path.join(tempRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      }),
    );
    writeFiles(tempRoot);
    return run(tempRoot);
  } finally {
    const expectedTempRoot = path.resolve(os.tmpdir());
    const resolvedTempRoot = path.resolve(tempRoot);
    if (
      path.dirname(resolvedTempRoot) !== expectedTempRoot ||
      !path.basename(resolvedTempRoot).startsWith(TEMP_PREFIX)
    ) {
      throw new Error(`refusing to remove unexpected fixture path: ${resolvedTempRoot}`);
    }
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
}

function writeFile(root, relativePath, contents) {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function createDirectoryJunction(root, linkRelative, targetRelative) {
  const link = path.join(root, linkRelative);
  const target = path.join(root, targetRelative);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, "junction");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  return link;
}

test("accepts local re-exports and Node built-ins", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        'export { join } from "node:path";\nexport { value } from "../../shared/value.ts";\n',
      );
      writeFile(root, "shared/value.ts", "export const value = 1;\n");
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  assert.equal(report.status, "scanned");
  assert.equal(report.scannedFiles, 2);
  assert.deepEqual(report.violations, []);
});

test("does not mistake a worktree located under .runtime for a Core dependency", () => {
  const report = withFixture(
    (tempRoot) => {
      const worktreeRoot = path.join(tempRoot, ".runtime", "worktree");
      writeFile(worktreeRoot, "packages/core/index.ts", "export const value = 1;\n");
      fs.mkdirSync(worktreeRoot, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeRoot, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
      );
    },
    (tempRoot) =>
      inspectCoreImportBoundaries(path.join(tempRoot, ".runtime", "worktree")),
  );

  assert.deepEqual(report.violations, []);
});

test("follows a local wrapper and transitive re-export to forbidden Electron", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        'export { value } from "../../shared/wrapper.ts";\n',
      );
      writeFile(
        root,
        "shared/wrapper.ts",
        'export { value } from "./bridge.ts";\n',
      );
      writeFile(
        root,
        "shared/bridge.ts",
        'import { app } from "electron";\nexport const value = app;\n',
      );
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  const violation = report.violations.find(
    (item) => item.code === "FORBIDDEN_MODULE_SPECIFIER",
  );
  assert.ok(violation);
  assert.match(violation.chain.join(" -> "), /packages\/core\/index\.ts/);
  assert.match(violation.chain.join(" -> "), /shared\/wrapper\.ts/);
  assert.match(violation.chain.join(" -> "), /shared\/bridge\.ts/);
});

test("rejects a transitive import into adapters even through a local wrapper", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        'import { value } from "../../shared/wrapper.ts";\nvoid value;\n',
      );
      writeFile(
        root,
        "shared/wrapper.ts",
        'export { value } from "../adapters/host.ts";\n',
      );
      writeFile(root, "adapters/host.ts", "export const value = 1;\n");
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  const violation = report.violations.find((item) =>
    ["FORBIDDEN_LOCAL_PATH", "FORBIDDEN_MODULE_SPECIFIER"].includes(item.code),
  );
  assert.ok(violation);
  assert.match(violation.chain.join(" -> "), /shared\/wrapper\.ts/);
});

test("fails closed for computed dynamic import and require targets", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        [
          'const first = "electron";',
          "void import(first);",
          'const second = "dsh";',
          "void require(second);",
        ].join("\n"),
      );
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  assert.equal(
    report.violations.filter((item) => item.code === "COMPUTED_MODULE_SPECIFIER").length,
    2,
  );
});

test("rejects configured local aliases that resolve into references", () => {
  const report = withFixture(
    (root) => {
      const tsconfigPath = path.join(root, "tsconfig.json");
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            baseUrl: ".",
            paths: { "@upstream/*": ["references/upstream/*"] },
          },
        }),
      );
      writeFile(root, "packages/core/index.ts", 'import "@upstream/bridge";\n');
      writeFile(root, "references/upstream/bridge.ts", "export {};\n");
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  assert.ok(report.violations.some((item) => item.code === "FORBIDDEN_LOCAL_PATH"));
});

test("rejects file URLs and absolute Windows module paths", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        [
          'import "file:///C:/outside/module.mjs";',
          'import "C:\\\\outside\\\\module.mjs";',
        ].join("\n"),
      );
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  const blocked = report.violations.filter(
    (item) => item.code === "FORBIDDEN_MODULE_SPECIFIER",
  );
  assert.equal(blocked.length, 2);
});

test("maps the U03 task selector and rejects unknown selectors", () => {
  assert.deepEqual(selectTests("unit", ["P01-U03"]), [
    "packages/contracts/test/json-value.test.mjs",
  ]);
  assert.throws(() => selectTests("unit", ["P99-U99"]), /unknown task selector/);
});

test("test runner exits nonzero for an unknown command-line task selector", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = spawnSync(
    process.execPath,
    ["tools/run-tests.mjs", "unit", "P99-U99"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown task selector/);
});

test("rejects a Core directory junction", () => {
  const report = withFixture(
    (root) => {
      writeFile(root, "actual-core/index.ts", "export const value = 1;\n");
      createDirectoryJunction(root, "packages/core", "actual-core");
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  const violation = report.violations.find(
    (item) =>
      item.code === "SYMLINK_SOURCE_UNSUPPORTED" &&
      item.file === "packages/core",
  );
  assert.ok(violation);
  assert.equal(report.scannedFiles, 0);
});

test("rejects a source junction located inside Core", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        'export { value } from "./linked/bridge.ts";\n',
      );
      writeFile(root, "actual-source/bridge.ts", "export const value = 1;\n");
      createDirectoryJunction(root, "packages/core/linked", "actual-source");
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  assert.ok(
    report.violations.some(
      (item) =>
        item.code === "SYMLINK_SOURCE_UNSUPPORTED" &&
        item.file === "packages/core/linked",
    ),
  );
});

test("rejects a wrapper import that crosses a directory junction", () => {
  for (const targetDirectory of ["references/upstream", "adapters"]) {
    const report = withFixture(
      (root) => {
        fs.writeFileSync(
          path.join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              preserveSymlinks: true,
            },
          }),
        );
        writeFile(
          root,
          "packages/core/index.ts",
          'export { value } from "../../shared/wrapper.ts";\n',
        );
        writeFile(
          root,
          "shared/wrapper.ts",
          'export { value } from "./junction/bridge.ts";\n',
        );
        writeFile(
          root,
          path.join(targetDirectory, "bridge.ts"),
          "export const value = 1;\n",
        );
        createDirectoryJunction(root, "shared/junction", targetDirectory);
      },
      (root) => inspectCoreImportBoundaries(root),
    );

    const violation = report.violations.find(
      (item) =>
        item.code === "SYMLINK_SOURCE_UNSUPPORTED" &&
        item.file === "shared/wrapper.ts",
    );
    assert.ok(
      violation,
      "expected junction into " + targetDirectory + " to be rejected",
    );
    assert.equal(violation.target, "shared/junction");
    assert.match(violation.chain.join(" -> "), /packages\/core\/index\.ts/);
    assert.match(violation.chain.join(" -> "), /shared\/wrapper\.ts/);
  }
});

test("allows a pnpm-style dependency junction whose canonical target stays under node_modules", () => {
  const report = withFixture(
    (root) => {
      writeFile(
        root,
        "packages/core/index.ts",
        'import { value } from "fixture-package";\nexport { value };\n',
      );
      writeFile(
        root,
        "node_modules/.pnpm/fixture-package@1.0.0/node_modules/fixture-package/package.json",
        JSON.stringify({ name: "fixture-package", types: "index.d.ts" }),
      );
      writeFile(
        root,
        "node_modules/.pnpm/fixture-package@1.0.0/node_modules/fixture-package/index.d.ts",
        "export declare const value: string;\n",
      );
      createDirectoryJunction(
        root,
        "node_modules/fixture-package",
        "node_modules/.pnpm/fixture-package@1.0.0/node_modules/fixture-package",
      );
    },
    (root) => inspectCoreImportBoundaries(root),
  );

  assert.equal(report.status, "scanned");
  assert.equal(report.scannedFiles, 1);
  assert.deepEqual(report.violations, []);
});

test("rejects pnpm-style junctions whose canonical targets enter forbidden paths", () => {
  const forbiddenTargets = [
    "references/upstream/node_modules/fixture-package",
    "adapters/node_modules/fixture-package",
    ".runtime/store/node_modules/fixture-package",
    "node_modules/.pnpm/fixture-package@1.0.0/node_modules/electron",
  ];

  for (const targetDirectory of forbiddenTargets) {
    const report = withFixture(
      (root) => {
        writeFile(
          root,
          "packages/core/index.ts",
          'import "safe-package";\n',
        );
        writeFile(
          root,
          path.join(targetDirectory, "package.json"),
          JSON.stringify({ name: "safe-package", types: "index.d.ts" }),
        );
        writeFile(
          root,
          path.join(targetDirectory, "index.d.ts"),
          "export {};\n",
        );
        createDirectoryJunction(
          root,
          "node_modules/safe-package",
          targetDirectory,
        );
      },
      (root) => inspectCoreImportBoundaries(root),
    );

    assert.ok(
      report.violations.some(
        (item) =>
          item.code === "SYMLINK_SOURCE_UNSUPPORTED" &&
          item.target === "node_modules/safe-package",
      ),
      "expected canonical target " + targetDirectory + " to be rejected",
    );
  }
});

test("rejects a node_modules junction whose canonical target is outside the repository", () => {
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), TEMP_PREFIX + "external-"),
  );
  try {
    const report = withFixture(
      (root) => {
        fs.writeFileSync(
          path.join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              preserveSymlinks: true,
            },
          }),
        );
        writeFile(
          root,
          "packages/core/index.ts",
          'import "fixture-package";\n',
        );
        writeFile(
          externalRoot,
          "node_modules/fixture-package/package.json",
          JSON.stringify({ name: "fixture-package", types: "index.d.ts" }),
        );
        writeFile(
          externalRoot,
          "node_modules/fixture-package/index.d.ts",
          "export {};\n",
        );
        const link = path.join(root, "node_modules/fixture-package");
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(
          path.join(externalRoot, "node_modules/fixture-package"),
          link,
          "junction",
        );
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      },
      (root) => inspectCoreImportBoundaries(root),
    );

    assert.ok(
      report.violations.some(
        (item) =>
          item.code === "SYMLINK_SOURCE_UNSUPPORTED" &&
          item.target === "node_modules/fixture-package",
      ),
    );
    assert.ok(
      fs.existsSync(path.join(externalRoot, "node_modules/fixture-package/index.d.ts")),
      "fixture cleanup must not follow the junction outside its root",
    );
  } finally {
    const expectedTempRoot = path.resolve(os.tmpdir());
    const resolvedExternalRoot = path.resolve(externalRoot);
    if (
      path.dirname(resolvedExternalRoot) !== expectedTempRoot ||
      !path.basename(resolvedExternalRoot).startsWith(TEMP_PREFIX + "external-")
    ) {
      throw new Error(
        "refusing to remove unexpected external fixture path: " +
          resolvedExternalRoot,
      );
    }
    fs.rmSync(resolvedExternalRoot, { recursive: true, force: true });
  }
});
