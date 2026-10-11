import type { ProviderReplayTranscript, ThreadId } from "@t3tools/contracts";

import { forkInstructions } from "../ForkTurnNote.ts";

const USER_MESSAGE_MARKER = "\n\nUser message:\n";

function withNote(value: unknown, prompt: string, note: string): unknown {
  if (typeof value === "string") {
    if (value === prompt) return `${note}${USER_MESSAGE_MARKER}${prompt}`;
    const suffix = `${USER_MESSAGE_MARKER}${prompt}`;
    return value.endsWith(suffix) && !value.includes(note)
      ? `${value.slice(0, -suffix.length)}\n\n${note}${suffix}`
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => withNote(entry, prompt, note));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withNote(entry, prompt, note)]),
  );
}

/**
 * Adds the fork instructions to a fork's first prompt in transcripts recorded
 * before forks received them, keeping outbound matching exact.
 */
export function materializeReplayTranscriptForkInstructions(
  transcript: ProviderReplayTranscript,
  fork: {
    readonly prompt: string;
    readonly parentThreadId: ThreadId;
    readonly parentTitle: string;
    readonly sourceRunOrdinal: number;
  },
): ProviderReplayTranscript {
  // The recorded fixtures run in the project's main checkout.
  const note = forkInstructions({ ...fork, inMainCheckout: true });
  return {
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "expect_outbound"
        ? { ...entry, frame: withNote(entry.frame, fork.prompt, note) }
        : entry,
    ),
  };
}
