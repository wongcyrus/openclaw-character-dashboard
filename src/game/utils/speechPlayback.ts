const INITIAL_HOLD_MS = 2_000;
const FINAL_HOLD_MS = 3_000;
const MIN_VISIBLE_MS = 6_000;
const SCROLL_PX_PER_SECOND = 18;

export class SpeechPlayback {
  offset = 0;
  private elapsed = 0;
  private endHold = 0;

  textChanged(): void {
    this.endHold = 0;
  }

  advance(deltaMs: number, overflow: number, complete: boolean): boolean {
    const previousElapsed = this.elapsed;
    this.elapsed += deltaMs;
    const scrollTime =
      Math.max(0, this.elapsed - INITIAL_HOLD_MS) -
      Math.max(0, previousElapsed - INITIAL_HOLD_MS);
    const remaining = Math.max(0, overflow - this.offset);
    const travelTime = (remaining / SCROLL_PX_PER_SECOND) * 1000;
    this.offset = Math.min(
      Math.max(0, overflow),
      this.offset + (scrollTime / 1000) * SCROLL_PX_PER_SECOND,
    );

    if (!complete || this.offset < overflow) {
      this.endHold = 0;
      return false;
    }

    this.endHold += Math.max(0, scrollTime - travelTime);
    return this.endHold >= FINAL_HOLD_MS && this.elapsed >= MIN_VISIBLE_MS;
  }
}
