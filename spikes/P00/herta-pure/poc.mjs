import assert from "node:assert/strict";
import {
  DEFAULT_DREAM_CONFIG,
  resolveDreamConfig,
} from "../../../references/herta-4623df12/packages/knowledge/src/dream/config.ts";
import { computeStrength } from "../../../references/herta-4623df12/packages/knowledge/src/dream/retention.ts";
import { selectEpisodes } from "../../../references/herta-4623df12/packages/knowledge/src/dream/select-episodes.ts";
import { segmentSession } from "../../../references/herta-4623df12/packages/knowledge/src/dream/segment-session.ts";

const baseMs = Date.parse("2026-10-01T09:00:00.000Z");
const minute = 60_000;
const config = resolveDreamConfig({
  enabled: false,
  episodeGapMs: 20 * minute,
  maxEpisodeBlocks: 60,
  maxEpisodeMs: 45 * minute,
  minHertaBlocks: 2,
  minEpisodeChars: 10,
  retentionHalfLifeDays: 30,
  retentionReactivationK: 0.5,
  retentionChargeWeight: 0,
});
assert.equal(DEFAULT_DREAM_CONFIG.enabled, false);
assert.equal(resolveDreamConfig().enabled, false);
const selection = {
  minHertaBlocks: config.minHertaBlocks,
  minEpisodeChars: config.minEpisodeChars,
};

const user = (text, offsetMinutes, atOverride) => ({
  kind: "user",
  text,
  at: atOverride ?? new Date(baseMs + offsetMinutes * minute).toISOString(),
});
const herta = (text, offsetMinutes, atOverride) => ({
  kind: "herta",
  surface: "speech",
  text,
  at: atOverride ?? new Date(baseMs + offsetMinutes * minute).toISOString(),
});
const syntheticRecord = (extra = {}) => ({
  id: "synthetic-memory-1",
  file: "synthetic-memory.txt",
  nn: 1,
  state: "live",
  sourceSessionId: "synthetic-session",
  sourceEpisodeHash: "synthetic-episode-hash",
  sourceEpisodes: ["synthetic-episode-hash"],
  runId: "synthetic-run",
  model: "not-used",
  generatedAt: new Date(baseMs).toISOString(),
  situationTag: "synthetic",
  summary: "synthetic test record",
  critiqueScores: { voice: 0.8, format: 1, novelty: 1 },
  validateFeianPassed: true,
  reactivationCount: 0,
  ...extra,
});

// Normal: a long gap splits two sufficiently voiced, settled episodes.
const resumedBlocks = [
  user("synthetic request about organizing notes", 0),
  herta("separate source from summary", 1),
  herta("keep claims tied to evidence", 2),
  user("synthetic follow-up after a pause", 31),
  herta("recheck against original events", 32),
  herta("retain the prior version on failure", 33),
];
const normalEpisodes = segmentSession(
  "synthetic-session",
  resumedBlocks,
  config,
  baseMs + 60 * minute,
);
assert.equal(normalEpisodes.length, 2);
assert.deepEqual(
  normalEpisodes.map(({ startIndex, endIndex, settled }) => ({
    startIndex,
    endIndex,
    settled,
  })),
  [
    { startIndex: 0, endIndex: 3, settled: true },
    { startIndex: 3, endIndex: 6, settled: true },
  ],
);
assert.equal(selectEpisodes(normalEpisodes, selection).length, 2);

// Failure: malformed timestamps cannot prove silence; open episodes stay out.
const malformedBlocks = [
  user("synthetic request with a bad time", 0, "not-a-date"),
  herta("synthetic first reply", 1, "not-a-date"),
  herta("synthetic second reply", 2, "not-a-date"),
];
const malformedEpisodes = segmentSession(
  "synthetic-malformed-session",
  malformedBlocks,
  config,
  baseMs + 24 * 60 * 60_000,
);
assert.equal(malformedEpisodes.length, 1);
assert.equal(malformedEpisodes[0].settled, false);
assert.equal(selectEpisodes(malformedEpisodes, selection).length, 0);

// Failure counterexample: a large system/chrome body cannot satisfy the voice floor.
const chromeOnlyEpisode = {
  sessionId: "synthetic-chrome-session",
  episodeHash: "synthetic-chrome-hash",
  blocks: [
    { kind: "user", text: "x" },
    { kind: "herta", surface: "speech", text: "嗯" },
    { kind: "herta", surface: "speech", text: "好" },
    { kind: "system", label: "synthetic", body: "chrome ".repeat(500) },
  ],
  startIndex: 0,
  endIndex: 4,
  settled: true,
};
assert.equal(selectEpisodes([chromeOnlyEpisode], selection).length, 0);

// Recovery: a previously open tail becomes selected when a later turn closes it.
const openTailBlocks = resumedBlocks.slice(0, 3);
const openTail = segmentSession(
  "synthetic-session",
  openTailBlocks,
  config,
  baseMs + 5 * minute,
);
assert.equal(openTail.length, 1);
assert.equal(openTail[0].settled, false);
assert.equal(selectEpisodes(openTail, selection).length, 0);
assert.equal(normalEpisodes[0].episodeHash, openTail[0].episodeHash);
assert.equal(selectEpisodes(normalEpisodes, selection).length, 2);

// Retention: deterministic decay, invalid-anchor containment, and reactivation recovery.
const freshScore = computeStrength(syntheticRecord(), baseMs, config);
const agedScore = computeStrength(
  syntheticRecord({ generatedAt: new Date(baseMs - 30 * 24 * 60 * 60_000).toISOString() }),
  baseMs,
  config,
);
const invalidAnchorScore = computeStrength(
  syntheticRecord({ generatedAt: "not-a-date" }),
  baseMs,
  config,
);
const reactivatedScore = computeStrength(
  syntheticRecord({
    generatedAt: new Date(baseMs - 90 * 24 * 60 * 60_000).toISOString(),
    lastReactivatedAt: new Date(baseMs).toISOString(),
    reactivationCount: 1,
  }),
  baseMs,
  config,
);
assert.ok(Math.abs(freshScore - 0.8) < 1e-9);
assert.ok(Math.abs(agedScore - 0.4) < 1e-9);
assert.ok(Number.isFinite(invalidAnchorScore));
assert.ok(Math.abs(invalidAnchorScore - 0.8) < 1e-9);
assert.ok(reactivatedScore > agedScore);

console.log(
  JSON.stringify({
    status: "PASS",
    scope: "fixed Herta pure functions via Node 24 TypeScript stripping",
    scenarios: {
      config: {
        defaultAutoDreamEnabled: DEFAULT_DREAM_CONFIG.enabled,
        resolvedAutoDreamEnabled: resolveDreamConfig().enabled,
        syntheticMinEpisodeChars: config.minEpisodeChars,
      },
      normal: {
        segmentedEpisodes: normalEpisodes.length,
        selectedEpisodes: selectEpisodes(normalEpisodes, selection).length,
        bounds: normalEpisodes.map(({ startIndex, endIndex, settled }) => ({
          startIndex,
          endIndex,
          settled,
        })),
      },
      failure: {
        malformedTimestampTailSettled: malformedEpisodes[0].settled,
        malformedTimestampSelected: selectEpisodes(malformedEpisodes, selection).length,
        chromeInflatedSelection: selectEpisodes([chromeOnlyEpisode], selection).length,
      },
      recovery: {
        openTailInitiallySelected: selectEpisodes(openTail, selection).length,
        resumedTailHashStable: normalEpisodes[0].episodeHash === openTail[0].episodeHash,
        selectedAfterResume: selectEpisodes(normalEpisodes, selection).length,
        retentionScoreAfterReactivationExceedsAged: reactivatedScore > agedScore,
      },
      retention: {
        freshScore,
        oneHalfLifeScore: agedScore,
        malformedAnchorFinite: Number.isFinite(invalidAnchorScore),
        reactivatedScore,
      },
    },
    modelCalls: 0,
    persistenceOrProductRuntime: false,
  }),
);
