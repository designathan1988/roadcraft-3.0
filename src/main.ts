import { profileOf } from '@world/roads/profile';
import { profiler } from '@core/profiler';
import { mountProfilerHud } from '@ui/profilerHud';
import { hookProfiler } from '@render/profilerHooks';
import { mountCompass, northOnScreen, northTurn, type Compass } from '@ui/v2/compass';
import { flipProfile, streetChain } from '@world/roads/streetChain';
import { furnitureChosen } from '@ui/roads/furnitureChoice';
import { isMarkingStyle } from '@world/roads/markingStyle';
import { createActions } from './actionsWiring';
import { FrameClock, Periodic, SimPeriodic, coalescedTask } from './frameLoop';
import { ConflictPool } from './conflictPool';
import { BayPool } from './bayPool';
import { useBayWorkers } from '@sim/agents/parking';
import { beginFrameWork } from '@core/frameWork';
import { GameState } from '@core/gameState';
import { Engine } from '@core/engine';
import { InputQueue } from '@core/events';
import { FrameTimer, HealthLog, frameStats } from '@core/health';
import { LotTool, type LotSplitKind, type ZoneMode } from '@editor/lotTool';
import { watchHealth } from '@ui/healthWatch';
import { mountHealthPanel } from '@ui/healthPanel';
import { METERS_PER_UNIT } from '@world/units';
import { applyLots, planLotsSteps } from '@world/lots';
import { type Vec2, dist } from '@core/vec2';
import { clamp } from '@core/scalar';
import { flattenSegment } from '@core/bezier';
import { RoadDoc, type JunctionControl } from '@world/doc';
import { DOC_CHANGE_KINDS, type Change, type ChangeKind, type ChangeRect } from '@world/changes';
import { MIN_LINK_LENGTH } from '@world/approach';
import { MAX_AUTHORED_GRADE } from '@world/elevation';
import { Network } from '@world/network';
import { PageSimHost, type SimHost, type SimSettings } from '@sim/host';
import { DEFAULT_CITY, planCity, type CityOptions, type CityPlan } from '@world/cityGen/plan';
import { greenCitySteps, layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { LAST_UPGRADE_CLASS, ROAD_TYPES, roadProfile, roadType } from '@world/roadTypes';
import { UNITS_PER_METER } from '@world/units';
import { MAX_TERRAIN_STAMPS, RELIEF_FLAT, type TerrainMode } from '@world/terrain';
import type { GeologyKind } from '@world/terrainPaint';
import { DEFAULT_REGION, isRegionId, type NatureSettings } from '@world/ecology';
import type { NodeId, SegmentId } from '@world/ids';
import { BARRIER_KINDS, type BarrierKind } from '@world/barriers';
import { BarrierTool } from '@editor/barriers';
import {
  POLE_PICK_PIXELS,
  PoleTool,
  commitPoleRun,
  planPoleRun,
  type PoleRunPlan,
} from '@editor/poles';
import { blockGridChoice, onRoadGridChange, roadGridShown, signChoice, strikeChoice, zoneColoursShown, paintKind, poleLampMode, poleToolMode, roadWidth, streetscapeKind, fogErase, fogBrush, setFogBrush, gullyErase, treeMode, treeKind, treeBrush, setTreeBrush, cloudMode, cloudBrush, setCloudBrush, elementKind, elementMode, elementBrush, setElementBrush } from '@ui/toolChoices';
import { TERRAIN_MIN_MS, TerrainBrush, type DabSettings } from '@editor/terrainBrush';
import { scatterClouds } from '@world/clouds';
import { CloudTool } from '@editor/cloudTool';
import { playThunder } from '@ui/thunder';
import { MAP_HALF, MAP_SIZE } from '@world/bounds';
import { blockGridLines, commitBlockGrid } from '@editor/blocks';
import { m, stepsIn } from '@world/units';
import { GRID_CELL } from '@world/grid';
import { sectionForWidth } from '@world/roadSection';
import { LANDSCAPE_RADIUS } from '@world/landscape';
import { StreetscapeTool } from '@editor/streetscapeTool';

import { Camera } from '@view/camera';
import { type Viewport, flatViewport } from '@view/viewport';
import { CanvasSurface } from '@ui/overlay/surface';
import { INVALID, SELECTION, HOVER } from '@ui/overlay/palette';
import { createSceneRenderer, type SceneHandle, type SkyMode } from '@render/renderer';
import { countMemory } from '@render/memoryCounters';
import { formatInventory, sceneInventory } from '@render/inventory';
import { cityBudgetTable, VIEW_BUDGETS, type CityView } from '@core/perfBudget';
import { primeSurfaceBake, startSurfaceBake } from '@render/surfaceBakeClient';
import { forgetOtherDerived, readDerivedAll, writeDerivedMany } from '@render/derivedCache';

declare const __CONFLICT_ZONES_HASH__: string | undefined;
import { DEFAULT_AZIMUTH, DEFAULT_ELEVATION, isoZoomBounds } from '@render/isoViewport';

import { SimWorld } from '@sim/world';
import { WorkerSimHost } from './simWorkerHost';
import { DT, NARROW_SCREEN_SHARE, NARROW_SCREEN_WIDTH } from '@sim/params';

import { type Anchor, anchorForHeight, findAnchor, roadSnap, setRoadSnap } from '@editor/snap';
import { duplicateSegment, joinSegments, splitSegment } from '@editor/commit';
import { type RoadEditRefusal, guardRoadEdit } from '@editor/editRules';
import { commitPedestrianCrossing, commitUturn } from '@editor/streetObjects';
import { commitRoundabout } from '@editor/roundabout';
import { RoadTool, type RoadDraft } from '@editor/roadTool';
import { Bulldozer } from '@editor/bulldozer';
import { NodeMover } from '@editor/nodeMover';
import { CameraGestures, type PointerSample } from '@view/cameraGestures';
import { CameraMotion } from '@view/cameraMotion';
import { freeRoadsEnabled } from '@ui/roadSectionEditor';
import { applyProfileTo } from '@editor/roads/profile';
import { drawProfile } from '@ui/roads/drawProfile';
import { cutWallsChosen } from '@ui/roads/cutWalls';
import { ROAD_PARKING_PRESETS, type RoadParkingPreset, roadParking, roadParkingPreset, setRoadParkingPreset } from '@editor/roadParking';
import { History, followNetwork, restoreInto, restoreSnapshot, serialize } from '@editor/history';
import { STUTTER_MS } from '@core/sampleRing';
import { type ImportResult, Persistence, importFromFile, type SavedSettings, MAX_INTENSITY } from '@editor/persistence';
import { exportToFile } from '@editor/mapExport';
import { openInspector, closeInspector as hideInspector, onInspectorChange, refreshInspector } from '@ui/inspector';
import { TransitTool, setTransitTool, transitTool } from '@editor/transitTools';
import type { BuildingId } from '@world/buildings/types';
import { createDecayWatch } from '@world/buildings/decayWatch';
import { focusCameFromKeyboard, trackFocusModality } from '@ui/chrome';
import { roadSwatch } from '@ui/roadSwatch';
import { mountShell, type ShellHandle, type ShellRoadClass, type ShellSlider, type ShellStatus, type ShellZonePatch } from '@ui/v2/shell';
import { formatCost } from '@ui/roads/money';
import { type BuildMode, buildRuns } from '@world/roads/buildMode';
import { profileRoad } from '@world/roads/profile';
import { mountAbout, openAbout } from '@ui/about';
import { applyTranslations, formatDecimal, initLanguage, onLanguageChange, setGlobalParams, t } from '@ui/i18n';
import { onRoadKeysChange, roadKeyAction, roadKeyParams } from '@ui/roads/keys';
import {
  peopleCountLabel,
  roadTypeDescription,
  roadTypeName,
  vehicleCountLabel,
} from '@ui/labels';
import { QUALITY_LEVELS, isQualityLevel, type QualityLevel } from '@render/quality';
import { createBuildingWiring } from './buildingsWiring';
import { levelElevation, roofRise } from '@world/buildings/geometry';
import { volumeTop } from '@world/buildings/types';
import { type ZoneUse, type ZoneDensity } from '@world/zones';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';
import { bulbClearing } from '@world/junction/bulb';

import { createToolMachine, isTool, type Tool } from '@editor/toolMachine';
import { createGameKeys } from '@editor/gameKeys';
import { RoadTop } from '@editor/roadTop';
import { editRandom } from '@editor/editStream';

/** The turning circles cleared after each edit, from the network's changes since the last one (`bulbClearing`). */
const clearBulbs = bulbClearing();

type Alignment = 'straight' | 'curve' | 'free';

// The interface language is resolved and applied BEFORE anything reads a label
setGlobalParams(roadKeyParams);
initLanguage();

const canvas = document.getElementById('game') as HTMLCanvasElement;

/** The game's health (`core/health.ts`): what broke and what was slow, with what the player was doing. */
const health = new HealthLog();
const frameTimer = new FrameTimer();
const healthWatch = watchHealth({
  log: health,
  frames: frameTimer,
  canvas,
  context: () => {
    const last = doc.changes.latest(1)[0];
    // Shown to the player in the F9 monitor: every word from the dictionaries; the gestures are dictionary keys
    return [
      t('health.context.tool', { tool: game.tool }),
      game.gesture ? t(game.gesture) : '',
      last ? t('health.context.lastChange', { serial: last.serial, kind: last.kind, cause: last.cause }) : '',
      booted ? '' : t('health.context.opening'),
    ].filter(Boolean).join(' · ');
  },
});

const doc = new RoadDoc();
// A new map is a level plain (the player, 2026-10-09); a saved one keeps its own (restored below).
const NEW_RELIEF = RELIEF_FLAT;
doc.terrainRelief = NEW_RELIEF;
/** A new map's ecosystem: the default biome, its patches laid by a seed of its own. */
const newNature = (region = DEFAULT_REGION): NatureSettings => ({ region, seed: Math.floor(Math.random() * 1_000_000_000) });
doc.nature = newNature();
const net = new Network(doc);
const camera = new Camera();
/** Whether the whole module has run. */
let booted = false;
const surface = new CanvasSurface(canvas, () => { if (booted) requestDraw(); });
const history = new History();
const persistence = new Persistence();

surface.observe();

// ------------------------------------------------------------------ boot
const surfaceBake = startSurfaceBake();
/** The simulation's seed: the same town plays out the same way. */
const SIM_SEED = 0x2024;
/** The conflict zones measured in earlier sessions */
const ZONES_PREFIX = typeof __CONFLICT_ZONES_HASH__ !== 'undefined' && __CONFLICT_ZONES_HASH__ ? `zones:${__CONFLICT_ZONES_HASH__}:` : null;
if (ZONES_PREFIX) forgetOtherDerived('zones', ZONES_PREFIX.slice('zones:'.length, -1));
const keptZones = ZONES_PREFIX ? readDerivedAll<Float64Array | null>(ZONES_PREFIX) : Promise.resolve(new Map<string, Float64Array | null>());
clearOldMapsOnce();
// The autosave: the small key, or IndexedDB for a map too large for it (`Persistence.loadSessionAsync`)
const savedSession = await persistence.loadSessionAsync();
// The game opens on an empty map - zoning starts from nothing - unless the player has a map of their own.
const saved = savedSession?.document && !isUntouchedStarter(savedSession.document)
  ? savedSession.document
  : null;

/** The cities saved before 2026-10-04 (the shipped town, the player's own maps, the copies set aside) are removed, once */
function clearOldMapsOnce(): void {
  const MARK = 'roadcraft.mapsCleared';
  try {
    if (window.localStorage.getItem(MARK) === '2026-10-04') return;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith('roadcraft.world') || key === 'roadcraft.oldTownBackup' || key === 'roadcraft.townVersion')) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
    window.localStorage.setItem(MARK, '2026-10-04');
  } catch {
    // Storage blocked: nothing was kept to clear.
  }
}
// A saved map that validates and still fails to load must not take the game down with it - on every reload.
let bootFailed = false;
if (saved) {
  try {
    doc.changes.causeNext('saved map loaded');
    restoreInto(doc, saved, net);
    doc.changes.causeNext('jogo');
    // Opened from the map's parts: those parts are this document, the next save writes only what changes.
    persistence.adoptLoaded(doc);
  } catch (error) {
    console.error('The saved map could not be loaded; it was set aside.', error);
    persistence.quarantineStored();
    const fresh = new RoadDoc();
    fresh.terrainRelief = NEW_RELIEF;
    fresh.nature = null;
    doc.replaceWith(fresh);
    net.rebuild();
    bootFailed = true;
  }
}

const engineFlags = new URLSearchParams(location.search);
/** The simulation as the page holds it (`sim/host.ts`): what it draws of it (`shown`), asks of it and does to it. */
const simHost: SimHost = await startSimulation({
  paused: savedSession?.settings.paused === true,
  speed: savedSession?.settings.speed ?? 1,
  trafficIntensity: savedSession?.settings.trafficIntensity ?? 1,
  pedestrianIntensity: savedSession?.settings.pedestrianIntensity ?? 1,
  demandMultiplier: savedSession?.settings.demandMultiplier ?? 1,
}, engineFlags.get('ambient') === 'view' ? 'view' : 'edges');
const shown = simHost.shown;

/** The simulation in its worker (`simWorkerHost.ts`); on the page only when asked (`?sim=page`, probes that read the world). */
async function startSimulation(settings: SimSettings, ambientSource: 'view' | 'edges'): Promise<SimHost> {
  if (engineFlags.get('sim') !== 'page') return new WorkerSimHost(doc, { seed: SIM_SEED, settings, ambientSource, zonesPrefix: ZONES_PREFIX }, () => requestDraw());
  const sim = new SimWorld(doc, net, SIM_SEED);
  // The lots' bays worked out on the other cores (`bayPool.ts`)
  useBayWorkers(sim, new BayPool());
  sim.auditEnabled = true;
  sim.auditLevel = 'cheap';
  // The status bar's alerts: checked once a second of play, not on every one of its sixty ticks
  sim.auditEvery = 60;
  sim.usePedestrianEngine((await import('@sim/agents/walk')).createAgentWalkEngine());
  // The scenery's life (`sim/ambient`): nobody lives here
  sim.ambient.enabled = true;
  sim.ambient.source = ambientSource;
  return new PageSimHost(net, sim, new ConflictPool(ZONES_PREFIX), settings);
}
/** The share of the population the screen allows (`sim/populationGovernor.ts`): a narrow one carries fewer. */
const screenShare = (): number => (window.innerWidth < NARROW_SCREEN_WIDTH ? NARROW_SCREEN_SHARE : 1);

/** The zoom range the renderer we are about to boot can actually represent. */
function bootZoomBounds(): { min: number; max: number } {
  return isoZoomBounds(Math.max(1, canvas.clientHeight || window.innerHeight));
}

if (savedSession && saved) {
  camera.x = savedSession.settings.camera.x;
  camera.y = savedSession.settings.camera.y;
  // Clamped against the ACTIVE renderer's range, not always the flat camera's.
  const limits = bootZoomBounds();
  camera.zoom = clamp(savedSession.settings.camera.zoom, limits.min, limits.max);
} else {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
}

/** Whether an autosave is exactly one of the starter scenarios an earlier build seeded, never edited. */
function isUntouchedStarter(saved: ReturnType<RoadDoc['toJSON']>): boolean {
  // Declared here, not at module level: boot calls this before any `const` below it is initialised.
  const OLD_STARTERS: readonly { readonly segments: number; readonly nodes: ReadonlySet<string> }[] = [
    // A 3x3 grid with four approach stubs.
    {
      segments: 16,
      nodes: new Set([
        ...[-360, 0, 360].flatMap((x) => [-260, 0, 260].map((y) => `${x},${y}`)),
        '0,-480', '0,480', '-580,0', '580,0',
      ]),
    },
    // An avenue crossed at a signalised crossroads, with a local street at a T.
    {
      segments: 6,
      nodes: new Set(['-560,0', '0,0', '330,0', '600,0', '0,-430', '0,430', '330,360']),
    },
  ];
  const nodes = saved.nodes ?? [];
  const segments = saved.segments ?? [];
  if ((saved.terrain ?? []).length > 0 || (saved.poles ?? []).length > 0 ||
    (saved.buildings ?? []).length > 0) return false;
  return OLD_STARTERS.some((starter) =>
    nodes.length === starter.nodes.size && segments.length === starter.segments &&
    nodes.every((n) => starter.nodes.has(`${n.x},${n.y}`)));
}

function worldBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes.values()) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  if (!Number.isFinite(minX)) return { minX: -m(80), minY: -m(80), maxX: m(80), maxY: m(80) };
  return { minX, minY, maxX, maxY };
}

// ------------------------------------------------------------------ state The tool in hand, the pause
/** The terrain brush: a land stamp (`TerrainMode`), or painting the ground (`terrainPaint.ts`). */
type BrushMode = TerrainMode | 'paint' | 'fog' | 'cloud' | 'elements' | 'gully' | 'trees' | 'weather' | Landform;
/** The landforms: a shape and its ROCK in one tool */
type Landform = 'mesa' | 'canyon' | 'escarpment' | 'sugarloaf';
const LANDFORMS: Readonly<Record<Landform, { readonly mode: 'raise' | 'lower'; readonly rock: GeologyKind; readonly hardness: number; readonly profile?: 'dome' }>> = {
  mesa: { mode: 'raise', rock: 'sandstone', hardness: 85 },
  canyon: { mode: 'lower', rock: 'sandstone', hardness: 80 },
  escarpment: { mode: 'raise', rock: 'basalt', hardness: 75 },
  sugarloaf: { mode: 'raise', rock: 'granite', hardness: 0, profile: 'dome' },
};
const landformOf = (mode: BrushMode): (typeof LANDFORMS)[Landform] | undefined => (LANDFORMS as Partial<Record<BrushMode, (typeof LANDFORMS)[Landform]>>)[mode];
const hardnessByMode: Partial<Record<BrushMode, number>> = { raise: 0, lower: 0, mesa: 85, canyon: 80, escarpment: 75 };
/** The game's state - the tool in hand, the pause and speed, the quality, the selection */
const gameState = new GameState({
  tool: 'inspect' as Tool,
  paused: simHost.settings.paused,
  speed: simHost.settings.speed,
  quality: 'high' as string,
  selectedSegment: null as SegmentId | null,
  selectedSegmentS: null as number | null,
  selectedNode: null as NodeId | null,
  // The road tool: class, plan, height above the ground, lanes.
  roadTypeIndex: 1,
  alignment: 'straight' as Alignment,
  roadHeightOffset: 0,
  roadLanePreset: null as number | null,
  roundaboutRadius: 100,
  // The terrain brush.
  terrainMode: 'raise' as BrushMode,
  terrainRadius: 80,
  terrainStrength: 24,
  terrainHardness: 0,
  // Walls, zones and lots.
  barrierKind: 'fence' as BarrierKind,
  zoneUse: 'residential' as ZoneUse,
  zoneDensity: 'low' as ZoneDensity,
  zoneEraser: false,
  zoneMode: 'brush' as ZoneMode,
  lotSplitKind: 'vertical' as LotSplitKind,
  lotSplitParts: 2,
  // The view.
  congestionOverlay: savedSession?.settings.congestionOverlay ?? false,
  perspective: false,
  /** What the player is in the middle of doing (`currentGesture`), null between gestures. */
  gesture: null as string | null,
  // The history, the sky and the road inspector, as the interface shows them.
  canUndo: false,
  canRedo: false,
  sky: 'day' as SkyMode,
  inspectorOpen: false,
}, () => { if (booted) requestDraw(); });
/** The game's state, read-only: `game.tool`, `game.paused`, `game.selectedSegment`... */
const game = gameState.values;
/** The tool in hand (`editor/toolMachine.ts`): the only way it changes. */
const tools = createToolMachine(game.tool, {
  take: takeTool,
  letGo: () => { if (game.selectedSegment !== null || game.selectedNode !== null) closeInspectorPanel(); },
});
/** The gully brush's strength, % (Paisagem > Relevo > Ravinas). */
let gullyStrength = 60;
/** How many clouds "spread over the sky" lays, and how much they vary, %. */
const cloudScatter = { count: 8, variation: 40 };

function sessionSettings(): SavedSettings {
  const centre = view.centre;
  return {
    camera: { x: centre.x, y: centre.y, zoom: view.zoom, azimuth: view.azimuth, elevation: view.elevation },
    ...simHost.settings,
    congestionOverlay: game.congestionOverlay,
  };
}

/** The road tool (`editor/roadTool.ts`): the stroke, the chain, the curve waiting for its bend, the road settling. */
const roadTool = new RoadTool({
  doc,
  net,
  zoom: () => view.zoom,
  px: (n) => camera.px(n),
  settings: () => ({
    typeIndex: game.roadTypeIndex, lanes: game.roadLanePreset, alignment: game.alignment,
    heightOffset: game.roadHeightOffset, parking: roadParking(), width: roadWidth(), grid: roadGridShown(),
    // The profile chosen in the profile editor for new roads.
    profile: drawProfile(),
    cutWalls: cutWallsChosen(),
    furniture: furnitureChosen(),
  }),
  setHeight: (value, cause) => gameState.set('roadHeightOffset', value, cause),
  worldAtScreen: (px, py, height) => worldAtScreen(px, py, height),
  naturalHeightAt: (x, y) => scene.builtGroundAt(x, y),
  offerElevation: (solution, revision) => scene.offerElevation(solution, revision),
  // The renderer's last solve while the land is the one it was solved on: the tunnel test starts from it.
  groundSolve: () => {
    const solved = scene.roadsSolve();
    return solved && solved.terrainRevision === doc.terrainRevision ? solved.elevation : null;
  },
  flash: (ids) => scene.flashRoads(ids),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The pole tool (`editor/poles.ts`): the stretch being dragged and the line's last pole. */
const poleTool = new PoleTool({
  doc,
  net,
  zoom: () => view.zoom,
  mode: () => poleToolMode(),
  lamps: () => poleLampMode(),
  inHand: () => game.tool === 'pole',
  mutate: (fn) => mutateBuilt(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The pole run planned for this frame (`PoleTool.plan`), shared by the 3D preview and the overlay. */
let framePolePlan: PoleRunPlan | null = null;
/** The landscaping tool (`editor/streetscapeTool.ts`): items on the footways. */
const streetscapeTool = new StreetscapeTool({
  doc,
  net,
  zoom: () => view.zoom,
  kind: () => streetscapeKind(),
  extra: (kind) => kind === 'sign' ? { signType: signChoice.type, text: signChoice.text }
    : kind === 'streetname' ? { text: signChoice.streetName }
    : kind === 'tree' || kind === 'shrub' ? { planted: simHost.minutes } : {},
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The walls tool (`editor/barriers.ts`): the wall, fence or hedge being traced. */
const barrierTool = new BarrierTool({
  net: () => net,
  kind: () => game.barrierKind,
  removeAt: (at) => {
    // The runs round the point only (`RoadDoc.barrierNear`), not every wall of the map.
    const hit = doc.barrierNear(at, BARRIER_PICK_PIXELS / view.zoom);
    if (!hit) return false;
    mutate(() => doc.removeBarrier(hit.id));
    return true;
  },
  build: (kind, path) => mutate(() => doc.addBarrier(kind, path) !== null),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The Zoning tool (`editor/lotTool.ts`): the lots the player draws, edits and zones, with its gestures' own state. */
const lotTool = new LotTool({
  doc,
  net,
  zoom: () => view.zoom,
  settings: () => ({
    mode: game.zoneMode, use: game.zoneUse, density: game.zoneDensity, eraser: game.zoneEraser,
    splitKind: game.lotSplitKind, splitParts: game.lotSplitParts,
  }),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
let hoverAnchor: Anchor | null = null;
/** What is selected - a road (and where along it) or a junction - written through the game's state with why (`gameState`). */
function select(segment: SegmentId | null, s: number | null, node: NodeId | null, cause: string): void {
  gameState.set('selectedSegment', segment, cause);
  gameState.set('selectedSegmentS', s, cause);
  gameState.set('selectedNode', node, cause);
}

/** The camera moved by hand: the pointers, a pan, an orbit, a pinch (`view/cameraGestures.ts`). */
const cameraHand = new CameraGestures({
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  orbited: () => persistence.saveSettingsSoon(sessionSettings),
  redraw: () => requestDraw(),
  heightUnder: (at) => groundHeightUnder(at),
});
/** Camera turn per press of the camera panel's buttons, rad. */
const KEY_TURN = Math.PI / 12;
/** The keys held and the wheel's notches, spent as a glide frame by frame (`view/cameraMotion.ts`). */
const cameraMotion = new CameraMotion({
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  heightUnder: (at) => groundHeightUnder(at),
});
/** The Move tool's node drag (`editor/nodeMover.ts`), previewed live and dropped as one undo step. */
const mover = new NodeMover({
  doc,
  net,
  settleTopology: () => {
    simHost.settle();
  },
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
/** The terrain brush (`editor/terrainBrush.ts`): the stroke in progress and what each dab does. */
const terrainBrush = new TerrainBrush({
  doc,
  settings: () => dabSettings(),
  heightAt: (at) => sceneHeightAt(at),
  // The cost-aware rate limit: every dab that moves the land re-solves the roads on it
  interval: (stroking) => Math.max(TERRAIN_MIN_MS, (stroking ? scene.stats.terrainMs : scene.stats.rebuildMs) * 1.4),
  record: () => { history.begin(doc); updateHistoryButtons(); },
  redraw: () => requestDraw(),
});
/** The brush in hand, as one dab reads it (`editor/terrainBrush.ts` `DabSettings`). */
function dabSettings(): DabSettings {
  const fog = fogBrush();
  return {
    mode: game.terrainMode,
    radius: game.terrainRadius,
    strength: game.terrainStrength,
    hardness: game.terrainHardness,
    landform: landformOf(game.terrainMode),
    element: { mode: elementMode(), kind: elementKind(), brush: elementBrush(elementKind()) },
    tree: { mode: treeMode(), kind: treeKind(), brush: treeBrush() },
    gully: { strength: gullyStrength, erase: gullyErase() },
    fog: { strength: fog.strength, height: fog.height, speed: fog.speed, erase: fogErase() },
    paint: paintKind(),
  };
}
canvas.dataset['tool'] = game.tool;

let view: Viewport = flatViewport(camera);


/** The editor's overlay gets its OWN canvas, and must. */
const overlayCanvas = document.createElement('canvas');
let overlayCtx: CanvasRenderingContext2D | null = null;
let previewAsphaltPattern: CanvasPattern | null = null;

/** Asphalt grain used by the live 3D-editor preview. */
function asphaltPreviewPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (previewAsphaltPattern) return previewAsphaltPattern;
  const tile = document.createElement('canvas');
  tile.width = 48;
  tile.height = 48;
  const paint = tile.getContext('2d');
  if (!paint) return '#45494b';
  paint.fillStyle = '#505456';
  paint.fillRect(0, 0, tile.width, tile.height);
  let state = 0x6d2b79f5;
  for (let i = 0; i < 150; i++) {
    state = (Math.imul(state ^ (state >>> 15), 2246822519) + 3266489917) >>> 0;
    const x = state % tile.width;
    const y = (state >>> 8) % tile.height;
    paint.globalAlpha = 0.08 + ((state >>> 17) & 15) / 100;
    paint.fillStyle = (state & 1) === 0 ? '#171a1b' : '#a4a6a3';
    paint.fillRect(x, y, 1 + ((state >>> 24) & 1), 1);
  }
  paint.globalAlpha = 1;
  previewAsphaltPattern = ctx.createPattern(tile, 'repeat');
  return previewAsphaltPattern ?? '#45494b';
}

const canvas3d = document.createElement('canvas');
canvas3d.id = 'game-scene';
canvas3d.setAttribute('aria-hidden', 'true');
canvas3d.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
canvas.parentElement?.insertBefore(canvas3d, canvas);
/** The quality the player last chose, or High: a level, never "automatic". */
function savedQualityLevel(): QualityLevel {
  try {
    const saved = window.localStorage.getItem('roadcraft.quality');
    return isQualityLevel(saved) ? saved : 'high';
  } catch {
    return 'high';
  }
}

// The graphics are what the player chose (High until they choose): the game never lowers them on its own.
primeSurfaceBake(await surfaceBake);
simHost.seedZones(await keptZones);
/** The engine that brings every derived product up to date, its ledger the work each did (`core/engine.ts`). */
const engine = new Engine();
const scene: SceneHandle = createSceneRenderer(canvas3d, { x: camera.x, y: camera.y }, camera.zoom, savedQualityLevel(), requestDraw, engine);
// The surgical profiler (`core/profiler.ts`)
const profileFrameEnd = wireProfiler();
function wireProfiler(): () => void {
  engine.watch(() => doc.changes.version);
  /** The hooks into three and WebGL and the observers, while the HUD is shown; null hidden: nothing of it runs then. */
  let attached: { readonly unhook: () => void; readonly observers: readonly PerformanceObserver[] } | null = null;
  /** The diary's serial the profiler last read: each frame tells it the changes since. */
  let profiledSerial = doc.changes.version;
  const shown = (on: boolean): void => {
    if (on === (attached !== null)) return;
    if (!on) {
      attached!.unhook();
      for (const observer of attached!.observers) observer.disconnect();
      engine.onRefresh = null;
      attached = null;
      return;
    }
    engine.onRefresh = (name, phase, ms, keys, idle) => profiler.product({ name, phase, ms, keys, idle });
    const observers: PerformanceObserver[] = [];
    const supported = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes : [];
    if (supported.includes('longtask')) {
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) profiler.longTask(entry.duration); });
      observer.observe({ type: 'longtask', buffered: false });
      observers.push(observer);
    }
    if (supported.includes('measure')) {
      const observer = new PerformanceObserver((list) => {
        for (const m of list.getEntries()) if (m.name.startsWith('hitch:')) profiler.step(`passo ${m.name.slice(6)}`, m.duration);
      });
      observer.observe({ type: 'measure', buffered: false });
      observers.push(observer);
    }
    profiledSerial = doc.changes.version;
    attached = { unhook: hookProfiler(scene.gl), observers };
  };
  mountProfilerHud(profiler, { visible: import.meta.env.DEV, shown });
  return (): void => {
    if (!attached) return;
    const serial = doc.changes.version;
    if (serial > profiledSerial) {
      for (const c of doc.changes.latest(Math.min(serial - profiledSerial, 64))) profiler.change({ kind: c.kind, cause: c.cause, ids: c.ids?.length ?? 0 });
    }
    profiledSerial = serial;
    profiler.heap((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize);
    profiler.gauges.set('drawCalls', scene.stats.drawCalls);
    profiler.gauges.set('gpuGeometries', scene.gl.info.memory.geometries);
    profiler.gauges.set('gpuTextures', scene.gl.info.memory.textures);
    profiler.endFrame();
  };
}

// The traffic's topology is not built here: it is built a slice a frame while the opening puts the town together
view = scene.viewport;
restoreOrbit(savedSession?.settings.camera);
canvas.style.opacity = '0';
// No loading screen (player, 2026-10-02): the town plays at once and each person appears as their body is ready

overlayCanvas.id = 'game-overlay';
overlayCanvas.setAttribute('aria-hidden', 'true');
overlayCanvas.style.cssText =
  'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
canvas.parentElement?.appendChild(overlayCanvas);
overlayCtx = overlayCanvas.getContext('2d');

window.addEventListener('resize', () => { scene.resize(); }, { passive: true });
canvas.dataset['render'] = 'webgl';

// Modular buildings
const buildings = createBuildingWiring({
  doc,
  net,
  history,
  scene,
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  undo: () => undo(),
  redo: () => redo(),
  focusBuilding(building) {
    const ground = building.volumes.filter((v) => v.base === 0);
    if (ground.length === 0) return;
    const cx = (Math.min(...ground.map((v) => v.x)) + Math.max(...ground.map((v) => v.x + v.w))) / 2;
    const cy = (Math.min(...ground.map((v) => v.y)) + Math.max(...ground.map((v) => v.y + v.d))) / 2;
    const c = Math.cos(building.rotation), s = Math.sin(building.rotation);
    const centre = { x: building.x + cx * c - cy * s, y: building.y + cx * s + cy * c };
    view.moveTo(centre);
    const span = Math.max(...ground.map((v) => Math.max(v.w, v.d)));
    const paletteWidth = document.getElementById('builder')?.getBoundingClientRect().width ?? 0;
    const available = Math.max(110, surface.cssW - paletteWidth - (surface.cssW < 600 ? 20 : 110));
      const corners = building.volumes.flatMap((v) => [
        [v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d],
      ] as const).map(([x, y]) => view.toScreen({ x: building.x + x * c - y * s, y: building.y + x * s + y * c }, surface.cssW, surface.cssH));
      const projectedWidth = Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x));
      const top = Math.max(...building.volumes.map((v) => levelElevation(building, volumeTop(v)) + roofRise(building, v)
        + Math.max(0, ...(v.roofDetails ?? []).map((detail) => detail.h ?? 0))));
      const projectedRise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      const projectedFootprint = Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y));
      const fit = Math.min(view.zoom * (available * .72) / Math.max(1, projectedWidth),
        view.zoom * (surface.cssH - 145) * .88 / Math.max(1, projectedRise + projectedFootprint));
    const ideal = Math.min(surface.cssW < 600 ? 3.2 : 7, Math.max(2.6, (surface.cssW < 600 ? 135 : 210) / span));
    const target = Math.max(view.zoomBounds.min, Math.min(view.zoomBounds.max, ideal, fit));
    view.zoomAt(surface.cssW / 2, surface.cssH / 2, target / view.zoom, surface.cssW, surface.cssH);
      const rise = Math.abs(view.toScreen(centre, surface.cssW, surface.cssH, top).y
        - view.toScreen(centre, surface.cssW, surface.cssH).y);
      view.panTo(centre, (surface.cssW - paletteWidth) / 2, surface.cssH / 2 + rise / 2 - 68, surface.cssW, surface.cssH);
  },
  afterEdit() {
    persistence.saveSessionSoon(doc, sessionSettings);
    updateHistoryButtons();
    requestDraw();
  },
  requestDraw: () => requestDraw(),
  flash: (key, params) => flashHint(key, params),
  hintChanged: () => updateHint(),
});
/** Puts the camera back at a saved bearing and tilt; a save without one gets the default view. */
function restoreOrbit(saved: SavedSettings['camera'] | undefined): void {
  view.setOrbit(saved?.azimuth ?? DEFAULT_AZIMUTH, saved?.elevation ?? DEFAULT_ELEVATION);
}

function syncViewFromFlatCamera(): void {
  view.moveTo({ x: camera.x, y: camera.y });
  view.zoomAt(
    surface.cssW / 2,
    surface.cssH / 2,
    camera.zoom / Math.max(0.001, view.zoom),
    surface.cssW,
    surface.cssH,
  );
}

function fitView(): void {
  camera.fit(worldBounds(), surface.cssW, surface.cssH);
  syncViewFromFlatCamera();
}

function syncFlatCameraFromView(): void {
  if (view.kind === '2d') return;
  const centre = view.centre;
  camera.x = centre.x;
  camera.y = centre.y;
  camera.zoom = view.zoom;
}

// ------------------------------------------------------------- mutations
function mutate(fn: () => boolean): void {
  mutateBuilt(fn);
}

/** A road edit made in place a split, a class, lanes, parking, a section, a direction, a bend, a join, a copy, a node's */
function mutateRoads(fn: () => boolean): boolean {
  let refused = null as RoadEditRefusal | null;
  const changed = mutateBuilt(() => {
    const result = guardRoadEdit(doc, net, fn);
    refused = result.refused;
    return result.changed;
  });
  if (refused) flashHint(`hint.rule.${refused}`);
  return changed;
}

/** The public transport tool (`editor/transitTools.ts`): each edit one undo step. */
const transitEditor = new TransitTool({
  doc: () => doc,
  net: () => net,
  edit: (next) => mutate(() => { doc.setTransit(next); return true; }),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});
setTransitTool(transitEditor);

/** The document as text for the autosave, kept while nothing in it has moved */
let docText: { key: string; text: string } | null = null;
function serializedDoc(): string {
  // Keyed by the diary, every kind of change to the document (`DOC_CHANGE_KINDS`).
  const key = `${doc.changes.serialOf(...DOC_CHANGE_KINDS)}:${doc.buildings.revision}:${doc.buildings.size}`;
  if (docText?.key === key) return docText.text;
  const text = serialize(doc);
  docText = { key, text };
  return text;
}

persistence.documentText = (d) => (d === doc ? serializedDoc() : null);

function mutateBuilt(fn: () => boolean): boolean {
  const mutateAt = performance.now();
  history.begin(doc);
  performance.measure('hitch:mutate/before', { start: mutateAt, end: performance.now() });
  // What the diary says this edit came from (`world/changes.ts`).
  doc.changes.causeNext(`tool ${game.tool}`);
  const changed = fn();
  if (changed) {
    // DO NOT move these below `history.end`.
    if (net.revision !== doc.revision) net.rebuild();
    // A road over a building demolishes it (where the network changed only).
    buildings.afterRoadEdit();
    // And nothing stands in a turning circle's carriageway (V8): what stood on a road end's footway goes.
    clearBulbs(doc, net);
  }
  doc.changes.causeNext('jogo');
  // An edit that reports success without changing anything
  const recorded = history.end(doc);
  if (!changed || !recorded) return false;
  performance.measure('hitch:mutate/edit+after', { start: mutateAt, end: performance.now() });
  // The simulation catches up in the frame AFTER the one that draws the edit
  topologyAfterDraw = topologyAfterDraw || simHost.behind(net.trafficRevision);
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  refreshInspector();
  requestDraw();
  performance.measure('hitch:mutate/after edit', { start: mutateAt, end: performance.now() });
  return true;
}

/** `snapshot`: the model's own undo/redo state, restored exactly. */
function applySnapshot(data: ReturnType<RoadDoc['toJSON']> | null, source: 'snapshot' | 'import' = 'snapshot'): void {
  if (!data) return;
  roadTool.cancel();
  if (source === 'import') {
    caused('map opened', () => restoreInto(doc, data, net));
    // A different map: nothing of the old simulation may carry over.
    simHost.reset();
  } else {
    restoreSnapshot(doc, data, net);
  }
  // A map opened: its traffic built now, the old simulation gone.
  if (source === 'import') scene.beginLoad();
  buildings.restored();
  select(null, game.selectedSegmentS, null, 'another map');
  closeInspector();
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  requestDraw();
}

// ---------------------------------------------------------------- input
/** The one conversion that differs between renderers. */
/** The world point under a screen position, ON THE SURFACE THAT IS THERE. */
function worldAtScreen(px: number, py: number, heightOffset?: number): Vec2 {
  let point = view.toWorld(px, py, surface.cssW, surface.cssH);
  if (view.kind === '2d') return point;
  if (heightOffset === undefined) return firstSurfaceAt(px, py) ?? point;
  let height = 0;
  for (let pass = 0; pass < 3; pass++) {
    const next = scene.terrainHeightAt(point.x, point.y) + heightOffset;
    if (Math.abs(next - height) < 0.05) break;
    height = next;
    point = view.toWorldAt(px, py, height, surface.cssW, surface.cssH);
  }
  return point;
}

/** The height of what is drawn under a screen point */
function groundHeightUnder(at: Vec2): number {
  const point = (h: number): Vec2 => view.toWorldAt(at.x, at.y, h, surface.cssW, surface.cssH);
  const below = (h: number): boolean => { const p = point(h); return scene.surfaceHeightAt(p.x, p.y) >= h; };
  let above = Math.min(600, surfaceTop());
  for (let h = above - 8; h >= -360; h -= 8) {
    if (!below(h)) { above = h; continue; }
    let lo = h;
    for (let i = 0; i < 14; i++) { const mid = (lo + above) / 2; if (below(mid)) lo = mid; else above = mid; }
    return lo;
  }
  return 0;
}

/** Whatever the player can see at a world point: a road deck, or the ground. */
function sceneHeightAt(p: Vec2): number {
  return scene.surfaceHeightAt(p.x, p.y);
}

/** Highest surface the pick looks for; step of the march down the ray. */
const PICK_TOP = m(64);
const PICK_STEP = m(0.8);

/** DO NOT walk `doc.nodes` here on each road edit: `RoadTop` reads only the cells the edit reached. */
const roadTop = new RoadTop(doc, net, (x, y) => scene.elevationAt(x, y));
function surfaceTop(): number {
  // The land as drawn (`SceneHandle.landTop`, read again by the renderer when it rewrites the ground)
  const top = Math.max(scene.landTop(), roadTop.height());
  return Number.isFinite(top) ? top + 12 : PICK_TOP;
}

/** Where the ray under the cursor first meets what is drawn - a deck, or the ground - marched down from above. */
function firstSurfaceAt(px: number, py: number): Vec2 | null {
  const at = (h: number): Vec2 => view.toWorldAt(px, py, h, surface.cssW, surface.cssH);
  const below = (h: number): boolean => {
    const p = at(h);
    return scene.surfaceHeightAt(p.x, p.y) >= h;
  };
  let above = Math.min(PICK_TOP, surfaceTop());
  for (let h = above - PICK_STEP; h >= -PICK_TOP; h -= PICK_STEP) {
    if (!below(h)) { above = h; continue; }
    let lo = h;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + above) / 2;
      if (below(mid)) lo = mid; else above = mid;
    }
    return at(lo);
  }
  return null;
}

/** `rect`: the canvas's box when the caller has already read it for this event (a layout read each). */
function pointerWorld(e: PointerEvent, rect?: DOMRect): Vec2 {
  const r = rect ?? canvas.getBoundingClientRect();
  const authoredHeight = game.tool === 'road' && roadTool.inProgress()
    ? game.roadHeightOffset
    : undefined;
  return worldAtScreen(e.clientX - r.left, e.clientY - r.top, authoredHeight);
}

/** Every position a move went through since the last event, CSS px of the canvas, at its own time stamp */
function coalescedPath(e: PointerEvent, r: DOMRect): PointerSample[] | undefined {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length > 0 ? list.map((c) => ({ x: c.clientX - r.left, y: c.clientY - r.top, t: c.timeStamp })) : undefined;
}


/** Ends every gesture in progress without committing it */
function cancelGestures(): void {
  roadTool.cancel();
  poleTool.cancel();
  barrierTool.cancel();
  // A lot being drawn, dragged, cut or bent, or the first lot of a join: dropped.
  lotTool.cancel();
  bulldozer.cancel();
  endTerrainStroke();
  cancelMove();
  cameraHand.cancel();
  if (game.tool === 'building') buildings.pointerUp(true);
  requestDraw();
}

/** The gesture in progress, named by its dictionary key */
function currentGesture(): string | null {
  const camera = cameraHand.gesture();
  if (camera) return camera;
  const movingNode = mover.gesture();
  if (movingNode) return movingNode;
  const road = roadTool.gesture();
  if (road) return road;
  if (terrainBrush.stroking) return 'gesture.terrain.stroke';
  const pole = poleTool.gesture();
  if (pole) return pole;
  const barrier = barrierTool.gesture();
  if (barrier) return barrier;
  const bulldozing = bulldozer.gesture();
  if (bulldozing) return bulldozing;
  const cloud = cloudTool.gesture();
  if (cloud) return cloud;
  return lotTool.gesture();
}
function syncGesture(): void {
  // Before the boot the file may not have run to the gestures' own variables.
  if (!booted) return;
  gameState.set('gesture', currentGesture(), `tool ${game.tool}`);
}
// After the event's own handlers: a task of its own, after the whole dispatch.
const syncGestureSoon = coalescedTask(syncGesture);
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'keyup'] as const) {
  window.addEventListener(type, syncGestureSoon, { capture: true, passive: true });
}
/** What the diary says a change came from (`world/changes.ts` `causeNext`) */
const NO_CAUSE = 'jogo';
for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'keydown'] as const) {
  window.addEventListener(type, () => {
    if (!booted) return;
    doc.changes.causeNext(`tool ${game.tool}${game.gesture ? `: ${game.gesture}` : ''}`);
    setTimeout(() => doc.changes.causeNext(NO_CAUSE), 0);
  }, { capture: true, passive: true });
}
/** Runs `fn` with the diary's cause set to `cause`, then puts the one before back. */
function caused<T>(cause: string, fn: () => T): T {
  const was = doc.changes.cause;
  doc.changes.causeNext(cause);
  try {
    return fn();
  } finally {
    doc.changes.causeNext(was);
  }
}

/** The bulldozer (`editor/bulldozer.ts`): a click removes what is under it, a box everything inside. */
const bulldozer = new Bulldozer({
  doc,
  net,
  bulldozeBuildingAt: (at) => buildings.bulldozeAt(at),
  poleReach: () => poleReach(),
  itemReach: () => streetscapeTool.reach(),
  mutate: (fn) => mutate(fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
});

/** Whether anything is being drawn or dragged right now. */
function gestureInProgress(): boolean {
  return roadTool.inProgress() || poleTool.inProgress() || terrainBrush.stroking || mover.dragging || lotTool.gesture() !== null || bulldozer.inProgress();
}

/** A press whose release will never arrive - the window lost focus, the pointer capture was taken */
function releaseHeld(): void {
  endTerrainStroke();
  cancelMove();
  cameraHand.releaseAll();
}

/** Cancels a node drag without leaving its live preview in the document. */
function cancelMove(): void {
  mover.cancel();
}


// THE CLOUD TOOL (Paisagem > Terreno > Nuvens)
const cloudTool = new CloudTool({
  doc,
  mode: () => cloudMode(),
  brush: () => cloudBrush(),
  drift: () => scene.cloudDrift(),
  rayAt: (px, py, height) => view.toWorldAt(px, py, height, surface.cssW, surface.cssH),
  record: () => history.begin(doc),
  changed: () => {
    updateHistoryButtons();
    persistence.saveSessionSoon(doc, sessionSettings);
    requestDraw();
  },
  hint: (key) => flashHint(key),
});
/** Ends the brush stroke (`TerrainBrush.end`), warning when the land's stamps near their cap. */
function endTerrainStroke(): void {
  const wasPainting = terrainBrush.end();
  // Past the cap the oldest sculpting is dropped to make room.
  if (wasPainting && doc.terrainStamps.length >= MAX_TERRAIN_STAMPS * 0.9) {
    flashHint(doc.terrainStamps.length >= MAX_TERRAIN_STAMPS ? 'hint.terrain.capReached' : 'hint.terrain.capNear');
  }
  // The roads were held for the stroke; this frame re-solves them.
  requestDraw();
}

// See inside a building by clicking it, with nothing in hand: two clicks open it (two on open ground close it)
/** The canvas's input, taken as the browser dispatches it and handled at the start of the next frame, in order */
type CanvasInput =
  | { readonly type: 'dblclick' | 'click'; readonly e: MouseEvent; readonly r: DOMRect }
  | { readonly type: 'down' | 'up' | 'cancel' | 'leave' | 'lost'; readonly e: PointerEvent; readonly r: DOMRect }
  | { readonly type: 'move'; readonly e: PointerEvent; readonly r: DOMRect; readonly path: PointerSample[] | undefined }
  | { readonly type: 'wheel'; readonly e: WheelEvent; readonly r: DOMRect };
const canvasInput = new InputQueue<CanvasInput>(() => requestDraw());
const take = (input: CanvasInput): void => canvasInput.push(input);

/** One input handled (`frame`, first thing). */
function handleInput(input: CanvasInput): void {
  switch (input.type) {
    case 'dblclick': return doubleClick(input.e, input.r);
    case 'click': return singleClick(input.e, input.r);
    case 'down': return pointerDown(input.e, input.r);
    case 'move': return pointerMove(input.e, input.r, input.path);
    case 'up': case 'cancel': return endPointer(input.e);
    case 'leave': return pointerLeft();
    case 'lost': return captureLost(input.e);
    case 'wheel': return wheel(input.e, input.r);
  }
}

canvas.addEventListener('dblclick', (e) => take({ type: 'dblclick', e, r: canvas.getBoundingClientRect() }));
canvas.addEventListener('click', (e) => take({ type: 'click', e, r: canvas.getBoundingClientRect() }));
canvas.addEventListener('pointerdown', (e) => {
  // The mouse's back and forward buttons are not a click
  if (e.pointerType === 'mouse' && e.button > 2) return;
  // Captured while dispatched: the capture is set only then.
  canvas.setPointerCapture(e.pointerId);
  take({ type: 'down', e, r: canvas.getBoundingClientRect() });
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  // The positions it went through read now: the list is the dispatch's.
  take({ type: 'move', e, r, path: coalescedPath(e, r) });
});
canvas.addEventListener('pointerup', (e) => take({ type: 'up', e, r: canvas.getBoundingClientRect() }));
canvas.addEventListener('pointercancel', (e) => take({ type: 'cancel', e, r: canvas.getBoundingClientRect() }));
canvas.addEventListener('pointerleave', (e) => take({ type: 'leave', e, r: canvas.getBoundingClientRect() }));
canvas.addEventListener('lostpointercapture', (e) => take({ type: 'lost', e, r: canvas.getBoundingClientRect() }));

function doubleClick(e: MouseEvent, r: DOMRect): void {
  // A double click ends a track or a line being laid (`pointerdown` carries no click count).
  if (game.tool === 'transit') { transitEditor.key('Enter'); return; }
  if (game.tool !== 'inspect') return;
  buildings.insideClick({ x: e.clientX - r.left, y: e.clientY - r.top }, true);
}
function singleClick(e: MouseEvent, r: DOMRect): void {
  if (game.tool !== 'inspect' || e.detail > 1) return;
  buildings.insideClick({ x: e.clientX - r.left, y: e.clientY - r.top }, false);
}
function pointerDown(e: PointerEvent, r: DOMRect): void {
  // The event's own time, as every time the camera's hand reads (`cameraGestures.ts`).
  cameraHand.press(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }, e.timeStamp);

  // A second finger promotes the gesture to pinch and cancels any draft.
  if (cameraHand.touches >= 2) {
    cancelGestures();
    cameraHand.startPinch();
    return;
  }

  // The mouse, as city builders have it: the right button dragged swings the camera round and over the centre of the view
  if (e.pointerType === 'mouse' && e.button === 2 && !e.shiftKey) {
    if (game.tool === 'building' && buildings.cancelOperation()) {
      requestDraw();
      return;
    }
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    // The camera turns about the ground under the pointer, at its own height.
    cameraHand.startOrbit(e.pointerId, at, gestureInProgress(), groundHeightUnder(at));
    return;
  }

  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    cameraHand.startPan(e.pointerId, at);
    return;
  }

  const world = pointerWorld(e);
  if (game.tool === 'road') roadTool.pointerAt({ x: e.clientX - r.left, y: e.clientY - r.top });
  // A curve waiting for its bend: this press sets it.
  if (game.tool === 'road' && roadTool.bend(world)) return;
  const anchor = findAnchor(doc, net, world, view.zoom);

  switch (game.tool) {
    case 'roundabout':
      if (freeRoadsEnabled()) {
        mutate(() => {
          const result = commitRoundabout(doc, net, world, game.roundaboutRadius, 0);
          if (!result.committed) flashHint(`hint.roundabout.${result.reason}`);
          return result.committed;
        });
      }
      break;
    case 'road':
      if (blockGridChoice.armed) {
        // Roads > Blocks at once: the whole grid, centred where the click lands.
        blockGridChoice.armed = false;
        let laid = 0;
        mutate(() => {
          laid = commitBlockGrid(doc, net, world, blockGridChoice, game.roadTypeIndex, game.roadLanePreset, roadParking());
          return laid > 0;
        });
        flashHint(laid > 0 ? 'hint.blocks.built' : 'hint.road.invalid');
        refreshShell();
        requestDraw();
        break;
      }
      roadTool.down(world, anchor);
      break;

    case 'terrain':
      if (game.terrainMode === 'cloud') cloudTool.down(e.pointerId, e.clientX - r.left, e.clientY - r.top);
      // The weather tool: a click calls a lightning bolt down there.
      else if (game.terrainMode === 'weather') scene.strikeAt(world.x, world.y);
      else terrainBrush.begin(e.pointerId, world);
      break;

    case 'building':
      buildings.pointerDown({ x: e.clientX - r.left, y: e.clientY - r.top }, world, e.shiftKey);
      break;

    case 'zone':
      lotTool.down(e.pointerId, world, e.shiftKey, e.detail);
      break;

    case 'transit':
      // Stops, tracks, stations, lines (`editor/transitTools.ts`).
      transitEditor.click(world, e.shiftKey, e.detail >= 2);
      break;

    case 'barrier':
      barrierTool.down(world, e.shiftKey, e.clientX, e.clientY, e.detail);
      break;

    case 'streetscape':
      streetscapeTool.down(world, e.shiftKey);
      break;

    case 'pole':
      // A stretch starts (at the line's last pole, if there is one); Shift-click or the Remove verb takes a pole away
      poleTool.down(world, e.shiftKey);
      break;

    case 'move':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        mover.grab(anchor.node);
      } else {
        cameraHand.startPan(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      }
      break;

    case 'split':
      if (
        anchor.kind === 'segment' &&
        anchor.segment !== undefined &&
        anchor.s !== undefined
      ) {
        let node: NodeId | null = null;
        if (!mutateRoads(() => {
          node = splitSegment(doc, net, anchor.segment as SegmentId, anchor.s as number, anchor.at);
          return node !== null;
        })) node = null;
        if (node !== null) {
          select(null, game.selectedSegmentS, node, 'road split');
          showInspector();
        }
      }
      break;

    case 'bulldoze':
      // The Actions' bomb and pistol: what they leave behind
      if (strikeChoice.mode === 'strike') {
        const sx = e.clientX - r.left, sy = e.clientY - r.top, at = { ...world };
        void scene.effects().then(() => actions.strikeAt(sx, sy, at));
        break;
      }
      if (strikeChoice.mode === 'shoot') {
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        void scene.effects().then(() => actions.shootAt(sx, sy));
        break;
      }
      // A click removes what is under it; a drag draws a box and removes everything inside it, as SimCity's bulldozer does
      bulldozer.down(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }, world, anchor);
      break;

    case 'upgrade':
      if (anchor.kind === 'segment' && anchor.segment !== undefined) {
        const id = anchor.segment;
        const seg = doc.segment(id);
        if (seg && seg.type < LAST_UPGRADE_CLASS) {
          mutateRoads(() => {
            doc.setSegmentType(id, seg.type + 1);
            return true;
          });
        }
      }
      break;

    case 'control':
      if (anchor.kind === 'node' && anchor.node !== undefined) {
        cycleNodeControl(anchor.node, e.shiftKey ? -1 : 1);
      } else {
        flashHint('hint.control.miss');
      }
      break;

    case 'inspect': {
      const box = canvas.getBoundingClientRect();
      // A click on a building is for seeing inside it
      const hitBuilding = buildings.tool.buildingAt({ x: e.clientX - box.left, y: e.clientY - box.top });
      if (hitBuilding !== null) {
        // Shift+click: maintenance - the building is renovated, as new.
        if (e.shiftKey) {
          const b = doc.buildings.get(hitBuilding as BuildingId);
          if (b) {
            mutate(() => { doc.buildings.put({ ...b, builtAt: simHost.minutes, decay: 0 }); return true; });
            flashHint('hint.building.renovated');
          }
        }
        break;
      }
    }
      select(anchor.kind === 'segment' ? (anchor.segment ?? null) : null,
        anchor.kind === 'segment' ? (anchor.s ?? null) : null,
        anchor.kind === 'node' ? (anchor.node ?? null) : null, 'inspection click');
      showInspector();
      break;
  }
  requestDraw();
}

window.addEventListener('blur', releaseHeld);
function captureLost(e: PointerEvent): void {
  // After an ordinary release the pointer is already gone from the map.
  if (cameraHand.has(e.pointerId)) releaseHeld();
}

function pointerMove(e: PointerEvent, r: DOMRect, path: PointerSample[] | undefined): void {
  // A mouse whose button is no longer down has ended its stroke, whether or not the release reached us.
  if (e.pointerType === 'mouse' && e.buttons === 0 && terrainBrush.stroking) endTerrainStroke();
  const screen: Vec2 = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (game.tool === 'road') roadTool.pointerAt(screen);
  // The pointer's look (`app.css`): a closed hand while it turns or drags the camera.
  const held = cameraHand.active ? 'held' : '';
  if (canvas.dataset['camera'] !== held) canvas.dataset['camera'] = held;
  // A pinch, an orbit or a pan takes the move first
  if (cameraHand.move(e.pointerId, screen, e.timeStamp, cameraHand.active ? path : undefined)) return;

  const world = pointerWorld(e, r);

  if (lotTool.move(e.pointerId, world)) return;
  if (bulldozer.move(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }, world)) return;
  if (game.tool === 'zone') {
    lotTool.hover = world;
    requestDraw();
  }

  // The curve's bend follows the pointer.
  if (game.tool === 'road' && roadTool.bending()) {
    roadTool.move(world);
    return;
  }

  if (game.tool === 'building') {
    buildings.pointerMove(screen, world, e.shiftKey);
    return;
  }

  // The stroke being drawn.
  if (roadTool.move(world)) return;

  if (game.tool === 'barrier') barrierTool.move(world);
  if (game.tool === 'transit') {
    transitEditor.move(world);
    requestDraw();
  }

  if (poleTool.move(world)) return;

  if (game.tool === 'streetscape') {
    streetscapeTool.move(world, (e.buttons & 1) === 1);
    return;
  }

  if (mover.move(world)) return;


  if (terrainBrush.pointer === e.pointerId) {
    terrainBrush.paint(world);
    return;
  }
  if (cloudTool.pointer === e.pointerId) {
    const rect = canvas.getBoundingClientRect();
    cloudTool.move(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  // The hover preview uses the same height-aware connection rule as the commit.
  const hovered = findAnchor(doc, net, world, view.zoom, undefined,
    game.tool === 'road' ? game.roadHeightOffset : undefined);
  if (game.tool === 'road') roadTool.hover(world);
  hoverAnchor = game.tool === 'terrain'
    ? { kind: 'free', at: world }
    : game.tool === 'road'
      ? anchorForHeight(doc, net, hovered, game.roadHeightOffset)
      : hovered;
  // A frame only where the hover is drawn
  if (HOVER_DRAWN.has(game.tool)) requestDraw();
}
/** The tools whose overlay follows the hover. */
const HOVER_DRAWN: ReadonlySet<string> = new Set(['road', 'roundabout', 'terrain', 'control', 'inspect']);

/** Pick radius for a pole, in world units at the current zoom (`PoleTool.reach`: one definition). */
function poleReach(): number {
  return poleTool.reach();
}

function endPointer(e: PointerEvent): void {
  const cancelled = e.type === 'pointercancel';
  const { wasPinching, clickCancels } = cameraHand.release(e.pointerId, e.timeStamp);
  // A right click that stayed a click cancels whatever is in progress.
  if (clickCancels && !cancelled) {
    cancelGestures();
    return;
  }
  if (terrainBrush.pointer === e.pointerId) endTerrainStroke();
  cloudTool.up(e.pointerId);
  if (game.tool === 'building') buildings.pointerUp(cancelled || wasPinching);
  bulldozer.up(e.pointerId, !cancelled && !wasPinching);
  lotTool.up(e.pointerId, !cancelled && !wasPinching);
  // The stroke let go: a click starts a chain, a curve waits for its bend, a drag is laid.
  roadTool.up(() => pointerWorld(e), !cancelled && !wasPinching);

  poleTool.up(!cancelled && !wasPinching);
  // A row of landscaping dragged out is laid (V7).
  if (game.tool === 'streetscape') {
    if (cancelled || wasPinching) streetscapeTool.row = null;
    else streetscapeTool.up();
  }

  // The node dropped: one undo step from where it started.
  mover.drop(!cancelled && !wasPinching);
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}

// The camera let go: the pointer's own look again.
for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, () => { canvas.dataset['camera'] = ''; });
// Nothing to aim at off the map: no hover preview left behind on it.
function pointerLeft(): void {
  if (hoverAnchor) {
    hoverAnchor = null;
    requestDraw();
  }
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    // Prevented while dispatched (the page would scroll); handled with the rest of the input.
    e.preventDefault();
    take({ type: 'wheel', e, r: canvas.getBoundingClientRect() });
  },
  { passive: false },
);
function wheel(e: WheelEvent, r: DOMRect): void {
  {
    // The wheel zooms, whatever tool is in hand (the player, 2026-10-06)
    if (game.tool === 'terrain' && (e.shiftKey || e.altKey)) {
      const notches = -Math.sign(e.deltaY || e.deltaX);
      if (e.altKey) setTerrainStrength(game.terrainStrength + notches);
      else setTerrainRadius(game.terrainRadius + notches * 10);
      return;
    }
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    // About the ground under the pointer at its real height
    const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    cameraMotion.wheel(-e.deltaY * lines * 0.0013, at);
    requestDraw();
  }
}


// -------------------------------------------------------------------- ui The interface

/** Each class's picture, drawn once (`roadSwatch` paints a canvas). */
const roadClassPictures: string[] = [];
/** Every road class as the upgrade tool shows it: name, picture, total width in whole metres. */
function roadClasses(): ShellRoadClass[] {
  return ROAD_TYPES.map((rt, index) => ({
    index,
    name: roadTypeName(rt),
    title: `${roadTypeName(rt)} — ${roadTypeDescription(rt)}`,
    picture: (roadClassPictures[index] ??= roadSwatch(rt)),
    widthM: Math.round((rt.width + rt.sidewalk * 2) * METERS_PER_UNIT),
  }));
}

/** The lanes a road is laid at. */
const MEDIAN_CLASS = ROAD_TYPES.findIndex((rt) => rt.median > 0);
const LANE_CHOICES: readonly { readonly id: string; readonly lanes: number | null }[] = [
  { id: '2', lanes: 2 },
  { id: '4', lanes: 4 },
  { id: '6', lanes: 6 },
  { id: 'median', lanes: null },
];
/** The lane choices, the one the next road will be laid as lit: with no count chosen, the class's own. */
function laneChoices(): { id: string; label: string; on: boolean }[] {
  return LANE_CHOICES.map((choice) => ({
    id: choice.id,
    label: choice.lanes === null ? t('palette.lanes.median') : t('palette.lanes.count', { count: choice.lanes }),
    on: choice.lanes === null
      ? game.roadLanePreset === null && game.roadTypeIndex === MEDIAN_CLASS
      : game.roadTypeIndex !== MEDIAN_CLASS && choice.lanes === (game.roadLanePreset ?? roadType(game.roadTypeIndex).lanes),
  }));
}
function setLanes(id: string): void {
  const choice = LANE_CHOICES.find((c) => c.id === id);
  if (!choice) return;
  gameState.set('roadLanePreset', choice.lanes, 'lanes chosen');
  if (choice.lanes === null) selectRoadType(MEDIAN_CLASS);
  requestDraw();
}

function selectRoadType(i: number): void {
  if (!ROAD_TYPES[i]) return;
  gameState.set('roadTypeIndex', i, 'road class chosen');
  requestDraw();
}

function setAlignment(next: Alignment): void {
  gameState.set('alignment', next, 'alignment chosen');
  if (next !== 'curve') roadTool.dropCurve();
  updateHint();
  requestDraw();
}
// A key rebound: every sentence that names it is written again.
onRoadKeysChange(() => { applyTranslations(document); updateHint(); });

/** The roundabout's radius, in whole metres. */
const ROUNDABOUT_RADIUS_M = [32, 128] as const;

/** A lot or zone setting changed (Zoning): the use, the density, the eraser, the lot verb, the cut. */
function setZone(patch: ShellZonePatch): void {
  if (patch.eraser !== undefined) gameState.set('zoneEraser', patch.eraser, 'zone eraser');
  if (patch.use === 'residential' || patch.use === 'commercial' || patch.use === 'industrial') gameState.set('zoneUse', patch.use, 'zone use');
  if (patch.density === 'low' || patch.density === 'medium' || patch.density === 'high') gameState.set('zoneDensity', patch.density, 'zone density');
  if (patch.mode !== undefined) {
    const wanted = patch.mode;
    gameState.set('zoneMode', wanted === 'fill' || wanted === 'edit' || wanted === 'front' || wanted === 'split' || wanted === 'join' || wanted === 'add' ||
      wanted === 'polygon' || wanted === 'curve' || wanted === 'delete' ? wanted : 'brush', 'zone mode');
    lotTool.modeChanged();
  }
  if (patch.splitKind !== undefined) gameState.set('lotSplitKind', patch.splitKind === 'horizontal' ? 'horizontal' : patch.splitKind === 'line' ? 'line' : 'vertical', 'lot cut');
  if (patch.splitParts !== undefined) gameState.set('lotSplitParts', clamp(Math.round(patch.splitParts), 2, 6), 'lot parts');
  requestDraw();
}

/** Every brush of the terrain tool, in the order of its number keys. */
const BRUSH_MODES: readonly BrushMode[] = ['raise', 'lower', 'flatten', 'river', 'paint', 'mesa', 'canyon', 'escarpment', 'sugarloaf', 'fog', 'cloud', 'elements', 'gully', 'trees', 'weather'];
function setTerrainMode(next: BrushMode): void {
  gameState.set('terrainMode', next, 'terrain brush');
  // Each tool its own hardness: a chapada's cliff is not the hill's slope.
  const hardness = hardnessByMode[next];
  if (hardness !== undefined) gameState.set('terrainHardness', hardness, 'mode hardness');
  updateHint();
}

/** One writer for each brush number */
const TERRAIN_RADIUS_RANGE = [30, 300] as const;
const TERRAIN_STRENGTH_RANGE = [1, 160] as const;
function setTerrainRadius(value: number): void {
  gameState.set('terrainRadius', clamp(Math.round(value), TERRAIN_RADIUS_RANGE[0], TERRAIN_RADIUS_RANGE[1]), 'brush radius');
  requestDraw();
}
function setTerrainStrength(value: number): void {
  gameState.set('terrainStrength', clamp(Math.round(value), TERRAIN_STRENGTH_RANGE[0], TERRAIN_STRENGTH_RANGE[1]), 'brush strength');
  requestDraw();
}

/** A slider of the map's own settings (the fog over the map, the weather, the gullies of the land) */
function mapSlider(min: number, max: number, step: number, get: () => number, set: (v: number) => void): ShellSlider {
  let recorded = false;
  return {
    min, max, step, get,
    set: (v) => {
      if (!recorded) { history.begin(doc); recorded = true; updateHistoryButtons(); }
      set(v);
      persistence.saveSessionSoon(doc, sessionSettings);
      requestDraw();
    },
    end: () => { recorded = false; },
  };
}
/** A slider of a brush, kept between sessions (`ui/toolChoices.ts`): not the map's, no undo. */
const brushSlider = (min: number, max: number, step: number, get: () => number, set: (v: number) => void): ShellSlider =>
  ({ min, max, step, get, set: (v) => { set(v); requestDraw(); } });

// THE WEATHER (Landscape > Sky, `world/weather.ts`) and the water under the river brush: the map's, one undo step a drag.
scene.onStrike((_x, _y, distance) => playThunder(distance / UNITS_PER_METER, doc.weather.thunder));
const weatherSlider = (key: keyof typeof doc.weather, min: number, max: number, step: number, scale: number): ShellSlider =>
  mapSlider(min, max, step, () => Math.round(doc.weather[key] * scale * 10) / 10, (v) => doc.setWeather({ [key]: v / scale }));

// The sky the player sets: the mist over everything, and (from before every cloud was the map's) the cloud cover.
const ATMOSPHERE_KEY = 'roadcraft.atmosphere.v5';
const atmosphere = { atmoClouds: 40, atmoCloudBase: 180, atmoCloudThickness: 150, atmoFog: 0, atmoFogHeight: 60 };
try {
  const kept = JSON.parse(localStorage.getItem(ATMOSPHERE_KEY) ?? 'null') as Record<string, number> | null;
  if (kept) {
    for (const key of Object.keys(atmosphere) as (keyof typeof atmosphere)[]) {
      const value = kept[key];
      if (value !== undefined && Number.isFinite(value)) atmosphere[key] = value;
    }
  }
} catch { /* storage blocked: the defaults */ }
function applyAtmosphere(redraw = true): void {
  scene.setAtmosphere({
    clouds: atmosphere.atmoClouds / 100,
    cloudBase: atmosphere.atmoCloudBase * UNITS_PER_METER,
    cloudThickness: atmosphere.atmoCloudThickness * UNITS_PER_METER,
    fog: atmosphere.atmoFog / 100,
    fogHeight: atmosphere.atmoFogHeight * UNITS_PER_METER,
  });
  try { localStorage.setItem(ATMOSPHERE_KEY, JSON.stringify(atmosphere)); } catch { /* not kept */ }
  // Not at boot: the frame loop is not set up yet then.
  if (redraw) requestDraw();
}
// The sky made no clouds of its own any more (every cloud is the map's, to move or take away)
if (atmosphere.atmoClouds > 0) {
  if (doc.clouds.length === 0) {
    doc.addClouds(scatterClouds(Math.round((atmosphere.atmoClouds / 100) * 12), {
      size: Math.max(40, atmosphere.atmoCloudThickness * UNITS_PER_METER), height: atmosphere.atmoCloudBase * UNITS_PER_METER, density: 0.8,
    }, 0.3, MAP_SIZE / 2, [], editRandom(doc, 0, 0)));
    persistence.saveSessionSoon(doc, sessionSettings);
  }
  atmosphere.atmoClouds = 0;
}
applyAtmosphere(false);

/** Every slider the interface shows, by name: its range and how the game reads and takes it. */
const SLIDERS: Readonly<Record<string, ShellSlider>> = {
  // The terrain brush (Paisagem > Relevo).
  terrainRadius: { min: TERRAIN_RADIUS_RANGE[0], max: TERRAIN_RADIUS_RANGE[1], step: 10, get: () => game.terrainRadius, set: setTerrainRadius },
  terrainStrength: { min: TERRAIN_STRENGTH_RANGE[0], max: TERRAIN_STRENGTH_RANGE[1], step: 1, get: () => game.terrainStrength, set: setTerrainStrength },
  // The brush's hardness: a mesa's cliff or a canyon's wall instead of a dome; each mode keeps its own.
  terrainHardness: { min: 0, max: 95, step: 5, get: () => game.terrainHardness, set: (v) => {
    gameState.set('terrainHardness', clamp(Math.round(v), 0, 95), 'brush hardness');
    if (hardnessByMode[game.terrainMode] !== undefined) hardnessByMode[game.terrainMode] = game.terrainHardness;
  } },
  // The gully brush, and how much of the steep land carries gullies of itself (the map's, `world/gullies.ts`).
  gullyStrength: { min: 5, max: 100, step: 5, get: () => gullyStrength, set: (v) => { gullyStrength = v; } },
  gullyAuto: mapSlider(0, 100, 5, () => Math.round(doc.gullyAuto * 100), (v) => doc.setGullyAuto(v / 100)),
  // The water of every river and lake.
  waterWaves: weatherSlider('waves', 0, 100, 5, 100),
  waterFoam: weatherSlider('foam', 0, 100, 5, 100),
  waterCurrent: weatherSlider('current', 0, 4, 0.1, 1),
  // Rain, wind, lightning and thunder over the whole map.
  weatherRain: weatherSlider('rain', 0, 100, 5, 100),
  weatherWind: weatherSlider('wind', 0, 30, 1, 1),
  weatherWindDir: weatherSlider('windDirection', 0, 355, 5, 1),
  weatherLightning: weatherSlider('lightning', 0, 30, 1, 1),
  weatherThunder: weatherSlider('thunder', 0, 100, 5, 100),
  // The tree brush (`world/trees.ts`).
  treeDensity: brushSlider(10, 600, 10, () => treeBrush().density, (v) => setTreeBrush({ density: v })),
  treeHeight: brushSlider(3, 30, 1, () => treeBrush().height, (v) => setTreeBrush({ height: v })),
  treeVariation: brushSlider(0, 80, 5, () => treeBrush().variation, (v) => setTreeBrush({ variation: v })),
  treeSpacing: brushSlider(2, 30, 1, () => treeBrush().spacing, (v) => setTreeBrush({ spacing: v })),
  // The element brush, each kind its own settings (`world/elements.ts`).
  elDensity: brushSlider(0.1, 200, 0.1, () => elementBrush().density, (v) => setElementBrush({ density: v })),
  elSize: brushSlider(0.05, 10, 0.05, () => elementBrush().size, (v) => setElementBrush({ size: v })),
  elVariation: brushSlider(0, 100, 5, () => elementBrush().variation, (v) => setElementBrush({ variation: v })),
  elSpacing: brushSlider(0, 20, 0.1, () => elementBrush().spacing, (v) => setElementBrush({ spacing: v })),
  elStrength: brushSlider(5, 100, 5, () => elementBrush().strength, (v) => setElementBrush({ strength: v })),
  elIntensity: brushSlider(0, 100, 5, () => elementBrush().intensity, (v) => setElementBrush({ intensity: v })),
  // The cloud tool: the next cloud's size, base and density, and how many "spread over the sky" lays.
  cloudSize: brushSlider(30, 600, 10, () => cloudBrush().size, (v) => setCloudBrush({ size: v })),
  cloudHeight: brushSlider(40, 900, 10, () => cloudBrush().height, (v) => setCloudBrush({ height: v })),
  cloudDensity: brushSlider(10, 100, 5, () => cloudBrush().density, (v) => setCloudBrush({ density: v })),
  cloudCount: { min: 1, max: 24, step: 1, get: () => cloudScatter.count, set: (v) => { cloudScatter.count = v; } },
  cloudVariation: { min: 0, max: 80, step: 5, get: () => cloudScatter.variation, set: (v) => { cloudScatter.variation = v; } },
  // The fog brush: each bank keeps the thickness, height and drift it was laid with (`world/fogPaint.ts`).
  fogStrength: brushSlider(5, 100, 5, () => fogBrush().strength, (v) => setFogBrush({ strength: v })),
  fogHeight: brushSlider(2, 160, 2, () => fogBrush().height, (v) => setFogBrush({ height: v })),
  fogSpeed: brushSlider(0, 24, 0.5, () => fogBrush().speed, (v) => setFogBrush({ speed: v })),
  // The map's: every bank's thickness at once, and the mist over everything.
  fogMapDensity: mapSlider(0, 200, 10, () => Math.round(doc.fogSettings.density * 100), (v) => doc.setFogSettings({ density: v / 100 })),
  atmoFog: { min: 0, max: 100, step: 5, get: () => atmosphere.atmoFog, set: (v) => { atmosphere.atmoFog = v; applyAtmosphere(); } },
  atmoFogHeight: { min: 5, max: 200, step: 5, get: () => atmosphere.atmoFogHeight, set: (v) => { atmosphere.atmoFogHeight = v; applyAtmosphere(); } },
  // The simulation: cars and people on foot as shares (%) of what the city's own density asks (`SimWorld.followCity`).
  trafficIntensity: { min: 0, max: MAX_INTENSITY * 100, step: 10, get: () => Math.round(simHost.settings.trafficIntensity * 100),
    set: (v) => { simHost.set({ trafficIntensity: v / 100 }); persistence.saveSettingsSoon(sessionSettings); } },
  pedIntensity: { min: 0, max: MAX_INTENSITY * 100, step: 10, get: () => Math.round(simHost.settings.pedestrianIntensity * 100),
    set: (v) => { simHost.set({ pedestrianIntensity: v / 100 }); persistence.saveSettingsSoon(sessionSettings); } },
  // The roundabout tool's radius, metres.
  roundaboutRadius: { min: ROUNDABOUT_RADIUS_M[0], max: ROUNDABOUT_RADIUS_M[1], step: 4, get: () => Math.round(game.roundaboutRadius / UNITS_PER_METER),
    set: (v) => { gameState.set('roundaboutRadius', clamp(v, ROUNDABOUT_RADIUS_M[0], ROUNDABOUT_RADIUS_M[1]) * UNITS_PER_METER, 'roundabout size'); requestDraw(); } },
};

/** The map's biome (`world/ecology.ts`): one gives an old map its ecosystem too; "none" takes it away. Undoable. */
function mapBiome(): string {
  return doc.nature?.region ?? 'none';
}
function setMapBiome(key: string): void {
  const next = isRegionId(key) ? { region: key, seed: doc.nature?.seed ?? newNature().seed } : null;
  if (JSON.stringify(doc.nature) === JSON.stringify(next)) return;
  history.begin(doc);
  doc.setNature(next);
  updateHistoryButtons();
  requestDraw();
}

/** One edit of the whole map, asked first and undoable: what each "clear" and "spread" button does. */
function wholeMapEdit(confirmKey: string | null, edit: () => void): void {
  if (confirmKey && !window.confirm(t(confirmKey))) return;
  history.begin(doc);
  edit();
  updateHistoryButtons();
  persistence.saveSessionSoon(doc, sessionSettings);
  requestDraw();
}
const MAP_ACTIONS: Readonly<Record<string, () => void>> = {
  clearTerrain: () => wholeMapEdit('confirm.clearTerrain', () => doc.clearTerrain()),
  clearGullies: () => { if (doc.gullyDabs.length > 0) wholeMapEdit('confirm.clearGullies', () => doc.clearGullies()); },
  clearFog: () => { if (doc.fogDabs.length > 0) wholeMapEdit('confirm.clearFog', () => doc.clearFog()); },
  clearTrees: () => { if (doc.trees.length > 0 || doc.treeClearings.length > 0) wholeMapEdit('confirm.clearTrees', () => doc.clearTrees()); },
  clearElements: () => { if (doc.elements.length > 0) wholeMapEdit('confirm.clearElements', () => doc.clearElements()); },
  clearClouds: () => {
    if (doc.clouds.length > 0) wholeMapEdit('confirm.clearClouds', () => { for (const cloud of [...doc.clouds]) doc.removeCloud(cloud.id); });
  },
  // Spread clouds over the sky: as many as asked, about the tool's size, height and density, varied
  scatterClouds: () => wholeMapEdit(null, () => {
    const brush = cloudBrush();
    const laid = scatterClouds(cloudScatter.count, {
      size: brush.size * UNITS_PER_METER, height: brush.height * UNITS_PER_METER, density: brush.density / 100,
    }, cloudScatter.variation / 100, MAP_SIZE / 2, doc.clouds, editRandom(doc, 0, 0));
    if (doc.addClouds(laid) < cloudScatter.count) flashHint('hint.cloud.full');
  }),
};

/** Puts a tool in hand: what it does to the game (gestures dropped, the selection let go, the Builder switched on or off). */
function takeTool(next: Tool): void {
  cancelGestures();
  gameState.set('tool', next, 'tool chosen');
  if (next !== 'inspect') {
    select(null, game.selectedSegmentS, null, `tool ${next}`);
    closeInspector();
  }
  const buildingActive = next === 'building';
  if (buildingActive) buildings.activate();
  else buildings.deactivate();
  requestDraw();
}

/** What follows the tool in hand outside the interface: the pointer's cursor, the Builder's mode, the hint. */
function showTool(next: Tool): void {
  canvas.dataset['tool'] = next;
  buildings.workspace.setMode(next === 'building' ? 'builder' : 'road');
  updateHint();
}
gameState.watch(['tool'], () => showTool(game.tool));

/** Takes a tool in hand (a panel's own choice, a road class key). */
function setTool(next: Tool): void {
  tools.send({ type: 'pick', tool: next });
}

/** Puts everything down: no tool in hand, nothing picked, no panel. */
function freeSelection(): void {
  tools.send({ type: 'putDown' });
}

/** A tool button or key: picks the tool, or puts it down when it is already in hand. */
function pickTool(next: Tool): void {
  tools.send({ type: 'toggle', tool: next });
}

/** The interface's handle: the road inspector's eyedropper opens the road tool through it. */
let shell: ShellHandle | null = null;
/** The interface (`ui/v2/shell.ts`): its HUD, dock, drawer and selection panel, handed the game's state and its commands. */
function mountInterface(): void {
  showTool(game.tool);
  shell = mountShell({
    workspace: buildings.workspace,
    game: gameState,
    inspectorPanel: document.getElementById('inspector'),
    pickTool: (next) => { if (isTool(next)) pickTool(next); },
    setTool: (next) => { if (isTool(next)) setTool(next); },
    putDown: freeSelection,
    setSpeed,
    undo,
    redo,
    newMap,
    openMap: () => void openMap(),
    saveMap,
    about: openAbout,
    qualityLevels: QUALITY_LEVELS,
    setQuality,
    markingStyle: () => doc.markingStyle,
    setMarkingStyle,
    setSky,
    toggleCongestion,
    camera: cameraCommand,
    cameraTurns: view.kind !== '2d',
    roundabout: freeRoadsEnabled(),
    roadClasses,
    selectRoadType,
    setAlignment: (next) => { if (next === 'straight' || next === 'curve' || next === 'free') setAlignment(next); },
    stepRoadHeight: (d) => roadTool.stepHeight(d),
    laneChoices,
    setLanes,
    setZone,
    setTerrainMode: (mode) => { if ((BRUSH_MODES as readonly string[]).includes(mode)) setTerrainMode(mode as BrushMode); },
    setBarrierKind: (kind) => { if ((BARRIER_KINDS as readonly string[]).includes(kind)) gameState.set('barrierKind', kind as BarrierKind, 'fence type'); },
    mapBiome,
    setMapBiome,
    mapAction: (name) => MAP_ACTIONS[name]?.(),
    demand: () => simHost.settings.demandMultiplier,
    setDemand,
    sliders: SLIDERS,
    onStatus: (listen) => { statusListeners.push(listen); listen(currentStatus()); },
    onHint: listenHint,
    roadSnap,
    setRoadSnap,
    parkingPresets: ROAD_PARKING_PRESETS,
    roadParkingPreset,
    setRoadParkingPreset: (preset) => {
      if ((ROAD_PARKING_PRESETS as readonly string[]).includes(preset)) setRoadParkingPreset(preset as RoadParkingPreset);
    },
    transitTool,
    // Junctions that cannot be built (`Network.impossible`)
    showImpossible: () => {
      const id = net.impossible.keys().next().value;
      const node = id === undefined ? undefined : doc.node(id);
      if (id === undefined || !node) return;
      setTool('inspect');
      select(null, null, id, 'impossible node shown');
      showInspector();
      view.moveTo(node);
      requestDraw();
    },
    // The old status bar's numbers (`ShellReadouts`): read while the Simulation or the Camera menu is open.
    readouts: () => {
      const centre = view.centre;
      return { roads: doc.segments.size, nodes: doc.nodes.size, zoom: view.zoom, x: centre.x, y: centre.y };
    },
  });
  // F9's button in the top bar, before Help (`ui/healthPanel.ts`).
  shell.addToBar(healthPanel.button);
  // The compass in a corner (`ui/v2/compass.ts`): a click faces north, a drag turns and tilts.
  if (view.kind !== '2d') {
    compass = mountCompass(document.querySelector<HTMLElement>('.v2') ?? document.body, {
      north: () => {
        cameraMotion.aim(() => northTurn(view, surface.cssW, surface.cssH));
        requestDraw();
      },
      drag: (turn, tilt) => {
        view.orbit(turn, tilt);
        persistence.saveSettingsSoon(sessionSettings);
        requestDraw();
      },
    });
  }
}
/** The compass in a corner of the interface (`mountInterface`). */
let compass: Compass | null = null;
/** Points the compass where north lies on screen: up the map. */
function updateCompass(): void {
  compass?.point(northOnScreen(view, surface.cssW, surface.cssH));
}
// Mounted after this module has finished evaluating
setTimeout(mountInterface, 0);

function setPaused(paused: boolean): void {
  gameState.set('paused', paused, paused ? 'paused' : 'simulation resumed');
  simHost.set({ paused });
  frameClock.restart();
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}

function setSpeed(speed: number): void {
  if (speed <= 0) setPaused(true);
  else {
    gameState.set('speed', speed, 'speed chosen');
    simHost.set({ speed });
    setPaused(false);
  }
}

/** How much traffic the city asks for: Low, Normal or Peak. */
function setDemand(value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  simHost.set({ demandMultiplier: value });
  persistence.saveSettingsSoon(sessionSettings);
}

function toggleCongestion(): void {
  gameState.set('congestionOverlay', !game.congestionOverlay, 'congestion map');
  persistence.saveSettingsSoon(sessionSettings);
}
trackFocusModality();
onRoadGridChange(requestDraw);
mountAbout();

/** A generated city (`world/cityGen/plan.ts`, `editor/cityGenerator.ts`): the map replaced */
let cityGrowth: { left: number; total: number; started: number; guard: number;
  /** The layout still being laid, a slice a frame (`layoutSteps`); gone once the lots are zoned. */
  layout?: Generator<void, { zoned: number; squares: number; pieces: number }> } | null = null;
function generateCity(options: CityOptions): { roads: number; lots: number; zoned: number; squares: number; pieces: number } {
  const plan = planCity(options);
  const cityDoc = layCity(plan);
  history.begin(doc);
  // The footways wide enough for street trees before the lots are cut (V7).
  widenCityFootways(cityDoc);
  // On the level plain, as every new map
  applySnapshot({ ...cityDoc.toJSON(), relief: NEW_RELIEF }, 'import');
  if (net.revision !== doc.revision) net.rebuild();
  // The lots, the squares, the power lines, the furniture and the zones a slice a frame (`growCity`), then the buildings
  cityGrowth = { left: 0, total: 0, started: performance.now(), guard: 0, layout: layoutSteps(plan, options.seed) };
  fitView();
  requestDraw();
  return { roads: doc.segments.size, lots: 0, zoned: 0, squares: 0, pieces: 0 };
}
/** The generated city's layout after its roads: lots cut, squares and streets dressed (`greenCitySteps`), lots zoned. */
function* layoutSteps(plan: CityPlan, seed: number): Generator<void, { zoned: number; squares: number; pieces: number }> {
  applyLots(doc, yield* planLotsSteps(doc, net));
  yield;
  // A square in each neighbourhood and the streets' trees and furniture (V7).
  const green = yield* greenCitySteps(doc, net, seed);
  yield;
  const zoned = zoneCity(doc, net, plan);
  lotTool.refused.clear();
  lotTool.refusedNow();
  return { zoned, ...green };
}
/** Builds on the generated city's lots, `GROW_SLICE_MS` a frame */
const cityProgress = document.createElement('div');
cityProgress.className = 'city-progress';
cityProgress.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:50;display:none;'
  + 'background:rgba(10,16,18,.85);color:#fff;font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:10px';
document.body.appendChild(cityProgress);
function growCity(): void {
  if (!cityGrowth) return;
  // DO NOT hold the buildings from the renderer until the last one
  const growing = cityGrowth;
  if (cityProgress.style.display !== 'block') {
    cityProgress.style.display = 'block';
    cityProgress.textContent = t('city.building', { done: 0, total: growing.total });
    requestDraw();
    return;
  }
  if (growing.layout) {
    // The layout first, within the slice; the lots counted as they are cut.
    const until = performance.now() + GROW_SLICE_MS;
    let laid: { zoned: number } | null = null;
    caused('city generated', () => {
      for (;;) {
        const step = growing.layout!.next();
        if (step.done) { laid = step.value; break; }
        if (performance.now() >= until) break;
      }
    });
    if (laid !== null) { growing.total = growing.left = (laid as { zoned: number }).zoned; delete growing.layout; }
    cityProgress.textContent = t('city.building', { done: 0, total: laid !== null ? growing.total : doc.lots.length });
    requestDraw();
    return;
  }
  const done = growSlice(growing);
  cityProgress.textContent = t('city.building', { done: growing.total - growing.left, total: growing.total });
  requestDraw();
  if (!done) return;
  cityGrowth = null;
  cityBuiltIn = (performance.now() - growing.started) / 1000;
  cityProgress.style.display = 'none';
  persistence.saveSessionSoon(doc, sessionSettings);
  updateStatus();
}
/** @rebuild One slice of the generated city's growth: lots built until `GROW_SLICE_MS` is spent; true when none is left. */
function growSlice(growing: NonNullable<typeof cityGrowth>): boolean {
  const until = performance.now() + GROW_SLICE_MS;
  let done = false;
  caused('city generated', () => {
    while (performance.now() < until) {
      if (++growing.guard > growing.total * 3 + 50) { done = true; break; }
      const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y), pavedAt: (x, y) => scene.pavedHeightAt(x, y) }, lotTool.refused, 0x5eed);
      if (id === null) {
        // DO NOT filter `doc.lots` here: it ran once per lot refused, every lot each time.
        if (doc.openLots.count(lotTool.refused) === 0) { done = true; break; }
        continue;
      }
      const fresh = doc.buildings.get(id as BuildingId);
      if (fresh) doc.buildings.put({ ...fresh, builtAt: simHost.minutes, decay: 0, lotPlan: LOT_PLAN_VERSION });
      growing.left--;
    }
  });
  return done;
}
/** Milliseconds a frame spent building the generated city's lots (`growCity`). */
const GROW_SLICE_MS = 100;
/** Seconds the last generated city took, from the call to its last building (probes). */
let cityBuiltIn = 0;

function newMap(): void {
  if (!window.confirm(t('confirm.newMap'))) return;
  // Discarding the whole map is the largest edit the editor can make, so it is the one that most needs to be undoable.
  history.begin(doc);
  // A new map is empty, painted to the Brazilian standard.
  applySnapshot({ ...new RoadDoc().toJSON(), relief: NEW_RELIEF, markingStyle: 'br' }, 'import');
  roadTool.reset();
  fitView();
  flashHint('hint.newMap');
}
// The sky: always day (the default), always night, or the residents' clock; kept.
const SKY_KEY = 'roadcraft.sky';
const SKY_MODES: readonly SkyMode[] = ['day', 'night', 'cycle'];
function setSky(mode: string): void {
  if (!(SKY_MODES as readonly string[]).includes(mode)) return;
  gameState.set('sky', mode as SkyMode, 'sky chosen');
  try { localStorage.setItem(SKY_KEY, mode); } catch { /* not kept */ }
}
try {
  const saved = localStorage.getItem(SKY_KEY);
  if (saved && (SKY_MODES as readonly string[]).includes(saved)) gameState.set('sky', saved as SkyMode, 'saved preference');
} catch { /* storage blocked: day */ }
gameState.watch(['sky'], () => { scene.setSkyMode(game.sky); requestDraw(); });
scene.setSkyMode(game.sky);

/** DO NOT say "saved" without asking `exportToFile` */
function saveMap(): void {
  const offered = exportToFile(doc, sessionSettings(), undefined, () => flashHint('hint.exportFailed'));
  if (offered) flashHint('hint.saved');
}
/** Loads a picked map. */
function openImported(result: ImportResult): boolean {
  if (result.status === 'cancelled') return false;
  if (result.status === 'invalid') {
    flashHint('hint.openFailed');
    return false;
  }
  const before = doc.toJSON();
  // Opening a map is an edit like any other: undo gives the map before it back.
  history.begin(doc);
  try {
    applySnapshot(result.session.document, 'import');
  } catch (error) {
    console.error('The map could not be loaded.', error);
    applySnapshot(before);
    history.end(doc);
    flashHint('hint.openFailed');
    return false;
  }
  history.end(doc);
  updateHistoryButtons();
  restoreSettings(result.session.settings);
  flashHint('hint.opened');
  return true;
}
async function openMap(): Promise<void> {
  openImported(await importFromFile());
}

// Perspective or the isometric (orthographic) view, the player's choice, kept.
const PERSPECTIVE_KEY = 'roadcraft.perspective.v2';
function setPerspective(on: boolean): void {
  gameState.set('perspective', on, 'camera');
  try { localStorage.setItem(PERSPECTIVE_KEY, on ? '1' : '0'); } catch { /* not kept */ }
}
/** The camera as the game's state has it. */
function showPerspective(): void {
  scene.setPerspective(game.perspective);
}
gameState.watch(['perspective'], showPerspective);
// At boot, once the whole file has run: switching the camera asks for a frame, and the frame loop is set up further down.
queueMicrotask(() => {
  let kept: string | null = null;
  try { kept = localStorage.getItem(PERSPECTIVE_KEY); } catch { /* storage blocked: the default */ }
  gameState.set('perspective', kept !== '0', 'saved preference');
  showPerspective();
});

/** The camera menu's buttons: a step per press; north and reset put the camera back (reset frames the map too). */
const TILT_STEP = Math.PI / 18;
function cameraCommand(command: string): void {
  switch (command) {
    case 'turnLeft': view.orbit(-KEY_TURN, 0); break;
    case 'turnRight': view.orbit(KEY_TURN, 0); break;
    case 'tiltUp': view.orbit(0, TILT_STEP); break;
    case 'tiltDown': view.orbit(0, -TILT_STEP); break;
    case 'north': view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION); break;
    case 'perspective': setPerspective(!game.perspective); break;
    case 'reset': view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION); fitView(); break;
    default: return;
  }
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}

// An undo can change something far off screen, so the game says it happened.
function undo(): void {
  // A drag or stroke in progress ends first
  cancelGestures();
  doc.changes.causeNext('desfazer');
  const done = history.undo(doc);
  if (done) afterRestore();
  doc.changes.causeNext('jogo');
  if (done) flashHint('hint.undone');
}
function redo(): void {
  cancelGestures();
  doc.changes.causeNext('refazer');
  const done = history.redo(doc);
  if (done) afterRestore();
  doc.changes.causeNext('jogo');
  if (done) flashHint('hint.redone');
}
/** The game after an undo or a redo put records back (`editor/history.ts`): the network rebuilt only when the roads moved */
function afterRestore(): void {
  roadTool.cancel();
  followNetwork(doc, net);
  buildings.restored();
  select(null, game.selectedSegmentS, null, 'another map');
  closeInspector();
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  updateStatus();
  requestDraw();
}

/** Whether there is something to undo and to redo, in the game's state. */
function updateHistoryButtons(): void {
  gameState.set('canUndo', history.canUndo, 'history');
  gameState.set('canRedo', history.canRedo, 'history');
}

/** Restores the user-visible state stored beside a map without touching topology. */
function restoreSettings(settings: SavedSettings): void {
  camera.x = settings.camera.x;
  camera.y = settings.camera.y;
  // Same rule as boot, asked of the live viewport this time.
  const limits = view.zoomBounds;
  camera.zoom = clamp(settings.camera.zoom, limits.min, limits.max);
  syncViewFromFlatCamera();
  restoreOrbit(settings.camera);
  // Through the game's state: setting the clock alone left `game.speed` and the speed buttons showing the speed before the
  gameState.set('speed', settings.speed, 'map loaded');
  simHost.set({ speed: settings.speed });
  setPaused(settings.paused);
  simHost.set({ trafficIntensity: settings.trafficIntensity, pedestrianIntensity: settings.pedestrianIntensity, demandMultiplier: settings.demandMultiplier ?? 1 });
  gameState.set('congestionOverlay', settings.congestionOverlay, 'map loaded');
  persistence.saveSettingsSoon(sessionSettings);
  requestDraw();
}
updateHistoryButtons();

/** The road inspector closed (its × , Escape, Delete): nothing picked. */
function closeInspectorPanel(): void {
  select(null, game.selectedSegmentS, null, 'inspector closed');
  closeInspector();
  requestDraw();
}
(document.getElementById('closeInspector') as HTMLButtonElement).onclick = closeInspectorPanel;
/** Closes the road inspector's panel (`ui/inspector.ts`). */
function closeInspector(): void {
  hideInspector();
}
// Open or closed, by a command or by itself (what it showed is gone): in the game's state.
onInspectorChange((open) => gameState.set('inspectorOpen', open, open ? 'inspector opened' : 'inspector closed'));

/** Junction control, as a tool rather than as a form field. */
const CONTROL_CYCLE: readonly JunctionControl[] = [
  'auto',
  'signal',
  'priority',
  'stop',
  'yield',
  'none',
  'mini',
];

function cycleNodeControl(id: NodeId, direction: 1 | -1): void {
  const node = doc.node(id);
  if (!node) return;
  // A node with fewer than three legs is not a junction
  if (node.incident.length < 3) {
    flashHint('hint.control.notJunction');
    return;
  }
  const at = CONTROL_CYCLE.indexOf(node.control);
  const next = CONTROL_CYCLE[
    ((at < 0 ? 0 : at) + direction + CONTROL_CYCLE.length) % CONTROL_CYCLE.length
  ] as JunctionControl;
  mutate(() => {
    doc.setNodeControl(id, next);
    return true;
  });
  select(null, game.selectedSegmentS, id, `controle ${next}`);
  flashHint(`control.${next}`);
}

/** Who shows the tool's hint and the game's answers (the interface, `onHint`). */
const hintListeners: ((text: string, flash: boolean) => void)[] = [];
/** The answers said before anyone listened (a map that failed to open at boot): told to the first listener. */
const earlyFlashes: string[] = [];
/** A transient answer of the game - saved, refused, undone, a road that cannot be laid */
function flashHint(key: string, params?: Readonly<Record<string, string | number>>): void {
  const text = t(key, params);
  if (hintListeners.length === 0) earlyFlashes.push(text);
  for (const listen of hintListeners) listen(text, true);
}

/** The tool's hint: what a click does now. */
function hintKey(prefix: string): string {
  if (game.tool === 'road' && game.alignment === 'curve') return `${prefix}.road.curve`;
  if (game.tool === 'road' && game.alignment === 'free') return `${prefix}.road.free`;
  // Each sculpting operation gets its own sentence.
  if (game.tool === 'terrain') return `${prefix}.terrain.${game.terrainMode}`;
  if (game.tool === 'building') return buildings.hintKey(prefix);
  return `${prefix}.${game.tool}`;
}

let hintShown = '';
function updateHint(): void {
  const text = t(hintKey('hint'));
  if (text === hintShown) return;
  hintShown = text;
  for (const listen of hintListeners) listen(text, false);
}
/** A listener of the hint: told the hint now, and any answer said before it came. */
function listenHint(listen: (text: string, flash: boolean) => void): void {
  hintListeners.push(listen);
  hintShown = t(hintKey('hint'));
  listen(hintShown, false);
  for (const text of earlyFlashes.splice(0)) listen(text, true);
}
if (bootFailed) flashHint('hint.bootFailed');

/** The terrain brush's operations in the number row's order (1 = raise). */
const TERRAIN_KEY_MODES: readonly BrushMode[] = ['raise', 'lower', 'flatten', 'river', 'paint', 'mesa', 'canyon', 'escarpment', 'sugarloaf', 'fog', 'cloud', 'elements', 'gully', 'trees', 'weather'];
/** Every key the game answers (`editor/gameKeys.ts`): one command a key. */
const gameKeys = createGameKeys({
  tool: () => game.tool,
  buildingKey: (e) => buildings.key(e),
  // A run being traced: Enter ends it, Backspace takes the last point back, Esc drops it.
  transitKey: (key) => transitEditor.key(key),
  barrierKey: (key) => barrierTool.key(key),
  // The road tool's keys, as the player bound them (`ui/roads/keys.ts`).
  roadKey: (key) => {
    const action = roadKeyAction(key);
    if (action === 'alignment') {
      const order: readonly Alignment[] = ['straight', 'curve', 'free'];
      setAlignment(order[(order.indexOf(game.alignment) + 1) % order.length]!);
    } else if (action) roadTool.stepHeight(action === 'heightUp' ? 1 : -1);
    return action !== null;
  },
  smoothNodePicked: () => game.selectedNode !== null && (doc.node(game.selectedNode)?.smooth ?? false),
  stepNodeHeight: (metres) => {
    const id = game.selectedNode;
    if (id === null) return;
    setNodeHeightMetres(id, doc.requireNode(id).heightOffset / UNITS_PER_METER + metres);
  },
  camera: {
    turn: (radians) => cameraMotion.turn(radians),
    press: (code, shift) => cameraMotion.press(code, shift),
    home: () => { view.setOrbit(DEFAULT_AZIMUTH, DEFAULT_ELEVATION); fitView(); },
  },
  requestDraw,
  saveMap,
  openMap: () => void openMap(),
  duplicateRoad: () => duplicateSelectedSegment(),
  undo,
  redo,
  roadPicked: () => game.selectedSegment !== null,
  // Delete removes what Inspect has picked: the road it shows.
  deleteRoad: () => {
    const id = game.selectedSegment;
    if (id === null) return;
    closeInspectorPanel();
    mutate(() => {
      doc.removeSegment(id);
      doc.pruneOrphanNodes();
      return true;
    });
  },
  // A button the player reached with the keyboard keeps Space for itself; one merely clicked with the mouse
  keyboardOnButton: (e) => e.target instanceof HTMLButtonElement && focusCameFromKeyboard(),
  // The focused control is let go by the listener below.
  togglePause: () => setSpeed(game.paused ? game.speed : 0),
  terrainMode: (index) => {
    const chosen = TERRAIN_KEY_MODES[index - 1];
    if (chosen) setTerrainMode(chosen);
    return chosen !== undefined;
  },
  terrainRadius: (step) => setTerrainRadius(game.terrainRadius + step * 10),
  terrainStrength: (step) => setTerrainStrength(game.terrainStrength + step),
  roadClassCount: ROAD_TYPES.length,
  // The class palette is shown only with the road tool
  pickRoadClass: (index) => {
    if (game.tool !== 'road') setTool('road');
    selectRoadType(index);
    shell?.toolKeyed('road');
  },
  // F8: what changed, where (`drawChanges`).
  toggleChanges: () => { showChanges = !showChanges; requestDraw(); },
  // F9: the monitor (`healthPanel`, mounted at the end of this file).
  health: { toggle: () => healthPanel.toggle(), close: () => healthPanel.close() },
  toolKey: (next) => {
    pickTool(next);
    shell?.toolKeyed(next);
  },
  // Escape ends whatever is being drawn
  escape: () => {
    if (gestureInProgress()) cancelGestures();
    else if (game.selectedSegment !== null || game.selectedNode !== null) closeInspectorPanel();
    else if (game.tool !== 'inspect') freeSelection();
    else return false;
    return true;
  },
});
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  const rule = gameKeys.press({ code: e.code, key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey }, e);
  if (!rule) return;
  if (rule.prevent !== false) e.preventDefault();
  // A control merely clicked keeps the focus, and a key makes the browser ring it (`:focus-visible`)
  if (e.target instanceof HTMLElement && e.target !== document.body && !focusCameFromKeyboard()) e.target.blur();
});
window.addEventListener('keyup', (e) => { cameraMotion.release(e.code, e.shiftKey); });
// A key let go elsewhere never comes up here: nothing stays held.
window.addEventListener('blur', () => cameraMotion.releaseAll());

// ------------------------------------------------------------- run loop
/** The frame asked for, and the time between frames (`frameLoop.ts`). */
const frameClock = new FrameClock(frame, () => booted && scene.opening);
/** The flat camera kept up with the view (what the tools measure their pixels with): ten times a second. */
const flatCameraDue = new Periodic(0.1);
/** The status bar, the inspector, the simulation's checks. */
const panelsDue = new Periodic(0.4);
/** The conflict zones measured since, kept for the next session (`keptZones`). */
const zonesDue = new Periodic(5);
/** The Actions' physics asked for (`frame`). */
let actionsWarm = false;

/** Set by an edit: draw the new geometry first, rebuild the simulation after. */
let topologyAfterDraw = false;

function requestDraw(): void {
  frameClock.request();
}

/** DO NOT go back to a `setInterval` on the wall clock. */
const growthDue = new SimPeriodic(0.5);
/** Nothing grows before this simulation time (rubble of a collapse lying, `strikeAt`); `at` the time it was set. */
let zoneGrowthHold = { at: 0, until: 0 };
function growZones(): void {
  // Buildings on zoned lots (`world/lots.ts`).
  const lotRefused = lotTool.refusedNow();
  const now = simHost.time;
  // A hold set before the clock went back (a new map) holds nothing.
  if (mover.dragging || (now >= zoneGrowthHold.at && now < zoneGrowthHold.until)) return;
  // DO NOT read `doc.lots` here (`lots.some` walked every lot twice a second).
  const grown = caused('zone growth', () => {
    const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y), pavedAt: (x, y) => scene.pavedHeightAt(x, y) }, lotRefused, 0x5eed);
    const fresh = id === null ? undefined : doc.buildings.get(id as BuildingId);
    if (fresh) doc.buildings.put({ ...fresh, builtAt: simHost.minutes, decay: 0, lotPlan: LOT_PLAN_VERSION });
    return id;
  });
  if (grown !== null) {
    persistence.saveSessionSoon(doc, sessionSettings);
    updateStatus();
    requestDraw();
  }
}

/** The loading curtain: over the page while a town is put together unseen */
const loadingCurtain = document.createElement('div');
loadingCurtain.className = 'loading-curtain';
loadingCurtain.setAttribute('role', 'status');
loadingCurtain.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;'
  + 'background:rgba(10,16,18,.92);color:#fff;font:600 16px system-ui,sans-serif;letter-spacing:.02em';
loadingCurtain.textContent = t('map.loading');
document.body.appendChild(loadingCurtain);
function syncLoadingCurtain(): void {
  const show = scene.opening;
  if ((loadingCurtain.style.display !== 'none') !== show) loadingCurtain.style.display = show ? 'flex' : 'none';
}
/** A frame has been drawn, and the first world has been put in place (the opening builds it in parts). */
let drawnOnce = false;
let worldShown = false;
/** @perFrame One frame: input, the topology catching up, the simulation, the drawing, the panels. */
function frame(now: number): void {
  if (!booted) return;
  profiler.beginFrame();
  // Each system's time in this frame (`core/health.ts`): a long frame is told with the systems that took it.
  frameTimer.begin();
  beginFrameWork();
  // The input since the last frame, in the order it came (`core/events.ts`).
  canvasInput.drain(handleInput);
  // Everyone watching the game's state is told what changed, once, here.
  gameState.flush();
  frameTimer.mark('panels');
  const wall = frameClock.tick(now);
  // The camera's glide: keys held, the wheel's notches being spent.
  if (cameraMotion.step(now)) persistence.saveSettingsSoon(sessionSettings);
  // The coast of a drag let go (`cameraGestures.ts`), taken to this frame's time on the events' clock
  cameraHand.advance(now);
  // A flatten held still levels on, a dab when its interval allows (`terrainBrush.ts` tick).
  if (terrainBrush.tick(performance.now())) requestDraw();
  frameTimer.mark('camera');

  // The opening puts the town together in parts (`SceneHandle.worldBusy`)
  if (!worldShown && drawnOnce && !scene.worldBusy) worldShown = true;
  // Moving a node is an authoring preview.
  const holdSim = mover.dragging || topologyAfterDraw || !worldShown;
  // A generated city being built (`generateCity`): its own share of the frame, apart from the traffic's topology.
  growCity();
  frameTimer.mark('growCity');
  // The pistol or the bomb chosen: their effects and the physics the bodies fall with loaded now, while the player aims
  if (!actionsWarm && game.tool === 'bulldoze' && strikeChoice.mode !== 'demolish') {
    actionsWarm = true;
    void scene.effects();
  }
  // The simulation run for the frame's wall time (`sim/host.ts`): its topology catching up with an edit first, held meanwhile.
  if (simHost.advance({ wall, hold: holdSim, opening: scene.opening, worldBusy: scene.worldBusy, focus: scene.focus, screenShare: screenShare() })) requestDraw();
  // The city's own periodic work, on its clock (`SimPeriodic`).
  const simTime = simHost.time;
  if (growthDue.due(simTime)) growZones();
  if (decayDue.due(simTime)) decayWatch();
  actions.tick(simTime);
  frameTimer.mark('simulation');

  if (net.revision !== doc.revision) {
    // Geometry is still refreshed during a drag
    if (!mover.dragging || mover.previewDue(now, scene.stats.rebuildMs)) {
      // DO NOT rebuild it here, whole and on the page
      net.rebuild();
    }
  }
  frameTimer.mark('roadNetwork');
  buildings.beforeDraw(game.tool === 'building');
  frameTimer.mark('buildings');
  // The pole run under the pointer, planned once per frame
  framePolePlan = poleTool.plan();
  scene.setPolePreview(net, framePolePlan && !framePolePlan.refused && framePolePlan.poles.length >= 2
    ? { poles: framePolePlan.poles.map((pole) => ({ x: pole.at.x, y: pole.at.y, lamp: pole.lamp, standing: pole.existing !== null })) }
    : null);
  frameTimer.mark('poles');
  scene.draw(net, shown, simHost.alpha, wall, {
    holdRoads: terrainBrush.stroking,
    paused: simHost.settings.paused,
    getUp: (id, x, y, heading, seconds, crawl) => simHost.control.getUp(id, x, y, heading, seconds, crawl),
  });
  frameTimer.mark('drawing');
  drawnOnce = true;
  drawOverlayScreen();
  updateCompass();
  frameTimer.mark('overlay');
  if (topologyAfterDraw) {
    topologyAfterDraw = false;
    requestDraw();
  }

  if (ZONES_PREFIX && zonesDue.due(wall)) writeDerivedMany(ZONES_PREFIX, simHost.takeMeasured());
  if (flatCameraDue.due(wall)) syncFlatCameraFromView();

  if (panelsDue.due(wall)) {
    updateStatus();
    // Safe while the player is using the panel
    refreshInspector();
    noteSimulationIssues();
  }
  syncLoadingCurtain();
  frameTimer.mark('panels');
  const timed = frameTimer.end();
  healthWatch.frameEnded(timed.start, timed.end);
  for (const [system, ms] of timed.systems) profiler.step(`frame ${system}`, ms);
  profileFrameEnd();

  // Keep animating while anything is moving; otherwise settle.
  const simMoving = !game.paused && shown.showsMotion();
  if (!document.hidden && (simMoving || roadTool.draft || mover.dragging || cameraHand.active || cameraHand.coasting || cameraMotion.moving || scene.busy())) requestDraw();
  // Only the clouds moving (they drift, form and fade), or the clock alone: a slower frame.
  else if (!document.hidden && (!game.paused || scene.drifting())) frameClock.drift();
}

/** The same hints as `drawOverlay`, projected instead of transformed. */
/** Draws a planned pole run onto the overlay. */
/** The map's rectangle the screen can show */
function groundOnScreen(w: number, h: number): ChangeRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const top = surfaceTop();
  for (const [px, py] of [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]] as const) {
    // The pixel's line of sight where the view has one: a ray level with or above the horizon meets no ground
    const ray = view.rayAt?.(px, py, w, h);
    for (const z of [0, top]) {
      let p: Vec2;
      if (ray) {
        const t = (z - ray.oz) / ray.dz;
        if (!(ray.dz < 0) || !(t >= 0) || !Number.isFinite(t)) return [-MAP_HALF, -MAP_HALF, MAP_HALF, MAP_HALF];
        p = { x: ray.ox + ray.dx * t, y: ray.oy + ray.dy * t };
      } else p = view.toWorldAt(px, py, z, w, h);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return [Math.max(-MAP_HALF, x0), Math.max(-MAP_HALF, y0), Math.min(MAP_HALF, x1), Math.min(MAP_HALF, y1)];
}

/** Pick radius for a barrier under a shift-click, screen pixels. */
const BARRIER_PICK_PIXELS = 10;

/** The run being traced (`editor/barriers.ts` `BarrierTool.plan`), as it will stand: red where it cannot be built. */
function drawBarrierPlan(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const { line: points, bad, dots } = barrierTool.plan();
  ctx.save();
  if (points.length >= 2) {
    ctx.strokeStyle = bad ? '#ff6f63' : SELECTION;
    ctx.lineWidth = game.barrierKind === 'hedge' ? 5 : game.barrierKind === 'wall' ? 4 : 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => { const s = at(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
    ctx.stroke();
  }
  ctx.fillStyle = SELECTION;
  for (const p of dots) {
    const s = at(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Where the landscaping tool would put its item: a ring on the footway, red where it cannot go. */
function drawStreetscapeHover(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  // The row being dragged out: a ring at each piece that would be laid.
  const row = streetscapeTool.row;
  for (const piece of row?.pieces ?? []) {
    const c = at(piece.at);
    const e = at({ x: piece.at.x + LANDSCAPE_RADIUS[row!.kind] + m(0.3), y: piece.at.y });
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = SELECTION;
    ctx.fillStyle = 'rgba(120, 200, 255, 0.18)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(6, Math.hypot(e.x - c.x, e.y - c.y)), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  const hover = streetscapeTool.hover;
  if (!hover) return;
  const centre = at(hover.at);
  const edge = at({ x: hover.at.x + LANDSCAPE_RADIUS[streetscapeKind()] + m(0.3), y: hover.at.y });
  const radius = Math.max(6, Math.hypot(edge.x - centre.x, edge.y - centre.y));
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = hover.ok ? SELECTION : '#e5534b';
  ctx.fillStyle = hover.ok ? 'rgba(120, 200, 255, 0.18)' : 'rgba(229, 83, 75, 0.18)';
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (!hover.ok) {
    const k = radius * 0.6;
    ctx.beginPath();
    ctx.moveTo(centre.x - k, centre.y - k);
    ctx.lineTo(centre.x + k, centre.y + k);
    ctx.moveTo(centre.x + k, centre.y - k);
    ctx.lineTo(centre.x - k, centre.y + k);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPolePlan(
  plan: PoleRunPlan | null,
  ctx: CanvasRenderingContext2D,
  at: (p: Vec2) => Vec2,
): void {
  const cross = (p: Vec2): void => {
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#e5534b';
    ctx.beginPath();
    ctx.moveTo(p.x - 8, p.y - 8);
    ctx.lineTo(p.x + 8, p.y + 8);
    ctx.moveTo(p.x + 8, p.y - 8);
    ctx.lineTo(p.x - 8, p.y + 8);
    ctx.stroke();
    ctx.restore();
  };
  const ring = (p: Vec2, colour: string, radius = 7): void => {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  if (game.tool !== 'pole' && !plan) return;
  const marks = poleTool.marks();
  // Removing: the pole under the pointer, in red.
  if (game.tool === 'pole' && poleToolMode() === 'remove') {
    if (marks.removing) ring(at(marks.removing), '#e5534b', 10);
    return;
  }
  if (plan?.refused) {
    // An end off the footways: a red cross where it would have gone.
    cross(at(plan.from.kind === 'free' ? plan.from.at : plan.to.at));
    return;
  }
  if (plan && plan.poles.length) {
    // The run itself is drawn in 3D as it will stand (`setPolePreview`)
    for (const pole of plan.poles) if (pole.existing !== null) ring(at(pole.at), HOVER, 9);
    return;
  }
  // Nothing drawn yet: where the first pole would go, or a cross where it cannot.
  if (marks.first) {
    const snap = marks.first;
    if (snap.kind === 'free') cross(at(snap.at));
    else ring(at(snap.at), snap.kind === 'pole' ? HOVER : SELECTION);
  }
}

/** F8: the diary's last changes drawn where they happened (`world/changes.ts`). */
let showChanges = false;
/** How long a change stays drawn, ms. */
const CHANGE_SHOWN = 8000;
const CHANGE_COLOURS: Record<ChangeKind, string> = {
  roads: '#ffd23f', traffic: '#fca311', clearings: '#95d5b2', terrain: '#c8823c', paint: '#9be564', buildings: '#ff8fab', zones: '#7bdff2', lots: '#b2f7ef', lotKeys: '#80cbc4', markingStyle: '#fff3b0',
  utilities: '#f7aef8', barriers: '#d0d0d0', landscape: '#6bd425', transit: '#4cc9f0', people: '#ffffff',
  trees: '#2d6a4f', elements: '#e0aaff', fog: '#e9ecef', clouds: '#f8f9fa', weather: '#adb5bd', nature: '#52b788',
  gullies: '#8d5524', economy: '#2a9d8f', buildingWear: '#a26769', elevation: '#ff6b6b', ground: '#f4a261', light: '#ffe066', surfaces: '#4361ee',
};

/** The rectangles of the changes of the last seconds, each in its kind's colour and labelled with what it was and why */
function drawChanges(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2): void {
  const now = performance.now();
  const recent = doc.changes.latest(200).filter((c) => now - c.at < CHANGE_SHOWN);
  if (recent.length === 0) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = '600 11px system-ui, sans-serif';
  for (const change of recent) {
    ctx.globalAlpha = 1 - (now - change.at) / CHANGE_SHOWN;
    ctx.strokeStyle = CHANGE_COLOURS[change.kind];
    ctx.fillStyle = CHANGE_COLOURS[change.kind];
    ctx.setLineDash(change.parent ? [5, 4] : []);
    for (const [minX, minY, maxX, maxY] of change.rects ?? []) {
      const corners = [at({ x: minX, y: minY }), at({ x: maxX, y: minY }), at({ x: maxX, y: maxY }), at({ x: minX, y: maxY })];
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    const first = change.rects?.[0];
    if (first) {
      const p = at({ x: first[0], y: first[3] });
      ctx.fillText(`#${change.serial} ${change.kind}: ${change.cause}${change.detail ? ` (${change.detail})` : ''}`, p.x + 3, p.y - 3);
    }
  }
  ctx.restore();
  // Drawn again while they fade.
  requestDraw();
}

function drawOverlayScreen(): void {
  const w = overlayCanvas.clientWidth;
  const h = overlayCanvas.clientHeight;
  const ctx = overlayCtx;
  if (!ctx || w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (
    overlayCanvas.width !== Math.round(w * dpr) ||
    overlayCanvas.height !== Math.round(h * dpr)
  ) {
    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Project at the height of whatever is UNDER the point, not at zero.
  const at = (p: Vec2): Vec2 => view.toScreen(p, w, h, sceneHeightAt(p));

  if (showChanges) drawChanges(ctx, at);

  if (game.tool === 'roundabout' && hoverAnchor) {
    ctx.save();
    ctx.strokeStyle = HOVER;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const angle = i * Math.PI / 32;
      const p = at({ x: hoverAnchor.at.x + Math.cos(angle) * game.roundaboutRadius,
        y: hoverAnchor.at.y + Math.sin(angle) * game.roundaboutRadius });
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // The pole run being drawn.
  drawPolePlan(framePolePlan, ctx, at);
  // The universal grid (`world/grid.ts`) on the ground while roads are built
  scene.setGrid(roadGridShown());
  if (game.tool === 'road' && blockGridChoice.armed && hoverAnchor) {
    // The grid the next click lays, on the ground.
    for (const [a, b] of blockGridLines(hoverAnchor.at, blockGridChoice)) {
      const steps = Math.max(2, Math.ceil(stepsIn(dist(a, b), 4)));
      ctx.save();
      ctx.strokeStyle = SELECTION;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let k = 0; k <= steps; k++) {
        const p = at({ x: a.x + (b.x - a.x) * (k / steps), y: a.y + (b.y - a.y) * (k / steps) });
        if (k === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  if (game.tool === 'streetscape') drawStreetscapeHover(ctx, at);
  if (game.tool === 'barrier') drawBarrierPlan(ctx, at);
  if (game.tool === 'transit') transitEditor.draw(ctx, at, true);
  // The metro seen through the ground and the track being laid, in the scene.
  scene.setTransitXray(game.tool === 'transit');
  scene.setTransitPreview(game.tool === 'transit' ? transitEditor.preview() : null);
  // The zoning grid is shown while a road is being drawn too, so a street can be laid out to the blocks it will make.
  const showLots = game.tool === 'zone' || (lotTool.anyZoned() && zoneColoursShown());
  if (showLots) {
    // What the Zoning tool draws (`editor/lotTool.ts`), in the scene; its labels on the 2D layer.
    const overlay = lotTool.overlayFor(game.tool === 'zone');
    const labels = overlay.labels;
    // All of them from the next frame: the ground's shaders draw them (`lotOverlay.ts`); the diary for the built lots' levels.
    scene.setLotOverlay(overlay, doc.changes);
    // Labels stay on the 2D layer, projected at the ground's real height.
    const ground = (p: Vec2): Vec2 => view.toScreen(p, w, h, scene.surfaceHeightAt(p.x, p.y));
    ctx.save();
    for (const label of labels) {
      const c = ground(label.at);
      ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#0b1416cc'; ctx.fillStyle = '#ffffff';
      if (label.kind === 'size') {
        const text = t('zone.lot.size', { w: Math.round(label.width * METERS_PER_UNIT), d: Math.round(label.depth * METERS_PER_UNIT) });
        ctx.font = '600 13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
        ctx.strokeText(text, c.x, c.y); ctx.fillText(text, c.x, c.y);
      } else {
        const text = `${Math.round(label.length * METERS_PER_UNIT)} m`;
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.strokeText(text, c.x, c.y - 10); ctx.fillText(text, c.x, c.y - 10);
      }
    }
    ctx.restore();
  } else scene.setLotOverlay(null);

  if (game.tool === 'building') buildings.drawOverlay(ctx);
  // The bulldozer's box, on the ground: its edges follow the land.
  const bulldozeBox = bulldozer.box();
  if (bulldozeBox) {
    const { a, b } = bulldozeBox;
    const corners = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    ctx.save();
    ctx.beginPath();
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % 4]!;
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / GRID_CELL));
      for (let k = 0; k < n; k++) {
        const on = { x: p.x + (q.x - p.x) * k / n, y: p.y + (q.y - p.y) * k / n };
        const s = view.toScreen(on, w, h, sceneHeightAt(on));
        if (i === 0 && k === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(227, 108, 96, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#ff6b5e';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.restore();
  }

  const strokeScreen = (
    points: readonly Vec2[],
    colour: string | CanvasGradient | CanvasPattern,
    width: number,
    dash: readonly number[] = [],
    projected?: readonly Vec2[],
  ): void => {
    if (points.length < 2) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([...dash]);
    ctx.beginPath();
    const first = projected?.[0] ?? at(points[0] as Vec2);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) {
      const p = projected?.[i] ?? at(points[i] as Vec2);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const ring = (centre: Vec2, radius: number, colour: string, width: number,
    projected?: Vec2): void => {
    const c = projected ?? at(centre);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  };

  // The road's centre line, picked or under the pointer, only with the Information tool in hand
  const infoTool = game.tool === 'inspect' && document.body.dataset['infoTool'] === 'on';
  // Drawn as a translucent band the width of the carriageway, not a line down its middle
  const roadBand = (id: SegmentId, colour: string): void => {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) return;
    const mid = ribbon.full.sampleAt(ribbon.full.length / 2);
    const a = at(mid.p);
    const b = at({ x: mid.p.x + mid.n.x * ribbon.road.width / 2, y: mid.p.y + mid.n.y * ribbon.road.width / 2 });
    strokeScreen(ribbon.full.toPoints(), colour, Math.max(3, 2 * Math.hypot(b.x - a.x, b.y - a.y)));
  };
  if (infoTool && game.selectedSegment !== null) roadBand(game.selectedSegment, 'rgba(120, 200, 255, 0.28)');
  if (infoTool && hoverAnchor?.kind === 'segment' && hoverAnchor.segment !== undefined && hoverAnchor.segment !== game.selectedSegment) {
    roadBand(hoverAnchor.segment, 'rgba(255, 255, 255, 0.14)');
  }

  if (game.selectedNode !== null) {
    const node = doc.node(game.selectedNode);
    if (node) ring({ x: node.x, y: node.y }, 12, SELECTION, 2);
  }

  // The node a road would start from, when the cursor is snapping to one.
  if (game.tool === 'road' && !roadTool.draft && hoverAnchor?.kind === 'node') {
    ring(hoverAnchor.at, 9, HOVER, 2);
  }

  // The brush, drawn where it will land.
  if (game.tool === 'terrain' && hoverAnchor) {
    const brush = terrainBrush.at ?? hoverAnchor.at;
    const centre = at(brush);
    const xEdge = at({ x: brush.x + game.terrainRadius, y: brush.y });
    const yEdge = at({ x: brush.x, y: brush.y + game.terrainRadius });
    const rx = Math.max(4, Math.hypot(xEdge.x - centre.x, xEdge.y - centre.y));
    const ry = Math.max(4, Math.hypot(yEdge.x - centre.x, yEdge.y - centre.y));
    const colour = TERRAIN_BRUSH_COLOUR[game.terrainMode];
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.fillStyle = TERRAIN_BRUSH_FILL[game.terrainMode];
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner ring: the half-strength contour, scaled by the strength setting so a heavier brush visibly bites deeper.
    const strengthMax = TERRAIN_STRENGTH_RANGE[1];
    const bite = 0.3 + 0.35 * (game.terrainStrength / strengthMax);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, rx * bite, ry * bite, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(centre.x - 5, centre.y);
    ctx.lineTo(centre.x + 5, centre.y);
    ctx.moveTo(centre.x, centre.y - 5);
    ctx.lineTo(centre.x, centre.y + 5);
    ctx.stroke();

    const height = terrainBrush.level ?? sceneHeightAt(brush);
    const label = game.terrainMode === 'flatten'
      ? `${t('terrain.level')} ${formatDecimal(height, 1)}`
      : formatDecimal(height, 1);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const width = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(12,18,16,0.76)';
    ctx.beginPath();
    ctx.roundRect(centre.x - width / 2, centre.y - ry - 24, width, 17, 8);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.fillText(label, centre.x, centre.y - ry - 10);
    ctx.restore();
  }

  // With the control tool up, every junction states what it is doing.
  if (game.tool === 'control') {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The junctions on screen only (`net.junctionCells`), never every node of the map each frame.
    for (const id of net.junctionCells.idsMeeting(groundOnScreen(w, h))) {
      const node = doc.node(id);
      if (!node || node.incident.length < 3) continue;
      const centre = at({ x: node.x, y: node.y });
      const colour = CONTROL_COLOUR[node.control] ?? HOVER;
      const hot = hoverAnchor?.kind === 'node' && hoverAnchor.node === node.id;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, hot ? 13 : 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,18,16,0.72)';
      ctx.fill();
      ctx.strokeStyle = colour;
      ctx.lineWidth = hot ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.fillText(CONTROL_GLYPH[node.control] ?? '?', centre.x, centre.y + 0.5);
    }
  }

  // The road just laid, as previewed, while the world with it is still being built.
  const shownRoad = roadTool.preview(!scene.worldBusy && !topologyAfterDraw);
  const settling = shownRoad?.settling ?? false;
  const roadPreview: RoadDraft | null = shownRoad?.road ?? null;
  if (roadPreview) {
    // The profile the road will be laid with: its lanes and its parking.
    const chosenWidth = roadWidth();
    const plainRt = roadProfile(game.roadTypeIndex, game.roadLanePreset);
    // A road picked from the catalogue (or customised) is previewed as it will be laid.
    const picked = drawProfile();
    const rt = picked ? profileRoad(picked.profile, picked.type) : roadProfile(game.roadTypeIndex, game.roadLanePreset,
      roadType(game.roadTypeIndex).lanes === 1 ? 'aToB' : 'both',
      chosenWidth === null ? undefined : sectionForWidth(plainRt, chosenWidth, Math.round(plainRt.speedLimit * 3.6 * METERS_PER_UNIT)),
      roadParking());
    const pieces = roadTool.pieces(roadPreview);
    const groundUnder = (p: Vec2): number => scene.terrainHeightAt(p.x, p.y);
    const points: Vec2[] = [];
    const projected: Vec2[] = [];
    const groundProjected: Vec2[] = [];
    const offsets: number[] = [];
    let previewHeight = roadPreview.startHeightOffset;
    let limited = false;
    for (const [pieceIndex, piece] of pieces.entries()) {
      // Sampled every couple of metres, so the preview lies on the ground as the road will
      const flattened = densify(flattenSegment(piece.start.at, piece.end.at, piece.curve), m(2));
      const pieceLength = flattened.reduce((sum, p, i) =>
        i === 0 ? 0 : sum + dist(p, flattened[i - 1] as Vec2), 0);
      const reach = pieceLength * MAX_AUTHORED_GRADE;
      const nextHeight = clamp(piece.end.heightOffset,
        previewHeight - reach, previewHeight + reach);
      limited ||= Math.abs(nextHeight - piece.end.heightOffset) > 1e-6;
      for (let i = pieceIndex === 0 ? 0 : 1; i < flattened.length; i++) {
        const p = flattened[i] as Vec2;
        const t = i / Math.max(1, flattened.length - 1);
        const eased = t * t * (3 - 2 * t);
        const offset = previewHeight + (nextHeight - previewHeight) * eased;
        const ground = groundUnder(p);
        points.push(p);
        offsets.push(offset);
        groundProjected.push(view.toScreen(p, w, h, ground));
        projected.push(view.toScreen(p, w, h, ground + offset));
      }
      previewHeight = nextHeight;
    }
    // Once the draft is judged, the road as it will be built
    const exact = settling ? null : roadTool.stations();
    const modes: BuildMode[] = [];
    if (exact && exact.length > 1) {
      points.length = projected.length = groundProjected.length = offsets.length = 0;
      for (const st of exact) {
        const p = { x: st.x, y: st.y };
        points.push(p);
        offsets.push(st.deck - groundUnder(p));
        projected.push(view.toScreen(p, w, h, st.deck));
        groundProjected.push(view.toScreen(p, w, h, st.ground));
        modes.push(st.mode);
      }
    }
    const pathLength = points.reduce((sum, point, i) =>
      i === 0 ? 0 : sum + Math.hypot(point.x - (points[i - 1] as Vec2).x, point.y - (points[i - 1] as Vec2).y), 0);
    // A draft the editing rules would refuse, named before it is let go (`RoadTool.verdict`, judged once the pointer rests).
    const refusal = settling ? null : roadTool.verdict();
    const ok = pathLength >= MIN_LINK_LENGTH * 0.25 &&
      !(limited && roadPreview.snap.guide === 'network') && refusal === null;
    // Use the length of both projected world axes.
    const here = points[0] ?? { x: 0, y: 0 };
    const origin = at(here);
    const xAxis = at({ x: here.x + 100, y: here.y });
    const yAxis = at({ x: here.x, y: here.y + 100 });
    const pixelsPerUnit = (
      Math.hypot(xAxis.x - origin.x, xAxis.y - origin.y) +
      Math.hypot(yAxis.x - origin.x, yAxis.y - origin.y)
    ) / 200;
    const asphaltWidth = Math.max(3, rt.width * pixelsPerUnit);
    const kerbWidth = Math.max(asphaltWidth + 2, (rt.width + 1.8) * pixelsPerUnit);
    const footwayWidth = Math.max(kerbWidth + 2, (rt.width + 1.8 + rt.sidewalk * 2) * pixelsPerUnit);
    const casingWidth = Math.max(footwayWidth + 2, footwayWidth + 3 * pixelsPerUnit);

    // The editor used to paint one translucent class-colour stroke here.
    ctx.save();
    if (modes.length > 1) drawBuildModes(ctx, projected, groundProjected, modes);
    else if (points.length > 1 && offsets.some((offset) => Math.abs(offset) > UNITS_PER_METER * 0.5)) {
      strokeScreen(points, 'rgba(6, 19, 21, 0.52)', casingWidth + 5, [7, 7], groundProjected);
      ctx.beginPath();
      ctx.moveTo(projected[0]!.x, projected[0]!.y);
      for (const p of projected.slice(1)) ctx.lineTo(p.x, p.y);
      for (const p of [...groundProjected].reverse()) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = previewHeight >= 0 ? 'rgba(101, 229, 195, 0.16)' : 'rgba(244, 184, 103, 0.20)';
      ctx.fill();
    }
    // Each band of the road as it will be laid
    const band = (half: number, fill: string | CanvasPattern): void => {
      if (points.length < 2) return;
      const left: Vec2[] = [], right: Vec2[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const p = points[i]!, z = (projected[i] && groundProjected[i]) ? offsets[i]! : 0;
        const l = { x: p.x + nx * half, y: p.y + ny * half }, r = { x: p.x - nx * half, y: p.y - ny * half };
        left.push(view.toScreen(l, w, h, groundUnder(l) + z));
        right.push(view.toScreen(r, w, h, groundUnder(r) + z));
      }
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]!.x, right[i]!.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    const asphaltHalf = rt.width / 2, kerbHalf = (rt.width + 1.8) / 2;
    const footwayHalf = (rt.width + 1.8 + rt.sidewalk * 2) / 2, casingHalf = footwayHalf + 1.5;
    if (!settling) band(casingHalf + 2, ok ? SELECTION : INVALID);
    band(casingHalf, '#536b47');
    band(footwayHalf, '#a7a498');
    band(kerbHalf, '#87877f');
    band(asphaltHalf, asphaltPreviewPattern(ctx));
    // A tunnel's stretch is under the land: the road drawn through it, dimmed and dashed.
    if (modes.includes('tunnel')) drawTunnelStretches(ctx, projected, modes, asphaltWidth);
    if (rt.markings !== 'none') {
      const dash = [Math.max(4, 10 * pixelsPerUnit), Math.max(3, 8 * pixelsPerUnit)];
      strokeScreen(points, rt.line, Math.max(1, 1.1 * pixelsPerUnit), dash, projected);
    }
    ctx.restore();
    if (points.length && !settling) {
      ring(roadPreview.start.at, 7, ok ? SELECTION : INVALID, 2, projected[0]);
      ring(roadPreview.snap.at, 7, ok ? SELECTION : INVALID, 2, projected[projected.length - 1]);
      const end = projected[projected.length - 1]!;
      const groundEnd = groundProjected[groundProjected.length - 1]!;
      // The road's length beside the pointer, in steps of 10 m, as SimCity shows it.
      {
        const tens = Math.round((pathLength * METERS_PER_UNIT) / 10) * 10;
        // With the reason a refused draft would be refused, beside its length.
        const cost = settling ? null : roadTool.cost();
        const built = exact && exact.length > 1 ? buildSummary(exact) : '';
        const priced = (cost === null ? `${tens} m` : `${tens} m · ${formatCost(cost)}`) + (built ? ` · ${built}` : '');
        const text = refusal ? `${priced} · ${t(`rule.short.${refusal}`)}` : priced;
        ctx.save();
        ctx.font = '700 13px system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        const bx = clamp(end.x + 16, 8, Math.max(8, w - tw - 28)), by = clamp(end.y - 40, 60, h - 40);
        ctx.fillStyle = 'rgba(9, 27, 28, 0.92)';
        ctx.beginPath();
        ctx.roundRect(bx, by, tw + 18, 24, 6);
        ctx.fill();
        ctx.fillStyle = ok ? '#e7fff7' : '#ffb4ab';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 9, by + 12.5);
        ctx.restore();
      }
      if (Math.abs(previewHeight) > UNITS_PER_METER * 0.5) {
        ctx.save();
        ctx.strokeStyle = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(groundEnd.x, groundEnd.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(groundEnd.x, groundEnd.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const metres = previewHeight / UNITS_PER_METER;
      const grade = pathLength > 1
        ? Math.round(Math.abs(previewHeight - roadPreview.startHeightOffset) / pathLength * 100)
        : 0;
      const label = `${metres >= 0 ? '+' : ''}${formatDecimal(metres, 1)} m · ${grade}%`;
      if (Math.abs(previewHeight) > 0.25 ||
        Math.abs(previewHeight - roadPreview.startHeightOffset) > 0.25) {
        const x = clamp(end.x + 16, 12, Math.max(12, w - 430));
        const y = clamp(end.y + 24, 80, h - 80);
        const baseline = y + 51;
        const levelY = (offset: number): number => baseline -
          clamp(offset / UNITS_PER_METER * 3, -22, 22);
        const startY = levelY(roadPreview.startHeightOffset);
        const endY = levelY(previewHeight);
        const colour = previewHeight >= 0 ? '#7df7d3' : '#ffc864';
        ctx.save();
        ctx.fillStyle = 'rgba(9, 27, 28, 0.94)';
        ctx.fillRect(x, y, 170, 68);
        ctx.strokeStyle = 'rgba(210, 226, 218, 0.55)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x + 12, baseline);
        ctx.lineTo(x + 158, baseline);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x + 12, startY);
        ctx.bezierCurveTo(x + 63, startY, x + 107, endY, x + 158, endY);
        ctx.stroke();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = limited ? '#ffc864' : '#e7fff7';
        ctx.fillText(label, x + 11, y + 16);
        ctx.restore();
      }
    }
  }
}

/** How each stretch of the road in hand will be built, drawn between its deck and the natural ground */
const BUILD_FILL: Readonly<Record<BuildMode, string | null>> = {
  ground: null,
  embankment: 'rgba(164, 120, 74, 0.62)',
  cutting: 'rgba(132, 128, 120, 0.62)',
  bridge: null,
  tunnel: 'rgba(40, 34, 30, 0.55)',
};
const PIER_EVERY = 14;
function drawBuildModes(ctx: CanvasRenderingContext2D, deck: readonly Vec2[], ground: readonly Vec2[], modes: readonly BuildMode[]): void {
  let i = 0;
  while (i < modes.length) {
    const mode = modes[i]!;
    let j = i;
    while (j + 1 < modes.length && modes[j + 1] === mode) j++;
    const a = Math.max(0, i - 1), b = Math.min(modes.length - 1, j + 1);
    const fill = BUILD_FILL[mode];
    if (fill) {
      ctx.beginPath();
      ctx.moveTo(deck[a]!.x, deck[a]!.y);
      for (let k = a + 1; k <= b; k++) ctx.lineTo(deck[k]!.x, deck[k]!.y);
      for (let k = b; k >= a; k--) ctx.lineTo(ground[k]!.x, ground[k]!.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (mode === 'cutting') {
        // The held side of the cut: its top line on the ground.
        ctx.strokeStyle = 'rgba(214, 208, 196, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ground[a]!.x, ground[a]!.y);
        for (let k = a + 1; k <= b; k++) ctx.lineTo(ground[k]!.x, ground[k]!.y);
        ctx.stroke();
      }
    }
    if (mode === 'bridge') {
      ctx.strokeStyle = 'rgba(206, 200, 188, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let k = i; k <= j; k += PIER_EVERY) {
        ctx.moveTo(deck[k]!.x, deck[k]!.y);
        ctx.lineTo(ground[k]!.x, ground[k]!.y);
      }
      ctx.stroke();
    }
    i = j + 1;
  }
}

function drawTunnelStretches(ctx: CanvasRenderingContext2D, deck: readonly Vec2[], modes: readonly BuildMode[], width: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(16, 14, 12, 0.6)';
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (let k = 0; k < modes.length; k++) {
    if (modes[k] !== 'tunnel') continue;
    const start = modes[k - 1] !== 'tunnel';
    if (start) ctx.moveTo(deck[k]!.x, deck[k]!.y);
    else ctx.lineTo(deck[k]!.x, deck[k]!.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** The ways the road in hand is built, beside its length: "ponte 120 m · aterro 40 m". */
function buildSummary(stations: Parameters<typeof buildRuns>[0]): string {
  const totals = new Map<BuildMode, number>();
  for (const run of buildRuns(stations)) totals.set(run.mode, (totals.get(run.mode) ?? 0) + run.to - run.from);
  return [...totals]
    .filter(([mode, length]) => mode !== 'ground' && length * METERS_PER_UNIT >= 5)
    .sort((x, y) => y[1] - x[1])
    .map(([mode, length]) => `${t(mode === 'cutting' && cutWallsChosen() ? 'buildMode.cuttingWalls' : `buildMode.${mode}`)} ${Math.max(10, Math.round((length * METERS_PER_UNIT) / 10) * 10)} m`)
    .join(' · ');
}

/** The brush's colour, by what it does to the ground. */
const TERRAIN_BRUSH_COLOUR: Readonly<Record<BrushMode, string>> = {
  paint: '#f2d27a',
  fog: '#e8eef4',
  cloud: '#ffffff',
  elements: '#b8e07a',
  gully: '#c98a5a',
  trees: '#5fbf5a',
  weather: '#cfe3ff',
  raise: SELECTION,
  lower: '#ffc864',
  flatten: '#cfd8d4',
  river: '#73cfe7',
  mesa: '#e29a5c',
  canyon: '#e29a5c',
  escarpment: '#9aa0a8',
  sugarloaf: '#c9c4bb',
};

const TERRAIN_BRUSH_FILL: Readonly<Record<BrushMode, string>> = {
  paint: 'rgba(242,210,122,0.10)',
  fog: 'rgba(232,238,244,0.12)',
  cloud: 'rgba(255,255,255,0)',
  elements: 'rgba(184,224,122,0.10)',
  gully: 'rgba(201,138,90,0.10)',
  trees: 'rgba(95,191,90,0.10)',
  weather: 'rgba(207,227,255,0)',
  raise: 'rgba(101,229,195,0.08)',
  lower: 'rgba(255,200,100,0.08)',
  flatten: 'rgba(207,216,212,0.08)',
  river: 'rgba(70,160,190,0.12)',
  mesa: 'rgba(226,154,92,0.10)',
  canyon: 'rgba(226,154,92,0.10)',
  escarpment: 'rgba(154,160,168,0.10)',
  sugarloaf: 'rgba(201,196,187,0.10)',
};

/** One glyph and one colour per control mode. */
const CONTROL_GLYPH: Readonly<Record<JunctionControl, string>> = {
  auto: 'A',
  signal: 'S',
  priority: 'P',
  stop: '\u25A0',
  yield: '\u25BC',
  none: '\u2013',
  mini: '○',
};

const CONTROL_COLOUR: Readonly<Record<JunctionControl, string>> = {
  auto: '#8fb3a6',
  signal: '#ffd24a',
  priority: '#7ec8ff',
  stop: '#ff7a6a',
  yield: '#ffb057',
  none: '#9aa3a0',
  mini: '#c9b6ff',
};

function setNodeHeightMetres(id: NodeId, metres: number): void {
  const node = doc.node(id);
  if (!node || !Number.isFinite(metres) || node.heightOffset === metres * UNITS_PER_METER) return;
  let lower = -Infinity;
  let upper = Infinity;
  for (const segmentId of node.incident) {
    const segment = doc.segment(segmentId);
    if (!segment) continue;
    const other = doc.node(segment.a === id ? segment.b : segment.a);
    if (!other) continue;
    const rise = net.polylines.get(doc, segmentId).length * MAX_AUTHORED_GRADE;
    lower = Math.max(lower, other.heightOffset - rise);
    upper = Math.min(upper, other.heightOffset + rise);
  }
  const requested = metres * UNITS_PER_METER;
  const height = lower <= upper ? clamp(requested, lower, upper) : node.heightOffset;
  if (height === node.heightOffset) {
    if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
    return;
  }
  mutateRoads(() => {
    doc.setNodeHeightOffset(id, height);
    return true;
  });
  if (Math.abs(height - requested) > 1e-6) flashHint('hint.road.gradeLimited');
}

function showInspector(): void {
  openInspector(
    doc,
    net,
    simHost.inspect,
    { segment: game.selectedSegment, node: game.selectedNode },
    {
      onUpgrade: (id) => {
        const seg = doc.segment(id);
        if (!seg || seg.type >= LAST_UPGRADE_CLASS) return;
        mutateRoads(() => {
          doc.setSegmentType(id, seg.type + 1);
          return true;
        });
      },
      onSetType: (id, type) => {
        const seg = doc.segment(id);
        if (!seg || seg.type === type) return;
        mutateRoads(() => {
          doc.setSegmentType(id, type);
          return true;
        });
      },
      onSetLanes: (id, lanes) => {
        if (!doc.segment(id)) return;
        mutateRoads(() => {
          doc.setSegmentLanes(id, lanes);
          return true;
        });
      },
      onSetParking: (id, parking) => {
        if (!doc.segment(id)) return;
        mutateRoads(() => {
          doc.setSegmentParking(id, parking);
          return true;
        });
      },
      // A profile or template applied to the road in place: judged and paid for as every road edit
      onApplyProfile: (id, profile, type) => {
        if (!doc.segment(id)) return;
        let problem: string | undefined;
        mutateRoads(() => {
          const result = applyProfileTo(doc, [id], profile, type);
          problem = result.problems[0];
          return result.changed;
        });
        if (problem) flashHint(`profile.problem.${problem}`);
      },
      // V8: the road's profile on the whole street it runs in, one edit, paid for.
      streetLength: (id) => streetChain(doc, id).length,
      onProfileToStreet: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const profile = profileOf(seg);
        let problem: string | undefined;
        mutateRoads(() => {
          let changed = false;
          for (const piece of streetChain(doc, id)) {
            if (piece.id === id) continue;
            const result = applyProfileTo(doc, [piece.id], piece.flipped ? flipProfile(profile) : profile, seg.type);
            problem ??= result.problems[0];
            changed = result.changed || changed;
          }
          return changed;
        });
        flashHint(problem ? `profile.problem.${problem}` : 'hint.profile.toStreet');
      },
      // The eyedropper: the road tool in hand, drawing with the profile just picked.
      onDrawWithProfile: () => {
        // The road tool's panel opened, showing the profile picked.
        shell?.openTool('road');
        flashHint('hint.profile.picked');
      },
      onSetSection: (id, section) => {
        if (!freeRoadsEnabled() || !doc.segment(id)) return;
        mutateRoads(() => {
          doc.setSegmentSection(id, section);
          return true;
        });
      },
      onSetDirection: (id, direction) => {
        if (!doc.segment(id)) return;
        mutateRoads(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSetNodeHeight: setNodeHeightMetres,
      onSetNodeEnd: (node, end) => mutateRoads(() => {
        doc.setNodeEnd(node, end);
        return true;
      }),
      onReverseDirection: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const direction = seg.direction === 'aToB' ? 'bToA' : 'aToB';
        mutateRoads(() => {
          doc.setSegmentDirection(id, direction);
          return true;
        });
      },
      onSplit: (id) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const polyline = net.polylines.get(doc, id);
        const at = polyline.sampleAt(polyline.length / 2).p;
        mutateRoads(() => splitSegment(doc, net, id, polyline.length / 2, at) !== null);
      },
      onAddCrossing: (id, kind) => {
        if (!doc.segment(id)) return;
        // Where the player clicked on the road, or its middle.
        const chosen = game.selectedSegment === id && game.selectedSegmentS !== null ? game.selectedSegmentS : undefined;
        let placed: NodeId | null = null;
        mutate(() => {
          const result = commitPedestrianCrossing(doc, net, id, kind, chosen);
          if (!result.committed) {
            flashHint(`hint.crossing.${result.reason}`);
            return false;
          }
          placed = result.node;
          return true;
        });
        if (placed !== null) {
          select(null, null, placed, 'point inserted on the road');
          showInspector();
        }
      },
      onAddUturn: (id, toward) => {
        if (!doc.segment(id)) return;
        const chosen = game.selectedSegment === id && game.selectedSegmentS !== null ? game.selectedSegmentS : undefined;
        let placed: NodeId | null = null;
        mutateRoads(() => {
          const result = commitUturn(doc, net, id, toward, chosen);
          if (!result.committed) {
            flashHint(`hint.uturn.${result.reason}`);
            return false;
          }
          placed = result.node;
          return true;
        });
        if (placed !== null) flashHint('hint.uturn.placed');
      },
      onRemoveCrossing: (node) => {
        mutate(() => {
          if (!doc.node(node)?.crossing) return false;
          doc.clearNodeCrossing(node);
          return true;
        });
      },
      onAddHeightPoint: (id) => {
        if (!doc.segment(id)) return;
        const polyline = net.polylines.get(doc, id);
        if (polyline.length < 20) { flashHint('hint.road.invalid'); return; }
        const chosen = game.selectedSegment === id && game.selectedSegmentS !== null
          ? game.selectedSegmentS : polyline.length / 2;
        const s = chosen < 5 || chosen > polyline.length - 5
          ? polyline.length / 2 : chosen;
        let node: NodeId | null = null;
        if (!mutateRoads(() => {
          node = splitSegment(doc, net, id, s, polyline.sampleAt(s).p);
          if (node === null) return false;
          doc.requireNode(node).smooth = true;
          return true;
        })) node = null;
        if (node !== null) {
          select(null, null, node, 'smooth point inserted');
          showInspector();
        }
      },
      onDuplicate: (id) => {
        duplicateSelectedSegment(id);
      },
      onSetControl: (id, control) => {
        if (!doc.node(id)) return;
        mutate(() => {
          doc.setNodeControl(id, control);
          return true;
        });
      },
      onSetMovementBlocked: (node, from, to, blocked) => {
        if (!doc.node(node)) return;
        mutate(() => {
          doc.setMovementBlocked(node, from, to, blocked);
          return true;
        });
      },
      project: (x, y) => view.toScreen({ x, y }, surface.cssW, surface.cssH),
      // Each leg's rule and the signal's settings.
      onSetApproachRules: (node, rules) => {
        if (!doc.node(node)) return;
        mutate(() => { doc.setNodeApproachRules(node, rules); return true; });
      },
      onSetSignal: (node, settings) => {
        if (!doc.node(node)) return;
        mutate(() => { doc.setNodeSignal(node, settings); return true; });
      },
      onSetSignals: (settings) => {
        mutate(() => { for (const [node, s] of settings) doc.setNodeSignal(node, s); return true; });
      },
      // The player's lane connections at a junction.
      onSetLaneLinks: (node, links) => {
        if (!doc.node(node)) return;
        mutate(() => {
          doc.setNodeLaneLinks(node, links);
          return true;
        });
      },
      onSetCurve: (id, curve) => {
        const seg = doc.segment(id);
        if (!seg) return;
        const unchanged =
          seg.curve === curve ||
          (seg.curve !== null && curve !== null && seg.curve.t === curve.t && seg.curve.h === curve.h);
        if (unchanged) return;
        mutateRoads(() => {
          doc.setSegmentCurve(id, curve);
          return true;
        });
      },
      onJoin: (node) => {
        mutateRoads(() => joinSegments(doc, node));
        select(game.selectedSegment, game.selectedSegmentS, null, 'roads joined');
        closeInspector();
      },
      onRemoveNode: (node) => {
        mutate(() => {
          const source = doc.node(node);
          if (!source) return false;
          for (const seg of [...source.incident]) doc.removeSegment(seg);
          doc.removeNode(node);
          doc.pruneOrphanNodes();
          return true;
        });
        select(game.selectedSegment, game.selectedSegmentS, null, 'point removed');
        closeInspector();
      },
      onDelete: (id) => {
        mutate(() => {
          doc.removeSegment(id);
          doc.pruneOrphanNodes();
          return true;
        });
        select(null, game.selectedSegmentS, game.selectedNode, 'road deleted');
        closeInspector();
      },
    },
  );
}

/** Duplicates the inspected road and keeps the copy selected for immediate editing. */
function duplicateSelectedSegment(id = game.selectedSegment): void {
  if (id === null) return;
  let copy: SegmentId | null = null;
  if (!mutateRoads(() => {
    copy = duplicateSegment(doc, net, id);
    return copy !== null;
  })) copy = null;
  if (copy !== null) {
    select(copy, game.selectedSegmentS, null, 'road duplicated');
    showInspector();
  }
}

/** Who shows the city's numbers (the interface, `onStatus`). */
const statusListeners: ((status: ShellStatus) => void)[] = [];
/** The city's numbers now: the clock, the traffic, the money, the junctions that cannot be built. */
function currentStatus(): ShellStatus {
  // The time of day and the residents' day (`sim/city`).
  const minutes = simHost.minutes % 1440;
  const { speedSum, queued, vehicles } = shown.stats;
  return {
    clock: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`,
    // The cars driving into and out of the lots' bays are cars driving too (`sim/agents/lotTraffic.ts`).
    vehicles: vehicleCountLabel(vehicles + shown.stats.lotsMoving),
    people: peopleCountLabel(shown.stats.peds),
    // The city's numbers, computed all along and shown nowhere (audit P2-02).
    trips: String(shown.stats.trips),
    lost: String(shown.stats.lost),
    meanSpeed: vehicles ? `${Math.round((speedSum / vehicles) * METERS_PER_UNIT * 3.6)} km/h` : '—',
    queued: String(queued),
    impossible: net.impossible.size,
    balance: doc.economy.balance,
  };
}
/** Tells the interface the city's numbers (a few times a second while the city runs, and after an edit). */
function updateStatus(): void {
  if (statusListeners.length === 0) return;
  const status = currentStatus();
  for (const listen of statusListeners) listen(status);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Do not let a hidden tab's elapsed wall time flood the accumulator.
    frameClock.restart();
    requestDraw();
  }
});

/** Closing the game saves it. */
const CLOSE_WAIT_MS = 8000;
function saveOnClose(): (event: BeforeUnloadEvent) => void {
  let saved = false;
  return (event) => {
    if (saved) return;
    persistence.saveSession(doc, sessionSettings());
    if (location.protocol !== 'app:') return;
    event.preventDefault();
    event.returnValue = '';
    void Promise.race([persistence.written(), new Promise((done) => setTimeout(done, CLOSE_WAIT_MS))]).then(() => {
      saved = true;
      window.close();
    });
  };
}
window.addEventListener('beforeunload', saveOnClose());
// A hidden or discarded tab may never see `beforeunload` (phones, tab freezing).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistence.flush();
});
window.addEventListener('pagehide', () => persistence.saveSession(doc, sessionSettings()));

// A failed write says so, at most once a minute, instead of losing the map at the next reload in silence.
let saveWarnedAt = -Infinity;
persistence.onSaveFailed = () => {
  const now = performance.now();
  if (now - saveWarnedAt < 60_000) return;
  saveWarnedAt = now;
  flashHint('hint.saveFailed');
};

requestDraw();

// The flat camera put where the view is before the first frame
syncFlatCameraFromView();

// ------------------------------------------------------------- language & quality

// Anything rendered from script rather than from markup has to be re-rendered when the language changes
onLanguageChange(() => {
  buildings.languageChanged();
  hintShown = '';
  updateHint();
  updateStatus();
  refreshInspector();
  requestDraw();
});

/** The map's road paint (`world/roads/markingStyle.ts`) */
function setMarkingStyle(value: string): void {
  if (!isMarkingStyle(value) || value === doc.markingStyle) return;
  history.begin(doc);
  doc.setMarkingStyle(value);
  persistence.saveSessionSoon(doc, sessionSettings);
  updateHistoryButtons();
  requestDraw();
}

const QUALITY_STORAGE_KEY = 'roadcraft.quality';
const savedQuality = (() => {
  try {
    return window.localStorage.getItem(QUALITY_STORAGE_KEY);
  } catch {
    return null;
  }
})();
gameState.set('quality', isQualityLevel(savedQuality) ? savedQuality : 'high', 'saved preference');
function setQuality(value: string): void {
  if (!isQualityLevel(value)) return;
  gameState.set('quality', value, 'quality menu');
  scene.setQuality(value);
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, value);
  } catch {
    // Not remembering the choice is not a reason to refuse it.
  }
  requestDraw();
}
/** The game's state in the console (`core/gameState.ts`): `__state()` its values now and the last changes */
(window as unknown as { __state: unknown }).__state = (count = 20): unknown => ({
  now: gameState.snapshot(),
  changes: gameState.latest(count).map((c) => `#${c.serial} ${c.key}: ${String(c.from)} → ${String(c.to)} (${c.cause})`),
  toolMachine: tools.latest(count).map((r) => `#${r.serial} ${r.from} → ${r.to} (${r.event})`),
});
/** The game's health in the console (`core/health.ts`): what broke or was slow, newest first. */
(window as unknown as { __health: unknown }).__health = (count = 30): unknown => health.latest(count);
/** The last frames per system (`core/health.ts` `frameStats`) */
(window as unknown as { __frames: unknown }).__frames = (since = 0): unknown =>
  frameStats(frameTimer.recent().filter((f) => f.start >= since));
/** The GPU time of the frames drawn since the last `__gpu(true)` (or the last 40 s) */
/** The F9 monitor's GPU lines (state tab, the whole width) */
function gpuLines(): string[] {
  const t = scene.gpu;
  const name = t.label.replace(/^ANGLE \([^,]*,\s*/, '').replace(/\s*\(0x[0-9A-Fa-f]+\).*$/, '').replace(/\s*Direct3D.*$/, '');
  if (!t.supported) return ['gpu: —', `gpuName: ${name || '—'}`];
  const s = t.samples.stats(STUTTER_MS);
  return [`gpu: p50 ${s.p50} · p95 ${s.p95} · p99 ${s.p99} · max ${s.max} ms · n ${s.n}`, `gpuName: ${name}`];
}
(window as unknown as { __gpu: unknown }).__gpu = (reset = false): unknown => {
  const t = scene.gpu;
  const out = { supported: t.supported, label: t.label, ...t.samples.stats(STUTTER_MS), skipped: t.skipped, disjoint: t.disjoint };
  if (reset) t.samples.clear();
  return out;
};

/** The simulation's own checks (`sim/invariants.ts`, run every 60 ticks) in the health log */
const issuesSeen = new WeakSet<object>();
function noteSimulationIssues(): void {
  for (const issue of simHost.issues()) {
    if (issuesSeen.has(issue)) continue;
    issuesSeen.add(issue);
    // Shown in the F9 monitor: the words from the dictionaries.
    health.record('invariant', 'warning', t('health.msg.invariant', { code: issue.code }),
      { detail: t('health.msg.invariantDetail', { subject: issue.subject, detail: issue.detail, tick: issue.tick }) });
  }
}

const valueText = (value: unknown): string => (value === null || value === undefined ? '—' : typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value));
const healthPanel = mountHealthPanel({
  log: health,
  world: (n) => doc.changes.latest(n).map((c) => {
    const where = c.rects === null ? t('health.world.whole') : t('health.world.rects', { count: c.rects.length });
    return `#${c.serial} ${c.kind} · ${c.cause}${c.parent ? ` ← #${c.parent}` : ''} · ${where}${c.ms !== undefined ? ` · ${c.ms.toFixed(1)} ms` : ''}${c.detail ? ` · ${c.detail}` : ''}`;
  }),
  state: (n) => ({
    now: [
      ...Object.entries(gameState.snapshot()).map(([key, value]) => `${key}: ${valueText(value)}`),
      ...tools.latest(3).map((r) => `tool machine #${r.serial}: ${r.from} → ${r.to} (${r.event})`),
    ],
    wide: [...gpuLines(),
      t('health.state.simulation', { ms: simHost.health().stepMs.toFixed(1), share: Math.round(simHost.health().share * 100), vehicles: shown.stats.vehicles, people: shown.stats.peds })],
    changes: gameState.latest(n).map((c) => `${c.key}: ${valueText(c.from)} → ${valueText(c.to)} (${c.cause})`),
  }),
});
/** The diary of changes in the console (`world/changes.ts`): `__changes()` lists the last ones */
(window as unknown as { __changes: unknown }).__changes = (count = 30, serial?: number): unknown => {
  const row = (c: Change) => ({
    serial: c.serial, kind: c.kind, cause: c.cause, after: c.parent ?? '',
    where: c.rects === null ? 'whole map' : `${c.rects.length} rects ${Math.round(c.rects.reduce((a, r) => a + (r[2] - r[0]) * (r[3] - r[1]), 0) / 1e3)}k u²`,
    ids: c.ids?.slice(0, 8).join(' ') ?? '', ms: c.ms === undefined ? '' : c.ms.toFixed(1), detail: c.detail ?? '',
  });
  if (serial !== undefined) {
    const chain: Change[] = [];
    for (let c = doc.changes.get(serial); c && chain.length < count; c = c.parent ? doc.changes.get(c.parent) : undefined) chain.push(c);
    console.table(chain.map(row));
    return chain;
  }
  const rows = doc.changes.latest(count);
  console.table(rows.map(row));
  return rows;
};

// Diagnostic surface for browser-driven checks.
(window as unknown as { __roadcraft: unknown }).__roadcraft = {
  /** The surgical profiler's numbers (`core/profiler.ts`), as its HUD shows them. */
  profiler: () => profiler.view(),
  /** The engine's ledger: each product's computes, last refresh and in all (`core/engine.ts`). */
  ledger: () => Object.fromEntries(engine.ledger),
  doc,
  net,
  /** The simulation's world where it runs on the page (`?sim=page`), null in its worker; `shown` is what is drawn of it. */
  sim: simHost.world,
  shown,
  camera,
  surface,
  DT,
  exportMap: () => exportToFile(doc, sessionSettings()),
  importMap: async () => openImported(await importFromFile()),
  /** The public transport tool. */
  transit: transitEditor,
  setTraffic: (enabled: boolean) => {
    if (!game.paused !== enabled) setSpeed(game.paused ? game.speed : 0);
  },
  setRoadHeight: (metres: number) => {
    roadTool.heightChosen(metres * UNITS_PER_METER);
    requestDraw();
  },
  /** A generated city (`editor/cityGenerator.ts`), and how far its building has gone. */
  generateCity: (options: Partial<CityOptions> = {}) => generateCity({ ...DEFAULT_CITY, ...options }),
  /** Probe: one building grown on a zoned lot, and what it cost (ms). */
  growTimed: () => { const t = performance.now(); const id = growOnLot({ doc, net, groundAt: (x, y) => scene.terrainHeightAt(x, y), pavedAt: (x, y) => scene.pavedHeightAt(x, y) }, lotTool.refused, 0x5eed); return { id, ms: performance.now() - t }; },
  cityGrowth: () => (cityGrowth || cityProgress.style.display === 'block' ? { pending: true } : null),
  cityBuiltIn: () => cityBuiltIn,
  /** Replaces the map as loading a file does: document, network and simulation topology. */
  loadDoc: (data: ReturnType<RoadDoc['toJSON']>) => {
    history.begin(doc);
    applySnapshot(data, 'import');
  },
  /** Centres the play camera on a world point, so the next frame builds what is there */
  /** The transport tool, for the browser checks. */
  transitTool: () => transitEditor,
  lookAt: (x: number, y: number, zoom = camera.zoom) => {
    camera.x = x;
    camera.y = y;
    camera.zoom = zoom;
    syncViewFromFlatCamera();
    requestDraw();
  },
  /** The camera put at a centre, zoom, bearing and tilt (radians) exactly, as `view()` reads them (`scripts/look.mjs`) */
  setView: (at: { x: number; y: number; zoom: number; azimuth: number; elevation: number }) => {
    camera.x = at.x;
    camera.y = at.y;
    camera.zoom = at.zoom;
    syncViewFromFlatCamera();
    view.setOrbit(at.azimuth, at.elevation);
    view.moveTo({ x: at.x, y: at.y });
    requestDraw();
  },
  /** Forces one frame. Used by the browser verification harness. */
  redraw: () => requestDraw(),
  /** What the scene holds in memory, in MB (`render/memoryCounters.ts`) */
  /** Everything the scene holds, by layer and kind of mesh (`render/inventory.ts`) */
  inventory: (options: { text?: boolean; top?: number } = {}) => {
    const inv = sceneInventory(scene.scene);
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const counts = {
      doc: {
        nodes: doc.nodes.size, segments: doc.segments.size, buildings: doc.buildings.size, lots: doc.lots.length, poles: doc.poles.size,
        landscape: doc.landscape.size, barriers: doc.barriers.size, trees: doc.trees.length, zones: doc.zones.length, people: doc.people.length,
      },
      sim: { vehicles: shown.stats.vehicles, people: shown.stats.peds },
      gl: { geometries: scene.gl.info.memory.geometries, textures: scene.gl.info.memory.textures, programs: scene.gl.info.programs?.length ?? 0, drawCalls: scene.stats.drawCalls, triangles: scene.stats.triangles },
      heapMB: heap === undefined ? null : Math.round(heap / 1e6),
    };
    if (options.text) return `${formatInventory(inv, options.top ?? 40)}

${JSON.stringify(counts)}`;
    return { ...inv, counts };
  },
  memory: () => {
    const mb = (bytes: number): number => Math.round(bytes / 1e5) / 10;
    const c = countMemory(scene.scene);
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return {
      geometryMB: mb(c.geometryBytes), geometryCpuMB: mb(c.geometryCpuBytes), textureMB: mb(c.textureBytes), targetMB: mb(scene.targetBytes()),
      heapMB: heap === undefined ? null : mb(heap),
      cpuByName: c.cpuByName.map(([name, bytes]) => `${name} ${mb(bytes)}`),
      buffers: c.buffers, textures: c.textures,
      glGeometries: scene.gl.info.memory.geometries, glTextures: scene.gl.info.memory.textures, programs: scene.gl.info.programs?.length ?? 0,
      drawCalls: scene.stats.drawCalls, triangles: scene.stats.triangles,
    };
  },
  /** The running game against the city plan's budgets */
  budget: (view: CityView) => {
    if (!(view in VIEW_BUDGETS)) throw new Error(`view: ${Object.keys(VIEW_BUDGETS).join(' | ')}`);
    const c = countMemory(scene.scene);
    const gpu = scene.gpu.supported ? scene.gpu.samples.toArray().slice(-120).sort((a, b) => a - b) : [];
    const rows = cityBudgetTable({
      view,
      triangles: scene.gl.info.render.triangles,
      drawCalls: scene.gl.info.render.calls,
      gpuMs: gpu.length ? Math.round(gpu[Math.ceil(gpu.length * 0.95) - 1]! * 10) / 10 : null,
      fps: scene.stats.fps,
      bytesByName: c.bytesByName,
      textureBytes: c.textureBytes,
      targetBytes: scene.targetBytes(),
      geometryCpuBytes: c.geometryCpuBytes,
      heapBytes: (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    });
    console.table(rows);
    return rows;
  },
  /** Runs the simulation for `seconds` of SIMULATION time, immediately. */
  runSim: (seconds: number) => {
    simHost.run(seconds);
    requestDraw();
  },
  pickAtScreen: (x: number, y: number) =>
    findAnchor(
      doc,
      net,
      worldAtScreen(x, y),
      view.zoom,
    ),
  // The pole tool, as the tool itself runs it: plan from two raw points, then commit that plan.
  utilities: {
    plan: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) =>
      planPoleRun(doc, net, from, to, reach),
    run: (from: Vec2, to: Vec2, reach = POLE_PICK_PIXELS / view.zoom) => {
      const plan = planPoleRun(doc, net, from, to, reach);
      return mutateBuilt(() => commitPoleRun(doc, plan));
    },
  },
  audit: () => [...simHost.issues()],
  /** The live three.js scene handle, for browser-driven checks. */
  scene: () => scene,
  /** The orbit camera (`setOrbit(azimuth, elevation)`), for photographing from a chosen angle. */
  view: () => view,
  /** The building tool, for browser-driven checks. */
  buildings: buildings.tool,
  /** One fixed simulation step, as the game takes it, without traffic or new pedestrians if asked. */
  step: (traffic = true, pedestrians = true) => simHost.step(traffic, pedestrians),
};

/** A polyline with points added so no step is longer than `step`. */
function densify(points: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  points.forEach((p, i) => {
    if (i === 0) { out.push(p); return; }
    const q = points[i - 1]!;
    const n = Math.max(1, Math.ceil(dist(p, q) / step));
    for (let k = 1; k <= n; k++) out.push({ x: q.x + (p.x - q.x) * (k / n), y: q.y + (p.y - q.y) * (k / n) });
  });
  return out;
}

/** Whether the road tool is drawing a road right now (a drag, a chained stretch or a curve). */
/** Asks the interface to redraw its panels (a state it shows changed in the game). */
function refreshShell(): void {
  const host = document.getElementById('game');
  if (host) { const t = host.dataset['tool'] ?? ''; host.dataset['tool'] = ''; host.dataset['tool'] = t; }
}

// Buildings run down without maintenance (`world/buildings/decayWatch.ts`)
const decayLook = createDecayWatch(doc, (id, decay) => caused('building wear', () => doc.buildings.wear(id, decay)));
const decayWatch = (): void => { if (decayLook(simHost.minutes)) requestDraw(); };
/** The buildings' decay looked at every 3 s of the city's time (`frame`), not on the wall clock. */
const decayDue = new SimPeriodic(3);

/** The Actions (`actionsWiring.ts`): the pistol, the bomb, the buildings it breaks and the fires it leaves. */
const actions = createActions({
  doc,
  net,
  sim: shown,
  control: simHost.control,
  time: () => simHost.time,
  scene,
  buildingAt: (screen) => buildings.tool.buildingAt(screen),
  view: () => view,
  size: () => ({ w: surface.cssW, h: surface.cssH }),
  heightAt: (p) => sceneHeightAt(p),
  strength: () => strikeChoice.strength,
  mutate: (fn) => mutate(fn),
  caused: (cause, fn) => caused(cause, fn),
  hint: (key) => flashHint(key),
  redraw: () => requestDraw(),
  holdGrowth: (seconds) => { zoneGrowthHold = { at: simHost.time, until: simHost.time + seconds }; },
});

// Everything is set up: the first frame may be drawn.
booted = true;
requestDraw();
