import { onEcologyRead } from './ecologyPool';
import { GRID_CELL } from '@world/grid';
import type { BodyPart, Severable } from '@sim/people/view';
import type { Archetype } from '@sim/vehicles/archetypes';
import type { Vehicle } from '@sim/vehicles/state';
import { workUntil } from '@core/frameWork';
import { pointInPolygon } from '@core/polygon';
import type { Occupant, RagdollProbe } from './ragdoll';
import type { GetUp, PlayEffects } from './playEffects';
import { createLotOverlay, type LotOverlayInput } from './lotOverlay';
import { onCarriageway } from '@world/carriageway';
import {
  BufferGeometry,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Float32BufferAttribute,
  Color,
  ACESFilmicToneMapping,
  Box3,
  PointLight,
  Group,
  Frustum,
  Matrix4,
  type Material,
  Mesh,
  MeshDepthMaterial,
  type Object3D,
  RGBADepthPacking,
  Sphere,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Digest } from '@core/digest';
import type { ChangeJournal, ChangeKind, ChangeRect, DerivedChangeKind } from '@world/changes';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { GROUND_ONLY, SURFACE_READ_REACH, buildRoadElevation, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE, sidewalkHalf } from '@world/roadTypes';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { type PavingData, type PavingSource, pavedHeightFrom } from '@world/paving';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { SimMirror } from '@sim/mirror';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment, slopeScaledShadowOffset } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { PERSPECTIVE_FOV, createIsoRig } from './isoViewport';
import { renderTargetsBytes } from './targetBytes';
import { DEFAULT_ATMOSPHERE, createPostChain, type Atmosphere, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, disposeSurfaceReuse, roadSurfaceSteps, storedKey, type RoadSurfaces, type SurfaceReuse, type TileBundle } from './roadSurfaces';
import { SurfaceInputs } from './roadSurfaceInputs';
import { forgetDerivedKeys, forgetOtherDerived, readDerivedKeys, readDerivedMany, writeDerivedMany } from './derivedCache';
import { disposeMesh } from './mesh/surfaceMesh';
import { RoadTilePool } from './roadTilePool';
import { GroundShapePool } from './groundShapePool';
import { type BlockDigestAsk, type GroundShapeAsk, type PlateShapeAnswer, blockDigest, cornerBoxes, shapeGroundAsk } from './groundShape';
import { shapeBoth } from './terrainShaping';
import { type HeightTile, heightTileBuffers } from './heightTile';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, createSceneryKit, plantSamples, type SceneryKit } from './scenery';
import { createStreetFurniture } from './streetFurnitureLayer';
import { createGardens, type GardenPlant, type Gardens } from './gardens';
import { gardenLists } from './gardenLists';
import { localToWorld, solidFootprints, storedBounds } from '@world/buildings/geometry';
import { followPieces } from '@world/buildings/elements';
import { RoadDoc } from '@world/doc';
import { compileAhead, compileCopy, drainCompiles, drainUploads, drainWarm, shadowStandIn, warmPending } from './uploads';
import { partWarmMeshes } from './buildings/partWarm';
import { advanceWind, setWindWeather } from './wind';
import { holdStill } from './stillTree';
import { createRain } from './rain';
import { createLightning } from './lightning';
import { windVector } from '@world/weather';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails } from './structures';
import { type StructureCells, createStructureCells } from './structureCells';
import { createExhaust } from './exhaust';
import { applyWear, createWearField } from './wear';
import { MAP_HALF, MAP_REGIONS, MAP_SIZE, regionAt } from '@world/bounds';
import { createSignLayer } from './signLayer';
import { type PlantCells, createCoverCells, createTreeCells } from './plantCells';
import { paintCatalogue } from './markings';
import { isNear, updateRoadLevels } from './mesh/roadResidency';
import { CellKeep, keepCellAt, keepCellBox, keepCellsOver } from './candidateKeep';
import { COVER_PLACE_REACH, type Candidate, type CoverGround, type NaturePlate, type ShoreCandidate, type WaterBox, forestIn, natureScale, pickNature, plateCells, rocksIn, scrubIn, shoreBox, shoreIn, sweepNaturePlate } from './plantPlaces';
import { JournalCursor } from '@world/derived';
import { Engine } from '@core/engine';
import { fadeMeshes } from './buildings/fade';
import { RevealGate } from './revealGate';
import { createGpuTimer, type GpuTimer } from './gpuTimer';
import { poleGroundAt } from './utilities';
import { type PoleLayer, buildPolePreview, buildUtilities, docPoles, type PolePreviewInput } from './poleLayer';
import { createBarriers } from './barriers';
import { buildTrackPreview, createTrackPreview, createTransit, type TrackPreview } from './transit';
import { TERRAIN_CELL, TERRAIN_GRID, TERRAIN_HALF, type TerrainPart, type TerrainRegion, type TerrainSurface } from './terrain';
import { createFlatAtlas } from './flatAtlas';
import { siteGrading } from '@world/buildings/siteGrading';
import { type CameraSolids, type GroundSince, cameraSolidsKeeper } from '@world/buildings/cameraSolids';
import { buildingFloors } from '@world/buildings/floors';
import { FLOOR_READ_REACH } from '@world/buildings/foundation';
import { RoomLamps } from './roomLamps';
import { TUNED_UNIT, m, perM } from '@world/units';
/** Room lights kept in the scene for the floors cut open (`roomLamps.ts`). */
const ROOM_LIGHTS = 6;
declare const __ROAD_TILES_HASH__: string | undefined;
/** The fingerprint of the road tiles' code (`cook-plugin.ts`): their tiles are kept under it between sessions. */
const ROAD_TILES_HASH = typeof __ROAD_TILES_HASH__ !== 'undefined' && __ROAD_TILES_HASH__ ? __ROAD_TILES_HASH__ : null;
/** How long the opening's roads wait for the kept tiles to be read, ms: past it they are built. */
const KEPT_TILES_WAIT_MS = 3000;

/** The thinnest frame bars are 0.045 u wide: their shadows are subpixel below this zoom. */
const FACADE_SHADOW_ZOOM = perM(27.5);
/** The zoom above which the shadow map is drawn every frame (px per metre). */
const SHADOW_FULL_ZOOM = perM(12);
/** Frames between shadow passes where a shadow is smaller than a texel. */
const SHADOW_FAR_EVERY = 3;
/** Longest a caster that arrived without saying so can be absent from the map, in frames */
const SHADOW_SAFETY_FRAMES = 30;
import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import { buildBuildingMeshes } from './buildings/buildingMesh';
import { refillArrays } from './mesh/gpuOnly';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';
import { type GroundRecord, type Rect, unionRect } from './groundChanges';
import { createGroundCoverKit } from './groundCover';
import { clearingIndex } from '@world/trees';
import { isCoverKind } from '@world/terrainPaint';
import { loadNatureTrees, type NatureTreeKit } from './natureTrees';
import { createFogField, createFogTexture, type FogLayer } from './fogLayer';
import { createElementLayer, loadElementKit, type ElementKit, type ElementLayer } from './elements';

/** The scene renderer. ## The rebuild contract Everything derived from the road network or the terrain is rebuilt in */

/** How the sky is kept: `cycle` follows the residents' clock. */
export type SkyMode = 'day' | 'night' | 'cycle';


/** What an explosion broke, for the renderer to throw (`blast.ts`): world coordinates. */
export interface BlastHit {
  readonly ground: 'road' | 'earth' | 'building';
  readonly crater: boolean;
  readonly poles: readonly { x: number; y: number; lamp: boolean; mode: 'whole' | 'snap' | 'splinter'; dirX: number; dirY: number }[];
  /** Wires torn off a broken pole: from the pole still standing towards the one that went. */
  readonly wires: readonly { fromX: number; fromY: number; toX: number; toY: number }[];
  readonly posts: readonly { x: number; y: number; yaw: number }[];
  /** `id` and `archetype`: which vehicle, for a wreck of its own body (`AgentMeshes.carcass`). */
  readonly vehicles: readonly { x: number; y: number; angle: number; length: number; width: number; height: number; color: number; id?: number; archetype?: Archetype }[];
  readonly items: readonly { kind: string; x: number; y: number }[];
}

interface RenderStats {
  /** Built scene geometry budget; `gl.info.render.triangles` counts drawn passes. */
  readonly triangles: number;
  /** Actual draw calls across every pass of the last game frame. */
  readonly drawCalls: number;
  readonly quality: QualityLevel;
  readonly fps: number;
  /** Wall time of the last world rebuild, in milliseconds. */
  readonly rebuildMs: number;
  /** The road surface tiles the last rebuild made afresh, and those it kept. */
  readonly roadTiles?: { readonly built: number; readonly reused: number };
  /** Increments once per completed world rebuild. */
  readonly rebuilds: number;
  /** Wall time of the last terrain-only update (a brush dab while roads are held), ms. */
  readonly terrainMs: number;
}

interface DrawOptions {
  /** Keep the roads, and everything laid along them, as they are */
  readonly holdRoads?: boolean;
  /** The simulation's clock stands still. */
  readonly paused?: boolean;
  /** Somebody a ragdoll held up again (`PlayEffects.frame`). */
  readonly getUp?: GetUp;
}

/** Where the player is looking, as the simulation takes it (`SimWorld.focus`). */
type SimFocus = NonNullable<SimWorld['focus']>;

export interface SceneHandle {
  /** Loads what shots and blows leave behind */
  effects(): Promise<void>;
  /** The world of the last edit is still being built (`worldSteps`); the old one is drawn meanwhile. */
  readonly worldBusy: boolean;
  /** The opening's town (or a map being opened) is still being put together, nothing of it shown yet (`opened` in `draw`). */
  readonly opening: boolean;
  /** A map is being opened (a file, the autosave): nothing is shown until its whole world is in */
  beginLoad(): void;
  readonly backend: 'three-webgl';
  readonly viewport: Viewport;
  readonly scene: Scene;
  /** The underlying WebGL renderer. Exposed for diagnostics and tests. */
  readonly gl: WebGLRenderer;
  readonly stats: RenderStats;
  /** The GPU time of each frame drawn (`gpuTimer.ts`): the F9 monitor and the performance gate read it. */
  readonly gpu: GpuTimer;
  /** The solved road height field, for the editor's own previews. */
  elevationAt(x: number, y: number, structure?: RoadStructure): number;
  /** The editor's building ghost; null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The pole run the pole tool would build, drawn as built; null removes it. */
  setPolePreview(net: Network, preview: PolePreviewInput | null): void;
  /** The metro seen as a cut through the ground (the transit tool on). */
  setTransitXray(on: boolean): void;
  /** The track being laid, built as it will be (`buildTrackPreview`); null removes it. */
  setTransitPreview(preview: { mode: 'train' | 'metro'; points: readonly { x: number; y: number }[] } | null): void;
  /** The lots of the Zoning tool coloured into the ground, all of them from the next frame (`lotOverlay.ts`) */
  setLotOverlay(input: LotOverlayInput | null, changes?: ChangeJournal): void;
  /** A blow on a building at world (x, y, z), `strength` 1..10: it breaks (`destruction.ts`). */
  strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
  /** A blow on the street at (x, y): a crater in the asphalt, dust. */
  strikeGround(x: number, y: number, strength: number): void;
  /** An explosion at world (x, y), height z, reaching `radius` (`blast.ts`), and the things it broke. */
  explode(x: number, y: number, z: number, radius: number, hit: BlastHit): void;
  /** People inside a struck building, thrown out of it (`ragdoll.fling`). */
  flingOccupants(list: readonly Occupant[]): void;
  /** Called when a struck building comes down after its blow (its pieces were made off the main thread). */
  onBuildingDown(listener: (id: number) => void): void;
  /** A broken hydrant spouting water (`blast.geyser`). */
  geyser(x: number, y: number, z: number, seconds?: number): void;
  /** A burst pipe: a small spout of water from a wall for a moment. */
  leak(x: number, y: number, z: number, seconds: number): void;
  /** Sparks of a short circuit at world (x, y), height z, for a while (`blast.arc`). */
  sparkAt(x: number, y: number, z: number, seconds: number): void;
  /** Soot laid on the ground (`blast.soot`). */
  soot(x: number, y: number, z: number, radius: number): void;
  /** Smoke in the air, 0 clear to 1 thick: the fog closes in, browner, the light dims. */
  setSmog(k: number): void;
  /** A lightning bolt onto the map point (x, y) now (`render/lightning.ts`). */
  strikeAt(x: number, y: number): void;
  /** Called at every strike with where it fell and how far from the view's centre, world units (for the thunder). */
  onStrike(listener: (x: number, y: number, distance: number) => void): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  cloudDrift(): { readonly x: number; readonly y: number };
  /** A lasting fire at world (x, y), height z (a building burning). */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Whether anything is still moving on its own (an explosion, bodies, debris): keep drawing. */
  busy(): boolean;
  /** Clouds drifting over the map: worth a frame now and then even with nothing else moving. */
  drifting(): boolean;
  /** The bytes of the render targets and shadow maps alive (an estimate, `targetBytes.ts`): not in the scene, so not in `countMemory`. */
  targetBytes(): number;
  /** Forgets a building's ruin (it was removed). */
  forgetRuin(id: number): void;
  /** The Builder's "Ocultar outros": undefined draws every building solid, null fades them all */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Clouds and mist as the player set them (Landscape > Sky and weather). */
  setAtmosphere(atmosphere: Atmosphere): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** A shot: a tracer from the muzzle to where it struck, and the muzzle's flash (world x, y, height). */
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  /** A person struck by a shot (world x, y, the height struck) */
  wound(x: number, y: number, z: number, dirX: number, dirY: number, severed: Severable | null): void;
  /** A shot along the line of sight between world points `a` and `b` (x, y, height) at the bodies on the ground */
  shootBody(a: readonly [number, number, number], b: readonly [number, number, number]): { alive: number; part: BodyPart } | 'hit' | null;
  /** Whether somebody is down on the ground as a body (not standing to be shot). */
  isDown(id: number): boolean;
  /** The bodies, guts and debris run at this share of real time (0: stopped; the weapons lab). */
  setEffectsSpeed(speed: number): void;
  /** Moves the bodies, guts and debris on by `seconds` once (a frame step while stopped). */
  stepEffects(seconds: number): void;
  /** Every body, piece, gut and blood stain gone (the weapons lab's clean slate). */
  clearCasualties(): void;
  /** Every body on the ground as the weapons lab measures it (`Ragdolls.probe`). */
  ragdollProbe(): RagdollProbe[];
  /** What poses a person now (`AgentMeshes.animProbe`). */
  animProbe(id: number): ReturnType<AgentMeshes['animProbe']>;
  /** Plays a clip on a person regardless (`AgentMeshes.forceClip`). */
  forceClip(id: number, clip: string | null): void;
  /** Every procedural person's skeleton measured against their body (`AgentMeshes.meshProbe`). */
  meshProbe(): ReturnType<AgentMeshes['meshProbe']>;
  /** A shot striking a vehicle at world (x, y, height z), coming along (dirX, dirY) */
  vehicleHit(x: number, y: number, z: number, dirX: number, dirY: number, glass: boolean, blood: boolean): void;
  /** The body a vehicle's driver or rider is drawn with (`AgentMeshes.driverBody`). */
  driverBody(vehicle: Pick<Vehicle, 'id' | 'people' | 'peopleAge' | 'archetype'>, x: number, y: number): number | null;
  /** A two-wheeler its rider was shot off: the machine itself falling over and sliding to a stop. */
  dropVehicle(v: { id: number; archetype: Archetype; x: number; y: number; angle: number; color: number; dirX: number; dirY: number }): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /** The highest corner of the ground as drawn now (the mesh is flat between corners), read once per change of it. */
  landTop(): number;
  /** The universal grid (`world/grid.ts`) drawn over the whole map, on the ground, or not. */
  setGrid(on: boolean): void;
  /** The grid's cells a road was just laid over light up and fade back, a blink */
  flashGrid(cells: readonly { x: number; y: number; ring: number }[]): void;
  /** The roads just laid light up and fade back, a blink, over their whole width. */
  flashRoads(ids: readonly SegmentId[]): void;
  /** The ground what is built stands on (`builtGroundAt`) */
  builtGroundAt(x: number, y: number): number;
  /** The roads' heights an edit already solved for this network on the natural terrain (the tunnel test, `commitRoadPath`) */
  offerElevation(elevation: RoadElevation, networkRevision: number): void;
  /** The roads' heights last solved on the natural terrain, with the terrain revision they were solved on */
  roadsSolve(): { readonly elevation: RoadElevation; readonly terrainRevision: number } | null;
  /** The top of what is drawn at a point: a deck where a road's casing covers it, the terrain elsewhere. */
  surfaceHeightAt(x: number, y: number): number;
  /** The height of the paving at a point - footway or carriageway of a road at grade - or NaN off the roads. */
  pavedHeightAt(x: number, y: number): number;
  /** The ground as drawn and the paving over a world box, for a worker to read as `terrainHeightAt` and `pavedHeightAt` (`heightTile.ts`). */
  heightTile(rect: readonly [number, number, number, number]): { readonly tile: HeightTile; readonly transfer: ArrayBuffer[] };
  resize(): void;
  draw(net: Network, sim: SimMirror, alpha: number, delta: number, options?: DrawOptions): void;
  /** Where the last frame drawn looked (`draw`): the simulation's people and traffic live round it. */
  readonly focus: SimFocus | null;
  setQuality(level: QualityLevel | 'auto'): void;
  readonly quality: QualityLevel | 'auto';
  /** The inspection camera (`inspector.ts`); null outside development builds. */
  readonly inspect: Inspector | null;
  /** Every figure drawn last frame and the body it was cast as: the runtime census. */
  census(): ReturnType<AgentMeshes['census']>;
  dispose(): void;
}

/** Roads at grade, and the decks above them, as `surfaceHeightAt` asks them. */
const SURFACE_SETS: readonly ReadonlySet<RoadStructure>[] = [GROUND_ONLY, new Set<RoadStructure>(['elevated', 'bridge'])];

/** A plant's leaf cards (`scenery.ts` `plantMeshes`, `gardens.ts`): `...-trees-<species>-cards`, `...-bushes-<kind>-cards`. */
const isLeafCards = (mesh: Object3D): boolean => mesh.name.endsWith('-cards');

/** The plants of every building's garden, in the world, on the ground they stand on. */
function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      // A long hedge in steps, each on the ground under it, not one box at its middle's height.
      const kind = el.kind;
      followPieces(el).forEach((piece, k) => {
        const at = localToWorld(b, piece.x, piece.y);
        out.push({ kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: piece.w, d: piece.d, h: piece.h, yaw,
          seed: ((b.id * 7919 + el.id * 104729 + k * 31) % 100003) / 100003 });
      });
    }
  }
  return out;
}

export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  initialCentre: Vec2,
  initialZoom: number,
  initialQuality: QualityLevel | 'auto' = 'auto',
  onAssetsReady: () => void = () => {},
  /** The engine the scene's products are registered with (`core/engine.ts`): the game's one, from `main.ts`. */
  engine: Engine = new Engine(),
): SceneHandle {
  // A plate's ecosystem read off the page (`ecologyPool.ts`) is drawn as it comes back.
  onEcologyRead(onAssetsReady);
  /** The shadow map is drawn only when it can have changed. */
  let shadowMoved = true;
  /** Frames since the shadow map was last drawn (`SHADOW_FAR_EVERY`). */
  let shadowFrame = 0;
  /** Whether anything that moves is drawn into the shadow map: a visible caster with instances outside what stands still */
  const castsInto = (root: Object3D): boolean => {
    const stack: Object3D[] = [root];
    while (stack.length) {
      const o = stack.pop()!;
      if (!o.visible) continue;
      const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number };
      if (mesh.isMesh && mesh.castShadow && (!mesh.isInstancedMesh || (mesh.count ?? 0) > 0)) return true;
      for (const child of o.children) stack.push(child);
    }
    return false;
  };
  const movingCasters = (): boolean => {
    for (const root of scene.children) {
      if (root === world || root === buildings.group || root.name === 'traffic-signals' || stillRoots.has(root)) continue;
      if (castsInto(root)) return true;
    }
    return castsInto(transit.group);
  };
  /** The ground and its grass, which never move (`movingCasters`). */
  const stillRoots = new Set<Object3D>();
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    // DO NOT drop it for a near plane pushed out or offsets grown until the flicker hides.
    reversedDepthBuffer: true,
  });
  // One game frame has the scene, shadows and several postprocess renders.
  renderer.info.autoReset = false;
  // Checking every program's compile and link log makes each new shader wait for the driver on the main thread
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  // The GPU time of every frame.
  const gpuTimer = createGpuTimer(renderer);
  renderer.outputColorSpace = SRGBColorSpace;
  // A film curve (ACES): contrast, deep shade and bright light, the look of the diorama the player holds up as the target
  renderer.toneMapping = ACESFilmicToneMapping;
  // Three's ACES already scales its input by 1 / 0.6
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186.
  renderer.shadowMap.type = PCFShadowMap;
  slopeScaledShadowOffset();
  // Drawn once a frame, on request (see `post.render` below).
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster without a depth material of its own with ONE
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
  };
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs, displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  let shadowDepthFrame = 0;
  const assignShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      if (!mesh.isMesh || !mesh.castShadow) return;
      const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
      if (current && !ownDepth.has(current)) return;
      if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
      const wanted = !mesh.isInstancedMesh
        ? depthVariants.plain
        : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
      if (current !== wanted) mesh.customDepthMaterial = wanted;
    });
  };

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  let gridWanted = false;
  /** The blinks of cells under a road just laid (`flashGrid`), until each has faded; `time` seconds since each began. */
  const gridFlashes: { mesh: Mesh; start: number; end: number; time: number }[] = [];
  /** ONE material for every blink, made once: a material per road laid was an object made and disposed per edit */
  const blinkMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aRing; varying float vRing;
        void main() {
          vRing = aRing;
          vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform float uTime; varying float vRing;
        void main() {
          float t = uTime - vRing * 0.09;
          float a = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.1, 0.75, t)) * (vRing < 0.5 ? 0.3 : 0.12);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(0.62, 0.95, 1.0, a);
        }`,
      // Over the ground whatever it does meanwhile
      transparent: true, depthWrite: false, depthTest: false, side: DoubleSide, blending: AdditiveBlending,
  });
  /** A blink on the ground: triangles (three's x, height, -y) lighting up and fading, each by its ring's delay. */
  const addBlink = (pos: readonly number[], ring: readonly number[]): void => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geometry.setAttribute('aRing', new Float32BufferAttribute(ring, 1));
    const mesh = new Mesh(geometry, blinkMaterial);
    mesh.name = 'grid-flash';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const flash = { mesh, start: performance.now(), end: 0.8 + Math.max(0, ...ring) * 0.09, time: 0 };
    mesh.onBeforeRender = () => {
      blinkMaterial.uniforms['uTime']!.value = flash.time;
      blinkMaterial.uniformsNeedUpdate = true;
    };
    scene.add(mesh);
    gridFlashes.push(flash);
  };
  /** Roads just laid, to blink once their heights are solved (`flashRoads`, `draw`). */
  const pendingRoadFlash: SegmentId[] = [];
  /** Behind the map while building it (`draw`): a plain dark blue. */
  const MAP_BACKGROUND = new Color(0x0c1a2c);
  const scene = new Scene();
  // The root never moves.
  scene.matrixAutoUpdate = false;
  scene.updateMatrix();
  const initialHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
  /** Where the relief's close window is centred (three's x, z; see `draw`). */
  const reliefFocus = { x: 0, z: 0 };
  const rig = createIsoRig(initialCentre, initialHeight / Math.max(0.001, initialZoom * 2));

  const environment = createEnvironment(scene, renderer, {
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
  });
  const materials: SceneMaterials = createMaterials(anisotropy);
  // Streets and footways wear with use (`wear.ts`).
  const wear = createWearField(MAP_SIZE);
  let lastWall = -1;
  applyWear(materials.asphalt, wear, MAP_SIZE, 0, 'asphalt');
  applyWear(materials.footway, wear, MAP_SIZE, 1, 'footway');
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once.
  const sceneryKit: SceneryKit = createSceneryKit();
  // The map's ground, in plates (`flatAtlas.ts`).
  const terrain: TerrainSurface = createFlatAtlas(anisotropy);
  /** The ground what is built stands on - the roads solved on it, the buildings' floors worked out on it */
  const builtGroundAt = (x: number, y: number): number => terrain.naturalRenderedHeightAt(x, y);
  // The perspective view looks at the ground and stays over it (`IsoRig.setGround`).
  rig.setGround((x, y) => terrain.renderedHeightAt(x, y));
  // DO NOT make it again unseen.
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __gl: renderer });
  scene.add(...terrain.meshes);
  for (const mesh of terrain.meshes) stillRoots.add(mesh);

  const world = new Group();
  world.name = 'world';
  // Roads, plants, poles, furniture, forests: placed once, never moved (`stillTree.ts`).
  holdStill(world);
  scene.add(world);

  let roads: RoadSurfaces | null = null;
  /** The roads' structures, cell by cell (`structureCells.ts`), made with the first world. */
  let details: StructureCells | null = null;
  /** What the player placed on the footways and the long grass, kept item by item from the diary (`streetFurnitureLayer.ts`) */
  const furniture = createStreetFurniture(sceneryKit);
  world.add(furniture.group, furniture.grass);
  let utilities: PoleLayer | null = null;
  /** The pole tool's planned run, and the plan it was built for (rebuilt only when that changes). */
  /** Vehicle exhaust and dust (`exhaust.ts`): one particle cloud for the map. */
  const exhaust = createExhaust();
  scene.add(exhaust.points);
  const shakeOffset = new Vector3();
  /** What shots and blows leave behind - bodies, blood, explosions, broken buildings (`playEffects.ts`) */
  let fx: PlayEffects | null = null;
  let fxLoading: Promise<void> | null = null;
  /** The effects asked for in idle time once the world stands (`draw`). */
  let fxPreload = false;
  // The effects' two lights - the muzzle's flash and the blast's - in the scene from the start, dark until used.
  const fxLights = {
    muzzle: new PointLight(0xffc070, 0, m(8), 2),
    blast: new PointLight(0xffb060, 0, m(60), 1.6),
  };
  scene.add(fxLights.muzzle, fxLights.blast);
  const buildingDownListeners: ((id: number) => void)[] = [];
  const loadEffects = (): Promise<void> => fxLoading ??= import('./playEffects').then((mod) => {
    fx = mod.createPlayEffects({
      scene, exhaust, agents,
      buildings: {
        chunkOf: (b) => buildings.chunkOf(b),
        setRuined: (ruined) => buildings.setRuined(ruined),
        lotHeightAt: (id, x, y) => buildings.lotHeightAt(id, x, y),
      },
      renderedHeightAt: (x, y) => terrain.renderedHeightAt(x, y),
      naturalRenderedHeightAt: (x, y) => builtGroundAt(x, y),
      pavedHeightAt: (x, y) => pavedHeightAt(x, y),
      camera: () => rig.camera,
      onAssetsReady,
      lights: fxLights,
    });
    fx.onBuildingDown((id) => { for (const listener of buildingDownListeners) listener(id); });
    onAssetsReady();
  });
  let polePreview: PoleLayer | null = null;
  /** Placed signs, street name plates and the junctions' rule plates, kept sign by sign from the diary (`signLayer.ts`). */
  const signs = createSignLayer();
  let polePreviewKey = '';
  const polePreviewRoads = new JournalCursor(['roads']);
  /** Walls, fences and hedges (`barriers.ts`), kept barrier by barrier from the diary. */
  const barriers = createBarriers();
  /** Public transport (`transit.ts`), kept track by track and stop by stop from the diary. */
  const transit = createTransit();
  let elevation: RoadElevation | null = null;
  /** Each rewrite of the drawn ground by the land (`terrain.update`), and the highest corner read after one (`landTop`). */
  let landVersion = 0;
  let landTopFor = -1;
  let landTopValue = 0;

  // What each rebuild keeps for the next
  const tilesPrefix = ROAD_TILES_HASH ? `roadtiles:${ROAD_TILES_HASH}:` : null;
  /** The kept tiles' keys have been read (or there are none to read). */
  let storedRead = tilesPrefix === null;
  /** What the store holds now, by `storedKey`. */
  const storedKeys = new Set<string>();
  /** Where the road tiles are kept for a later session, off the page (`derivedWriter.worker.ts`); none in tests. */
  const tileWriter = tilesPrefix && typeof Worker !== 'undefined'
    ? new Worker(new URL('./derivedWriter.worker.ts', import.meta.url), { type: 'module' }) : null;
  /** Where the camera looks and how far the roads are at full detail round it (`mesh/roadResidency.ts`). */
  const roadFocus = { x: initialCentre.x, y: initialCentre.y, reach: 700, frames: 0 };
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY, SURFACE_READ_REACH) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: paintCatalogue(),
    // A block of road is made at full detail only near the camera (`mesh/roadLod.ts`).
    near: (x, y) => isNear(x, y, roadFocus.x, roadFocus.y, roadFocus.reach),
    chunks: new Map(),
    inputs: new SurfaceInputs(),
    retired: [],
    // The store's keys known from the start (`readDerivedKeys`); a build reads the tiles it needs by them.
    ...(tilesPrefix ? { stored: { has: (key: string) => storedKeys.has(key), read: (keys: readonly string[]) => readDerivedMany<TileBundle>(tilesPrefix, keys) } } : {}),
    // DO NOT hold the built tiles for idle writes
    keep: (key, bundle) => {
      if (!tilesPrefix || storedKeys.has(key)) return;
      storedKeys.add(key);
      // The tile's arrays handed to the writer, not copied: nothing reads them once its blocks are merged (`SurfaceReuse.keep`).
      if (tileWriter) {
        const buffers: ArrayBuffer[] = [];
        for (const tile of bundle.values()) {
          for (const a of [tile.positions, tile.normals, tile.uvs, tile.colors, tile.sections, tile.indices]) buffers.push(a.buffer as ArrayBuffer);
        }
        tileWriter.postMessage({ prefix: tilesPrefix, entries: [[key, bundle]] }, buffers);
      } else writeDerivedMany(tilesPrefix, new Map([[key, bundle]]));
    },
  };
  if (tilesPrefix && ROAD_TILES_HASH) {
    forgetOtherDerived('roadtiles', ROAD_TILES_HASH);
    void readDerivedKeys(tilesPrefix).then((kept) => {
      for (const key of kept) storedKeys.add(key);
    }).finally(() => { storedRead = true; });
  }
  /** After a build: the store made to hold the network just built - its new tiles written as they were built */
  const keepTiles = (): void => {
    if (!tilesPrefix) return;
    const current = new Set<string>();
    for (const [pass, tiles] of surfaceReuse.tiles) for (const digest of tiles.keys()) current.add(storedKey(pass, digest));
    const gone = [...storedKeys].filter((key) => !current.has(key));
    for (const key of gone) storedKeys.delete(key);
    forgetDerivedKeys(tilesPrefix, gone);
  };

  /** The world being rebuilt for the last edit (`rebuildWorld`), a slice a frame. */
  let worldJob: Generator<'wait' | void, void, void> | null = null;
  /** The roads' heights an edit solved ahead (`offerElevation`). */
  let offeredElevation: { elevation: RoadElevation; revision: number; terrain: number } | null = null;
  /** The roads' surface tiles shaped on the other cores (`roadTilePool.ts`). */
  const roadTiles = new RoadTilePool();
  /** The job was started in this frame (`pumpWorld` waits for the next). */
  let worldJobFresh = false;
  /** DO NOT hold the grading for the whole job */
  let worldJobGround = false;
  /** The opening's town (or a map opened) is held until it is whole (`revealGate.ts`). */
  const reveal = new RevealGate();
  let openingSince: number | null = null;
  /** While nothing is shown (`opened` false) the world is built this much a frame */
  const HIDDEN_SLICE_MS = 250;

  /** The world of an edit is built up to this much a frame */
  const WORLD_SLICE_MS = 28;
  /** The last steps' costs, ms: the next step is started only if the dearest of them still fits in the slice */
  const stepCosts = new Float64Array(8);
  let stepCursor = 0;
  /** Builds the world of the last edit for a few milliseconds; it puts itself in place once complete. */
  const pumpWorld = (): void => {
    if (!worldJob) return;
    // Not in the frame of the edit itself, which has already paid for the edit and the roads' heights
    if (worldJobFresh) { worldJobFresh = false; onAssetsReady(); return; }
    const until = reveal.opened ? workUntil(WORLD_SLICE_MS, WORLD_SLICE_MS) : performance.now() + HIDDEN_SLICE_MS;
    if (!until) { onAssetsReady(); return; }
    // At least one step a frame, whatever it is expected to cost: the job always moves on.
    let at = performance.now();
    let step = worldJob.next();
    for (;;) {
      const now = performance.now();
      stepCosts[stepCursor++ % stepCosts.length] = now - at;
      if (step.done || step.value === 'wait') break;
      let estimate = 0;
      for (const cost of stepCosts) if (cost > estimate) estimate = cost;
      if (now + estimate > until) break;
      at = now;
      step = worldJob.next();
    }
    if (step.done) { worldJob = null; stepCosts.fill(0); shadowMoved = true; }
    else onAssetsReady();
  };
  /** Where the last frame drawn looked (`SceneHandle.focus`). */
  let focusNow: SimFocus | null = null;
  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  let terrainMs = 0;

  const deckHeight = (
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** The footway's rise over the carriageway at a point (`footwayRiseAt`), kerbed before any network is built. */
  const footwayRiseHere = (x: number, y: number): number => (worldNet ? footwayRiseAt(worldNet, x, y) : FOOTWAY_RISE);
  /** See `SceneHandle.pavedHeightAt` (`world/paving.ts`). */
  const pavedHeightAt: PavingSource = Object.assign((x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    return pavedHeightFrom(elevation, GROUND_ONLY, footwayRiseHere, x, y);
  }, {
    pack: (rect: readonly [number, number, number, number]): { data: PavingData; transfer: ArrayBuffer[] } | null => {
      const ground = elevation !== null && elevation.has(GROUND_ONLY);
      if (ground && !elevation!.fieldFor) return null;
      const field = ground ? elevation!.fieldFor!([rect], []) : null;
      const flush = worldNet ? packFlush(worldNet, [rect]) : null;
      return { data: { rect, field: field?.data ?? null, flush: flush?.data ?? null },
        transfer: [...field?.transfer ?? [], ...flush?.transfer ?? []] };
    },
  });

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    // A walker off the streets stands on what is drawn there
    (x, y) => {
      const lot = buildings.anyLotHeightAt(x, y);
      // On a road's footway or carriageway, its paving; the terrain elsewhere.
      const paved = pavedHeightAt(x, y);
      const ground = Number.isFinite(paved) ? paved : terrain.renderedHeightAt(x, y);
      return Number.isFinite(lot) ? Math.max(lot, ground) : ground;
    },
    // A resident's parked car stands on its lot as the lot is drawn.
    (building, x, y) => buildings.lotHeightAt(building as BuildingId, x, y),
    // The land alone: whether a walker off the streets is on screen at all, before the yards are asked.
    (x, y) => terrain.renderedHeightAt(x, y));

  const crowdFrustum = new Frustum();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // How tall a person stands on the screen, canvas pixels: feet and head through the view-projection (either camera)
  const pixelFoot = new Vector3(), pixelOther = new Vector3(), pixelBase = new Vector3(), cameraRight = new Vector3();
  const personPixels = (x: number, y: number, z: number, height: number): number => {
    const halfW = renderer.domElement.width * 0.5, halfH = renderer.domElement.height * 0.5;
    pixelFoot.set(x, z, -y);
    pixelOther.set(x, z + height, -y).applyMatrix4(crowdProjection);
    pixelBase.copy(pixelFoot).addScaledVector(cameraRight, height).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    const tall = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    pixelOther.copy(pixelBase);
    const across = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    return Math.max(tall, across * 0.4);
  };
  /** CSS pixels a world unit across the screen at (x, y, z) - the viewport's zoom, there */
  const screenScale = (x: number, y: number, z: number): number => {
    pixelFoot.set(x, z, -y);
    pixelOther.copy(pixelFoot).add(cameraRight).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    return Math.hypot((pixelOther.x - pixelFoot.x) * cssHalfW, (pixelOther.y - pixelFoot.y) * cssHalfH);
  };
  /** The drawing buffer's width in pixels: what the poles' cut by size on the screen counts in (`instanceRuns.ts` `PixelCut`). */
  const viewWidth = (): number => renderer.domElement.width;
  /** Half the canvas's CSS size, read once a frame (`draw`). */
  let cssHalfW = 1, cssHalfH = 1;
  // A vehicle is tested with its own reach, grown by its height towards the sun's side
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  /** The most pixels a world unit spans in a box: at one of its corners (the depth is affine, its inverse convex), unbounded when one is behind the eye. */
  const areaBox = new Box3(), cameraForward = new Vector3(), cornerFromEye = new Vector3();
  const areaPixels = (minX: number, minY: number, maxX: number, maxY: number, lo: number, hi: number): number => {
    areaBox.min.set(minX, lo, -maxY);
    areaBox.max.set(maxX, hi, -minY);
    if (!crowdFrustum.intersectsBox(areaBox)) return 0;
    let most = 0;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? maxX : minX, y = k & 2 ? maxY : minY, z = k & 4 ? hi : lo;
      if (cornerFromEye.set(x, z, -y).sub(rig.camera.position).dot(cameraForward) <= 0) return Infinity;
      most = Math.max(most, screenScale(x, y, z));
    }
    return most;
  };
  scene.add(...agents.meshes);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate
  const buildings = createBuildingLayer();
  scene.add(buildings.group);
  // The town's meshes keep their arrays only until they are on the GPU (`mesh/gpuOnly.ts`)
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    refillArrays(scene);
    for (const { mesh } of surfaceReuse.chunks?.values() ?? []) refillArrays(mesh);
    buildings.refill();
  });
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Gardens | null = null;
  const coverKit = createGroundCoverKit();
  // The countryside's trees are hand-made models (`natureTrees.ts`), loaded once
  let natureTreeKit: NatureTreeKit | null = null;
  /** The plants and stones drawn cell by cell (`plantCells.ts`) */
  let coverCells: PlantCells | null = null;
  let natureCards: PlantCells | null = null;
  let natureForest: PlantCells | null = null;
  let paintedForest: PlantCells | null = null;
  let plantedForest: PlantCells | null = null;
  /** The trees the player planted, which of them stand (`CellKeep`), and what of the diary they follow. */
  let plantedKeep: CellKeep<RoadDoc['trees'][number]> | null = null;
  const plantedRead = new JournalCursor(['trees']);
  let natureTreesPending = true;
  /** Whether the camera's pull in front of a building is still moving (`isoViewport.ts` `settle`): draw again. */
  let cameraEasing = false;
  /** The town's solids as filed for the camera, for the light shut out of the streets (`canyonLight.ts`). */
  let townSolids: (() => CameraSolids) | null = null;
  /** The ecosystem's plates as last swept (`plantPlaces.ts` sweepNaturePlate), by surface, and those of the plates shown. */
  const naturePlates = new WeakMap<object, NaturePlate>();
  let natureShown = new Map<object, NaturePlate>();
  /** The rock colours and the card trees the cover cells were last drawn for: either moved, every cell drawn again. */
  let coverLook: { readonly geology: number; readonly standIns: boolean } | null = null;
  /** What the plants' and stones' tests read, from the diary: a change there tests again only the places it reached */
  const vegetationRead = new JournalCursor(['roads', 'buildings', 'clearings', 'terrain', 'elevation', 'ground']);
  let vegetationRedraw = true;
  /** The network the keeps test against (`draw`'s). */
  let keepNet: Network | null = null;
  /** The elements laid with the brush (`elements.ts`): their models, loaded once, and the layer built for the map. */
  let elementKit: ElementKit | null = null;
  let elementLayer: ElementLayer | null = null;
  /** What the elements follow in the diary: they themselves, and the land and the ground under them. */
  const elementRead = new JournalCursor(['elements', 'terrain', 'ground']);
  void loadElementKit(anisotropy).then(async (kit) => {
    // Its programs built before the first element is drawn, with their shadows.
    const sample = createElementLayer(kit);
    await compileSamples(sample.warm());
    sample.dispose();
    elementKit = kit;
    onAssetsReady();
  }, (error: unknown) => {
    console.warn('[elements] models not loaded', error);
  });
  /** The weather drawn (`world/weather.ts`) */
  const rain = createRain();
  const lightning = createLightning();
  const cloudDrift = { x: 0, y: 0 };
  const canvasSize = new Vector2();
  const rainWind = new Vector2();
  let weatherActive = false;
  scene.add(rain.object, lightning.group);
  const strikeListeners: ((x: number, y: number, distance: number) => void)[] = [];
  /** A bolt onto the map point (x, y), from some way up in the sky. */
  const strikeAt = (x: number, y: number): void => {
    const ground = terrain.renderedHeightAt(x, y);
    const up = m(260) + Math.random() * m(140);
    lightning.strike(new Vector3(x + (Math.random() - 0.5) * up * 0.3, ground + up, -y + (Math.random() - 0.5) * up * 0.3), new Vector3(x, ground, -y));
    const distance = Math.hypot(x - rig.target.x, y + rig.target.z);
    for (const listener of strikeListeners) listener(x, y, distance);
  };
  /** The painted fog's map (`fogLayer.ts`), and the fog and land it was built for. */
  const fogTexture = createFogTexture();
  let fogLayer: FogLayer | null = null;
  const fogField = createFogField(fogTexture);
  /** What the fog map follows in the diary, and how far it was read. */
  const fogRead = new JournalCursor(['fog', 'terrain', 'ground']);
  /** A brush stroke that moved the land is held: the fog and the elements wait for its end. */
  let landStroke = false;
  let fogMoving = false;
  /** Clouds placed on the map: they boil, so the frame is drawn now and then. */
  let placedCloudsShown = false;
  let natureTreesStarted = false;
  /** @rebuild Once, when the first world is in (`draw`). */
  const startNatureTrees = (): void => {
    natureTreesStarted = true;
    void loadNatureTrees(anisotropy).then(async (kit) => {
      // Its programs built before the first forest is drawn - its shadow's too, wind-swayed (`uploads.ts` shadowStandIn)
      const sample = createTreeCells(kit, 'nature-warm', () => []);
      await compileSamples(sample.warm());
      sample.dispose();
      natureTreeKit = kit;
      // The kept trees are grown with it at the next look.
      vegetationRedraw = true;
      onAssetsReady();
    }, (error: unknown) => {
      natureTreesPending = false;
      vegetationRedraw = true;
      console.warn('[nature] trees not loaded; the procedural ones stay', error);
      onAssetsReady();
    });
  };
  /** Meshes' programs built ahead for the target the scene is drawn into, and their shadows' (`uploads.ts`); resolved once all are. */
  function compileSamples(meshes: readonly Object3D[]): Promise<void> {
    const lit = new Group(), shadows = new Group();
    for (const mesh of meshes) {
      lit.add(mesh);
      const standIn = (mesh as Mesh).isMesh ? shadowStandIn(mesh as Mesh) : null;
      if (standIn) shadows.add(standIn);
    }
    return Promise.all([compileAhead(lit), compileAhead(shadows, true)]).then(() => { lit.clear(); shadows.clear(); });
  }
  /** THE PROGRAMS OF A WORLD, BUILT AT ITS LOAD: one copy of each material in each way it is drawn (`compileCopy`) */
  const compileScene = (): Promise<void> => {
    const known = new Map<Material, Set<string>>();
    const samples: Object3D[] = [];
    scene.traverse((o) => {
      const material = (o as Mesh).material as Material | Material[] | undefined;
      if (!material) return;
      const mesh = o as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown; isSkinnedMesh?: boolean };
      const variant = mesh.isSkinnedMesh ? 'skinned' : mesh.isInstancedMesh ? mesh.instanceColor ? 'instanced-color' : 'instanced' : o.type;
      let fresh = false;
      for (const each of Array.isArray(material) ? material : [material]) {
        let seen = known.get(each);
        if (!seen) known.set(each, seen = new Set());
        if (!seen.has(variant)) { seen.add(variant); fresh = true; }
      }
      if (!fresh) return;
      // Shown in the copy: three's compile walks only what is visible, and a mesh hidden until it has something to draw is not.
      const copy = compileCopy(o);
      copy.visible = true;
      samples.push(copy);
    });
    return compileSamples(samples);
  };
  /** The world's programs being built at its load (`compileScene`), and whether they are: the opening waits for them. */
  let sceneCompiled: Promise<void> | null = null;
  let sceneReady = false;
  /** The buildings cut open, for the people drawn inside them (`indoors.ts`). */
  let cutSpec: CutawaySpec | null = null;
  let skyMode: SkyMode = 'day';
  /** Clouds and mist as the player set them (`setAtmosphere`). */
  let atmosphere: Atmosphere = DEFAULT_ATMOSPHERE;
  /** The sun's colour times its strength, that the clouds are lit by. */
  const sunLight = new Color();
  /** Towards the sun, for the relief's own shadows (`TerrainSurface.setSun`). */
  const sunTowards = new Vector3();
  const flatDirection = new Vector3();
  const roomLamps = new RoomLamps();
  // Room lights for the floors cut open: a fixed set, so switching them on and off never changes the scene's light count
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  /** Whether a building came, went or changed where the floors cut open are lit (`roomLamps.ts`), from the diary. */
  const lampsRead = new JournalCursor(['buildings']);
  const buildingsMovedNear = (doc: RoadDoc, spec: CutawaySpec): boolean => {
    const entries = lampsRead.read(doc.changes);
    if (entries === null) return true;
    const only = spec.only !== undefined ? doc.buildings.get(spec.only) : undefined;
    const box = only ? storedBounds(only, 0) : { minX: spec.x - spec.radius, minY: spec.y - spec.radius, maxX: spec.x + spec.radius, maxY: spec.y + spec.radius };
    return entries.some((e) => e.rects === null || e.rects.some((r) => r[0] <= box.maxX && r[2] >= box.minX && r[1] <= box.maxY && r[3] >= box.minY));
  };
  let tallestFor = -1;
  /** The sky's mesh (`environment.ts`), found once by name (`draw`). */
  let skyMesh: Object3D | null = null;
  let lastDark = -1;
  let tallestTop = 0;
  const tallestBox = new Box3();
  const viewDirection = new Vector3();
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /** What the ground under the buildings is graded from (`buildingPads`) */
  /** The ground the buildings were last graded on (frozen while a stroke is held). */
  let buildingGround = '';
  /** Where and when the drawn ground changed: what stands on it is set again only there (`groundChanges.ts`). */
  let groundDiary: ChangeJournal | null = null;
  const GROUND_KINDS: readonly DerivedChangeKind[] = ['elevation', 'ground'];
  /** The serial of the latest change of the ground (not of the diary: a zone drawn is no change of the ground), and how far the diary was read for it. */
  let groundVersion = 0, groundScanned = 0;
  /** Where the ground changed after `since`, from the diary; null where it cannot say (the whole map, or forgotten). */
  const groundRectsSince = (since: number): ChangeRect[] | null => {
    const entries = groundDiary?.since(since, GROUND_KINDS);
    if (!entries) return null;
    const rects: ChangeRect[] = [];
    for (const entry of entries) {
      if (entry.rects === null) return null;
      rects.push(...entry.rects);
    }
    return rects;
  };
  const groundChanges: GroundRecord = {
    get version() {
      const diary = groundDiary;
      if (!diary || diary.version === groundScanned) return groundVersion;
      const fresh = diary.since(groundScanned, GROUND_KINDS);
      if (fresh === null) groundVersion = diary.version;
      else if (fresh.length) groundVersion = fresh[fresh.length - 1]!.serial;
      groundScanned = diary.version;
      return groundVersion;
    },
    touches: (since, area) => groundDiary?.touches(since, area, GROUND_KINDS) ?? false,
    // DO NOT leave it out: without it the gardens asked every planted building of the city whether the ground moved under it
    rectsSince: (since) => groundRectsSince(since),
  };
  /** The gardens' plants, building by building, on the ground they stand on (`gardenLists.ts`). */
  const plantLists = gardenLists(groundChanges, (b) => bankBox(b), (b) => gardenPlants([b], terrain.renderedHeightAt));
  /** Where the ground changed since a serial, from the same diary (`cameraSolids.ts` `GroundSince`). */
  const groundSince: GroundSince = {
    get version() { return groundChanges.version; },
    rectsSince: (since) => groundRectsSince(since),
  };
  /** The diary's serials of the ground graded round the sites that changed (`shapeGround` with `sites`) */
  const sitesGradedSerials = new Set<number>();
  /** DO NOT re-floor the buildings round a graded site */
  const floorGroundSince: GroundSince = {
    get version() { return groundChanges.version; },
    rectsSince: (since) => {
      for (const serial of sitesGradedSerials) if (serial <= since) sitesGradedSerials.delete(serial);
      const entries = groundDiary?.since(since, GROUND_KINDS);
      if (!entries) return null;
      const rects: ChangeRect[] = [];
      for (const entry of entries) {
        if (sitesGradedSerials.has(entry.serial)) continue;
        if (entry.rects === null) return null;
        rects.push(...entry.rects);
      }
      return rects;
    },
  };
  /** Where a building's floor reads the ground and the paving (`FLOOR_READ_REACH`), once per record. */
  const floorBoxes = new WeakMap<Building, ChangeRect>();
  const floorBox = (b: Building): ChangeRect => {
    let box = floorBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, FLOOR_READ_REACH);
      floorBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** The buildings' solids for the camera's eye (`world/buildings/cameraSolids.ts`) */
  /** DO NOT key the canyon on a revision of the whole town again: it laid its whole window at every building. */
  const CANYON_KINDS: readonly ChangeKind[] = ['buildings', 'ground', 'elevation'];
  const CANYON_GROUND_REACH = FLOOR_READ_REACH + m(64);
  const canyonRead = new JournalCursor(CANYON_KINDS);
  const NOTHING_CHANGED: readonly ChangeRect[] = [];
  const canyonChanges = (journal: ChangeJournal): readonly ChangeRect[] | null => {
    const entries = canyonRead.read(journal);
    if (!entries || entries.some((e) => e.rects === null)) return null;
    if (!entries.length) return NOTHING_CHANGED;
    // The ground moved under a building's floor (it reads the ground round it) lifts the whole building
    const grow = (r: ChangeRect, d: number): ChangeRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
    return entries.flatMap((e) => e.kind === 'buildings' ? e.rects! : e.rects!.map((r) => grow(r, CANYON_GROUND_REACH)));
  };
  /** Each building's floor, once per record while what it reads stands (`floors.ts`) */
  const floors = buildingFloors(builtGroundAt, pavedHeightAt, floorBox, FLOOR_READ_REACH);
  const followFloors = (net: Network): void => floors.follow(net.doc.buildings, floorGroundSince);
  const cameraSolidsKept = cameraSolidsKeeper((b) => floors.floorOf(b), floorBox, FLOOR_READ_REACH);
  /** The roads watched for vanishing from the picture */
  let roadsWatchedAt = 0;
  /** Where the sampling of the roads stands: a live walk of the network's ribbons, never a copy of them. */
  let roadsWatchWalk: { readonly of: ReadonlyMap<SegmentId, unknown>; walk: Iterator<SegmentId> } | null = null;
  let roadsReported = false;
  /** The next road sampled, round and round the network's ribbons. */
  const nextWatched = (net: Network): SegmentId | null => {
    if (roadsWatchWalk?.of !== net.ribbons) roadsWatchWalk = { of: net.ribbons, walk: net.ribbons.keys() };
    let next = roadsWatchWalk.walk.next();
    if (next.done) { roadsWatchWalk.walk = net.ribbons.keys(); next = roadsWatchWalk.walk.next(); }
    return next.done ? null : next.value;
  };
  /** Whether the roads' group draws anything: the first visible mesh with vertices ends the look. */
  const roadsDrawn = (): boolean => {
    const stack: Object3D[] = roads ? [roads.group] : [];
    while (stack.length) {
      const o = stack.pop()!;
      if (!o.visible) continue;
      const mesh = o as Mesh;
      if (mesh.isMesh && (mesh.geometry.getAttribute('position')?.count ?? 0) > 0) return true;
      for (const child of o.children) stack.push(child);
    }
    return false;
  };
  const watchRoads = (net: Network): void => {
    const now = performance.now();
    // Not while the world is being rebuilt: until the job lands the new roads have no picture yet by design
    if (now - roadsWatchedAt < 1000 || !reveal.opened || net.doc.segments.size === 0 || worldJob !== null) return;
    roadsWatchedAt = now;
    let buried: { x: number; y: number; land: number; paved: number } | null = null;
    for (let k = 0; k < 4; k++) {
      const id = nextWatched(net);
      const ribbon = id === null ? undefined : net.ribbons.get(id);
      if (!ribbon) break;
      const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
      const paved = pavedHeightAt(p.x, p.y), land = terrain.renderedHeightAt(p.x, p.y);
      // Under the land on purpose in a tunnel.
      if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
      if (Number.isFinite(paved) && land > paved + m(0.3)) { buried = { x: p.x, y: p.y, land, paved }; break; }
    }
    const missing = !roads || !roads.group.parent || !roadsDrawn();
    if ((missing || buried) && !roadsReported) {
      roadsReported = true;
      console.error('roads missing from the picture', JSON.stringify({
        missing, buried, inWorld: !!roads?.group.parent, worldJob: worldJob !== null, segments: net.doc.segments.size,
      }));
    } else if (!missing && !buried) roadsReported = false;
  };
  /** Cuts and fills the ground to the roads AND to the buildings */
  /** Each building's platform, the town's, and the sites as last graded (`world/buildings/siteGrading.ts`). */
  const sitesGraded = siteGrading(builtGroundAt, pavedHeightAt, TERRAIN_CELL * 1.5, (b) => bankBox(b), floors);
  /** The box a building's bank reaches, once per record (records are never changed in place) */
  const bankBoxes = new WeakMap<Building, readonly [number, number, number, number]>();
  /** How far a building's bank reaches past its own bounds. */
  const BANK_REACH = TERRAIN_CELL * 1.5 + m(40) + TERRAIN_CELL;
  const bankBox = (b: Building): readonly [number, number, number, number] => {
    let box = bankBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, BANK_REACH);
      bankBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** DO NOT walk the town for it: every building's bank was made again at each building grown */
  const buildingsOnGroundSince = (doc: RoadDoc, serial: number): Building[] | null => {
    const rects = groundSince.rectsSince(serial);
    if (!rects) return null;
    // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
    return doc.buildings.nearAny(rects, BANK_REACH, (b, r) => {
      const box = bankBox(b);
      return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
    });
  };
  /** The ground serial the buildings were last told of (`buildingGround`). */
  let buildingGroundSeen = -1;
  /** Where two solves of the roads differ: the blocks of the map whose ground the roads shape differently. */
  const SHAPE_BLOCK = 160;
  /** What a block of ground reads of a solve, digested: at each corner of the terrain grid in it */
  const groundRead = new WeakMap<RoadElevation, Map<number, number>>();
  /** The blocks of a solve being digested off the page, each with the job that will file it (`compareSolves`). */
  const groundReading = new WeakMap<RoadElevation, Map<number, Promise<void>>>();
  const blockKey = (x0: number, y0: number): number => x0 * 65_536 + y0;
  const readOf = (solve: RoadElevation): Map<number, number> => {
    let known = groundRead.get(solve);
    if (!known) groundRead.set(solve, known = new Map());
    return known;
  };
  /** A block of a solve digested on the page (`groundShape.ts` `blockDigest`, the worker's own function). */
  const blockRead = (solve: RoadElevation, x0: number, y0: number): number => {
    const known = readOf(solve);
    const key = blockKey(x0, y0);
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    const value = blockDigest(solve, terrain.naturalRenderedHeightAt, x0, y0, SHAPE_BLOCK, TERRAIN_CELL, TERRAIN_HALF);
    known.set(key, value);
    return value;
  };
  /** Two solves compared block by block (`compareSolves`): `blocks` once `ready`, with the page's time it took. */
  interface BlockCompare { blocks: [number, number, number, number][]; ready: boolean; ms: number }
  /** The blocks whose ground two solves of the roads shape differently, or whose decks differ */
  const compareSolves = (before: RoadElevation, after: RoadElevation, landBlocks: readonly [number, number, number, number][] | null): BlockCompare => {
    const at = performance.now();
    const out: BlockCompare = { blocks: [], ready: false, ms: 0 };
    const candidates: [number, number][] = [];
    // Only blocks a road that differs reaches can differ (`differences`)
    const where = after.differences?.(before) ?? null;
    if (!where || where.length) {
      // Every plate's own blocks.
      for (const plate of MAP_REGIONS) {
        for (let x = plate.cx - plate.half; x < plate.cx + plate.half; x += SHAPE_BLOCK) {
          for (let y = plate.cy - plate.half; y < plate.cy + plate.half; y += SHAPE_BLOCK) {
            const x1 = x + SHAPE_BLOCK, y1 = y + SHAPE_BLOCK;
            if (where && !where.some((r) => r.minX <= x1 && r.maxX >= x && r.minY <= y1 && r.maxY >= y)) continue;
            candidates.push([x, y]);
          }
        }
      }
    }
    const finish = (): void => {
      const changed: [number, number, number, number][] = [];
      for (const [x, y] of candidates) if (blockRead(before, x, y) !== blockRead(after, x, y)) changed.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      if (landBlocks) {
        const seen = new Set(changed.map((b) => `${b[0]},${b[1]}`));
        for (const b of landBlocks) if (!seen.has(`${b[0]},${b[1]}`)) changed.push(b);
      }
      out.blocks = changed;
      out.ready = true;
    };
    const waits: Promise<void>[] = [];
    const ask: { solve: RoadElevation; blocks: [number, number][] }[] = [];
    for (const solve of [before, after]) {
      const known = readOf(solve);
      const reading = groundReading.get(solve);
      const mine: [number, number][] = [];
      for (const [x, y] of candidates) {
        const key = blockKey(x, y);
        if (known.has(key)) continue;
        const job = reading?.get(key);
        if (job) { if (!waits.includes(job)) waits.push(job); continue; }
        mine.push([x, y]);
      }
      if (mine.length) ask.push({ solve, blocks: mine });
    }
    if (ask.length && groundWorkers.available && ask.every((a) => a.solve.shapeCut)) {
      // The roads near the blocks asked and the ground under them, as plain numbers; a block the worker cannot read
      const rect = (x: number, y: number): [number, number, number, number] => [x - 1, y - 1, x + SHAPE_BLOCK + 1, y + SHAPE_BLOCK + 1];
      const job: BlockDigestAsk = {
        solves: ask.map(({ solve, blocks }) => ({
          roads: solve.shapeCut!(blocks.map(([x, y]) => rect(x, y))),
          blocks: Float64Array.from(blocks.flat()),
        })),
        plates: terrain.naturalCut?.(ask.flatMap(({ blocks }) => blocks.map(([x, y]) => rect(x, y)))) ?? [],
        block: SHAPE_BLOCK, cell: TERRAIN_CELL, half: TERRAIN_HALF,
      };
      const filed = groundWorkers.digest(job).then((answers) => {
        ask.forEach(({ solve, blocks }, k) => {
          const known = readOf(solve);
          blocks.forEach(([x, y], j) => { const v = answers[k]![j]!; if (!Number.isNaN(v)) known.set(blockKey(x, y), v); });
        });
      }, (error: unknown) => { console.warn('[ground] blocks digested on the page', error); }).finally(() => {
        for (const { solve, blocks } of ask) for (const [x, y] of blocks) groundReading.get(solve)?.delete(blockKey(x, y));
      });
      for (const { solve, blocks } of ask) {
        let reading = groundReading.get(solve);
        if (!reading) groundReading.set(solve, reading = new Map());
        for (const [x, y] of blocks) reading.set(blockKey(x, y), filed);
      }
      waits.push(filed);
    }
    if (!waits.length) { finish(); out.ms = performance.now() - at; return out; }
    out.ms = performance.now() - at;
    void Promise.all(waits).then(() => { const t = performance.now(); finish(); out.ms += performance.now() - t; });
    return out;
  };
  /** A terrain region (`terrainRegion`) back as the world box it covers, a cell round. */
  const regionRect = (region: TerrainRegion): Rect => terrain.rectOf(region);
  /** A world box as the terrain grid corners it covers. */
  const terrainRegion = (box: readonly [number, number, number, number]): TerrainRegion => terrain.regionOf(box);
  /** `region`: a brush dab while the stroke is held */
  /** The ground cut and filled again only in `blocks` (the roads changed there, the land did not) */
  /** `shapeBlocks` in steps (`worldSteps`) */
  function* shapeBlocksSteps(net: Network, blocks: readonly [number, number, number, number][]): Generator<'wait' | void, void, void> {
    // DO NOT walk `buildings.all()` for them, nor every building for a platform not known yet (`ensure`, a building a step)
    const reached = net.doc.buildings.nearAny(blocks, BANK_REACH, (b, q) => {
      const box = bankBox(b);
      return box[0] <= q[2] && box[2] >= q[0] && box[1] <= q[3] && box[3] >= q[1];
    });
    followFloors(net);
    for (const b of reached) {
      sitesGraded.refresh(b);
      yield;
    }
    gradedFor = net.doc.buildings.revision;
    // The sites that changed with the edit
    const sites = sitesGraded.changedSites(net.doc.buildings);
    sitesGraded.rebuild(net.doc.buildings);
    yield;
    // Each block in quarters, a quarter a step: a whole block was 18 ms of terrain in one step, past the frame's allowance
    const quarters = (q: readonly [number, number, number, number]): [number, number, number, number][] => {
      const mx = (q[0] + q[2]) / 2, my = (q[1] + q[3]) / 2;
      return [[q[0], q[1], mx, my], [mx, q[1], q[2], my], [q[0], my, mx, q[3]], [mx, my, q[2], q[3]]];
    };
    const regions = blocks.flatMap(quarters).map(terrainRegion);
    if (sites) regions.push(...sites.map(terrainRegion));
    // DO NOT cut it into a block a step again: that spread the page's work over frames, and it is the worker's now.
    const shaping = shapeGround(net, regions, false, true);
    while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    derived(net, 'ground', regions.map(regionRect), 'ground cut and filled up to the roads', worldCause,
      { ms: shaping.ms, detail: `${regions.length} regions` });
  }


  /** The ground's work off the page (`groundShapePool.ts`). */
  const groundWorkers = new GroundShapePool();
  /** A shaping pass asked of the ground's worker (`shapeGround`): put in place in the order asked (`landShapes`). */
  interface Shaping {
    readonly ask: GroundShapeAsk;
    readonly take: (answers: readonly PlateShapeAnswer[]) => boolean;
    /** What the ground's readers are told, once the heights are in place (the diary's 'ground'). */
    readonly then: () => void;
    answers: PlateShapeAnswer[] | null;
    failed: boolean;
    landed: boolean;
    /** The page's time: the ask put together and the answer put in place. */
    ms: number;
  }
  /** The passes asked, in order. */
  const shapings: Shaping[] = [];
  const LANDED = { landed: true, ms: 0 } as const;
  /** Puts in place every pass answered, in the order asked, up to the first still being worked out. */
  const landShapes = (): void => {
    while (shapings.length) {
      const next = shapings[0]!;
      if (!next.answers && !next.failed) { groundWorkers.check(); return; }
      shapings.shift();
      const at = performance.now();
      next.take(next.answers ?? shapeGroundAsk(next.ask));
      next.ms += performance.now() - at;
      next.landed = true;
      next.then();
    }
  };
  /** DO NOT shape the corners here while the worker is there: 9.5 s of the page in a 2,560 m city's growth (2026-10-15). */
  const shapeGround = (net: Network, regions: TerrainRegion | readonly TerrainRegion[] | null = null, sites = false, padsReady = false): { readonly landed: boolean; readonly ms: number } => {
    const at = performance.now();
    const list: readonly TerrainRegion[] | null = regions === null ? null
      : typeof regions[0] === 'number' ? [regions as TerrainRegion] : regions as readonly TerrainRegion[];
    if (list && !list.length) return LANDED;
    const region = list;
    // The ground is cut and filled here, and only here: what stands on it reads where from the diary
    const parent = net.doc.changes.version;
    const told = (): void => {
      if (padsReady) return;
      const serial = derived(net, 'ground', list ? list.map(regionRect) : null, sites ? 'lot ground levelled' : 'ground cut and filled', parent);
      if (sites && serial) sitesGradedSerials.add(serial);
    };
    const roads = net.doc.segments.size > 0 ? elevation : null;
    followFloors(net);
    if (!padsReady && (!region || !sitesGraded.pads || sites)) {
      gradedFor = net.doc.buildings.revision;
      // The roads or the land moved: every platform is worked out afresh.
      if (!sites) sitesGraded.forget(net.doc.buildings);
      sitesGraded.rebuild(net.doc.buildings);
    }
    const pads = net.doc.buildings.size > 0 ? sitesGraded.pads : null;
    if (groundWorkers.available || shapings.length) {
      // The corners asked, and the roads and platforms they read as they stand now, as plain numbers.
      const asking = terrain.askShape(region, region ? null : [...(roads?.shapeBounds() ?? []), ...(pads?.shapeBounds() ?? [])]);
      const boxes = cornerBoxes(asking.plates, TERRAIN_CELL, TERRAIN_HALF);
      const ask: GroundShapeAsk = { roads: roads ? roads.shapeCut!(boxes) : null, pads: pads ? pads.cut(boxes) : null, plates: asking.plates };
      const shaping: Shaping = { ask, take: asking.take, then: told, answers: null, failed: false, landed: false, ms: 0 };
      shapings.push(shaping);
      if (groundWorkers.available) {
        groundWorkers.shape(ask).then((answers) => { shaping.answers = answers; }, (error: unknown) => {
          console.warn('[ground] a pass is shaped on the page', error);
          shaping.failed = true;
        });
      } else shaping.failed = true;
      shaping.ms = performance.now() - at;
      // No worker: put in place now, after the passes before it.
      if (shaping.failed) landShapes();
      return shaping;
    }
    told();
    const shape = pads ? { shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()], shapeAt: shapeBoth(roads, pads) } : roads;
    terrain.shapeToRoads(shape, region);
    return { landed: true, ms: performance.now() - at };
  };

  /** What moves a pole or its parts: the poles and wires, the roads (its kerb), the roads' heights and the ground under it. */
  const poleRead = new JournalCursor(['utilities', 'roads', 'elevation', 'ground', 'terrain']);
  /** The pole layer brought up to the diary (`poleLayer.ts`), on the roads as `solve` set them; whether it had anything to do. */
  const syncUtilities = (net: Network, solve: RoadElevation): boolean => {
    const entries = poleRead.read(net.doc.changes);
    if (utilities && entries !== null && entries.length === 0) return false;
    const groundAt = poleGroundAt(solve, terrain.renderedHeightAt, net);
    const before = utilities?.triangles ?? 0;
    if (!utilities || entries === null || entries.some((e) => e.rects === null)) {
      if (utilities) { world.remove(utilities.group); utilities.dispose(); }
      utilities = buildUtilities(net, groundAt, sceneryKit, docPoles(net.doc), 'utilities', viewWidth);
      world.add(utilities.group);
    } else {
      utilities.follow(net, groundAt, net.doc, entries);
    }
    builtTriangles += utilities.triangles - before;
    return true;
  };

  /** The city's clock, read each frame: the planted trees and shrubs grow with it (`plantGrowth`). */
  let cityMinutes = Number.NaN;
  /** The street furniture and the signs brought up to the diary, once the world stands (`draw`): the furniture item by item */
  /** The world the placed things stand on, once it stands (`draw`): what the engine's 'draw' phase reads. */
  let placedOn: Network | null = null;
  engine.register({
    name: 'street furniture',
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      const at = performance.now();
      const before = furniture.triangles;
      const work = furniture.sync(placedOn, elevation, terrain.renderedHeightAt, cityMinutes);
      builtTriangles += furniture.triangles - before;
      performance.measure('hitch:furniture', { start: at, end: performance.now() });
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'signs',
    // DO NOT build every sign of the map again on a serial of the roads, the land or the landscaping: every edit anywhere did.
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      if (!signs.group.parent) world.add(signs.group);
      return signs.sync(placedOn, elevation);
    },
  }, 'draw');

  engine.register({
    name: 'barriers',
    // DO NOT build every barrier of the map again on its revision or on a change of the ground under any one.
    refresh: (): number => {
      if (!placedOn) return 0;
      if (!barriers.group.parent) world.add(barriers.group);
      const before = barriers.triangles;
      const work = barriers.sync(placedOn.doc, terrain.renderedHeightAt);
      builtTriangles += barriers.triangles - before;
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'transit',
    // DO NOT build the whole transport again on its revision or the ground under it.
    refresh: (): number => {
      const net = placedOn;
      if (!net) return 0;
      if (!transit.group.parent) { world.add(transit.group); transit.setXray(transitXray); }
      const before = transit.triangles;
      // A metro entrance stands off the streets and out of the buildings: the buildings at the point only
      const work = transit.sync(net.doc, terrain.renderedHeightAt, pavedHeightAt, (p) => {
        if (onCarriageway(net, p)) return true;
        for (const b of net.doc.buildings.near(p.x, p.y, p.x, p.y)) {
          if (solidFootprints(b).some((ring) => pointInPolygon(p, ring))) return true;
        }
        return false;
      });
      builtTriangles += transit.triangles - before;
      return work;
    },
  }, 'draw');

  /** The comparisons of solves whose blocks a dropped rebuild had not shaped yet */
  let pendingBlocks: (BlockCompare | null)[] = [];
  /** The land a brush moved since the world was last built */
  let landDirty: Rect | 'all' | null = null;
  /** The shaping blocks a world box reaches, on the grid `changedBlocks` uses. */
  const blocksOver = (box: Rect): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    for (const plate of MAP_REGIONS) {
      const left = plate.cx - plate.half, right = plate.cx + plate.half;
      const bottom = plate.cy - plate.half, top = plate.cy + plate.half;
      if (box[2] <= left || box[0] >= right || box[3] <= bottom || box[1] >= top) continue;
      const x0 = Math.max(left, Math.floor((box[0] - left) / SHAPE_BLOCK) * SHAPE_BLOCK + left);
      const y0 = Math.max(bottom, Math.floor((box[1] - bottom) / SHAPE_BLOCK) * SHAPE_BLOCK + bottom);
      for (let x = x0; x < Math.min(right, box[2]); x += SHAPE_BLOCK) {
        for (let y = y0; y < Math.min(top, box[3]); y += SHAPE_BLOCK) out.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      }
    }
    return out;
  };
  /** The diary entry the world being built follows from (`world/changes.ts`). */
  let worldCause = 0;
  /** Writes what the world derived in the document's diary, after `parent`; its serial (0: nothing written). */
  const derived = (net: Network, kind: DerivedChangeKind, rects: readonly ChangeRect[] | null, cause: string, parent: number,
    extra: { readonly ms?: number; readonly detail?: string } = {}): number =>
    net.doc.changes.record(kind, rects, { cause, ...(parent ? { parent } : {}), ...extra });
  /** The network the world was last built for: what stands on a footway reads it (`footwayRiseAt`). */
  let worldNet: Network | null = null;
  const rebuildWorld = (net: Network): void => {
    worldNet = net;
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision) {
      // A world being built builds the poles too (`worldSteps`); outside one, a pole edit moves the poles alone.
      if (worldJob === null && elevation) {
        const atUtilities = performance.now();
        if (syncUtilities(net, elevation)) performance.measure('hitch:road-edit/utilities alone', { start: atUtilities, end: performance.now() });
      }
      return;
    }
    buildWorld(net);
  };
  /** @rebuild The roads' heights solved again and the world's rebuild started (`worldSteps`). */
  const buildWorld = (net: Network): void => {
    const started = performance.now();
    // Only the roads changed (the land did not): the ground is cut and filled again only where the solve of the roads differs.
    const landStill = terrainRevision === net.doc.terrainRevision && elevation !== null;
    const previousElevation = elevation;
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    // ONE solve for the whole network, shared by every consumer below.
    const offered = offeredElevation;
    offeredElevation = null;
    elevation = offered && offered.revision === net.revision && offered.terrain === terrainRevision
      ? offered.elevation
      // On land that has not moved, from the last solve
      : buildRoadElevation(net, builtGroundAt, landStill ? previousElevation : null);
    performance.measure('hitch:road-edit/elevation', { start: started, end: performance.now() });
    // Now the ground comes to meet the roads
    const land = landDirty;
    landDirty = null;
    const landBlocks = !landStill && land !== null && land !== 'all' ? blocksOver(land) : null;
    // The blocks the two solves differ in, digested off the page (`compareSolves`) and read by the job, which waits for them
    const compare = previousElevation && (landStill || landBlocks) ? compareSolves(previousElevation, elevation, landBlocks) : null;
    pendingBlocks = compare && !pendingBlocks.includes(null) ? [...pendingBlocks, compare] : [null];
    const elevationMs = performance.now() - started;
    const cause = net.doc.changes.version;
    // DO NOT build it in one go: the roads of a generated city were built in the frame of the change, on the page
    worldJob = worldSteps(net, pendingBlocks, { cause, elevationMs }, started, true);
    worldJobFresh = true;
    worldJobGround = true;
  };

  /** @rebuild What `worldSteps` builds before it is put in place at once. */
  function* worldSteps(net: Network, compares: readonly (BlockCompare | null)[], solved: { readonly cause: number; readonly elevationMs: number },
    started: number, sliced: boolean): Generator<'wait' | void, void, void> {
    const solve = elevation!;
    // The blocks the solves differ in, once the worker has digested them (`compareSolves`).
    while (compares.some((c) => c && !c.ready)) { groundWorkers.check(); yield 'wait'; }
    const own = compares[compares.length - 1] ?? null;
    const changed = own ? own.blocks : null;
    // In the diary: the roads' heights solved again where they differ, after the edit that moved them.
    worldCause = derived(net, 'elevation', changed, 'road heights solved', solved.cause,
      { ms: solved.elevationMs + (own?.ms ?? 0), detail: changed ? `${changed.length} blocks of ${SHAPE_BLOCK} u` : 'whole map' }) || solved.cause;
    const joined = compares.includes(null) ? null : compares.flatMap((c) => c!.blocks);
    // The roads' own heights (the footway, the carriageway) moved where the solve did
    const blocks = joined !== null && joined.length * SHAPE_BLOCK * SHAPE_BLOCK < MAP_SIZE * MAP_SIZE * 0.25 ? joined : null;
    if (blocks === null) {
      const shaping = shapeGround(net);
      while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    } else if (blocks.length || gradedFor !== net.doc.buildings.revision) yield* shapeBlocksSteps(net, blocks);
    pendingBlocks = [];
    worldJobGround = false;
    yield;
    // The keys of the tiles kept from the last session, read while the game started: a sliced build waits for them a little
    if (sliced && !storedRead) {
      const since = performance.now();
      while (!storedRead && performance.now() - since < KEPT_TILES_WAIT_MS) yield 'wait';
    }
    // Sliced, the tiles are shaped by the workers while the frames go on (`roadTilePool.ts`); built in one go
    const freshRoads = yield* roadSurfaceSteps(net, solve, materials, terrain.renderedHeightAt, surfaceReuse, terrain.vergeMaterial,
      sliced ? roadTiles : null);
    keepTiles();
    derived(net, 'surfaces', freshRoads.rebuilt, 'road surfaces rebuilt', worldCause,
      { ms: freshRoads.workMs, detail: `${freshRoads.built} tiles feitos, ${freshRoads.reused} aproveitados` });
    // The structures' details, the poles and the street furniture are each kept as they are when the edit's blocks reach none
    const atdetails = performance.now();
    details ??= createStructureCells(materials, terrain.vergeMaterial);
    const freshDetails = details.prepare(net, solve, terrain.renderedHeightAt, blocks);
    performance.measure('hitch:road-edit/details', { start: atdetails, end: performance.now() });
    yield;

    // The new pieces' shaders compiled before they are drawn - in parallel where the driver can
    if (sliced) {
      const stage = new Group();
      for (const piece of [freshRoads.group, ...freshDetails.fresh]) {
        if (piece.parent === null) stage.add(piece);
      }
      if (stage.children.length > 0) {
        let compiled = false;
        void compileAhead(stage).then(() => { compiled = true; });
        while (!compiled) yield 'wait';
      }
    }

    // Everything in place at once: the world as it was goes - only what is replaced here.
    let triangles = builtTriangles;
    if (roads && roads !== freshRoads) { triangles -= roads.triangles; world.remove(roads.group); roads.dispose(); }
    triangles -= details.triangles;
    for (const mesh of surfaceReuse.retired?.splice(0) ?? []) disposeMesh(mesh);
    roads = freshRoads;
    roads.adopt();
    world.add(roads.group);
    freshDetails.apply();
    if (!details.group.parent) world.add(details.group);
    builtTriangles = triangles + roads.triangles + details.triangles;
    // The poles the edit reached, on the ground just put in place (`syncUtilities`, from the diary).
    const atutilities = performance.now();
    syncUtilities(net, solve);
    performance.measure('hitch:road-edit/utilities', { start: atutilities, end: performance.now() });
    // The street furniture and the signs follow from the diary once the world stands (the engine's 'draw' phase, in `draw`).
    rebuildMs = performance.now() - started;
    performance.measure('hitch:road-edit/world rebuilt', { start: started, end: performance.now() });
    rebuilds++;
    onAssetsReady();
  }

  /** The road shaders compiled before the first road is drawn. */
  let roadShadersWarm: 'no' | 'started' = 'no';
  /** @rebuild Once; every later frame returns at its first check. */
  const warmRoadShaders = (): void => {
    if (roadShadersWarm !== 'no') return;
    roadShadersWarm = 'started';
    try {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      // Each class of road, a junction and a pedestrian crossing on one leg.
      [[m(70), 0, 0], [-m(70), 0, 1], [0, m(70), 2], [0, -m(70), 3]].forEach(([x, y, type]) => {
        doc.addSegment(doc.addNode({ x: x!, y: y! }).id, centre.id, type!);
      });
      const pole1 = doc.addPole({ x: m(20), y: m(12) }, true);
      const pole2 = doc.addPole({ x: m(50), y: m(12) }, false);
      doc.addPoleSpan(pole1.id, pole2.id);
      const warmNet = new Network(doc);
      warmNet.rebuild();
      const flat = (): number => 0;
      const warmElevation = buildRoadElevation(warmNet, flat);
      const group = new Group();
      const warmPoles = buildUtilities(warmNet, poleGroundAt(warmElevation, flat), sceneryKit);
      const parts = [
        buildRoadSurfaces(warmNet, warmElevation, materials, flat, undefined, terrain.vergeMaterial),
        buildStructureDetails(warmNet, warmElevation, flat, materials),
        warmPoles,
      ];
      for (const part of parts) group.add(part.group);
      // The poles' parts are drawn only once culled: one instance of each compiles their programs.
      group.add(...warmPoles.warm());
      // And the street furniture's, the long grass's and the signs' meshes as their layers draw them, with their shadows
      const placedShadows = new Group();
      for (const mesh of [...furniture.warm(), ...signs.warm()]) {
        group.add(mesh);
        const standIn = shadowStandIn(mesh);
        if (standIn) placedShadows.add(standIn);
      }
      void compileAhead(placedShadows, true).then(() => placedShadows.clear());
      void compileAhead(group).then(() => {
        for (const part of parts) part.dispose();
      });
    } catch (error) {
      console.warn('road shader warm-up skipped', error);
    }
  };

  /** The shaders a blow first needs - a broken building's pieces */
  let blastShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmBlastShaders = (): void => {
    if (blastShadersWarm) return;
    blastShadersWarm = true;
    const kit = buildings.kit;
    const tiny = new BufferGeometry();
    tiny.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    tiny.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tiny.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    tiny.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    tiny.setAttribute('aDecay', new Float32BufferAttribute([0, 0, 0], 1));
    const group = new Group();
    const mats = [...Object.values(kit.shell), ...Object.values(kit.material), kit.furniture().material, kit.massing];
    for (const mat of mats) {
      const mesh = new Mesh(tiny, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // In the scene for its lights, but never drawn
    group.visible = false;
    scene.add(group);
    void compileAhead(group).then(() => { scene.remove(group); tiny.dispose(); });
    // And every part as the layer draws it, instanced, with its shadow (`partWarmMeshes`)
    const parts = new Group();
    const partShadows = new Group();
    for (const mesh of partWarmMeshes(kit)) {
      parts.add(mesh);
      const standIn = shadowStandIn(mesh);
      if (standIn) partShadows.add(standIn);
    }
    parts.visible = false;
    scene.add(parts);
    void compileAhead(parts).then(() => { scene.remove(parts); parts.clear(); });
    void compileAhead(partShadows, true).then(() => partShadows.clear());
  };

  /** The plants' and stones' layers and the road blink compiled ahead: their meshes come with the first look or edit */
  let plantShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmPlantShaders = (): void => {
    if (plantShadersWarm) return;
    plantShadersWarm = true;
    const cover = createCoverCells(coverKit, 'cover-warm', { rocksIn: () => [], scrubIn: () => [], treesIn: () => [] });
    const blinkShape = new BufferGeometry();
    blinkShape.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
    blinkShape.setAttribute('aRing', new Float32BufferAttribute([0, 0, 0], 1));
    void compileSamples([...cover.warm(), new Mesh(blinkShape, blinkMaterial)]).then(() => { cover.dispose(); blinkShape.dispose(); });
  };

  /** The tools' previews compiled ahead, as the roads' and the blows' are */
  let previewShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmPreviewShaders = (): void => {
    if (previewShadersWarm) return;
    previewShadersWarm = true;
    try {
      const group = new Group();
      const done: (() => void)[] = [];
      const blueprint = BLUEPRINTS[0];
      if (blueprint) {
        const sample = { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
        const ghost = buildBuildingMeshes([sample], () => 0, buildings.kit, true);
        group.add(ghost.group);
        done.push(() => ghost.dispose());
        // And as a building grown on a lot draws it: its window panes carry their rooms' light slots
        const real = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        group.add(real.group);
        done.push(() => real.dispose());
        // And faded ("ocultar outros", `fade.ts`): the faded materials on parts with and without instance colours.
        const faded = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        fadeMeshes(faded.group, buildings.kit, true);
        group.add(faded.group);
        done.push(() => faded.dispose());
      }
      // The gardens' plants and their shadows, the first lots painted grow them.
      const plants = plantSamples(sceneryKit);
      group.add(plants.group);
      void compileAhead(plants.depth, true);
      done.push(() => plants.dispose());
      for (const mode of ['train', 'metro'] as const) {
        const track = buildTrackPreview([{ x: 0, y: 0 }, { x: m(60), y: 0 }], mode, () => 0);
        group.add(track.group);
        done.push(() => track.dispose());
      }
      // The lots need no program of their own: the ground's materials draw them (`lotOverlay.ts`).
      void compileAhead(group).then(() => { for (const finish of done) finish(); });
    } catch (error) {
      console.warn('preview shader warm-up skipped', error);
    }
  };

  const applyQuality = (level: QualityLevel): void => {
    quality = QUALITY[level];
    // The far woods as dense as the near ones, on the same budget (`farWoods.ts`).
    terrain.setVegetation?.(quality.vegetation);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    materials.setDetail(quality.surfaceDetail);
    environment.setQuality({ shadows: quality.shadows, shadowMapSize: quality.shadowMapSize });
    post?.dispose();
    post = createPostChain(renderer, scene, rig.camera, quality, level);
    post.setNight(Math.max(0, lastDark));
    resize();
    // DO NOT force one with `networkRevision = -1`
    shadowMoved = true;
  };

  let post: PostChain = createPostChain(renderer, scene, rig.camera, quality, governor.current);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    post.setSize(width, height, renderer.getPixelRatio());
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  // Development only: the production build replaces the flag with false and drops the inspector with it.
  const inspect = import.meta.env.DEV ? createInspector(renderer, scene) : null;
  let lotOverlay: ReturnType<typeof createLotOverlay> | null = null;
  let transitXray = false;
  let transitPreview: TrackPreview | null = null;
  let transitPreviewKey = '';

  /** The map zoom and the plant layers `setMap` was last told about (`draw`). */
  let plantMapFor: { map: boolean | null; gardens: Gardens | null } = { map: null, gardens: null };
  /** In perspective: how far down the street a person or a car is still big enough to see appear, u. */
  const VIEW_SEEN = m(320);
  /** In perspective: radians added to each side of the camera's width (the camera turns). */
  const VIEW_MARGIN = 0.35;
  const shadowCentre = new Vector3();
  /** DO NOT key every plate's sweep on the document's terrain revision */
  const plateLandRead = new JournalCursor(['terrain']);
  const plateLand = new WeakMap<object, number>();
  let landSerial = 0;
  const bringPlateLand = (doc: RoadDoc): void => {
    const entries = plateLandRead.read(doc.changes);
    if (entries !== null && entries.length === 0) return;
    for (const part of terrain.parts) {
      const box: ChangeRect = [part.cx - TERRAIN_HALF - TERRAIN_CELL, part.cy - TERRAIN_HALF - TERRAIN_CELL, part.cx + TERRAIN_HALF + TERRAIN_CELL, part.cy + TERRAIN_HALF + TERRAIN_CELL];
      const reached = entries === null || entries.some((e) => e.rects === null || e.rects.some((r) => r[0] <= box[2] && r[2] >= box[0] && r[1] <= box[3] && r[3] >= box[1]));
      if (reached) plateLand.set(part.surface, ++landSerial);
    }
  };
  /** DO NOT make it at every keep - a keep runs at every road, building and terrain edit */
  const clearingsRead = new JournalCursor(['clearings']);
  let clearings: (x: number, y: number) => boolean = () => false;
  /** The clearings filed again when the diary says they changed, once a look (`draw`), before any place is tested. */
  const followClearings = (doc: RoadDoc): void => {
    const entries = clearingsRead.read(doc.changes);
    if (entries === null || entries.length > 0) clearings = clearingIndex(doc.treeClearings);
  };
  /** Water, a cliff, a road or a building: nothing of the ecosystem grows there. */
  const natureOpen = (net: Network, x: number, y: number, z: number): boolean => {
    const plate = regionAt(x, y);
    if (Math.abs(x - plate.cx) > plate.half - m(2) || Math.abs(y - plate.cy) > plate.half - m(2)) return false;
    const level = terrain.shoreLevelAt(x, y);
    if (level !== null && level > z - m(0.3)) return false;
    const g = m(2);
    const grade = Math.hypot(terrain.renderedHeightAt(x + g, y) - terrain.renderedHeightAt(x - g, y), terrain.renderedHeightAt(x, y + g) - terrain.renderedHeightAt(x, y - g)) / (2 * g);
    if (grade > 0.75) return false;
    return !onCarriageway(net, { x, y }) && !buildings.covers(x, y);
  };
  /** How far round a place its test reads (the slope's samples, a margin): a change within it tests the place again. */
  const KEEP_REACH = m(4);
  /** Which of the ecosystem's trees stand, cell by cell: on open ground, out of the clearings (`natureOpen`). */
  const natureKeep = new CellKeep<Candidate>((c) => {
    const net = keepNet!;
    const at = terrain.renderedHeightAt(c.x, c.y);
    return natureOpen(net, c.x, c.y, at) && !clearings(c.x, c.y) ? at : null;
  });
  /** The ecosystem's trees brought up to the plates shown: a plate swept and picked again only when its ecology, its land */
  const natureFollow = (): void => {
    const vegetation = quality.vegetation;
    // Nothing moved: every plate shown with an ecology swept for what it is now, and no other.
    let same = true, count = 0;
    if (vegetation > 0) {
      for (const part of terrain.parts) {
        const field = part.surface.ecology();
        if (!field) continue;
        count++;
        const plate = natureShown.get(part.surface);
        if (!plate || plate.field !== field || plate.land !== (plateLand.get(part.surface) ?? 0) || plate.vegetation !== vegetation) { same = false; break; }
      }
    }
    if (same && count === natureShown.size) return;
    const live = new Map<object, NaturePlate>();
    let swept = false;
    if (vegetation > 0) {
      for (const part of terrain.parts) {
        const field = part.surface.ecology();
        if (!field) continue;
        const land = plateLand.get(part.surface) ?? 0;
        let plate = naturePlates.get(part.surface);
        if (!plate || plate.field !== field || plate.land !== land || plate.vegetation !== vegetation) {
          const at = performance.now();
          plate = sweepNaturePlate(part, field, land, vegetation, plate);
          naturePlates.set(part.surface, plate);
          swept = true;
          performance.measure('hitch:nature/sweep', { start: at, end: performance.now() });
        }
        live.set(part.surface, plate);
      }
    }
    // A plate no longer shown: its trees go, unless a plate shown stands where it stood (its trees are listed over them).
    const standing = new Set([...live.values()].map((p) => regionAt(p.part.cx, p.part.cy)));
    for (const [surface, plate] of natureShown) {
      if (live.has(surface)) continue;
      swept = true;
      if (!standing.has(regionAt(plate.part.cx, plate.part.cy))) for (const cell of plateCells(plate.part)) natureKeep.relist(cell, []);
    }
    natureShown = live;
    if (!swept) return;
    const scale = natureScale([...live.values()], vegetation);
    for (const plate of live.values()) {
      if (plate.picked?.scale === scale) continue;
      const trees = pickNature(plate, scale);
      plate.picked = { scale, trees };
      const byCell = new Map<number, Candidate[]>();
      for (const t of trees) {
        const cell = keepCellAt(t.x, t.y);
        const list = byCell.get(cell);
        if (list) list.push(t); else byCell.set(cell, [t]);
      }
      for (const cell of plateCells(plate.part)) natureKeep.relist(cell, byCell.get(cell) ?? []);
    }
  };
  /** A cover's place: never on a road or under a building. */
  const coverFree = (x: number, y: number): boolean => !onCarriageway(keepNet!, { x, y }) && !buildings.covers(x, y);
  const plainCover = (c: Candidate): number | null => (coverFree(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null);
  /** Which of the painted covers' and the rivers' places stand, kind by kind: the woods out of the clearings, a river's stone */
  const coverKeeps = {
    forest: new CellKeep<Candidate>((c) => (coverFree(c.x, c.y) && !clearings(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null)),
    scrub: new CellKeep<Candidate>(plainCover),
    rocks: new CellKeep<Candidate>(plainCover),
    shore: new CellKeep<ShoreCandidate>((c) => {
      const ground = terrain.renderedHeightAt(c.x, c.y);
      const above = ground - c.level;
      // Thickest at the waterline, thinning up the bank and into the deep.
      const odds = above < -m(2.5) ? 0.06 : above < -m(0.3) ? 0.3 : above < m(0.6) ? 0.45 : above < m(2) ? 0.22 : above < m(4) ? 0.07 : 0;
      return c.draw <= odds && coverFree(c.x, c.y) ? ground : null;
    }),
  };
  const paintedKeeps = [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks] as const;
  const coverKinds = [...paintedKeeps, coverKeeps.shore] as const;
  /** The plates shown by their place on the map: the covers' places read only those (`coverGround`). */
  const shownPlates = new Map<object, TerrainPart>();
  const shownAt = (x: number, y: number): TerrainPart | undefined => shownPlates.get(regionAt(x, y));
  const coverGround: CoverGround = {
    forestAt: (x, y) => { const p = shownAt(x, y); return p ? p.surface.forestAt(x - p.cx, y - p.cy) : 0; },
    coverAt: (kind, x, y) => { const p = shownAt(x, y); return p ? p.surface.coverAt(kind, x - p.cx, y - p.cy) : 0; },
    shoreLevelAt: (x, y) => { const p = shownAt(x, y); return p ? p.surface.shoreLevelAt(x - p.cx, y - p.cy) : null; },
  };
  /** What the covers' places follow: the paint from the diary, the plates shown and each one's water */
  const coverPaintRead = new JournalCursor(['paint']);
  let coverPlates = new Map<object, { readonly part: TerrainPart; readonly water: WaterBox | null }>();
  /** Every box paint was laid in since the paint was last read whole: the painted places can stand only there. */
  let paintArea: Rect | null = null;
  /** The water's box over the plates shown, as the rivers' stones were last listed for. */
  let coverWater: WaterBox | null = null;
  /** @rebuild Every cover dab's box (the only paints that raise a density): the paint read whole (a map opened, an undo the diary cannot place). */
  const coverDabsArea = (doc: RoadDoc): Rect | null => {
    let area: Rect | null = null;
    for (const dab of doc.terrainPaint) if (isCoverKind(dab.kind)) area = unionRect(area, [dab.x - dab.radius, dab.y - dab.radius, dab.x + dab.radius, dab.y + dab.radius]);
    return area;
  };
  /** The covers' places brought up to the paint and the plates: only the cells a dab, a plate shown or let go, or a plate's water reached are listed again. */
  const coverFollow = (doc: RoadDoc): void => {
    const entries = coverPaintRead.read(doc.changes);
    // No paint since, and the same plates shown with the same water: nothing to list.
    if (entries !== null && entries.length === 0 && terrain.parts.length === coverPlates.size
      && terrain.parts.every((part) => coverPlates.get(part.surface)?.water === part.surface.waterArea())) return;
    const painted = new Set<number>(), shore = new Set<number>();
    const paintAll = entries === null || entries.some((e) => e.rects === null);
    if (paintAll) {
      paintArea = coverDabsArea(doc);
      for (const keep of paintedKeeps) for (const cell of keep.cellKeys()) painted.add(cell);
    } else {
      for (const entry of entries) for (const r of entry.rects!) {
        paintArea = unionRect(paintArea, [r[0], r[1], r[2], r[3]]);
        keepCellsOver([r[0] - COVER_PLACE_REACH, r[1] - COVER_PLACE_REACH, r[2] + COVER_PLACE_REACH, r[3] + COVER_PLACE_REACH], painted);
      }
    }
    const live = new Map<object, { readonly part: TerrainPart; readonly water: WaterBox | null }>();
    const watered: TerrainPart[] = [];
    let water: WaterBox | null = null;
    shownPlates.clear();
    for (const part of terrain.parts) {
      shownPlates.set(regionAt(part.cx, part.cy), part);
      const was = coverPlates.get(part.surface);
      const box = part.surface.waterArea();
      live.set(part.surface, { part, water: box });
      if (!was || paintAll) {
        const area = paintArea;
        if (area) for (const cell of plateCells(part)) {
          const b = keepCellBox(cell);
          if (b[0] <= area[2] + COVER_PLACE_REACH && b[2] >= area[0] - COVER_PLACE_REACH && b[1] <= area[3] + COVER_PLACE_REACH && b[3] >= area[1] - COVER_PLACE_REACH) painted.add(cell);
        }
      }
      if (!was || was.water !== box) watered.push(part);
      if (box) {
        const b = { minX: box.minX + part.cx, maxX: box.maxX + part.cx, minY: box.minY + part.cy, maxY: box.maxY + part.cy };
        water = water ? { minX: Math.min(water.minX, b.minX), maxX: Math.max(water.maxX, b.maxX), minY: Math.min(water.minY, b.minY), maxY: Math.max(water.maxY, b.maxY) } : b;
      }
    }
    // A plate let go: its places go with it (none stand where no plate is shown).
    for (const [surface, { part }] of coverPlates) {
      if (live.has(surface) || shownAt(part.cx, part.cy)) continue;
      for (const cell of plateCells(part)) {
        for (const keep of paintedKeeps) keep.relist(cell, []);
        coverKeeps.shore.relist(cell, []);
      }
    }
    coverPlates = live;
    // The rivers' stones: over the water's box of every plate shown, as one sweep of it; a moved box lists every plate's again.
    const sameWater = water === coverWater || (!!water && !!coverWater && water.minX === coverWater.minX && water.maxX === coverWater.maxX && water.minY === coverWater.minY && water.maxY === coverWater.maxY);
    const reach = shoreBox(water);
    if (!sameWater) for (const cell of coverKeeps.shore.cellKeys()) shore.add(cell);
    for (const part of sameWater ? watered : [...live.values()].map((v) => v.part)) {
      if (reach) for (const cell of plateCells(part)) {
        const b = keepCellBox(cell);
        if (b[0] <= reach[2] && b[2] >= reach[0] && b[1] <= reach[3] && b[3] >= reach[1]) shore.add(cell);
      }
      for (const cell of plateCells(part)) if (coverKeeps.shore.has(cell)) shore.add(cell);
    }
    coverWater = water;
    for (const cell of painted) {
      const [x0, y0, x1, y1] = keepCellBox(cell);
      const shown = !!shownAt((x0 + x1) / 2, (y0 + y1) / 2);
      coverKeeps.forest.relist(cell, shown ? forestIn(cell, coverGround) : []);
      coverKeeps.scrub.relist(cell, shown ? scrubIn(cell, coverGround) : []);
      coverKeeps.rocks.relist(cell, shown ? rocksIn(cell, coverGround) : []);
    }
    for (const cell of shore) coverKeeps.shore.relist(cell, shoreIn(cell, coverGround, water));
  };
  /** @rebuild Every planted tree's cell, and every cell kept: a map opened, or a change the diary cannot place. */
  const plantedCellsAll = (doc: RoadDoc, keep: CellKeep<RoadDoc['trees'][number]>, cells: Set<number>): void => {
    for (const cell of keep.cellKeys()) cells.add(cell);
    for (const t of doc.trees) cells.add(keepCellAt(t.x, t.y));
  };
  /** The planted trees brought up to the diary: the cells an entry reached listed again from the document (`RoadDoc.treesIn`). */
  const plantedFollow = (doc: RoadDoc, keep: CellKeep<RoadDoc['trees'][number]>): void => {
    const entries = plantedRead.read(doc.changes);
    if (entries !== null && entries.length === 0) return;
    const cells = new Set<number>();
    if (entries === null || entries.some((e) => e.rects === null)) plantedCellsAll(doc, keep, cells);
    else {
      for (const entry of entries) for (const r of entry.rects!) keepCellsOver(r, cells);
    }
    for (const cell of cells) keep.relist(cell, doc.treesIn(keepCellBox(cell)).filter((t) => keepCellAt(t.x, t.y) === cell));
  };
  const handle: SceneHandle = {
    // Asked for by the Actions (a shot, a bomb) and the weapons lab: the effects, and now the physics the bodies fall with
    effects: () => loadEffects().then(() => import('./ragdoll')).then((mod) => mod.warmPhysics()),
    flashGrid(cells) {
      if (!cells.length) return;
      const pos: number[] = [], ring: number[] = [];
      const lift = m(0.3), sub = 4, d = GRID_CELL / sub;
      for (const c of cells) {
        // Each cell in 4 x 4 pieces on the ground, so it bends with it.
        for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
          const x0 = c.x + i * d, y0 = c.y + j * d, x1 = x0 + d, y1 = y0 + d;
          const v = (x: number, y: number): void => { pos.push(x, terrain.renderedHeightAt(x, y) + lift, -y); ring.push(c.ring); };
          v(x0, y0); v(x1, y0); v(x1, y1); v(x0, y0); v(x1, y1); v(x0, y1);
        }
      }
      addBlink(pos, ring);
    },
    flashRoads(ids) {
      // Built in the next frame, once the new roads' heights are solved (`draw`).
      pendingRoadFlash.push(...ids);
      onAssetsReady();
    },
    setGrid(on) {
      // Drawn by the ground's own material (`TERRAIN_GRID`): always on it, over the whole map, in world units.
      TERRAIN_GRID.value = [GRID_CELL, on ? 0.08 : 0, MAP_HALF];
      if (on !== gridWanted) { gridWanted = on; onAssetsReady(); }
    },
    shootBody: (a, b) => fx?.shootBody(a, b) ?? null,
    isDown: (id) => fx?.hides(id) ?? false,
    setEffectsSpeed(speed) { fx?.setEffectsSpeed(speed); },
    stepEffects(seconds) { fx?.stepEffects(seconds); },
    ragdollProbe: () => fx?.ragdollProbe() ?? [],
    clearCasualties() { fx?.clearCasualties(); },
    meshProbe: () => agents.meshProbe(),
    animProbe: (id) => agents.animProbe(id),
    forceClip: (id, clip) => agents.forceClip(id, clip as never),
    driverBody: (vehicle, x, y) => agents.driverBody(vehicle, x, y),
    get focus() { return focusNow; },
    vehicleHit(x, y, z, dirX, dirY, glass, blood) { fx?.vehicleHit(x, y, z, dirX, dirY, glass, blood); },
    dropVehicle(v) { fx?.dropVehicle(v); },
    wound(x, y, z, dirX, dirY, severed) { fx?.wound(x, y, z, dirX, dirY, severed); },
    shot(from, to) { fx?.shot(from, to); },
    inspect,
    census: () => agents.census(),
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    gpu: gpuTimer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles + buildings.triangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        roadTiles: roads ? { built: roads.built, reused: roads.reused } : { built: 0, reused: 0 },
        rebuilds,
        terrainMs: Math.round(terrainMs),
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    landTop() {
      if (landTopFor !== landVersion) {
        landTopFor = landVersion;
        // Kept by the atlas as its plates' ground moves
        let top = terrain.highest?.() ?? -Infinity;
        const corners = Math.round((TERRAIN_HALF * 2) / TERRAIN_CELL);
        if (!terrain.highest) for (const part of terrain.parts) {
          for (let j = 0; j <= corners; j++) {
            for (let i = 0; i <= corners; i++) top = Math.max(top, part.surface.renderedHeightAt(-TERRAIN_HALF + i * TERRAIN_CELL, TERRAIN_HALF - j * TERRAIN_CELL));
          }
        }
        landTopValue = top;
      }
      return landTopValue;
    },
    builtGroundAt(x, y) {
      return builtGroundAt(x, y);
    },
    get worldBusy() {
      return worldJob !== null;
    },
    get opening() {
      return !reveal.opened;
    },
    beginLoad() {
      reveal.begin();
      // A world opened is a load: its programs built again before it is shown.
      sceneCompiled = null;
      sceneReady = false;
      openingSince = null;
      onAssetsReady();
    },
    offerElevation(solved, revision) {
      offeredElevation = { elevation: solved, revision, terrain: terrainRevision };
    },
    roadsSolve() {
      return elevation ? { elevation, terrainRevision } : null;
    },
    surfaceHeightAt(x, y) {
      const ground = terrain.renderedHeightAt(x, y);
      if (!elevation) return ground;
      let top = ground;
      // The road at grade and the decks are asked apart
      for (const set of SURFACE_SETS) {
        if (!elevation.has(set)) continue;
        const road = elevation.roadAt(x, y, set);
        if (road.type < 0 || Math.abs(road.across) > road.half) continue;
        top = Math.max(top, elevation.at(x, y, set));
      }
      return top;
    },
    pavedHeightAt,
    heightTile(rect) {
      const paving = pavedHeightAt.pack?.(rect) ?? null;
      const tile: HeightTile = { terrain: terrain.packHeights?.(rect) ?? null, paving: paving?.data ?? null };
      return { tile, transfer: [...heightTileBuffers(tile), ...paving?.transfer ?? []] };
    },
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    strikeBuilding: (b, x, y, z, strength) => fx?.strikeBuilding(b, x, y, z, strength) ?? false,
    strikeGround(x, y, strength) {
      for (let k = 0; k < 6 + strength * 2; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * m(0.6 + strength * 0.25);
        wear.wheels(x + Math.cos(a) * r, y + Math.sin(a) * r, a, 0.01, 30);
      }
      wear.tick(10);
      exhaust.burst(x, y, terrain.renderedHeightAt(x, y), 20 + strength * 6, 1, m(1 + strength * 0.4), m(3), 5);
    },
    explode(x, y, z, radius, hit) { fx?.explode(x, y, z, radius, hit); },
    burn: (x, y, z, size, seconds) => fx?.burn(x, y, z, size, seconds),
    soot: (x, y, z, r) => fx?.soot(x, y, z, r),
    geyser: (x, y, z, seconds) => fx?.geyser(x, y, z, seconds),
    sparkAt: (x, y, z, seconds) => fx?.sparkAt(x, y, z, seconds),
    leak: (x, y, z, seconds) => fx?.leak(x, y, z, seconds),
    onBuildingDown: (listener) => { buildingDownListeners.push(listener); },
    flingOccupants: (list) => { fx?.flingOccupants(list); },
    setSmog: (k) => environment.setSmog(k),
    strikeAt: (x, y) => strikeAt(x, y),
    onStrike(listener) { strikeListeners.push(listener); },
    cloudDrift: () => cloudDrift,
    busy: () => (fx?.busy() ?? false) || natureTreesPending || cameraEasing,
    targetBytes: () => renderTargetsBytes([...post.targets(), environment.sun.shadow.map]),
    drifting: () => ((fogMoving || placedCloudsShown) && post.enabled && (quality.cloudShadows || quality.skyClouds)) || weatherActive,
    forgetRuin(id) { fx?.forgetRuin(id); },
    setTransitXray(on) {
      transitXray = on;
      transit.setXray(on);
    },
    setTransitPreview(preview) {
      const key = preview ? `${preview.mode}:${preview.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}` : '';
      if (key === transitPreviewKey) return;
      transitPreviewKey = key;
      // ONE preview for the tool's life, written again as the track changes (`createTrackPreview`).
      if (!transitPreview) {
        transitPreview = createTrackPreview();
        world.add(transitPreview.group);
      }
      transitPreview.set(preview?.points ?? [], preview?.mode ?? 'train', terrain.renderedHeightAt, pavedHeightAt);
    },
    setLotOverlay(input, changes) {
      lotOverlay ??= createLotOverlay((x, y) => handle.surfaceHeightAt(x, y));
      lotOverlay.set(input, changes);
    },
    setPolePreview(net, preview) {
      const key = preview && elevation
        ? preview.poles.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${+p.lamp},${+p.standing}`).join(';')
        : '';
      // The run built again when it changed, or the roads it stands along did (from the diary).
      const roadsMoved = polePreviewRoads.read(net.doc.changes);
      if (key === polePreviewKey && roadsMoved !== null && roadsMoved.length === 0) return;
      polePreviewKey = key;
      if (polePreview) {
        world.remove(polePreview.group);
        polePreview.dispose();
        polePreview = null;
      }
      if (!preview || !elevation || preview.poles.length === 0) return;
      polePreview = buildPolePreview(net, poleGroundAt(elevation, terrain.renderedHeightAt, net), sceneryKit, preview);
      world.add(polePreview.group);
    },
    setPerspective(on) {
      if (on === rig.perspective) return;
      rig.setPerspective(on);
      // The passes hold the camera they were made with.
      post.dispose();
      post = createPostChain(renderer, scene, rig.camera, quality, governor.current);
      post.setNight(Math.max(0, lastDark));
      resize();
      onAssetsReady();
    },
    setSkyMode(mode) {
      // Read by the next frame drawn.
      skyMode = mode;
    },
    setAtmosphere(next) {
      atmosphere = next;
    },
    setBuildingCutaway(spec) {
      buildings.setCutaway(spec);
      cutSpec = spec;
    },
    setBuildingsDimmed(except) {
      buildings.setDimmed(except === undefined ? undefined : (except as BuildingId | null));
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    // Wall-clock time between drawn frames, for things that age as they are watched.
    draw(net, sim, alpha, delta, options) {
      renderer.info.reset();
      groundDiary = net.doc.changes;
      // Planted trees and shrubs grow with the city's clock: resized once a city hour.
      cityMinutes = sim.minutes;
      const wallNow = performance.now();
      const wallDt = lastWall < 0 ? 0 : Math.min(0.1, (wallNow - lastWall) / 1000);
      // The bodies, guts and debris on their own clock
      const fxDt = fx ? fx.clock(wallDt) : 0;
      lastWall = wallNow;
      cameraEasing = rig.settle(wallDt);
      if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        resize();
      }
      const terrainStarted = performance.now();
      const stroking = !!options?.holdRoads && !!elevation && networkRevision === net.revision;
      const groundMoved = terrain.update(net.doc, stroking);
      landStroke = !!options?.holdRoads && (landStroke || groundMoved);
      if (groundMoved) {
        landVersion++;
        // The stroke's dirty region, dab by dab (`landDirty`).
        const moved = terrain.lastRegion;
        landDirty = moved === null || landDirty === 'all' ? 'all' : moved.reduce<Rect | null>((dirty, region) => unionRect(dirty, regionRect(region)), landDirty);
      }
      terrain.updatePaint(net.doc);
      // A brush stroke in progress: every dab used to re-solve the whole road network and re-mesh every road
      if (stroking) {
        if (groundMoved) {
          shapeGround(net, terrain.lastRegion);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        const atRebuild = performance.now();
        rebuildWorld(net);
        performance.measure('hitch:draw/Rebuild', { start: atRebuild, end: performance.now() });
        terrain.settle();
      }
      const atPump = performance.now();
      pumpWorld();
      performance.measure('hitch:draw/Pump', { start: atPump, end: performance.now() });
      // A building placed, moved or reshaped grades its own site.
      landShapes();
      followFloors(net);
      if (!(worldJob && worldJobGround) && gradedFor !== net.doc.buildings.revision) {
        gradedFor = net.doc.buildings.revision;
        const changed = sitesGraded.changedSites(net.doc.buildings);
        if (changed) shapeGround(net, changed.map(terrainRegion), true);
      }
      // What stands on the ground - the buildings, the walls, the transport, the gardens
      const groundSettled = !stroking && !worldJob;
      // The street furniture, the signs, the barriers and the transport on the world as it stands (the engine's 'draw' products)
      if (groundSettled) { placedOn = net; engine.refresh('draw'); }
      // The buildings follow the ground once a stroke is over, not on every dab of it
      if (groundSettled && groundChanges.version !== buildingGroundSeen) {
        const moved = buildingGroundSeen < 0 ? null : buildingsOnGroundSince(net.doc, buildingGroundSeen);
        if (moved === null || moved.length > 0) buildingGround = String(groundChanges.version);
        buildingGroundSeen = groundChanges.version;
      }
      // At the opening the buildings come once the first world (the roads, the ground cut and filled to them) is in
      if (roads !== null && (reveal.opened || !worldJob)) {
        buildings.hidden = !reveal.opened;
        // Buildings put together or streamed in (HLOD, `layer.ts`) are new casters: the shadow map is drawn again.
        if (buildings.update(net.doc, terrain.renderedHeightAt, buildingGround, pavedHeightAt, builtGroundAt,
          (b, since) => groundChanges.touches(Number(since), bankBox(b)),
          (since) => (since === '' ? null : buildingsOnGroundSince(net.doc, Number(since))))) shadowMoved = true;
        if (buildings.pending) onAssetsReady();
      }
      // The countryside's trees are grown once the first world is in, not while the opening builds it (`loadNatureTrees`).
      if (!natureTreesStarted && roads !== null && !worldJob) startNatureTrees();
      // The Actions' effects (`playEffects.ts`) made in idle time once the world stands, not on the first shot
      if (!fxPreload && !fxLoading && roads !== null && !worldJob && typeof requestIdleCallback === 'function') {
        fxPreload = true;
        requestIdleCallback(() => { void loadEffects(); }, { timeout: 5000 });
      }
      // Each building's plants (`gardenLists.ts`), placed again only when some changed.
      const plants = plantLists.update(net.doc.buildings, groundSettled);
      if (plants) {
        // Kept building by building (`gardens.ts`): a list the same as before keeps its plants' slots.
        gardens ??= createGardens(sceneryKit);
        const swapped = gardens.update(plants);
        for (const mesh of swapped.removed) world.remove(mesh);
        for (const mesh of swapped.added) world.add(mesh);
      }
      // THE PLANTS AND STONES, cell by cell (`plantPlaces.ts`, `CellKeep`): each kind follows what its places read, from the diary
      if (!stroking && !worldJob) {
        keepNet = net;
        followClearings(net.doc);
        // What the tests read that changed since the last look, and where (null: the diary cannot say).
        const entries = vegetationRead.read(net.doc.changes);
        let rects: ChangeRect[] | null = entries === null ? null : [];
        for (const entry of entries ?? []) {
          if (entry.rects === null) { rects = null; break; }
          rects!.push(...entry.rects);
        }
        const moved = rects === null || rects.length > 0;
        // The stones, the scrub and the painted woods: tested again where the change reached, listed again where the paint did.
        const atCover = performance.now();
        if (moved) for (const keep of coverKinds) keep.refresh(rects, KEEP_REACH);
        coverFollow(net.doc);
        // The painted woods' trees are the countryside's (`natureTrees.ts`); the old card trees only if those cannot be grown.
        const standIns = !natureTreeKit && !natureTreesPending;
        // The stones take the colour of the painted rock under them.
        const geology = terrain.geologyChanges.version;
        const coverWhole = vegetationRedraw || coverLook?.geology !== geology || coverLook?.standIns !== standIns;
        // The cells whose places changed, of every kind (the painted woods' are read by the cover's card trees and by the forest).
        const taken = coverKinds.map((keep) => keep.takeChangedCells());
        if (coverWhole || taken.some((cells) => cells.size > 0)) {
          const changed = new Set(taken.flatMap((cells) => [...cells]));
          const allCells = (): Set<number> => new Set(coverKinds.flatMap((keep) => [...keep.cellKeys()]));
          coverCells ??= (() => {
            const made = createCoverCells(coverKit, 'ground-cover', {
              rocksIn: (cell) => [...coverKeeps.rocks.standingIn(cell), ...coverKeeps.shore.standingIn(cell)]
                .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed, rock: terrain.geologyAt(c.x, c.y) })),
              scrubIn: (cell) => coverKeeps.scrub.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed })),
              treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
            });
            world.add(made.group);
            return made;
          })();
          coverCells.sync(coverWhole ? null : changed, allCells());
          if (natureTreeKit) {
            paintedForest ??= (() => {
              const made = createTreeCells(natureTreeKit, 'painted-forest', (cell) => coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
              world.add(made.group);
              return made;
            })();
            paintedForest.sync(coverWhole ? null : changed, coverKeeps.forest.cellKeys());
          }
        }
        coverLook = { geology, standIns };
        performance.measure('hitch:cover', { start: atCover, end: performance.now() });
        // The ecosystem's own trees: tested again where the change reached, swept again on the plates whose ecology or land moved.
        const atNature = performance.now();
        bringPlateLand(net.doc);
        if (moved) natureKeep.refresh(rects, KEEP_REACH);
        natureFollow();
        const natureCells = natureKeep.takeChangedCells();
        if (vegetationRedraw || natureCells.size) {
          const changedNature = vegetationRedraw ? null : natureCells;
          if (natureTreeKit) {
            natureForest ??= (() => {
              const made = createTreeCells(natureTreeKit, 'nature-forest', (cell) => natureKeep.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
              world.add(made.group);
              return made;
            })();
            natureForest.sync(changedNature, natureKeep.cellKeys());
            // Grown (or nothing to grow): no longer drawing while waiting for them.
            natureTreesPending = false;
          }
          // The old card trees only if the new ones could not be grown
          natureCards ??= (() => {
            const made = createCoverCells(coverKit, 'nature-cards', {
              rocksIn: () => [], scrubIn: () => [],
              treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? natureKeep.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
            });
            world.add(made.group);
            return made;
          })();
          natureCards.sync(changedNature, natureKeep.cellKeys());
        }
        performance.measure('hitch:nature', { start: atNature, end: performance.now() });
        // The trees the player planted (`world/trees.ts`), with the woods' own models
        if (natureTreeKit) {
          const keep = plantedKeep ??= new CellKeep((t) => (onCarriageway(keepNet!, t) || buildings.covers(t.x, t.y) ? null : terrain.renderedHeightAt(t.x, t.y)));
          if (moved) keep.refresh(rects, KEEP_REACH);
          plantedFollow(net.doc, keep);
          const cells = keep.takeChangedCells();
          if (cells.size || vegetationRedraw) {
            plantedForest ??= (() => {
              const made = createTreeCells(natureTreeKit, 'planted-forest', (cell) => keep.standingIn(cell)
                .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' as const })));
              world.add(made.group);
              return made;
            })();
            plantedForest.sync(vegetationRedraw ? null : cells, keep.cellKeys());
          }
        }
        vegetationRedraw = false;
      }
      // The perspective camera kept out of the buildings (`IsoRig.setSolids`)
      followFloors(net);
      if (cameraSolidsKept.follow(net.doc.buildings, floorGroundSince)) {
        rig.setSolids((x, y) => cameraSolidsKept.solids().floorAt(x, y), (x, y) => cameraSolidsKept.solids().roofAt(x, y));
        townSolids = () => cameraSolidsKept.solids();
      }
      // The light the buildings shut out of the streets round the view (`canyonLight.ts`).
      post.followTown(rig.target.x, -rig.target.z, townSolids, canyonChanges(net.doc.changes));
      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      const plantMap = rig.viewport.zoom < PLANT_MAP_ZOOM;
      // Keep the full facade at street zoom: the planar far mesh loses frames on side-facing windows.
      buildings.setFar(rig.viewport.zoom < perM(7.5));
      // Facade detail only within ~500 m of the eye (`cullDetails`).
      {
        const eye = rig.camera.position;
        let k = 1;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          k = halfH / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360) / Math.max(1e-3, eye.distanceTo(rig.target));
        }
        const t = rig.target;
        const ex = t.x + (eye.x - t.x) * k, ey = -(t.z + (eye.z - t.z) * k), ez = t.y + (eye.y - t.y) * k;
        // The far level of the buildings by the error on the screen, in CSS pixels
        const pxAtMetre = canvas.clientHeight / (2 * Math.tan(((rig.perspective ? (rig.camera as PerspectiveCamera).fov : PERSPECTIVE_FOV) * Math.PI) / 360));
        // In the view from above a metre spans the same pixels wherever it stands
        let reach = Infinity;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          const halfW = (halfH * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
          reach = Math.hypot(halfW, halfH / Math.max(0.3, Math.sin(rig.viewport.elevation))) * 1.25 + m(120);
        }
        buildings.levelOfDetail(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach);
        buildings.cullDetails(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom);
      }
      buildings.setShadowFar(rig.viewport.zoom < FACADE_SHADOW_ZOOM);
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      watchRoads(net);
      // DO NOT test `-leaves`: no mesh is named so, and the cards were drawn at every zoom.
      for (const mesh of furniture.meshes) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !isLeafCards(mesh));
      }
      for (const mesh of gardens?.meshes ?? []) {
        mesh.visible = detailed && (!plantMap || !isLeafCards(mesh));
      }
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      // After `visible` is set (the contract of `Scenery.setMap`), and only when the map zoom is crossed or the layer is new
      if (plantMap !== plantMapFor.map || gardens !== plantMapFor.gardens) {
        plantMapFor = { map: plantMap, gardens };
        gardens?.setMap(plantMap);
        furniture.setMap(plantMap);
      }
      // The roads just laid: a strip over their whole width, on their own deck.
      if (pendingRoadFlash.length && elevation) {
        const pos: number[] = [], ring: number[] = [];
        for (const id of pendingRoadFlash.splice(0)) {
          const ribbon = net.ribbons.get(id);
          if (!ribbon) continue;
          const line = ribbon.full, half = sidewalkHalf(ribbon.road);
          const at = (s: number, side: number): [number, number, number] => {
            const f = line.sampleAt(Math.min(s, line.length));
            const x = f.p.x + f.n.x * half * side, y = f.p.y + f.n.y * half * side;
            return [x, elevation!.onSegment(id, f.p.x, f.p.y) + m(0.3), -y];
          };
          // The road itself only: cut where its ends meet a junction (its trims), not running into the road it joins.
          const trims = net.trims.get(id);
          const from = trims ? Math.max(0, ...Object.values(trims.a)) : 0;
          const to = line.length - (trims ? Math.max(0, ...Object.values(trims.b)) : 0);
          const step = m(1.5);
          for (let s = from; s < to; s += step) {
            const e = Math.min(to, s + step);
            const l0 = at(s, 1), r0 = at(s, -1), l1 = at(e, 1), r1 = at(e, -1);
            pos.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1);
            for (let k = 0; k < 6; k++) ring.push(0);
          }
        }
        if (pos.length) addBlink(pos, ring);
      }
      for (let i = gridFlashes.length - 1; i >= 0; i--) {
        const f = gridFlashes[i]!;
        const t = (performance.now() - f.start) / 1000;
        f.time = t;
        if (t > f.end) { scene.remove(f.mesh); f.mesh.geometry.dispose(); gridFlashes.splice(i, 1); }
        else onAssetsReady();
      }
      // The map stands on a plain dark blue
      {
        // Found once: looked up by name it walked the whole scene every frame.
        skyMesh ??= scene.getObjectByName('sky') ?? null;
        if (skyMesh) skyMesh.visible = false;
        scene.background = MAP_BACKGROUND;
      }
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      const cullCamera = rig.camera;
      crowdProjection.multiplyMatrices(cullCamera.projectionMatrix, cullCamera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection, cullCamera.coordinateSystem, cullCamera.reversedDepth);
      cameraRight.setFromMatrixColumn(cullCamera.matrixWorld, 0).normalize();
      cameraForward.setFromMatrixColumn(cullCamera.matrixWorld, 2).normalize().negate();
      // The canvas's CSS size read once a frame, before the vehicles ask `screenScale`
      cssHalfW = renderer.domElement.clientWidth * 0.5;
      cssHalfH = renderer.domElement.clientHeight * 0.5;
      // Plants and street furniture outside the view are not drawn at all.
      furniture.cull(crowdFrustum, crowdProjection);
      utilities?.cull(crowdFrustum, crowdProjection);
      polePreview?.cull(crowdFrustum, crowdProjection);
      signs.cull(crowdFrustum, crowdProjection);
      barriers.cull(crowdFrustum, crowdProjection);
      transit.cull(crowdFrustum, crowdProjection);
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.cull(crowdFrustum, crowdProjection);
      // The gardens' meshes given more or less room for what is in view, swapped in the scene.
      const regrown = gardens?.cull(crowdFrustum, crowdProjection);
      for (const mesh of regrown?.removed ?? []) world.remove(mesh);
      for (const mesh of regrown?.added ?? []) world.add(mesh);
      transit.update(sim.trains, terrain.renderedHeightAt);
      agents.sync(sim, net, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        personPixels,
        screenScale,
        areaPixels,
        shadows: renderer.shadowMap.enabled,
        eye: cullCamera.position,
        vehicleVisible,
        occupantZoom: quality.occupantZoom,
        exhaust: (x, y, z, angle, length, speed, dusty) => {
          exhaust.emit(x, y, z, angle, length, speed, dusty);
          if (!dusty && Math.abs(speed) > 0.5) wear.wheels(x, y, angle, Math.min(length * 0.42, m(1.7)), wallDt);
        },
        // The bodies of shots and blows (`playEffects.ts`), once anybody has shot or struck.
        ...(fx ? { ragdolls: (citizens: Parameters<PlayEffects['frame']>[0]) => fx!.frame(citizens, sim, net.doc, options?.getUp ?? (() => {}), wallDt, fxDt) } : {}),
        hiddenPed: (id) => fx?.hides(id) ?? false,
      });
      exhaust.tick(windClock, renderer.domElement.height / 2);
      fx?.update(wallDt, fxDt);
      for (const ped of sim.pedViews) if (ped.v > 0.05) wear.feet(ped.x, ped.y, wallDt);
      wear.tick(wallDt);
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}` : '';
      const lampsMoved = !!cutSpec && buildingsMovedNear(net.doc, cutSpec);
      if (key !== lampsKey || lampsMoved) {
        lampsKey = key;
        const lamps = roomLamps.lamps(net.doc, cutSpec, builtGroundAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      // Falls off with the distance in world units: the same lamp in metres at any unit.
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * TUNED_UNIT ** light.decay * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim, net, detailed, crowdFrustum);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      // The screen's height covers more ground the lower the camera looks
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, once per rebuild of the layer
      if (tallestFor !== buildings.version) {
        tallestFor = buildings.version;
        tallestBox.setFromObject(buildings.group);
        tallestTop = tallestBox.isEmpty() ? 0 : tallestBox.max.y;
      }
      // Day and night, by the city's clock (`sim/city/city.ts`).
      const fixedHour = skyMode === 'day' ? 16 * 60 : skyMode === 'night' ? 22 * 60 : null;
      const clock = fixedHour === null ? sim.minutes : fixedHour;
      {
        // THE WEATHER (`world/weather.ts`): the wind carries the clouds and bends the plants and the smoke
        const weather = net.doc.weather;
        const step = Math.min(0.1, Math.max(0, delta));
        const wind = windVector(weather, m(1));
        cloudDrift.x += wind.x * step;
        cloudDrift.y += wind.y * step;
        post.setCloudDrift(cloudDrift.x, cloudDrift.y);
        setWindWeather(wind.x, -wind.y, weather.wind);
        // The water: its waves run with the wind, rougher the harder it blows; its foam; how fast the rivers run.
        const windLength = Math.hypot(wind.x, wind.y);
        const angle = (weather.windDirection * Math.PI) / 180;
        terrain.setWaterLook({
          waves: Math.min(1, weather.waves + weather.wind / 40),
          foam: weather.foam,
          current: weather.current * m(1),
          windX: windLength > 1e-6 ? wind.x / windLength : Math.cos(angle),
          windZ: windLength > 1e-6 ? -wind.y / windLength : -Math.sin(angle),
          windSpeed: windLength,
        });
        const span = 2 * Math.max(halfWidth, halfHeight);
        if (weather.lightning > 0 && Math.random() < (step * weather.lightning) / 60) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * span * 0.45;
          strikeAt(target.x + Math.cos(a) * r, -target.z + Math.sin(a) * r);
        }
        canvasSize.set(canvas.clientWidth, canvas.clientHeight);
        const flash = lightning.update(step, canvasSize);
        const storm = Math.min(1, weather.lightning / 8);
        environment.setWeather(Math.max(weather.rain * 0.85, storm * 0.6), flash);
        rainWind.set(wind.x, -wind.y);
        rain.update(weather.rain, target, span, rainWind, step);
        sceneryKit.setHaze(Math.max(weather.rain, storm));
        weatherActive = weather.rain > 0 || weather.lightning > 0 || flash > 0 || (weather.wind > 0 && placedCloudsShown);
      }
      const dark = environment.setTimeOfDay(clock);
      // What a cloud's shadow can take: the sun's share of the light now.
      post.setDirectShare(environment.directShare());
      if (Math.abs(dark - lastDark) > 0.01) {
        lastDark = dark;
        post.setNight(dark);
        sceneryKit.setNight(dark);
        agents.setNight(dark);
      }
      // The windows every frame: how many rooms are lit follows the clock
      buildings.setNight(lastDark, clock / 60);
      rig.camera.getWorldDirection(viewDirection);
      // The shadows round the ground looked at.
      const sunMoved = environment.follow(shadowCentre.copy(target), halfWidth, groundHalfDepth, viewDirection, Math.max(0, tallestTop - target.y), rig.camera.position.distanceTo(target));
      // What the simulation must show in full: people step round each other only where they are seen, and big enough to see it
      {
        // In perspective, tilted towards the horizon, the camera sees far past the circle round the centre of the view
        let view: { ex: number; ey: number; dx: number; dy: number; cos: number; far: number } | null = null;
        if (rig.perspective) {
          // The cone on the plane, as the simulation sees it.
          const coneDirection = rig.camera.getWorldDirection(flatDirection);
          const flat = Math.hypot(coneDirection.x, coneDirection.z);
          if (flat > 0.05) {
            const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
            const fov = rig.camera instanceof PerspectiveCamera ? rig.camera.fov : PERSPECTIVE_FOV;
            const halfAcross = Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
            view = {
              ex: rig.camera.position.x, ey: -rig.camera.position.z,
              dx: coneDirection.x / flat, dy: -coneDirection.z / flat,
              cos: Math.cos(Math.min(Math.PI, halfAcross + VIEW_MARGIN)), far: VIEW_SEEN,
            };
          }
        }
        focusNow = {
          x: target.x,
          y: -target.z,
          r: Math.hypot(halfWidth, groundHalfDepth) + m(20),
          detail: rig.viewport.zoom * m(1.7) >= 10,
          view,
        };
      }

      // The shadow pass, drawn when the map can have changed.
      if (renderer.shadowMap.enabled) {
        shadowFrame++;
        // The two-wheelers changed between casting and a soft disc: their shadows come or go now.
        if (agents.castersChanged) shadowMoved = true;
        // Moving only when something that moves is in the pass (`movingCasters`) or the wind bends the trees
        const moving = net.doc.weather.wind > 0 || (!options?.paused && movingCasters());
        const every = rig.viewport.zoom >= SHADOW_FULL_ZOOM ? 1 : SHADOW_FAR_EVERY;
        if (shadowMoved || sunMoved || (moving && shadowFrame >= every) || shadowFrame >= SHADOW_SAFETY_FRAMES) {
          renderer.shadowMap.needsUpdate = true;
          shadowMoved = false;
          shadowFrame = 0;
        }
      }
      // It follows meshes a rebuild or an asset load adds, and instance colours created on first use - twice a second
      if (renderer.shadowMap.enabled && ++shadowDepthFrame % 30 === 1) assignShadowDepth(scene);
      // An explosion shakes the camera for a moment.
      const shake = fx?.shake() ?? 0;
      if (shake > 0) {
        shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
        rig.camera.position.add(shakeOffset);
        rig.camera.updateMatrixWorld();
      }
      // The land's own light (its hills' shading, baked a plate at a time).
      terrain.setSun(sunTowards.copy(environment.sun.position).sub(environment.sun.target.position));
      {
        // The relief's close window (terrainRelief.ts) round the ground the view looks at, drawn a little towards the camera
        const centre = rig.viewport.centre;
        const cam = rig.camera.position;
        const dx = cam.x - centre.x, dz = cam.z + centre.y;
        const across = Math.hypot(dx, dz);
        const pull = across > 1 ? Math.min(150, across * 0.3) / across : 0;
        reliefFocus.x = centre.x + dx * pull;
        reliefFocus.z = -centre.y + dz * pull;
        // Close: the screen's height under some 1800 units of ground, in either camera
        const halfHeight = renderer.domElement.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
        const close = halfHeight < 900;
        // The atlas keeps in full only the plates near what the view takes in (`flatAtlas.ts`).
        terrain.focus?.(centre.x, centre.y, halfHeight);
        // The plates out of view let go of their GPU copies; three.js sends them again when they are next drawn.
        terrain.cull?.(crowdFrustum);
        // The roads at full detail within reach of what the view takes in, the far level beyond: a few frames apart
        roadFocus.x = centre.x; roadFocus.y = centre.y;
        roadFocus.reach = Math.min(900, Math.max(320, halfHeight * 1.8));
        if (roadFocus.frames++ % 6 === 0) {
          const blocks: Mesh[] = [];
          for (const { mesh } of surfaceReuse.chunks.values()) blocks.push(mesh);
          updateRoadLevels(blocks, roadFocus.x, roadFocus.y, roadFocus.reach);
        }
        terrain.bakeRelief(renderer, close ? reliefFocus : null);
      }
      {
        // The painted fog: its map again when the fog or the land under it changed (never in the middle of a sculpting stroke).
        const doc = net.doc;
        // A fog stroke shows as it is painted; a land stroke waits for its end.
        if (!landStroke) {
          const entries = fogRead.read(doc.changes);
          if (entries === null || entries.length > 0) {
            const startedAt = performance.now();
            // Only where the fog, the land or the ground under it changed (`createFogField`)
            const ground = (x: number, y: number): number => terrain.renderedHeightAt(x, y);
            const laid = !entries || entries.some((e) => e.rects === null)
              ? fogField.whole(doc.fogDabs, ground)
              : fogField.update(doc.fogDabs, ground, entries.flatMap((e) => e.rects!));
            fogLayer = laid.any ? laid : null;
            performance.measure('hitch:fog', { start: startedAt, end: performance.now() });
          }
        }
        const f = doc.fogSettings;
        post.setPlacedClouds(doc.clouds);
        // The elements: the cells where they or the ground under them changed, from the diary (`elements.ts`).
        if (elementKit && !landStroke) {
          if (!elementLayer) {
            elementLayer = createElementLayer(elementKit);
            world.add(elementLayer.group);
            elementRead.reset();
          }
          const entries = elementRead.read(doc.changes);
          if (entries === null || entries.length > 0) {
            const startedAt = performance.now();
            const items: ChangeRect[] = [], ground: ChangeRect[] = [];
            const whole = entries === null || entries.some((e) => e.rects === null);
            if (!whole) for (const e of entries) (e.kind === 'elements' ? items : ground).push(...e.rects!);
            elementLayer.sync(whole ? { items: null, ground: null } : { items, ground }, doc, terrain.renderedHeightAt);
            performance.measure('hitch:elements', { start: startedAt, end: performance.now() });
          }
        }
        // In the frame they changed in, as the other layers were culled above.
        elementLayer?.cull(crowdFrustum, crowdProjection);
        elementLayer?.emit(Math.min(0.1, Math.max(0, delta)), rig.camera.position, exhaust);
        post.setGroundFog(fogLayer?.any ? { texture: fogLayer.texture, low: fogLayer.low, high: fogLayer.high, density: f.density } : null);
        fogMoving = !!fogLayer?.any;
        placedCloudsShown = doc.clouds.length > 0 || !!elementLayer?.hasEffects;
      }
      // Rain thickens the air: a grey mist over the distance (`world/weather.ts`).
      const rainNow = net.doc.weather.rain;
      const air = rainNow > 0 ? { ...atmosphere, fog: Math.max(atmosphere.fog, rainNow * 0.2), fogHeight: Math.max(atmosphere.fogHeight, m(120)) } : atmosphere;
      // The orthographic camera stands far back by construction
      const eyeShift = rig.perspective ? 0
        : rig.camera.position.distanceTo(rig.target) - halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      post.setAtmosphere(air, sunTowards.copy(environment.sun.position).sub(environment.sun.target.position), environment.skyColor,
        sunLight.copy(environment.sun.color).multiplyScalar(environment.sun.intensity), eyeShift);
      const atRender = performance.now();
      // The people's skeletons on the GPU (`people/crowdAnimation.ts`), before anybody draws them.
      agents.renderPalettes(renderer);
      // The opening's town is shown whole
      openingSince ??= performance.now();
      if (!reveal.opened) {
        const built = roads !== null && !worldJob && !buildings.pending && natureTreesStarted && !natureTreesPending;
        // Its programs built, every one of them at once and in parallel where the driver can, before the frame that shows it.
        if (built && !sceneCompiled) {
          // A world opened meanwhile (`beginLoad`) waits for its own.
          const mine: Promise<void> = sceneCompiled = compileScene().then(() => { if (sceneCompiled === mine) { sceneReady = true; onAssetsReady(); } });
        }
        const whole = built && sceneReady;
        const next = reveal.step(whole, performance.now());
        if (next === 'warm') {
          // One frame drawn unseen first: the new meshes go to the GPU
          if (post.target) {
            renderer.setRenderTarget(post.target);
            renderer.render(scene, rig.camera);
            renderer.setRenderTarget(null);
          }
          onAssetsReady();
        } else if (next === 'show') {
          performance.mark('opening:shown', { detail: { waitedMs: performance.now() - openingSince, workedMs: reveal.worked, whole } });
        }
      }
      if (reveal.opened) {
        // Round the frame's whole drawing: the shadow, the scene, every pass.
        gpuTimer.poll();
        gpuTimer.begin();
        post.render(delta);
        gpuTimer.end();
      } else onAssetsReady();
      performance.measure('hitch:draw/Render', { start: atRender, end: performance.now() });
      if (shake > 0) { rig.camera.position.sub(shakeOffset); rig.camera.updateMatrixWorld(); }
      // One waiting texture a frame to the GPU, before anybody draws it.
      drainUploads(renderer, 1);
      drainCompiles(renderer, rig.camera, scene, post.target);
      // From the second frame on, the compiler answers: warm the road shaders.
      warmRoadShaders();
      warmBlastShaders();
      warmPreviewShaders();
      warmPlantShaders();
      // One waiting body's geometry a frame to the GPU, before anybody draws it.
      drainWarm(renderer, rig.camera, scene, post.target);
      // Meshes still waiting to go up: another frame, so the queue never stands while the game is still.
      if (warmPending()) onAssetsReady();

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
    },
    setQuality(level) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved);
    },
    get quality() {
      return requested;
    },
    dispose() {
      roadTiles.dispose();
      groundWorkers.dispose();
      tileWriter?.terminate();
      // Everything the renderer made, the GPU's included: the layers, the previews and the effects too
      fx?.dispose();
      exhaust.dispose();
      wear.dispose();
      barriers.dispose();
      transit.dispose();
      transitPreview?.dispose();
      polePreview?.dispose();
      utilities?.dispose();
      signs.dispose();
      for (const flash of gridFlashes) flash.mesh.geometry.dispose();
      agents.dispose();
      signals.dispose();
      buildings.dispose();
      blinkMaterial.dispose();
      worldJob = null;
      roads?.dispose();
      disposeSurfaceReuse(surfaceReuse);
      details?.dispose();
      furniture.dispose();
      gardens?.dispose();
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.dispose();
      coverKit.dispose();
      fogTexture.dispose();
      elementLayer?.dispose();
      elementKit?.dispose();
      paintedForest?.dispose();
      plantedForest?.dispose();
      rain.dispose();
      lightning.dispose();
      natureTreeKit?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      lotOverlay?.dispose();
      renderer.dispose();
    },
  };
  return handle;
}
