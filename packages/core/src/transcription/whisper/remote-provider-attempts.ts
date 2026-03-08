import { transcribeWithAssemblyAi, transcribeFileWithAssemblyAi } from "./assemblyai.js";
import type { CloudProvider } from "./cloud-providers.js";
import { MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { transcribeWithFal } from "./fal.js";
import { isFfmpegAvailable, transcodeBytesToMp3 } from "./ffmpeg.js";
import { transcribeFileWithGemini, transcribeWithGemini } from "./gemini.js";
import { shouldRetryOpenAiViaFfmpeg, transcribeWithOpenAi } from "./openai.js";
import type { WhisperProgressEvent, WhisperTranscriptionResult } from "./types.js";
import { formatBytes, wrapError } from "./utils.js";

type Env = Record<string, string | undefined>;

export type RemoteByteState = {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
};

type RemoteByteAttemptResult = {
  state: RemoteByteState;
  result: WhisperTranscriptionResult | null;
  error: Error | null;
  skipped?: boolean;
};

type RemoteFileAttemptResult =
  | { kind: "result"; result: WhisperTranscriptionResult }
  | { kind: "error"; error: Error }
  | { kind: "delegate-to-bytes" };

type TranscribeOversizedBytesWithChunking = (args: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}) => Promise<WhisperTranscriptionResult>;

export async function attemptRemoteBytesProvider(args: {
  provider: CloudProvider;
  state: RemoteByteState;
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  env: Env;
  notes: string[];
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeOversizedBytesWithChunking?: TranscribeOversizedBytesWithChunking;
}): Promise<RemoteByteAttemptResult> {
  const executor = BYTE_PROVIDER_EXECUTORS[args.provider];
  return executor(args);
}

export async function attemptRemoteFileProvider(args: {
  provider: CloudProvider;
  filePath: string;
  mediaType: string;
  filename: string | null;
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  env: Env;
}): Promise<RemoteFileAttemptResult> {
  if (args.provider === "assemblyai") {
    try {
      const text = await transcribeFileWithAssemblyAi({
        filePath: args.filePath,
        mediaType: args.mediaType,
        apiKey: args.assemblyaiApiKey!,
      });
      if (text)
        return { kind: "result", result: { text, provider: "assemblyai", error: null, notes: [] } };
      return { kind: "error", error: new Error("AssemblyAI transcription returned empty text") };
    } catch (caught) {
      return {
        kind: "error",
        error:
          caught instanceof Error ? caught : wrapError("AssemblyAI transcription failed", caught),
      };
    }
  }

  if (args.provider === "gemini") {
    try {
      const text = await transcribeFileWithGemini({
        filePath: args.filePath,
        mediaType: args.mediaType,
        filename: args.filename,
        apiKey: args.geminiApiKey!,
        env: args.env,
      });
      if (text)
        return { kind: "result", result: { text, provider: "gemini", error: null, notes: [] } };
      return { kind: "error", error: new Error("Gemini transcription returned empty text") };
    } catch (caught) {
      return {
        kind: "error",
        error: wrapError("Gemini transcription failed", caught),
      };
    }
  }

  return { kind: "delegate-to-bytes" };
}

const BYTE_PROVIDER_EXECUTORS: Record<
  CloudProvider,
  (args: {
    state: RemoteByteState;
    assemblyaiApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey: string | null;
    falApiKey: string | null;
    env: Env;
    notes: string[];
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
    transcribeOversizedBytesWithChunking?: TranscribeOversizedBytesWithChunking;
  }) => Promise<RemoteByteAttemptResult>
> = {
  assemblyai: async ({ state, assemblyaiApiKey }) => {
    try {
      const text = await transcribeWithAssemblyAi(state.bytes, state.mediaType, assemblyaiApiKey!);
      if (text) {
        return {
          state,
          result: { text, provider: "assemblyai", error: null, notes: [] },
          error: null,
        };
      }
      return {
        state,
        result: null,
        error: new Error("AssemblyAI transcription returned empty text"),
      };
    } catch (caught) {
      return {
        state,
        result: null,
        error:
          caught instanceof Error ? caught : wrapError("AssemblyAI transcription failed", caught),
      };
    }
  },
  gemini: async ({ state, geminiApiKey, env }) => {
    try {
      const text = await transcribeWithGemini(
        state.bytes,
        state.mediaType,
        state.filename,
        geminiApiKey!,
        { env },
      );
      if (text) {
        return {
          state,
          result: { text, provider: "gemini", error: null, notes: [] },
          error: null,
        };
      }
      return { state, result: null, error: new Error("Gemini transcription returned empty text") };
    } catch (caught) {
      return {
        state,
        result: null,
        error: wrapError("Gemini transcription failed", caught),
      };
    }
  },
  openai: async ({
    state,
    openaiApiKey,
    env,
    notes,
    onProgress,
    transcribeOversizedBytesWithChunking,
  }) => {
    let nextState = state;
    if (
      nextState.bytes.byteLength > MAX_OPENAI_UPLOAD_BYTES &&
      transcribeOversizedBytesWithChunking &&
      openaiApiKey
    ) {
      const canChunk = await isFfmpegAvailable();
      if (canChunk) {
        return {
          state: nextState,
          result: await transcribeOversizedBytesWithChunking({
            bytes: nextState.bytes,
            mediaType: nextState.mediaType,
            filename: nextState.filename,
            onProgress,
          }),
          error: null,
        };
      }
      notes.push(
        `Media too large for Whisper upload (${formatBytes(nextState.bytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`,
      );
      nextState = {
        ...nextState,
        bytes: nextState.bytes.slice(0, MAX_OPENAI_UPLOAD_BYTES),
      };
    }

    let error: Error | null = null;
    try {
      const text = await transcribeWithOpenAi(
        nextState.bytes,
        nextState.mediaType,
        nextState.filename,
        openaiApiKey!,
        { env },
      );
      if (text) {
        return {
          state: nextState,
          result: { text, provider: "openai", error: null, notes: [] },
          error: null,
        };
      }
      error = new Error("OpenAI transcription returned empty text");
    } catch (caught) {
      error = wrapError("OpenAI transcription failed", caught);
    }

    if (error && shouldRetryOpenAiViaFfmpeg(error)) {
      const canTranscode = await isFfmpegAvailable();
      if (canTranscode) {
        try {
          notes.push("OpenAI could not decode media; transcoding via ffmpeg and retrying");
          const mp3Bytes = await transcodeBytesToMp3(nextState.bytes);
          const retried = await transcribeWithOpenAi(
            mp3Bytes,
            "audio/mpeg",
            "audio.mp3",
            openaiApiKey!,
            { env },
          );
          if (retried) {
            return {
              state: { bytes: mp3Bytes, mediaType: "audio/mpeg", filename: "audio.mp3" },
              result: { text: retried, provider: "openai", error: null, notes: [] },
              error: null,
            };
          }
          error = new Error("OpenAI transcription returned empty text after ffmpeg transcode");
          nextState = { bytes: mp3Bytes, mediaType: "audio/mpeg", filename: "audio.mp3" };
        } catch (caught) {
          notes.push(
            `ffmpeg transcode failed; cannot retry OpenAI decode error: ${
              caught instanceof Error ? caught.message : String(caught)
            }`,
          );
        }
      } else {
        notes.push("OpenAI could not decode media; install ffmpeg to enable transcoding retry");
      }
    }

    return { state: nextState, result: null, error };
  },
  fal: async ({ state, falApiKey, notes }) => {
    if (!state.mediaType.toLowerCase().startsWith("audio/")) {
      notes.push(`Skipping FAL transcription: unsupported mediaType ${state.mediaType}`);
      return { state, result: null, error: null, skipped: true };
    }
    try {
      const text = await transcribeWithFal(state.bytes, state.mediaType, falApiKey!);
      if (text) {
        return {
          state,
          result: { text, provider: "fal", error: null, notes: [] },
          error: null,
        };
      }
      return { state, result: null, error: new Error("FAL transcription returned empty text") };
    } catch (caught) {
      return {
        state,
        result: null,
        error: wrapError("FAL transcription failed", caught),
      };
    }
  },
};
