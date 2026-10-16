import { applyStructureSway } from './wind';
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
  type Frustum,
  type BufferGeometry,
  type Material,
} from 'three';

import { signalPostPlace } from '@world/signalPosts';
import { JournalCursor } from '@world/derived';
import type { SimMirror } from '@sim/mirror';
import type { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { signalStateFor, type SignalState } from '@sim/signals/query';
import { m } from '@world/units';

/** Physical traffic signal heads. ## Why every head is double-sided A real signal aims its lenses at the traffic it */

/** Signal heads at life size, like everything else in the scene */
const SIGNAL_SCALE = 1;
const u = (metres: number): number => m(metres) * SIGNAL_SCALE;

const POST_HEIGHT = u(6.2);
const POST_RADIUS = u(0.09);
const ARM_LENGTH = u(3.5);
const ARM_RADIUS = u(0.06);
const HEAD_HEIGHT = u(1.05);
const HEAD_WIDTH = u(0.42);
const HEAD_DEPTH = u(0.3);
const LAMP_RADIUS = u(0.15);
const VISOR_DEPTH = u(0.18);
const HEAD_CENTRE = u(5.5);
/** Vertical spacing between lens centres. */
const LAMP_PITCH = HEAD_HEIGHT * 0.3;

type Lamp = 'red' | 'amber' | 'green';
const LAMPS: readonly Lamp[] = ['red', 'amber', 'green'];
/** Which way each lens cluster looks, along the housing's local Z. */
const FACES = [1, -1] as const;

export interface SignalHeads {
  readonly group: Group;
  /** `frustum`: what the camera sees this frame; the lamps of cells out of it wait until they come in. */
  sync(world: SimMirror, net: Network, detailed: boolean, frustum?: Frustum): void;
  dispose(): void;
}

/** The heads are batched BY CELL of the ground */
const SIGNAL_CELL = m(256);
/** How far a head's parts reach from the foot of its post, with its sway: the cell's sphere grows by it. */
const HEAD_REACH = Math.hypot(ARM_LENGTH + HEAD_WIDTH, POST_HEIGHT) + m(0.1);

interface Head {
  readonly x: number;
  readonly height: number;
  readonly y: number;
  readonly yaw: number;
  readonly groupId: number;
  readonly key: string;
  state: SignalState | null;
}

/** A signalised junction's heads, and the controller's phase they were last drawn at. */
interface Junction {
  readonly node: NodeId;
  readonly heads: Head[];
  /** The phase seen (`plan`, `stageIndex`, `sub`): the heads are asked again only when it moves. */
  plan: unknown;
  stage: number;
  sub: string;
}

type BatchName = 'posts' | 'arms' | 'boxes' | 'visors' | 'lit' | 'halos' | 'red' | 'amber' | 'green';

interface Cell {
  readonly junctions: Junction[];
  readonly heads: Head[];
  readonly batches: Record<BatchName, InstancedMesh>;
  readonly sphere: Sphere;
  /** A head's state changed: its lenses are written again (this cell's only). */
  stale: boolean;
}

/** Builds and updates the physical signal heads used by the Three.js renderer. */
export function createSignalHeads(
  scene: Scene,
  elevationAt: (x: number, y: number, segment?: SegmentId) => number = () => 0,
): SignalHeads {
  const group = new Group();
  group.name = 'traffic-signals';
  scene.add(group);

  const postGeometry = new CylinderGeometry(POST_RADIUS, POST_RADIUS, POST_HEIGHT, 8);
  const armGeometry = new CylinderGeometry(ARM_RADIUS, ARM_RADIUS, ARM_LENGTH, 8);
  const housingGeometry = new BoxGeometry(HEAD_WIDTH, HEAD_HEIGHT, HEAD_DEPTH);
  // A flat disc rather than a sphere
  const lensGeometry = new CylinderGeometry(LAMP_RADIUS, LAMP_RADIUS, u(0.06), 12).rotateX(
    Math.PI / 2,
  );
  const haloGeometry = new CylinderGeometry(LAMP_RADIUS * 1.8, LAMP_RADIUS * 1.8, u(0.02), 12)
    .rotateX(Math.PI / 2);
  const visorGeometry = new BoxGeometry(LAMP_RADIUS * 2.5, u(0.06), VISOR_DEPTH);

  const steel = new MeshStandardMaterial({ color: 0x2b302d, roughness: 0.7, metalness: 0.45 });
  const housing = new MeshStandardMaterial({ color: 0x15191a, roughness: 0.78, metalness: 0.1 });
  // A signal post sways a few centimetres at the top in a gust, its arm and heads with it (`applyStructureSway`).
  const armSteel = steel.clone();
  const SWAY = m(0.05);
  applyStructureSway(steel, POST_HEIGHT / 2, POST_HEIGHT, SWAY, 'signal-post');
  applyStructureSway(armSteel, POST_HEIGHT - u(0.3), POST_HEIGHT, SWAY, 'signal-arm');
  applyStructureSway(housing, HEAD_CENTRE, POST_HEIGHT, SWAY, 'signal-housing');
  // Lit lenses keep their hue at full brightness: basic and untone-mapped, white here and coloured per instance.
  const lit = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const LIT: Record<Lamp, Color> = {
    red: new Color(0xff4034),
    amber: new Color(0xffb219),
    green: new Color(0x3bf06a),
  };
  // Off, but still obviously a coloured filter over a dark can.
  const dark: Record<Lamp, MeshStandardMaterial> = {
    red: lensMaterial(0x8d221c, 0x2a0705),
    amber: lensMaterial(0x8a6410, 0x281c04),
    green: lensMaterial(0x1d6b33, 0x07230f),
  };
  const halo = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.28 });
  for (const [k, mat] of [['lit', lit], ['halo', halo], ['red', dark.red], ['amber', dark.amber], ['green', dark.green]] as const) {
    applyStructureSway(mat, HEAD_CENTRE, POST_HEIGHT, SWAY, `signal-${k}`);
  }
  const HALO: Record<Lamp, Color> = {
    red: new Color(0xff5145),
    amber: new Color(0xffc850),
    green: new Color(0x59ff86),
  };

  const solid = { cast: true, receive: true };
  const shading = { cast: true, receive: false };
  const glow = { cast: false, receive: false };
  /** Each kind of part: its geometry, material, instances a head, shadows, and whether it takes a colour per instance. */
  const KINDS: Record<BatchName, readonly [BufferGeometry, Material, number, { cast: boolean; receive: boolean }, boolean]> = {
    posts: [postGeometry, steel, 1, solid, false],
    arms: [armGeometry, armSteel, 1, solid, false],
    boxes: [housingGeometry, housing, 1, solid, false],
    visors: [visorGeometry, housing, LAMPS.length * FACES.length, shading, false],
    lit: [lensGeometry, lit, FACES.length, glow, true],
    halos: [haloGeometry, halo, FACES.length, glow, true],
    red: [lensGeometry, dark.red, FACES.length, glow, false],
    amber: [lensGeometry, dark.amber, FACES.length, glow, false],
    green: [lensGeometry, dark.green, FACES.length, glow, false],
  };
  const NAMES = Object.keys(KINDS) as BatchName[];
  const FIXED: readonly BatchName[] = ['posts', 'arms', 'boxes', 'visors'];
  const LENSES: readonly BatchName[] = ['lit', 'halos', 'red', 'amber', 'green'];
  /** A cell's batches, sized for its heads, culled by its sphere. */
  const batchesFor = (heads: number, sphere: Sphere): Record<BatchName, InstancedMesh> => {
    const out = {} as Record<BatchName, InstancedMesh>;
    for (const name of NAMES) {
      const [geometry, material, perHead, shadows, coloured] = KINDS[name];
      const capacity = Math.max(1, heads * perHead);
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.name = `signal-${name}`;
      mesh.count = 0;
      mesh.castShadow = shadows.cast;
      mesh.receiveShadow = shadows.receive;
      // Culled as a cell, by the sphere round its heads (three's own test, `frustumCulled` left on).
      mesh.boundingSphere = sphere;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      if (coloured) {
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
        mesh.instanceColor.setUsage(DynamicDrawUsage);
      }
      group.add(mesh);
      out[name] = mesh;
    }
    return out;
  };

  // Where each part sits in its head, relative to the foot of the post.
  const at = (x: number, y: number, z: number, rotateZ = 0): Matrix4 =>
    new Matrix4().makeRotationZ(rotateZ).setPosition(x, y, z);
  const POST = at(0, POST_HEIGHT / 2, 0);
  const ARM = at(ARM_LENGTH / 2, POST_HEIGHT - u(0.3), 0, -Math.PI / 2);
  const BOX = at(ARM_LENGTH, HEAD_CENTRE, 0);
  const lens: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const halos: Record<Lamp, Matrix4[]> = { red: [], amber: [], green: [] };
  const visors: Matrix4[] = [];
  LAMPS.forEach((name, index) => {
    const y = HEAD_CENTRE + LAMP_PITCH * (1 - index);
    for (const face of FACES) {
      const z = (HEAD_DEPTH / 2 + u(0.03)) * face;
      halos[name].push(at(ARM_LENGTH, y, z * 0.96));
      lens[name].push(at(ARM_LENGTH, y, z));
      // A hood over each lens.
      visors.push(at(ARM_LENGTH, y + LAMP_RADIUS * 1.15, z + (VISOR_DEPTH / 2) * face));
    }
  });

  const root = new Matrix4();
  const place = new Matrix4();
  const turn = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const foot = new Vector3();
  const one = new Vector3(1, 1, 1);
  const put = (mesh: InstancedMesh, local: Matrix4, colour?: Color): void => {
    place.multiplyMatrices(root, local);
    mesh.setMatrixAt(mesh.count, place);
    if (colour) mesh.setColorAt(mesh.count, colour);
    mesh.count++;
  };
  /** What was written of a mesh to the GPU: its first `count` instances. */
  const flush = (mesh: InstancedMesh): void => {
    mesh.visible = mesh.count > 0;
    if (!mesh.count) return;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  };
  const rootOf = (head: Head): void => {
    root.compose(foot.set(head.x, head.height, -head.y), turn.setFromAxisAngle(up, head.yaw), one);
  };

  /** What each head shows, by `node:segment`, for the verification harness. */
  const shown = new Map<string, SignalState>();
  group.userData.heads = shown;
  /** The cells by key (`SIGNAL_CELL` of each junction's first head), and each junction's cell. */
  const cells = new Map<number, Cell>();
  const junctionCell = new Map<NodeId, number>();
  /** The network the heads stand on, the junctions' log as last read (`signalChangesSince`), and the land's changes. */
  let placedNetwork: Network | null = null;
  let signalSerial = -1;
  const landRead = new JournalCursor(['terrain', 'elevation']);

  const dropCell = (cell: Cell): void => {
    for (const name of NAMES) { group.remove(cell.batches[name]); cell.batches[name].dispose(); }
  };
  const dropCells = (): void => {
    for (const cell of cells.values()) dropCell(cell);
    cells.clear();
    junctionCell.clear();
  };

  /** A cell's lenses written again from its heads' states: that cell's alone. */
  const writeLenses = (cell: Cell): void => {
    const b = cell.batches;
    for (const name of LENSES) b[name].count = 0;
    for (const head of cell.heads) {
      rootOf(head);
      for (const name of LAMPS) {
        const on = head.state === name;
        for (let face = 0; face < FACES.length; face++) {
          if (on) {
            put(b.lit, lens[name][face] as Matrix4, LIT[name]);
            put(b.halos, halos[name][face] as Matrix4, HALO[name]);
          } else {
            put(b[name], lens[name][face] as Matrix4);
          }
        }
      }
    }
    for (const name of LENSES) flush(b[name]);
    cell.stale = false;
  };

  /** A signalised junction's heads, one on each approach of a signal group, where the world stands its post. */
  const junctionOf = (world: SimMirror, net: Network, node: NodeId): Junction | null => {
    const groups = world.junctionGroups(node);
    if (!groups || !world.controller(node)) return null;
    const nodeRecord = net.doc.node(node);
    if (!nodeRecord) return null;
    const heads: Head[] = [];
    for (const segmentId of nodeRecord.incident) {
      const segment = net.doc.segment(segmentId);
      if (!segment) continue;
      const signalGroup = groups.find((candidate) => candidate.segments.includes(segmentId));
      if (!signalGroup) continue;
      // Where the post stands is the world's (`world/signalPosts.ts`): the pedestrians walk round the same post.
      const post = signalPostPlace(net, node, segmentId);
      if (!post) continue;
      heads.push({
        x: post.x,
        height: elevationAt(post.x, post.y, segmentId),
        y: post.y,
        // Local +X carries the arm inward over the road.
        yaw: post.yaw,
        groupId: signalGroup.id,
        key: `${node}:${segmentId}`,
        state: null,
      });
    }
    return heads.length ? { node, heads, plan: null, stage: -1, sub: '' } : null;
  };
  const cellKeyOf = (j: Junction): number => Math.floor(j.heads[0]!.x / SIGNAL_CELL) * 100_003 + Math.floor(j.heads[0]!.y / SIGNAL_CELL);
  /** A cell's batches made again from its junctions: that cell's alone. */
  const buildCell = (key: number, junctions: Junction[]): void => {
    const was = cells.get(key);
    if (was) { dropCell(was); cells.delete(key); }
    if (!junctions.length) return;
    const heads = junctions.flatMap((j) => j.heads);
    let cx = 0, cy = 0, cz = 0;
    for (const h of heads) { cx += h.x; cy += h.height; cz -= h.y; }
    cx /= heads.length; cy /= heads.length; cz /= heads.length;
    let r = 0;
    for (const h of heads) r = Math.max(r, Math.hypot(h.x - cx, h.height - cy, -h.y - cz));
    const sphere = new Sphere(new Vector3(cx, cy, cz), r + HEAD_REACH);
    const cell: Cell = { junctions, heads, batches: batchesFor(heads.length, sphere), sphere, stale: true };
    for (const head of heads) {
      rootOf(head);
      put(cell.batches.posts, POST);
      put(cell.batches.arms, ARM);
      put(cell.batches.boxes, BOX);
      for (const visor of visors) put(cell.batches.visors, visor);
    }
    for (const name of FIXED) flush(cell.batches[name]);
    for (const name of LENSES) cell.batches[name].visible = false;
    cells.set(key, cell);
  };
  const countLamps = (): void => {
    let lamps = 0;
    for (const cell of cells.values()) lamps += cell.heads.length * LAMPS.length * FACES.length;
    group.userData.lamps = lamps;
  };

  /** @rebuild Every head of the map placed again, cell by cell. */
  const placeAll = (world: SimMirror, net: Network): void => {
    dropCells();
    shown.clear();
    const byCell = new Map<number, Junction[]>();
    for (const node of world.junctionNodesInOrder()) {
      const entry = junctionOf(world, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      const list = byCell.get(key);
      if (list) list.push(entry); else byCell.set(key, [entry]);
    }
    for (const [key, junctions] of byCell) buildCell(key, junctions);
    countLamps();
  };

  /** These junctions placed again, and the cells they left or came into made again. */
  const placeSome = (world: SimMirror, net: Network, nodes: Iterable<NodeId>): void => {
    const touched = new Map<number, Junction[]>();
    const cellJunctions = (key: number): Junction[] => {
      let list = touched.get(key);
      if (!list) touched.set(key, list = [...(cells.get(key)?.junctions ?? [])]);
      return list;
    };
    for (const node of new Set(nodes)) {
      const was = junctionCell.get(node);
      if (was !== undefined) {
        const list = cellJunctions(was);
        const at = list.findIndex((j) => j.node === node);
        if (at >= 0) for (const head of list[at]!.heads) shown.delete(head.key);
        if (at >= 0) list.splice(at, 1);
        junctionCell.delete(node);
      }
      const entry = junctionOf(world, net, node);
      if (!entry) continue;
      const key = cellKeyOf(entry);
      junctionCell.set(node, key);
      cellJunctions(key).push(entry);
    }
    for (const [key, junctions] of touched) buildCell(key, junctions);
    countLamps();
  };

  return {
    group,
    sync(world, net, detailed, frustum) {
      if (!detailed) {
        group.visible = false;
        return;
      }
      group.visible = true;
      // DO NOT place every head of the map again on a revision of the network, the traffic, the land or the topology
      const log = world.signalChangesSince(signalSerial);
      const land = landRead.read(net.doc.changes);
      if (placedNetwork !== net || log.nodes === null || land === null || land.some((e) => e.rects === null)) {
        placedNetwork = net;
        placeAll(world, net);
      } else {
        const nodes = new Set<NodeId>(log.nodes);
        for (const entry of land) {
          for (const rect of entry.rects!) {
            for (const id of net.segmentCells.idsMeeting(rect)) {
              const segment = net.doc.segment(id);
              if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
            }
          }
        }
        if (nodes.size) placeSome(world, net, nodes);
      }
      signalSerial = log.serial;
      // DO NOT ask every head of the map each frame, nor write every lens of the map at a change of one.
      let litLenses = 0;
      for (const cell of cells.values()) {
        if (frustum && !frustum.intersectsSphere(cell.sphere)) continue;
        for (const junction of cell.junctions) {
          const controller = world.controller(junction.node);
          const plan = controller?.plan ?? null, stage = controller?.stageIndex ?? -1, sub = controller?.sub ?? '';
          if (junction.plan === plan && junction.stage === stage && junction.sub === sub && junction.heads[0]!.state !== null) continue;
          junction.plan = plan;
          junction.stage = stage;
          junction.sub = sub;
          for (const head of junction.heads) {
            const state = controller ? signalStateFor(controller, head.groupId) : 'red';
            if (head.state === state) continue;
            head.state = state;
            shown.set(head.key, state);
            cell.stale = true;
          }
        }
        if (cell.stale) writeLenses(cell);
        litLenses += cell.batches.lit.count;
      }
      group.userData.litLamps = litLenses;
    },
    dispose() {
      scene.remove(group);
      dropCells();
      group.clear();
      shown.clear();
      for (const geometry of [
        postGeometry,
        armGeometry,
        housingGeometry,
        lensGeometry,
        haloGeometry,
        visorGeometry,
      ]) {
        geometry.dispose();
      }
      const materials: Material[] = [steel, armSteel, housing, lit, halo, ...Object.values(dark)];
      for (const material of materials) material.dispose();
    },
  };
}

/** An unlit lens: a coloured filter with a faint glow, over a dark can. */
function lensMaterial(color: number, emissive: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 1,
    roughness: 0.35,
    metalness: 0,
  });
}
