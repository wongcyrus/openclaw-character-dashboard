import { describe, expect, it } from "vitest";

import { SpeechPlayback } from "./speechPlayback";

describe("SpeechPlayback", () => {
  it("holds the first lines for two seconds before scrolling", () => {
    const playback = new SpeechPlayback();
    expect(playback.advance(2_000, 180, true)).toBe(false);
    expect(playback.offset).toBe(0);
    expect(playback.advance(1_000, 180, true)).toBe(false);
    expect(playback.offset).toBe(18);
  });

  it("shows overflowing text and then holds the final lines", () => {
    const playback = new SpeechPlayback();
    expect(playback.advance(12_000, 180, true)).toBe(false);
    expect(playback.offset).toBe(180);
    expect(playback.advance(2_999, 180, true)).toBe(false);
    expect(playback.advance(1, 180, true)).toBe(true);
  });

  it("keeps short completed messages visible for at least six seconds", () => {
    const playback = new SpeechPlayback();
    expect(playback.advance(5_999, 0, true)).toBe(false);
    expect(playback.advance(1, 0, true)).toBe(true);
  });

  it("never dismisses a message while its run is still streaming", () => {
    const playback = new SpeechPlayback();
    expect(playback.advance(60_000, 180, false)).toBe(false);
    expect(playback.offset).toBe(180);
    expect(playback.advance(2_999, 180, true)).toBe(false);
    expect(playback.advance(1, 180, true)).toBe(true);
  });

  it("extends scrolling without restarting when text grows", () => {
    const playback = new SpeechPlayback();
    playback.advance(12_000, 180, true);
    playback.advance(2_000, 180, true);
    playback.textChanged();
    expect(playback.advance(10_000, 360, true)).toBe(false);
    expect(playback.offset).toBe(360);
    expect(playback.advance(2_999, 360, true)).toBe(false);
    expect(playback.advance(1, 360, true)).toBe(true);
  });
});
