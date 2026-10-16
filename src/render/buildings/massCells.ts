import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three';
import { gpuOnly } from '../mesh/gpuOnly';
import { cancelWarm, warmLooseAhead } from '../uploads';
import { m } from '@world/units';
import type { CellMass } from './cellArrays';
import type { BuildingKit } from './kit';

/** THE BUILDINGS' FAR LEVEL, cell by cell: each cell of the buildings' grid */

/** The largest thing the far level leaves out, m: a balcony's slab (1.3 m) or a sill and its frame stand out of the wall */
const FAR_ERROR = m(1.5);
/** The detail is drawn while what the far level leaves out spans this many pixels or more. */
const NEAR_PIXELS = 2;
/** A cell drawn near stays near down to this share of `NEAR_PIXELS`. */
const HYSTERESIS = 0.85;
/** STREET-LEVEL HORIZON VIEWS: with the eye near the ground and looking along the streets */
const STREET_EYE = m(40);
const HORIZON_HALF = m(150);

/** A cell's key from its column and row (`layer.ts` `cellOf`). */
const keyOf = (i: number, j: number): string => `${i},${j}`;

interface Cell {
  mesh: Mesh | null;
  /** Its buildings have no mass (lots only): drawn by its detail alone, always near. */
  massless: boolean;
  /** Its box in the plan (map x/y) and its highest point, for the distance to the eye. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  near: boolean;
}

/** The farthest a cell may be drawn near in perspective, world units: where its far level's error falls to `NEAR_PIXELS`. */
export function nearReach(pxAtMetre: number): number {
  return (FAR_ERROR * pxAtMetre) / NEAR_PIXELS;
}

export interface MassCells {
  readonly group: Group;
  /** A cell whose masses are asked (new, or its buildings changed): kept as it stands until they come (`land`) */
  plan(key: string): void;
  /** A cell's masses come: its mesh made of them (null: its buildings have no mass, the cell always near). */
  land(key: string, mass: CellMass | null): void;
  /** A cell with no building left: gone. */
  remove(key: string): void;
  /** Every cell there is (the whole town filed again, `layer.ts`). */
  keys(): IterableIterator<string>;
  /** Which cells are drawn near (their detail) and which far (their masses), from the eye (map x/y, height) and the screen */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, allNear: boolean | ReadonlySet<string>, reach?: number): void;
  /** Whether a cell is drawn near; a cell with no mass (lawns only), or none known, always is. */
  near(key: string): boolean;
  /** The cells drawn near now (what the streaming of the detail reads, `layer.ts` `landCells`). */
  nearKeys(): Iterable<string>;
  /** Whether a cell's detail is shown (`layer.ts` streaming): a near cell keeps its mass shown until its detail lands */
  setDetailed(key: string, detailed: boolean): void;
  dispose(): void;
}

const boxOf = (b: Float64Array): Box3 => new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
const sphereOf = (b: Float64Array): Sphere => new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);

/** A cell's mesh from its masses' arrays, taken as they came */
function cellMesh(mass: CellMass, kit: BuildingKit): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mass.position, 3));
  g.setAttribute('normal', new BufferAttribute(mass.normal, 3));
  g.setAttribute('color', new BufferAttribute(mass.color, 3));
  g.setAttribute('facade', new BufferAttribute(mass.facade, 4));
  g.setAttribute('glazing', new BufferAttribute(mass.glazing, 2));
  g.setIndex(new BufferAttribute(mass.index, 1));
  g.boundingBox = boxOf(mass.bounds);
  g.boundingSphere = sphereOf(mass.bounds);
  const mesh = new Mesh(g, kit.massing);
  gpuOnly(mesh, () => ({}));
  mesh.name = 'building-massing';
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createMassCells(kit: BuildingKit, cellSize: number): MassCells {
  const group = new Group();
  group.name = 'buildings-far';
  group.matrixAutoUpdate = false;
  const cells = new Map<string, Cell>();
  /** DO NOT walk every cell of the town each frame to choose */
  const nearKeys = new Set<string>();
  const detailed = new Set<string>();
  /** How far a cell's box reaches past its square (a building over its edge), the most of any: the eye's search is grown by it. */
  let overhang = 0;
  /** A cell's mass shown: far, or near with no detail to stand in for it. */
  const showMass = (key: string, cell: Cell): void => {
    if (cell.mesh) cell.mesh.visible = !cell.near || !detailed.has(key);
  };
  const setNear = (key: string, cell: Cell, near: boolean): void => {
    cell.near = near;
    if (near) nearKeys.add(key); else nearKeys.delete(key);
    showMass(key, cell);
  };
  const drop = (cell: Cell): void => {
    if (!cell.mesh) return;
    cancelWarm([cell.mesh]);
    group.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    cell.mesh = null;
  };
  /** A cell's square on the map. */
  const square = (key: string): { x0: number; y0: number; x1: number; y1: number } => {
    const comma = key.indexOf(',');
    const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
    return { x0: i * cellSize, y0: j * cellSize, x1: (i + 1) * cellSize, y1: (j + 1) * cellSize };
  };
  return {
    group,
    plan(key) {
      if (cells.has(key)) return;
      // Near until the eye says otherwise (`choose`), as a cell made before the eye is known.
      const cell: Cell = { mesh: null, massless: false, ...square(key), top: 0, near: true };
      cells.set(key, cell);
      setNear(key, cell, true);
    },
    land(key, mass) {
      const known = cells.get(key);
      if (known) drop(known);
      const cell: Cell = { mesh: null, massless: mass === null, ...square(key), top: 0, near: known?.near ?? true };
      if (mass) {
        const mesh = cellMesh(mass, kit);
        const box = mesh.geometry.boundingBox!;
        cell.mesh = mesh;
        cell.top = mass.top;
        // A building reaching past its cell's edge: the cell's box is its masses'.
        const { x0, y0, x1, y1 } = cell;
        cell.x0 = Math.min(x0, box.min.x); cell.x1 = Math.max(x1, box.max.x); cell.y0 = Math.min(y0, -box.max.z); cell.y1 = Math.max(y1, -box.min.z);
        overhang = Math.max(overhang, x0 - cell.x0, cell.x1 - x1, y0 - cell.y0, cell.y1 - y1);
        group.add(mesh);
        // DO NOT wait for the camera to frame it: a cell of masses out of view was never uploaded and kept its copy on the CPU
        void warmLooseAhead([mesh]);
      }
      cells.set(key, cell);
      // A cell with no mass is always near (its detail is all it has).
      setNear(key, cell, cell.massless || cell.near);
    },
    remove(key) {
      const cell = cells.get(key);
      if (!cell) return;
      drop(cell);
      cells.delete(key);
      nearKeys.delete(key);
    },
    keys() {
      return cells.keys();
    },
    choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, allNear, reach = Infinity) {
      const decide = (key: string, cell: Cell): void => {
        let near: boolean;
        const forced = allNear === true || (allNear !== false && allNear.has(key));
        if (forced || cell.massless) near = true;
        else {
          // To the cell's nearest point (Cesium measures to the tile's bounding volume).
          const dx = Math.max(cell.x0 - eyeX, 0, eyeX - cell.x1);
          const dy = Math.max(cell.y0 - eyeY, 0, eyeY - cell.y1);
          let pixels: number;
          let allowed = NEAR_PIXELS;
          if (orthoPx !== null) pixels = FAR_ERROR * orthoPx;
          else {
            const dz = Math.max(eyeZ - cell.top, 0);
            const d = Math.max(Math.hypot(dx, dy, dz), 1);
            pixels = (FAR_ERROR * pxAtMetre) / d;
            // The eye low: the farther the cell, the more error it may make (`HORIZON_HALF`).
            const street = Math.max(0, 1 - eyeZ / STREET_EYE);
            allowed = NEAR_PIXELS * (1 + (street * d) / HORIZON_HALF);
          }
          // Within reach, with a margin for a cell already near (hysteresis).
          near = pixels >= allowed * (cell.near ? HYSTERESIS : 1) && Math.hypot(dx, dy) <= reach * (cell.near ? 1.25 : 1);
        }
        if (near !== cell.near) setNear(key, cell, near);
      };
      // Those near now may go far; those named stay near.
      for (const key of [...nearKeys]) decide(key, cells.get(key)!);
      if (allNear !== true && allNear !== false) for (const key of allNear) { const cell = cells.get(key); if (cell && !cell.near) decide(key, cell); }
      // A far cell comes near only within the farthest a near cell may be on the map
      const within = allNear === true ? Infinity
        : orthoPx !== null ? (FAR_ERROR * orthoPx >= NEAR_PIXELS ? reach : 0)
          : Math.min(reach, nearReach(pxAtMetre));
      if (within <= 0) return;
      const r = within + overhang;
      const i0 = Math.floor((eyeX - r) / cellSize), i1 = Math.floor((eyeX + r) / cellSize);
      const j0 = Math.floor((eyeY - r) / cellSize), j1 = Math.floor((eyeY + r) / cellSize);
      const span = (i1 - i0 + 1) * (j1 - j0 + 1);
      // Past the town's own cells (a view of the whole map): its cells, no more.
      if (!Number.isFinite(span) || span > cells.size) {
        for (const [key, cell] of cells) if (!cell.near) decide(key, cell);
        return;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = keyOf(i, j);
          const cell = cells.get(key);
          if (cell && !cell.near) decide(key, cell);
        }
      }
    },
    near(key) {
      return cells.get(key)?.near ?? true;
    },
    nearKeys() {
      return nearKeys;
    },
    setDetailed(key, on) {
      if (on) detailed.add(key); else detailed.delete(key);
      const cell = cells.get(key);
      if (cell) showMass(key, cell);
    },
    dispose() {
      for (const cell of cells.values()) drop(cell);
      cells.clear();
      nearKeys.clear();
      detailed.clear();
    },
  };
}
