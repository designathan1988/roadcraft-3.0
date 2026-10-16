import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Frustum,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Sphere,
  type BufferAttribute,
  type Camera,
} from 'three';
import { Rng } from '@core/rng';
import { RunBuilder, createInstanceRuns, type Run, type RunStore } from '@render/instanceRuns';
import { SHADOW_REACH } from '@render/scenery';
import { m } from '@world/units';

/** THE LAYER KEPT THING BY THING (`instanceRuns.ts`) */

const geometry = new BoxGeometry(1, 1, 1);
geometry.computeBoundingSphere();
const material = new MeshBasicMaterial();
const specs: RunStore[] = [
  { name: 'plain', geometry, material, castShadow: true, receiveShadow: true, tinted: false, cards: false },
  { name: 'tinted', geometry, material, castShadow: true, receiveShadow: true, tinted: true, cards: false },
  { name: 'cards', geometry, material, castShadow: false, receiveShadow: true, tinted: true, cards: true },
];

/** A thing: a few instances round a centre, in some of the stores. */
function thing(rng: Rng, cx: number, cz: number, spread: number): { run: Run; spheres: Map<number, Sphere[]>; rows: Map<number, string[]> } {
  const builder = new RunBuilder(specs);
  const object = new Object3D();
  const spheres = new Map<number, Sphere[]>(), rows = new Map<number, string[]>();
  const n = 1 + Math.floor(rng.float() * 6);
  for (let i = 0; i < n; i++) {
    const store = Math.floor(rng.float() * specs.length);
    const s = m(0.3) + rng.float() * m(8);
    object.position.set(cx + (rng.float() - 0.5) * spread, rng.float() * m(20), cz + (rng.float() - 0.5) * spread);
    object.rotation.set(0, rng.float() * 6, 0);
    object.scale.set(s, s * (0.5 + rng.float()), s);
    object.updateMatrix();
    const tint = { r: rng.float(), g: rng.float(), b: rng.float() };
    builder.add(store, object.matrix.elements, Math.max(s, s * (0.5 + 1)), tint);
    const sphere = geometry.boundingSphere!.clone().applyMatrix4(object.matrix);
    const matrix = Float32Array.from(object.matrix.elements);
    const colour = specs[store]!.tinted ? Float32Array.from([tint.r, tint.g, tint.b]) : new Float32Array(0);
    (spheres.get(store) ?? spheres.set(store, []).get(store)!).push(sphere);
    (rows.get(store) ?? rows.set(store, []).get(store)!).push([...matrix, ...colour].join(','));
  }
  return { run: builder.build(), spheres, rows };
}

function cameraAt(rng: Rng, spread: number): Camera {
  if (rng.float() < 0.3) {
    const half = m(20) + rng.float() * spread;
    const camera = new OrthographicCamera(-half, half, half * 0.6, -half * 0.6, 1, m(20000));
    camera.position.set((rng.float() - 0.5) * spread, m(300) + rng.float() * m(2000), (rng.float() - 0.5) * spread);
    camera.lookAt(camera.position.x + (rng.float() - 0.5) * m(400), 0, camera.position.z + (rng.float() - 0.5) * m(400));
    camera.updateMatrixWorld();
    return camera;
  }
  const camera = new PerspectiveCamera(30 + rng.float() * 50, 1.2 + rng.float(), 1, m(200) + rng.float() * m(5000));
  camera.position.set((rng.float() - 0.5) * spread, m(2) + rng.float() * m(400), (rng.float() - 0.5) * spread);
  camera.lookAt((rng.float() - 0.5) * spread, 0, (rng.float() - 0.5) * spread);
  camera.updateMatrixWorld();
  return camera;
}

/** What the GPU holds of an attribute, updated as `WebGLAttributes` does when the mesh is drawn. */
class GpuCopy {
  private data: Float32Array | null = null;
  private version = -1;
  constructor(readonly attribute: BufferAttribute) {}
  draw(): Float32Array {
    const a = this.attribute, array = a.array as Float32Array;
    if (!this.data) {
      this.data = Float32Array.from(array);
      this.version = a.version;
    } else if (this.version < a.version) {
      if (a.updateRanges.length === 0) this.data.set(array);
      else for (const r of a.updateRanges) this.data.set(array.subarray(r.start, r.start + r.count), r.start);
      a.clearUpdateRanges();
      this.version = a.version;
    }
    return this.data;
  }
}

describe('instances kept thing by thing', () => {
  it('draws the live instances each sphere lets the view see, through things coming and going and hidden stores', () => {
    const rng = new Rng(2026);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    const live: ReturnType<typeof thing>[] = [];
    const gpu = new Map<object, { matrix: GpuCopy; colour: GpuCopy | null }>();
    const spread = m(3000);
    let compared = 0;
    const tolerance = m(0.01);
    for (let round = 0; round < 60; round++) {
      // Things come and go.
      const added: ReturnType<typeof thing>[] = [], removed: ReturnType<typeof thing>[] = [];
      for (let k = Math.floor(rng.float() * 40); k > 0; k--) {
        const c = rng.float() < 0.8 ? [(rng.float() - 0.5) * spread, (rng.float() - 0.5) * spread] : [m(70000), -m(66000)];
        added.push(thing(rng, c[0]!, c[1]!, m(50)));
      }
      for (let k = Math.floor(rng.float() * 20); k > 0 && live.length; k--) removed.push(...live.splice(Math.floor(rng.float() * live.length), 1));
      layer.update({ added: added.map((t) => t.run), removed: removed.map((t) => t.run) });
      live.push(...added);
      if (round % 7 === 3) layer.setMap(round % 2 === 1);
      for (let c = 0; c < 4; c++) {
        const camera = cameraAt(rng, spread);
        const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const frustum = new Frustum().setFromProjectionMatrix(view);
        // Some stores hidden for this view, shown again for the same view.
        const hidden = layer.meshes.filter((mesh) => mesh.visible && rng.float() < 0.3);
        for (const mesh of hidden) mesh.visible = false;
        layer.cull(frustum, view);
        for (const mesh of hidden) mesh.visible = true;
        layer.cull(frustum, view);
        for (const mesh of layer.meshes) {
          if (!mesh.visible) continue;
          const store = specs.findIndex((s) => s.name === mesh.name);
          let copy = gpu.get(mesh);
          if (!copy) gpu.set(mesh, copy = { matrix: new GpuCopy(mesh.instanceMatrix), colour: mesh.instanceColor ? new GpuCopy(mesh.instanceColor) : null });
          const on = copy.matrix.draw(), tints = copy.colour?.draw() ?? null;
          const got: string[] = [];
          for (let i = 0; i < mesh.count; i++) {
            const row = [...(mesh.instanceMatrix.array as Float32Array).subarray(i * 16, i * 16 + 16), ...(tints ? (mesh.instanceColor!.array as Float32Array).subarray(i * 3, i * 3 + 3) : [])];
            got.push(row.join(','));
            // The GPU's copy is the mesh's.
            expect([...on.subarray(i * 16, i * 16 + 16)].join(',')).toBe(row.slice(0, 16).join(','));
          }
          expect(new Set(got).size, 'each instance once').toBe(got.length);
          const drawnSet = new Set(got);
          for (const t of live) {
            (t.spheres.get(store) ?? []).forEach((sphere, i) => {
              const row = t.rows.get(store)![i]!;
              const probe = sphere.clone();
              probe.radius = sphere.radius * 1.5 + SHADOW_REACH + tolerance;
              if (!frustum.intersectsSphere(probe)) expect(drawnSet.has(row)).toBe(false);
              probe.radius = sphere.radius + SHADOW_REACH - tolerance;
              if (frustum.intersectsSphere(probe)) expect(drawnSet.has(row)).toBe(true);
            });
          }
          compared += got.length;
          expect(mesh.instanceMatrix.updateRanges.length).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(compared).toBeGreaterThan(5_000);
    layer.dispose();
  });

  it('sends nothing to the GPU again when the same instances are in view', () => {
    const rng = new Rng(5);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    layer.update({ added: Array.from({ length: 400 }, () => thing(rng, (rng.float() - 0.5) * m(2000), (rng.float() - 0.5) * m(2000), m(40)).run), removed: [] });
    const camera = new PerspectiveCamera(50, 1.6, 1, m(800));
    camera.position.set(0, m(80), 0);
    camera.lookAt(m(200), 0, -m(200));
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(view);
    layer.cull(frustum, view);
    const mesh = layer.meshes.find((x) => x.name === 'tinted')!;
    expect(mesh.count).toBeGreaterThan(0);
    mesh.instanceMatrix.clearUpdateRanges();
    const version = mesh.instanceMatrix.version, count = mesh.count;
    // Another view, then this one again: only what moved is written; the same view itself writes nothing.
    layer.cull(frustum, view.clone());
    expect(mesh.instanceMatrix.version).toBe(version);
    expect(mesh.count).toBe(count);
    layer.dispose();
  });

  it('holds on the GPU room for what is drawn, not for every instance of the town', () => {
    const rng = new Rng(11);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    layer.update({ added: Array.from({ length: 3000 }, () => thing(rng, (rng.float() - 0.5) * m(9000), (rng.float() - 0.5) * m(9000), m(40)).run), removed: [] });
    const look = (x: number, z: number, far: number): void => {
      const camera = new PerspectiveCamera(50, 1.6, 1, far);
      camera.position.set(x, m(60), z);
      camera.lookAt(x + m(100), 0, z - m(100));
      camera.updateMatrixWorld();
      const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      layer.cull(new Frustum().setFromProjectionMatrix(view), view);
    };
    const room = (): number => layer.meshes.reduce((n, mesh) => n + mesh.instanceMatrix.count, 0);
    const drawn = (): number => layer.meshes.reduce((n, mesh) => n + mesh.count, 0);
    look(0, 0, m(300));
    const near = room();
    expect(near).toBeLessThan(2_000);
    expect(drawn()).toBeGreaterThan(0);
    // The whole town in view: room grown to it; back to the street: given back.
    look(0, m(9000), m(30000));
    expect(room()).toBeGreaterThanOrEqual(drawn());
    expect(drawn()).toBeGreaterThan(near);
    look(0, 0, m(300));
    expect(room()).toBeLessThanOrEqual(Math.max(near * 2, 64 * specs.length * 2));
    layer.dispose();
  });
});
