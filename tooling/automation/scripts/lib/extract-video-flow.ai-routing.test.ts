import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateStep, ModelAnalysis } from "../extract-video-flow.js";
import { analyzeWithModel, resolveAnalysisResult } from "../extract-video-flow.js";

const GEMINI_RUNTIME_ENV_KEYS = [
  "GEMINI_MODEL",
  "GEMINI_QUALITY_PROFILE",
  "GEMINI_THINKING_LEVEL",
  "GEMINI_INCLUDE_THOUGHTS",
  "GEMINI_TOOL_MODE",
];

type ObservedRuntime = {
  modelName: string;
  thinkingLevel: string;
  includeThoughts: boolean;
  toolMode: string;
  qualityProfile: string;
  mediaResolution: string;
};

function buildStep(id: string, sourceEngine: string): CandidateStep {
  return {
    step_id: id,
    action: "click",
    target: { selectors: [{ kind: "css", value: "#submit", score: 80 }] },
    confidence: 0.9,
    source_engine: sourceEngine,
    evidence_ref: `test:${sourceEngine}:${id}`,
  };
}

function buildModel(modelName: string, sourceEngine: string): ModelAnalysis {
  return {
    modelName,
    detectedSignals: [],
    candidateSteps: [buildStep("s1", sourceEngine)],
  };
}

async function withClearedGeminiRuntimeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of GEMINI_RUNTIME_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Gemini helper succeeds in gemini-only routing", async () => {
  let runtimeCaptured = false;
  let seenRuntime: ObservedRuntime = {
    modelName: "",
    thinkingLevel: "",
    includeThoughts: false,
    toolMode: "",
    qualityProfile: "",
    mediaResolution: "",
  };
  let geminiCalls = 0;
  const result = await analyzeWithModel(
    { scenario: "gemini-success" },
    {
      analyzers: {
        analyzeWithGeminiHelper: async (_contextPayload, runtime) => {
          runtimeCaptured = true;
          geminiCalls += 1;
          seenRuntime = runtime as unknown as ObservedRuntime;
          return buildModel("gemini-3.1-pro-preview", "gemini-video");
        },
      },
    },
  );

  assert.equal(geminiCalls, 1);
  assert.equal(result?.modelName, "gemini-3.1-pro-preview");
  assert.equal(result?.candidateSteps[0]?.source_engine, "gemini-video");
  assert.equal(runtimeCaptured, true);
  assert.equal(seenRuntime.toolMode, "auto");
  assert.equal(seenRuntime.thinkingLevel, "high");
  assert.equal(seenRuntime.includeThoughts, true);
  assert.equal(seenRuntime.mediaResolution, "high");
});

test("Provider hints do not change gemini-only routing", async () => {
  let geminiCalls = 0;
  const seenModels: string[] = [];
  const analyzers = {
    analyzeWithGeminiHelper: async (
      _contextPayload: Record<string, unknown>,
      runtime: ObservedRuntime,
    ) => {
      geminiCalls += 1;
      seenModels.push(runtime.modelName);
      return buildModel("gemini-3.1-pro-preview", "gemini-video");
    },
  };

  // Legacy/unknown hints should not affect Gemini-only routing behavior.
  for (const provider of ["legacy-provider", "fallback-disabled", "gemini"]) {
    const result = await analyzeWithModel(
      { scenario: `provider-${provider}` },
      { provider, analyzers },
    );
    assert.equal(result?.modelName, "gemini-3.1-pro-preview");
    assert.equal(result?.candidateSteps[0]?.source_engine, "gemini-video");
  }

  assert.equal(geminiCalls, 3);
  assert.deepEqual(seenModels, [
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview",
  ]);
});

test("Default runtime options enforce high thinking + includeThoughts=true + AUTO tool mode", async () => {
  await withClearedGeminiRuntimeEnv(async () => {
    let runtimeCaptured = false;
    let seenRuntime: ObservedRuntime = {
      modelName: "",
      thinkingLevel: "",
      includeThoughts: false,
      toolMode: "",
      qualityProfile: "",
      mediaResolution: "",
    };
    await analyzeWithModel(
      { scenario: "default-runtime" },
      {
        analyzers: {
          analyzeWithGeminiHelper: async (_contextPayload, runtime) => {
            runtimeCaptured = true;
            seenRuntime = runtime as unknown as ObservedRuntime;
            return buildModel(runtime.modelName, "gemini-video");
          },
        },
      },
    );

    assert.equal(runtimeCaptured, true);
    assert.equal(seenRuntime.modelName, "gemini-3.1-pro-preview");
    assert.equal(seenRuntime.thinkingLevel, "high");
    assert.equal(seenRuntime.includeThoughts, true);
    assert.equal(seenRuntime.toolMode, "auto");
    assert.equal(seenRuntime.qualityProfile, "pro");
    assert.equal(seenRuntime.mediaResolution, "high");
  });
});

test("Runtime options can switch function-calling mode to ANY and fast profile model", async () => {
  await withClearedGeminiRuntimeEnv(async () => {
    let runtimeCaptured = false;
    let seenRuntime: ObservedRuntime = {
      modelName: "",
      thinkingLevel: "",
      includeThoughts: false,
      toolMode: "",
      qualityProfile: "",
      mediaResolution: "",
    };
    await analyzeWithModel(
      { scenario: "runtime-overrides" },
      {
        runtime: {
          qualityProfile: "fast",
          toolMode: "any",
          includeThoughts: false,
          thinkingLevel: "medium",
          mediaResolution: "medium",
        },
        analyzers: {
          analyzeWithGeminiHelper: async (_contextPayload, runtime) => {
            runtimeCaptured = true;
            seenRuntime = runtime as unknown as ObservedRuntime;
            return buildModel(runtime.modelName, "gemini-video");
          },
        },
      },
    );

    assert.equal(runtimeCaptured, true);
    assert.equal(seenRuntime.modelName, "gemini-3.0-flash");
    assert.equal(seenRuntime.thinkingLevel, "medium");
    assert.equal(seenRuntime.includeThoughts, false);
    assert.equal(seenRuntime.toolMode, "any");
    assert.equal(seenRuntime.qualityProfile, "fast");
    assert.equal(seenRuntime.mediaResolution, "medium");
  });
});

test("When Gemini fails, result is diagnosable via event-log fallback path", async () => {
  const llm = await analyzeWithModel(
    { scenario: "gemini-failed" },
    {
      analyzers: {
        analyzeWithGeminiHelper: async () => {
          return null;
        },
      },
    },
  );

  assert.equal(llm, null);

  const fallbackSteps: CandidateStep[] = [buildStep("fallback-s1", "event-log")];
  const analysis = resolveAnalysisResult(llm, fallbackSteps);

  assert.equal(analysis.analysisPath, "event-log-fallback");
  assert.equal(analysis.analysisEngine, "event-log-fallback");
  assert.deepEqual(analysis.candidateSteps, fallbackSteps);
  assert.equal(analysis.analysisMeta.modelName, "event-log-fallback");
  assert.equal(analysis.analysisMeta.thinking, "high");
  assert.equal(analysis.analysisMeta.toolMode, "auto");
  assert.equal(analysis.analysisMeta.mediaResolutionApplied.default, "high");
  assert.equal(analysis.analysisMeta.thoughtSummaryPresent, false);
});

test("LLM analysis_meta is preserved in resolveAnalysisResult", async () => {
  const llm = await analyzeWithModel(
    { scenario: "llm-analysis-meta" },
    {
      analyzers: {
        analyzeWithGeminiHelper: async () => ({
          modelName: "gemini-3.1-pro-preview",
          detectedSignals: [],
          candidateSteps: [buildStep("s1", "gemini-video")],
          analysisMeta: {
            modelName: "gemini-3.1-pro-preview",
            thinking: "high",
            toolMode: "auto",
            mediaResolutionApplied: {
              default: "high",
              perPart: { part_1: "high", part_2: "medium" },
            },
            thoughtSummaryPresent: true,
          },
        }),
      },
    },
  );

  const analysis = resolveAnalysisResult(llm, []);
  assert.equal(analysis.analysisPath, "llm");
  assert.equal(analysis.analysisMeta.modelName, "gemini-3.1-pro-preview");
  assert.deepEqual(analysis.analysisMeta.mediaResolutionApplied.perPart, {
    part_1: "high",
    part_2: "medium",
  });
  assert.equal(analysis.analysisMeta.thoughtSummaryPresent, true);
});
