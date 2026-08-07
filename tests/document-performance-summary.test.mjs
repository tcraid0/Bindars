import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizePerformanceResults,
} from "../scripts/verify-document-performance.mjs";

function pipelineEvent(transformMs) {
  return { smartypants: { transformMs } };
}

test("performance summaries separate per-execution and total-per-open Smartypants work", () => {
  const summary = summarizePerformanceResults({
    coldTrials: [
      {
        caseId: "smartypants-punctuation-65536",
        trial: 2,
        commitMs: 984,
        settledMs: 2_474,
        pipelineEvents: [pipelineEvent(578), pipelineEvent(568), pipelineEvent(562)],
      },
      {
        caseId: "smartypants-punctuation-65536",
        trial: 1,
        commitMs: 967,
        settledMs: 2_210,
        pipelineEvents: [pipelineEvent(585), pipelineEvent(571)],
      },
    ],
  });

  assert.deepEqual(summary["smartypants-punctuation-65536"], {
    commitMs: { minimum: 967, median: 975.5, maximum: 984 },
    settledMs: { minimum: 2_210, median: 2_342, maximum: 2_474 },
    pipelineExecutionsPerOpen: { minimum: 2, median: 2.5, maximum: 3 },
    trials: [
      {
        trial: 1,
        commitMs: 967,
        settledMs: 2_210,
        pipelineExecutionCount: 2,
        observedPipelineEventsBeforeTimeout: null,
        perExecutionTransformMs: [585, 571],
        totalTransformMs: 1_156,
      },
      {
        trial: 2,
        commitMs: 984,
        settledMs: 2_474,
        pipelineExecutionCount: 3,
        observedPipelineEventsBeforeTimeout: null,
        perExecutionTransformMs: [578, 568, 562],
        totalTransformMs: 1_708,
      },
    ],
    smartypants: {
      perExecutionTransformMs: { minimum: 562, median: 571, maximum: 585 },
      totalTransformMsPerOpen: { minimum: 1_156, median: 1_432, maximum: 1_708 },
    },
  });
});

test("performance summaries retain timeout trials without inventing timings", () => {
  const summary = summarizePerformanceResults({
    coldTrials: [
      {
        caseId: "source-word-soup-1048576",
        trial: 1,
        commitMs: null,
        settledMs: null,
        observedPipelineEventsBeforeTimeout: 0,
      },
    ],
  });

  assert.deepEqual(summary["source-word-soup-1048576"], {
    commitMs: null,
    settledMs: null,
    pipelineExecutionsPerOpen: null,
    trials: [
      {
        trial: 1,
        commitMs: null,
        settledMs: null,
        pipelineExecutionCount: null,
        observedPipelineEventsBeforeTimeout: 0,
        perExecutionTransformMs: null,
        totalTransformMs: null,
      },
    ],
  });
});

test("performance summaries distinguish a known zero-event refusal from a timeout", () => {
  const summary = summarizePerformanceResults({
    coldTrials: [
      {
        caseId: "source-word-soup-1048577",
        trial: 1,
        commitMs: 310,
        settledMs: 620,
        pipelineEvents: [],
      },
    ],
  });

  assert.deepEqual(summary["source-word-soup-1048577"], {
    commitMs: { minimum: 310, median: 310, maximum: 310 },
    settledMs: { minimum: 620, median: 620, maximum: 620 },
    pipelineExecutionsPerOpen: { minimum: 0, median: 0, maximum: 0 },
    trials: [
      {
        trial: 1,
        commitMs: 310,
        settledMs: 620,
        pipelineExecutionCount: 0,
        observedPipelineEventsBeforeTimeout: null,
        perExecutionTransformMs: [],
        totalTransformMs: 0,
      },
    ],
  });
});
