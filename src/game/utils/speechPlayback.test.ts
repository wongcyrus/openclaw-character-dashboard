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

  it("shows all overflowing text, then holds the last lines for exactly three seconds", () => {
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

  it("extends the scroll without restarting when new text arrives during the final hold", () => {
    const playback = new SpeechPlayback();
    playback.advance(12_000, 180, true);
    expect(playback.advance(2_000, 180, true)).toBe(false);
    playback.textChanged();
    expect(playback.offset).toBe(180);
    expect(playback.advance(10_000, 360, true)).toBe(false);
    expect(playback.offset).toBe(360);
    expect(playback.advance(2_999, 360, true)).toBe(false);
    expect(playback.advance(1, 360, true)).toBe(true);
  });

  it("resets dismissal when text changes without adding overflow", () => {
    const playback = new SpeechPlayback();
    playback.advance(10_000, 0, false);
    expect(playback.advance(2_000, 0, true)).toBe(false);
    playback.textChanged();
    expect(playback.advance(2_999, 0, true)).toBe(false);
    expect(playback.advance(1, 0, true)).toBe(true);
  });

  it("handles a frame that crosses the end of scrolling without counting travel as hold time", () => {
    const playback = new SpeechPlayback();
    playback.advance(2_000, 18, true);
    expect(playback.advance(3_500, 18, true)).toBe(false);
    expect(playback.offset).toBe(18);
    expect(playback.advance(500, 18, true)).toBe(true);
  });
});
