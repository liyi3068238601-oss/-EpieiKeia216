const command = process.argv[2];

if (command !== "test:eval" && command !== "test:e2e") {
  console.error("usage: node tools/not-implemented.mjs <test:eval|test:e2e>");
  process.exitCode = 2;
} else {
  console.error(
    JSON.stringify({ command, status: "NOT_IMPLEMENTED", exitCode: 2 }),
  );
  process.exitCode = 2;
}
