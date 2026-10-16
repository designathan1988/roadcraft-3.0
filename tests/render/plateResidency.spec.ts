// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { DataTexture, Frustum, Matrix4, OrthographicCamera, type DataArrayTexture, type EventDispatcher, type Material, type WebGLRenderer } from 'three';

// The baked surfaces need a canvas's pixels; flat stand-ins do for the plates' buffers.
vi.mock('@render/mesh/textureBaker', async (load) => {
  const real = await load<typeof import('@render/mesh/textureBaker')>();
  const flat = (): DataTexture => { const t = new DataTexture(new Uint8Array(4 * 4 * 4).fill(128), 4, 4); t.needsUpdate = true; return t; };
  return { ...real, bakeSurface: () => ({ map: flat(), normalMap: flat(), roughnessMap: flat() }) };
});

import { RoadDoc } from '@world/doc';
import { PLATE_SIZE } from '@world/bounds';
import { createFlatAtlas } from '@render/flatAtlas';
import type { TerrainSurface } from '@render/terrain';

/** THE PLATES' GPU COPIES ONLY FOR THE PLATES IN VIEW (`render/flatAtlas.ts` cull, `render/terrain.ts` keepOnGpu) */

/** A camera straight down over a point of the map, taking in `half` metres each way. */
const viewOver = (x: number, y: number, half: number): Frustum => {
  const camera = new OrthographicCamera(-half, half, half, -half, 1, 10_000);
  camera.up.set(0, 0, -1);
  camera.position.set(x, 5000, -y);
  camera.lookAt(x, 0, -y);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
};
const own = (s: TerrainSurface): { paint: DataArrayTexture; shore: DataTexture; ecology: DataTexture } => {
  const data = (s.ground.material as Material).userData;
  return { paint: data['paint'] as DataArrayTexture, shore: data['shore'] as DataTexture, ecology: data['ecology'] as DataTexture };
};
/** Whether three.js sends the textures again (it calls `onUpdate` after an upload). */
const uploaded = (s: TerrainSurface): void => { for (const t of Object.values(own(s))) t.onUpdate?.(t); };

describe('the plates\' GPU copies', () => {
  it('are let go by the plates out of view, every array staying, and kept by those in it', () => {
    const doc = new RoadDoc();
    const atlas = createFlatAtlas(1);
    atlas.update(doc as never, false);
    atlas.updatePaint(doc as never);
    const far = { x: 2 * PLATE_SIZE, y: 2 * PLATE_SIZE };
    // Land on two plates: both drawn in full, wherever the view is.
    doc.addTerrainStamp({ x: 100, y: 100, radius: 50, strength: 5, mode: 'raise' });
    doc.addTerrainStamp({ x: far.x + 100, y: far.y + 100, radius: 50, strength: 5, mode: 'raise' });
    doc.addPaintDab({ kind: 'soil', x: far.x + 100, y: far.y + 100, radius: 30, strength: 1 } as never);
    atlas.update(doc as never, false);
    atlas.updatePaint(doc as never);
    const plateAt = (x: number, y: number): TerrainSurface => atlas.parts.find((p) => p.cx === x && p.cy === y)!.surface;
    const home = plateAt(0, 0), away = plateAt(far.x, far.y);
    uploaded(home);
    uploaded(away);
    const disposed = new Set<EventDispatcher<{ dispose: object }>>();
    for (const s of [home, away]) for (const o of [s.ground.geometry, ...Object.values(own(s))]) o.addEventListener('dispose', () => disposed.add(o));
    const height = atlas.renderedHeightAt(far.x + 100, far.y + 100);
    const positions = away.ground.geometry.getAttribute('position').array;

    atlas.cull!(viewOver(0, 0, 500));
    for (const o of [away.ground.geometry, ...Object.values(own(away))]) expect(disposed.has(o)).toBe(true);
    // The home plate lends its materials to the whole map: kept.
    expect([home.ground.geometry, ...Object.values(own(home))].some((o) => disposed.has(o))).toBe(false);
    // Only the GPU's copies go: the ground answers as before, from the same arrays.
    expect(atlas.renderedHeightAt(far.x + 100, far.y + 100)).toBe(height);
    expect(away.ground.geometry.getAttribute('position').array).toBe(positions);

    // Painted while let go: no box sent, no range or layer named (three.js r186 would send only those into the fresh texture).
    const copies: unknown[] = [];
    const renderer = { copyTextureToTexture: (...args: unknown[]) => { copies.push(args); } } as unknown as WebGLRenderer;
    doc.addPaintDab({ kind: 'forest', x: far.x + 120, y: far.y + 90, radius: 30, strength: 1 } as never);
    atlas.updatePaint(doc as never);
    away.bakeRelief(renderer, null);
    expect(copies).toHaveLength(0);
    expect(own(away).shore.updateRanges).toHaveLength(0);
    doc.clearPaint();
    atlas.updatePaint(doc as never);
    expect(own(away).paint.layerUpdates.size).toBe(0);

    // Back in view: nothing let go again; once sent whole, a dab goes as its box.
    disposed.clear();
    atlas.cull!(viewOver(far.x, far.y, 500));
    expect(disposed.size).toBe(0);
    // The first dab after the clearing lays the plate's paint again, whole; the next goes as its box.
    doc.addPaintDab({ kind: 'soil', x: far.x + 100, y: far.y + 100, radius: 30, strength: 1 } as never);
    atlas.updatePaint(doc as never);
    uploaded(away);
    doc.addPaintDab({ kind: 'forest', x: far.x + 120, y: far.y + 90, radius: 30, strength: 1 } as never);
    atlas.updatePaint(doc as never);
    away.bakeRelief(renderer, null);
    expect(copies).toHaveLength(1);
  });
});
