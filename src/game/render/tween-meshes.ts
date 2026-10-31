import Phaser from "phaser";
import { SPRITE_CANVAS_SIZE } from "../../shared/fighter-model";
import type { AlphaMask } from "./arap";
import type { FrameRef, TweenLayer } from "./pose-tweener";

/**
 * Phaser glue for PoseTweener output: one Mesh per tween layer id (made the
 * first time it shows), placed at the feet anchor and mirrored for a fighter
 * facing left. WebGL only. Shared by the fight's FighterSpriteView and the
 * fighter-select previews.
 */
export class TweenMeshes {
  private readonly meshes = new Map<string, Phaser.GameObjects.Mesh>();
  private shown: Phaser.GameObjects.Mesh[] = [];

  constructor(
    private readonly scene: Phaser.Scene,
    /** The texture a layer's capture is drawn from. */
    private readonly textureFor: (frame: FrameRef) => string,
    private readonly tint?: number,
  ) {}

  /** Draw `layers` (back to front) from depth `depth` up; hides any mesh not in them. */
  show(layers: TweenLayer[], facing: 1 | -1, at: { x: number; y: number }, depth: number, scale = 1): void {
    const shown = layers.map((layer, i) => {
      const mesh = this.meshFor(layer);
      // The capture's texture can change under a mesh (a talking stand-in: talking-mouth-view.ts).
      const texture = this.textureFor(layer.frame);
      if (mesh.texture.key !== texture) mesh.setTexture(texture);
      // Write screen-space vertex positions straight in (vx/vy), mirrored for P2. x/y
      // match them through the mesh's orthographic view, so a recompute changes nothing.
      for (let k = 0; k < mesh.vertices.length; k++) {
        const v = mesh.vertices[k];
        const index = layer.triangles[k];
        v.vx = facing * layer.positions[2 * index];
        v.vy = layer.positions[2 * index + 1];
        v.x = v.vx;
        v.y = -v.vy;
      }
      return mesh.setPosition(at.x, at.y).setScale(scale).setAlpha(layer.alpha).setDepth(depth + 0.1 * (i + 1)).setVisible(true);
    });
    for (const mesh of this.shown) if (!shown.includes(mesh)) mesh.setVisible(false);
    this.shown = shown;
  }

  hide(): void {
    for (const mesh of this.shown) mesh.setVisible(false);
    this.shown = [];
  }

  destroy(): void {
    this.meshes.forEach((mesh) => mesh.destroy());
    this.meshes.clear();
    this.shown = [];
  }

  private meshFor(layer: TweenLayer): Phaser.GameObjects.Mesh {
    let mesh = this.meshes.get(layer.id);
    if (!mesh) {
      mesh = this.scene.add.mesh(0, 0, this.textureFor(layer.frame));
      // 1 vertex unit = 1 px, y up; both windings drawn (mirroring flips them).
      mesh.hideCCW = false;
      mesh.setOrtho(mesh.width, mesh.height);
      const positions: number[] = [], uvs: number[] = [];
      for (let i = 0; i < layer.uvs.length; i += 2) {
        positions.push(layer.positions[i], -layer.positions[i + 1]);
        uvs.push(layer.uvs[i], layer.uvs[i + 1]);
      }
      mesh.addVertices(positions, uvs, Array.from(layer.triangles), false, undefined, this.tint ?? 0xffffff);
      this.meshes.set(layer.id, mesh);
    }
    return mesh;
  }
}

/** A texture's pixels at sprite-canvas size, or null if it can't be read. */
export function readAlpha(scene: Phaser.Scene, key: string): AlphaMask | null {
  const image = scene.textures.get(key).getSourceImage() as CanvasImageSource;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE_CANVAS_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(image, 0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
    return ctx.getImageData(0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
  } catch (err) {
    console.warn(`[tween] can't read ${key}, using hard cuts for it`, err);
    return null;
  }
}
