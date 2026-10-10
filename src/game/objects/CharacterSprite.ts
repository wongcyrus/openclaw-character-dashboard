import Phaser from "phaser";

import type { CharacterConfig } from "@/types/world";
import type { CharacterMessage } from "@/store/characterStore";
import { formatSenderHeader } from "@/utils/messageFormat";

// ---------------------------------------------------------------------------
// Animation clip names (match spec/character-sprite-sheet.csv)
// ---------------------------------------------------------------------------

export type AnimationClip =
  | "stand"
  | "walk-down"
  | "walk-up"
  | "walk-left"
  | "walk-right" // derived from walk-left via flipX
  | "sit"
  | "sleep"
  | "work";

export type SpriteVariant = "inside" | "outside";

// ---------------------------------------------------------------------------
// Walk speed constants (pixels per second)
// ---------------------------------------------------------------------------

export type WalkSpeed = "fastest" | "normal" | "slowest";

export const WALK_SPEED_PX: Record<WalkSpeed, number> = {
  fastest: 160,
  normal: 80,
  slowest: 40,
};

// ---------------------------------------------------------------------------
// Frame layout from the loaded spritesheet texture.
// startFrame for a clip = row * framesPerRow (not def.frames, which is the
// number of used frames in that clip, which may be 2 or 3).
// ---------------------------------------------------------------------------

type ClipDef = {
  row: number;
  frames: number;
  frameRate: number;
  repeat: number;
  /** Which variant files this clip appears in */
  variants: SpriteVariant[];
};

// CLIP_DEFS is loaded at runtime from public/clip-defs.json via Phaser's JSON cache.
// Access it with: this.scene.cache.json.get("clip-defs") as Record<string, ClipDef>

/**
 * CharacterSprite
 *
 * A Phaser Sprite that wraps a character config, manages animation clips,
 * and exposes a moveTo() API for pathfinding-driven movement (Phase 5).
 *
 * Animation key naming convention: `<characterId>-<variant>-<clipName>`
 * e.g. "alice-outside-walk-down"
 */
export class CharacterSprite extends Phaser.GameObjects.Sprite {
  private characterId: string;
  private characterConfig: CharacterConfig;
  private currentVariant: SpriteVariant;
  private currentClip: AnimationClip = "stand";
  private activeTween: Phaser.Tweens.Tween | null = null;
  private speechBubble: Phaser.GameObjects.Container | null = null;
  private speechHeader: Phaser.GameObjects.Text | null = null;
  private speechText: Phaser.GameObjects.Text | null = null;
  private speechBg: Phaser.GameObjects.Graphics | null = null;
  private speechMessage: CharacterMessage | null = null;
  private speechTimer = 0;
  private onSpeechComplete: (() => void) | null = null;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    config: CharacterConfig,
    initialVariant: SpriteVariant,
  ) {
    const textureKey = `${config.id}-${initialVariant}`;
    super(scene, x, y, textureKey, 0);

    this.characterId = config.id;
    this.characterConfig = config;
    this.currentVariant = initialVariant;

    scene.add.existing(this);
    // Depth is managed per-frame by WorldScene (Y-sort); no static depth here.
    this.setOrigin(0.5, 1); // anchor at feet

    this.registerAnimations(config);
    this.playClip("stand");
    this.createSpeechBubble();
  }

  private createSpeechBubble(): void {
    const maxBubbleWidth = 320;
    const paddingX = 12;

    this.speechBg = this.scene.add.graphics();

    this.speechHeader = this.scene.add.text(0, 0, "", {
      fontSize: "11px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontStyle: "bold",
      color: "#38bdf8",
    });
    this.speechHeader.setOrigin(0, 0);

    this.speechText = this.scene.add.text(0, 0, "", {
      fontSize: "13px",
      fontFamily: "monospace, system-ui, sans-serif",
      color: "#ffffff",
      align: "left",
      wordWrap: {
        width: maxBubbleWidth - paddingX * 2,
        useAdvancedWrap: true,
      },
    });
    this.speechText.setOrigin(0, 0);

    this.speechBubble = this.scene.add.container(0, 0, [
      this.speechBg,
      this.speechHeader,
      this.speechText,
    ]);
    this.speechBubble.setVisible(false);
    this.speechBubble.setDepth(20000); // Well above characters
  }

  showSpeech(message: CharacterMessage, onComplete: () => void): void {
    if (
      !this.speechText ||
      !this.speechHeader ||
      !this.speechBubble ||
      !this.speechBg
    )
      return;

    this.speechMessage = message;
    this.onSpeechComplete = onComplete;
    this.speechTimer = 0;

    const isUser = message.role === "user";
    const headerLabel = formatSenderHeader(
      message.role,
      this.characterConfig.name || this.characterId,
      message.channel,
    );
    const headerColor = isUser ? "#38bdf8" : "#fbbf24";
    const bodyColor = isUser ? "#e0f2fe" : "#ffffff";
    const bgColor = isUser ? 0x0f172a : 0x111827;
    const bgAlpha = 0.92;
    const borderColor = isUser ? 0x0284c7 : 0xd97706;

    this.speechHeader.setText(headerLabel);
    this.speechHeader.setColor(headerColor);

    this.speechText.setText(message.text);
    this.speechText.setColor(bodyColor);

    this.speechBubble.setVisible(true);

    const headerBounds = this.speechHeader.getBounds();
    const textBounds = this.speechText.getBounds();

    const paddingX = 12;
    const paddingY = 8;
    const headerGap = 4;

    const contentWidth = Math.max(headerBounds.width, textBounds.width);
    const bubbleWidth = Math.max(
      120,
      Math.min(320, contentWidth + paddingX * 2),
    );
    const bubbleHeight =
      paddingY + headerBounds.height + headerGap + textBounds.height + paddingY;

    const boxX = -bubbleWidth / 2;
    const boxY = -bubbleHeight - 6; // 6px for pointer tail

    this.speechBg.clear();

    // Main bubble background
    this.speechBg.fillStyle(bgColor, bgAlpha);
    this.speechBg.lineStyle(2, borderColor, 1);
    this.speechBg.fillRoundedRect(boxX, boxY, bubbleWidth, bubbleHeight, 8);
    this.speechBg.strokeRoundedRect(boxX, boxY, bubbleWidth, bubbleHeight, 8);

    // Header divider line
    const dividerY = boxY + paddingY + headerBounds.height + 2;
    this.speechBg.lineStyle(1, borderColor, 0.4);
    this.speechBg.beginPath();
    this.speechBg.moveTo(boxX + paddingX, dividerY);
    this.speechBg.lineTo(boxX + bubbleWidth - paddingX, dividerY);
    this.speechBg.strokePath();

    // Pointer tail triangle at the bottom pointing to character
    this.speechBg.fillStyle(bgColor, bgAlpha);
    this.speechBg.lineStyle(2, borderColor, 1);
    this.speechBg.beginPath();
    this.speechBg.moveTo(-6, -6);
    this.speechBg.lineTo(0, 0);
    this.speechBg.lineTo(6, -6);
    this.speechBg.closePath();
    this.speechBg.fillPath();
    this.speechBg.strokePath();

    // Position text elements inside container
    this.speechHeader.setPosition(boxX + paddingX, boxY + paddingY);
    this.speechText.setPosition(
      boxX + paddingX,
      boxY + paddingY + headerBounds.height + headerGap,
    );

    this.updateSpeechPosition();
  }

  hideSpeech(): void {
    this.speechBubble?.setVisible(false);
    this.speechMessage = null;
    this.speechTimer = 0;
    this.onSpeechComplete = null;
  }

  private updateSpeechPosition(): void {
    if (
      !this.speechBubble ||
      !this.speechText ||
      !this.speechHeader
    )
      return;

    // Position above head
    let targetX = this.x;
    let targetY = this.y - this.displayHeight - 6;

    const headerBounds = this.speechHeader.getBounds();
    const textBounds = this.speechText.getBounds();
    const paddingX = 12;
    const paddingY = 8;
    const headerGap = 4;
    const contentWidth = Math.max(headerBounds.width, textBounds.width);
    const bubbleWidth = Math.max(
      120,
      Math.min(320, contentWidth + paddingX * 2),
    );
    const bubbleHeight =
      paddingY + headerBounds.height + headerGap + textBounds.height + paddingY;

    const sceneWidth = this.scene.scale.width;
    const sceneHeight = this.scene.scale.height;

    targetX = Phaser.Math.Clamp(
      targetX,
      bubbleWidth / 2 + 8,
      sceneWidth - bubbleWidth / 2 - 8,
    );
    if (targetY - bubbleHeight - 6 < 8) {
      targetY = bubbleHeight + 6 + 8;
    }
    if (targetY > sceneHeight - 16) {
      targetY = sceneHeight - 16;
    }

    this.speechBubble.setPosition(targetX, targetY);
  }

  preUpdate(time: number, delta: number): void {
    super.preUpdate(time, delta);
    if (this.speechBubble?.visible && this.speechMessage) {
      this.updateSpeechPosition();
      if (this.speechMessage.complete !== false) {
        this.speechTimer += delta;
        if (this.speechTimer >= 9000) {
          const onComplete = this.onSpeechComplete;
          this.hideSpeech();
          onComplete?.();
        }
      } else {
        this.speechTimer = 0;
      }
    }
  }

  override destroy(fromScene?: boolean): void {
    this.speechBubble?.destroy();
    this.speechBubble = null;
    this.speechHeader = null;
    this.speechText = null;
    this.speechBg = null;
    this.speechMessage = null;
    this.onSpeechComplete = null;
    super.destroy(fromScene);
  }

  /** Play a named animation clip. "walk-right" is walk-left with flipX. */
  playClip(clip: AnimationClip): void {
    if (clip === "walk-right") {
      this.setFlipX(true);
      this.playClipInternal("walk-left");
    } else {
      this.setFlipX(false);
      this.playClipInternal(clip);
    }
    this.currentClip = clip;
  }

  /**
   * Switch between inside/outside sprite sheet.
   * Re-plays the current clip on the new texture.
   */
  switchVariant(variant: SpriteVariant): void {
    if (variant === this.currentVariant) return;
    this.currentVariant = variant;
    const newKey = `${this.characterId}-${variant}`;
    this.setTexture(newKey);
    this.playClip(this.currentClip);
  }

  /**
   * Move the sprite to a pixel position via a tween.
   * Used by the pathfinding layer (Phase 5) to move through waypoints.
   */
  tweenTo(
    targetX: number,
    targetY: number,
    speed: WalkSpeed,
    onComplete?: () => void,
  ): void {
    // Cancel any in-progress tween
    if (this.activeTween) {
      this.activeTween.stop();
      this.activeTween = null;
    }

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const pxPerSec = WALK_SPEED_PX[speed];
    const durationMs = (distance / pxPerSec) * 1000;

    if (durationMs < 1) {
      // Already at target
      onComplete?.();
      return;
    }

    // Choose walk clip from movement direction
    const walkClip = this.walkClipFromDelta(dx, dy);
    this.playClip(walkClip);

    this.activeTween = this.scene.tweens.add({
      targets: this,
      x: targetX,
      y: targetY,
      duration: durationMs,
      ease: "Linear",
      onComplete: () => {
        this.activeTween = null;
        this.playClip("stand");
        onComplete?.();
      },
    });
  }

  stopMovement(): void {
    if (this.activeTween) {
      this.activeTween.stop();
      this.activeTween = null;
    }
    this.playClip("stand");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private playClipInternal(clip: string): void {
    const animKey = `${this.characterId}-${this.currentVariant}-${clip}`;
    if (this.anims.currentAnim?.key === animKey && this.anims.isPlaying) return;
    if (this.scene.anims.exists(animKey)) {
      this.play(animKey);
    }
  }

  private registerAnimations(config: CharacterConfig): void {
    const characterId = config.id;
    const variants: SpriteVariant[] = ["inside", "outside"];
    const clipDefs = this.scene.cache.json.get("clip-defs") as Record<
      string,
      ClipDef
    >;

    if (!clipDefs) {
      console.error(
        "[CharacterSprite] clip-defs not found in Phaser JSON cache.",
      );
      return;
    }

    for (const variant of variants) {
      const textureKey = `${characterId}-${variant}`;

      // Skip if texture not loaded (assets not ready or not provided yet)
      if (!this.scene.textures.exists(textureKey)) continue;

      const framesPerRow = this.getFramesPerRow(
        textureKey,
        config.spriteSheet.frameWidth,
      );
      if (framesPerRow === null) continue;

      for (const [clipName, def] of Object.entries(clipDefs)) {
        if (!def.variants.includes(variant)) continue;

        const animKey = `${characterId}-${variant}-${clipName}`;
        if (this.scene.anims.exists(animKey)) continue;

        const startFrame = def.row * framesPerRow;

        this.scene.anims.create({
          key: animKey,
          frames: this.scene.anims.generateFrameNumbers(textureKey, {
            start: startFrame,
            end: startFrame + def.frames - 1,
          }),
          frameRate: def.frameRate,
          repeat: def.repeat,
        });
      }
    }
  }

  private getFramesPerRow(
    textureKey: string,
    frameWidth: number,
  ): number | null {
    const texture = this.scene.textures.get(textureKey);
    const sourceImage = texture.getSourceImage();

    if (!sourceImage || typeof sourceImage.width !== "number") {
      console.error(
        `[CharacterSprite] Could not determine texture width for "${textureKey}".`,
      );
      return null;
    }

    const framesPerRow = Math.floor(sourceImage.width / frameWidth);
    if (framesPerRow < 1) {
      console.error(
        `[CharacterSprite] Invalid frames-per-row for "${textureKey}" with width ${sourceImage.width} and frameWidth ${frameWidth}.`,
      );
      return null;
    }

    return framesPerRow;
  }

  private walkClipFromDelta(dx: number, dy: number): AnimationClip {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? "walk-right" : "walk-left";
    }
    return dy >= 0 ? "walk-down" : "walk-up";
  }
}
