const mode = process.argv[2];

if (mode === "hang") {
  process.stdout.write("U06_HANG_FIXTURE_STARTED\n");
  setInterval(() => {}, 1000);
} else if (mode === "bad-json") {
  process.stdout.write("not-json\n");
} else if (mode === "nonzero") {
  process.stderr.write("U06_NONZERO_FIXTURE_FAILURE\n");
  process.exitCode = 7;
} else {
  process.stderr.write("unknown U06 Hook fixture mode\n");
  process.exitCode = 64;
}
