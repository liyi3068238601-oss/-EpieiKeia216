import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const IGNORED_DIRECTORY_NAMES = new Set([".git", "dist", "node_modules"]);

/**
 * Walk the local static import/re-export graph reachable from packages/core.
 * The scan is a source boundary check, not a runtime sandbox.
 */
export function inspectCoreImportBoundaries(repoRoot, coreRelative = "packages/core") {
  const root = resolveRealPath(repoRoot);
  const coreDir = path.resolve(root, coreRelative);
  if (!isPathInside(root, coreDir)) {
    throw new Error("Core source directory must be inside the repository root");
  }

  let coreStat;
  try {
    coreStat = fs.lstatSync(coreDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "core-absent", scannedFiles: 0, violations: [] };
    }
    throw error;
  }
  if (coreStat.isSymbolicLink()) {
    return {
      status: "scanned",
      scannedFiles: 0,
      violations: [
        {
          code: "SYMLINK_SOURCE_UNSUPPORTED",
          file: relativePosix(root, coreDir),
          line: 1,
          target: relativePosix(root, coreDir),
          reason: "Core source directory cannot be a symbolic link",
          chain: [relativePosix(root, coreDir)],
        },
      ],
    };
  }
  if (!coreStat.isDirectory()) {
    return { status: "core-absent", scannedFiles: 0, violations: [] };
  }

  const { compilerOptions, configError } = readCompilerOptions(root);
  if (configError !== undefined) {
    return {
      status: "configuration-error",
      scannedFiles: 0,
      violations: [configError],
    };
  }

  const { files: initialFiles, symlinks } = listSourceFiles(coreDir, root);
  if (initialFiles.length === 0 && symlinks.length === 0) {
    return { status: "core-empty", scannedFiles: 0, violations: [] };
  }

  const visited = new Set();
  const violations = new Map();
  for (const link of symlinks) {
    addViolation(violations, {
      code: "SYMLINK_SOURCE_UNSUPPORTED",
      file: link,
      line: 1,
      target: link,
      reason: "symbolic-link source is not followed by the static boundary checker",
      chain: [link],
    });
  }
  const visit = (filename, chain) => {
    const realFilename = resolveRealPath(filename);
    const display = relativePosix(root, realFilename);

    const forbiddenPath = forbiddenPathReason(display);
    if (forbiddenPath !== undefined) {
      addViolation(violations, {
        code: "FORBIDDEN_LOCAL_PATH",
        file: display,
        line: 1,
        target: display,
        reason: forbiddenPath,
        chain: [...chain, display],
      });
      return;
    }

    if (!isPathInside(root, realFilename)) {
      addViolation(violations, {
        code: "LOCAL_IMPORT_OUTSIDE_ROOT",
        file: chain.at(-1) ?? display,
        line: 1,
        target: realFilename,
        reason: "local source resolved outside the repository root",
        chain: [...chain, display],
      });
      return;
    }

    if (hasPathSegment(realFilename, "node_modules")) return;
    if (visited.has(realFilename)) return;
    visited.add(realFilename);

    let text;
    try {
      text = fs.readFileSync(realFilename, "utf8");
    } catch (error) {
      addViolation(violations, {
        code: "SOURCE_UNREADABLE",
        file: display,
        line: 1,
        target: display,
        reason: error instanceof Error ? error.message : String(error),
        chain: [...chain, display],
      });
      return;
    }

    const source = ts.createSourceFile(
      realFilename,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(realFilename),
    );
    const currentChain = [...chain, display];

    for (const edge of collectModuleEdges(source)) {
      const line = source.getLineAndCharacterOfPosition(edge.position).line + 1;
      if (edge.computed) {
        addViolation(violations, {
          code: "COMPUTED_MODULE_SPECIFIER",
          file: display,
          line,
          target: edge.expression,
          reason: "computed import/require target cannot be checked statically",
          chain: currentChain,
        });
        continue;
      }

      const specifier = edge.specifier;
      if (specifier === undefined) {
        addViolation(violations, {
          code: "UNRESOLVED_MODULE_SPECIFIER",
          file: display,
          line,
          target: edge.expression,
          reason: "module target is not a string literal",
          chain: currentChain,
        });
        continue;
      }

      const forbiddenSpecifier = forbiddenSpecifierReason(specifier);
      if (forbiddenSpecifier !== undefined) {
        addViolation(violations, {
          code: "FORBIDDEN_MODULE_SPECIFIER",
          file: display,
          line,
          target: specifier,
          reason: forbiddenSpecifier,
          chain: currentChain,
        });
        continue;
      }

      const resolution = resolveModule(specifier, realFilename, root, compilerOptions);
      if (resolution.kind === "unresolved-local") {
        addViolation(violations, {
          code: "UNRESOLVED_LOCAL_IMPORT",
          file: display,
          line,
          target: specifier,
          reason: "relative or configured local import did not resolve",
          chain: currentChain,
        });
        continue;
      }
      if (resolution.kind !== "local") continue;

      const targetDisplay = relativePosix(root, resolution.filename);
      if (resolution.kind === "symlink") {
        addViolation(violations, {
          code: "SYMLINK_SOURCE_UNSUPPORTED",
          file: display,
          line,
          target: resolution.symlink,
          reason: "symbolic-link imports are not followed by the static boundary checker",
          chain: [...currentChain, targetDisplay],
        });
        continue;
      }

      const targetForbidden = forbiddenPathReason(targetDisplay);
      if (targetForbidden !== undefined) {
        addViolation(violations, {
          code: "FORBIDDEN_LOCAL_PATH",
          file: display,
          line,
          target: targetDisplay,
          reason: targetForbidden,
          chain: [...currentChain, targetDisplay],
        });
        continue;
      }

      if (!isPathInside(root, resolution.filename)) {
        addViolation(violations, {
          code: "LOCAL_IMPORT_OUTSIDE_ROOT",
          file: display,
          line,
          target: resolution.filename,
          reason: "local source resolved outside the repository root",
          chain: [...currentChain, resolution.filename],
        });
        continue;
      }

      visit(resolution.filename, currentChain);
    }
  };

  for (const filename of initialFiles) visit(filename, []);

  return {
    status: "scanned",
    scannedFiles: visited.size,
    violations: [...violations.values()].sort((left, right) =>
      `${left.file}:${left.line}:${left.code}:${left.target}`.localeCompare(
        `${right.file}:${right.line}:${right.code}:${right.target}`,
      ),
    ),
  };
}

function readCompilerOptions(root) {
  const configPath = path.join(root, "tsconfig.json");
  if (!fs.existsSync(configPath)) {
    return { compilerOptions: ts.getDefaultCompilerOptions() };
  }

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    return {
      compilerOptions: ts.getDefaultCompilerOptions(),
      configError: {
        code: "TSCONFIG_ERROR",
        file: "tsconfig.json",
        line: 1,
        target: configPath,
        reason: ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
        chain: [],
      },
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    root,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0];
    return {
      compilerOptions: parsed.options,
      configError: {
        code: "TSCONFIG_ERROR",
        file: "tsconfig.json",
        line: 1,
        target: configPath,
        reason: ts.flattenDiagnosticMessageText(
          firstError.messageText,
          "\n",
        ),
        chain: [],
      },
    };
  }
  return { compilerOptions: parsed.options };
}

function listSourceFiles(root, repoRoot) {
  const found = [];
  const symlinks = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(relativePosix(repoRoot, filename));
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
          pending.push(filename);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(filename);
      }
    }
  }
  return {
    files: found.sort((left, right) => left.localeCompare(right)),
    symlinks: symlinks.sort((left, right) => left.localeCompare(right)),
  };
}

function collectModuleEdges(source) {
  const edges = [];
  const addLiteral = (node, kind) => {
    if (node === undefined) return;
    if (isStringLiteral(node)) {
      edges.push({ kind, specifier: node.text, position: node.getStart(source) });
    } else {
      edges.push({
        kind,
        expression: node.getText(source),
        position: node.getStart(source),
      });
    }
  };

  const walk = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier, "declaration");
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (
        ts.isExternalModuleReference(reference) &&
        reference.expression !== undefined
      ) {
        addLiteral(reference.expression, "import-equals");
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        (ts.isStringLiteral(argument.literal) ||
          ts.isNoSubstitutionTemplateLiteral(argument.literal))
      ) {
        addLiteral(argument.literal, "import-type");
      } else {
        edges.push({
          kind: "import-type",
          expression: argument.getText(source),
          position: argument.getStart(source),
        });
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        addCallArgument(argument, "dynamic-import", addLiteral, edges, source);
      } else if (isRequireCall(node.expression)) {
        const argument = node.arguments[0];
        addCallArgument(argument, "require", addLiteral, edges, source);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return edges;
}

function addCallArgument(argument, kind, addLiteral, edges, source) {
  if (
    argument !== undefined &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    addLiteral(argument, kind);
    return;
  }
  edges.push({
    kind,
    computed: true,
    expression: argument?.getText(source) ?? "<missing module specifier>",
    position: argument?.getStart(source) ?? 0,
  });
}

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isRequireCall(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "require";
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "require" &&
    ts.isIdentifier(expression.expression)
  ) {
    return expression.expression.text === "module";
  }
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "module" &&
    expression.argumentExpression !== undefined &&
    isStringLiteral(expression.argumentExpression) &&
    expression.argumentExpression.text === "require"
  );
}

function resolveModule(specifier, containingFile, root, compilerOptions) {
  const result = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (result !== undefined) {
    const sourcePath = path.resolve(result.resolvedFileName);
    const filename = resolveRealPath(sourcePath);
    const symlink = isPathInside(root, sourcePath)
      ? findSymlinkBelow(root, sourcePath)
      : undefined;
    if (symlink !== undefined) {
      return { kind: "symlink", filename, symlink: relativePosix(root, symlink) };
    }
    if (
      hasPathSegment(sourcePath, "node_modules") &&
      hasPathSegment(filename, "node_modules")
    ) {
      return { kind: "external" };
    }
    return { kind: "local", filename };
  }

  if (
    specifier.startsWith(".") ||
    isAbsoluteModuleSpecifier(specifier) ||
    matchesConfiguredPath(specifier, compilerOptions.paths)
  ) {
    return { kind: "unresolved-local" };
  }
  return { kind: "external" };
}

function matchesConfiguredPath(specifier, paths) {
  if (paths === undefined) return false;
  return Object.keys(paths).some((pattern) => {
    const wildcard = pattern.indexOf("*");
    if (wildcard < 0) return specifier === pattern;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

function forbiddenSpecifierReason(specifier) {
  if (/^file:/i.test(specifier)) {
    return "file URL imports are not permitted in Core";
  }
  if (isAbsoluteModuleSpecifier(specifier)) {
    return "absolute filesystem imports are not permitted in Core";
  }
  const reason = forbiddenPathReason(specifier);
  if (reason !== undefined) return reason;

  const tokens = specifier.toLowerCase().split(/[/\\@._-]+/).filter(Boolean);
  if (tokens.includes("electron")) return "Electron dependency is outside Core";
  if (tokens.includes("zcode")) return "ZCode dependency is outside Core";
  if (tokens.includes("dsh")) return "DSH dependency is outside Core";
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "deepseek" && tokens[index + 1] === "harness") {
      return "DeepSeek Harness dependency is outside Core";
    }
  }
  return undefined;
}

function forbiddenPathReason(filename) {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.includes(".runtime")) return ".runtime is outside Core";
  if (segments.includes("references")) return "references/upstream sources are read-only";
  if (segments.includes("adapters")) return "adapters are outside Core";
  return forbiddenSpecifierReasonTokens(normalized);
}

function forbiddenSpecifierReasonTokens(value) {
  const tokens = value.split(/[/\\@._-]+/).filter(Boolean);
  if (tokens.includes("electron")) return "Electron source is outside Core";
  if (tokens.includes("zcode")) return "ZCode source is outside Core";
  if (tokens.includes("dsh")) return "DSH source is outside Core";
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "deepseek" && tokens[index + 1] === "harness") {
      return "DeepSeek Harness source is outside Core";
    }
  }
  return undefined;
}

function scriptKindFor(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".tsx":
    case ".jsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function hasPathSegment(filename, segment) {
  return filename
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .includes(segment.toLowerCase());
}

function resolveRealPath(filename) {
  const resolved = path.resolve(filename);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function findSymlinkBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isAbsoluteModuleSpecifier(specifier) {
  return (
    path.isAbsolute(specifier) ||
    path.win32.isAbsolute(specifier) ||
    /^[A-Za-z]:[\\/]/.test(specifier) ||
    /^\\\\/.test(specifier)
  );
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function relativePosix(root, filename) {
  return path.relative(root, filename).replaceAll("\\", "/");
}

function addViolation(target, violation) {
  const key = `${violation.code}|${violation.file}|${violation.line}|${violation.target}`;
  if (!target.has(key)) target.set(key, violation);
}

function formatViolation(violation) {
  const chain = violation.chain.length === 0 ? "" : `\n  chain: ${violation.chain.join(" -> ")}`;
  return `${violation.file}:${violation.line}: ${violation.code}: ${violation.target} (${violation.reason})${chain}`;
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1] !== undefined) {
      root = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      console.error(`unknown argument: ${argv[index]}`);
      return 2;
    }
  }

  const report = inspectCoreImportBoundaries(root);
  if (report.status === "configuration-error") {
    for (const violation of report.violations) {
      console.error(formatViolation(violation));
    }
    return 1;
  }
  if (report.status === "core-absent" || report.status === "core-empty") {
    console.log(
      `BOUNDARY_SCAN_NOT_RUN: packages/core is ${report.status === "core-absent" ? "absent" : "empty"}; no product Core imports were checked.`,
    );
    return 0;
  }
  if (report.violations.length > 0) {
    for (const violation of report.violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      `BOUNDARY_SCAN_FAILED: ${report.violations.length} violation(s) across ${report.scannedFiles} reachable source file(s).`,
    );
    return 1;
  }
  console.log(
    `BOUNDARY_SCAN_OK: ${report.scannedFiles} reachable source file(s); no forbidden dependency edges.`,
  );
  return 0;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
