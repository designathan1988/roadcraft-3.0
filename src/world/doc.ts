import { type MarkingStyleId, isMarkingStyle } from './roads/markingStyle';
import { type ApproachRuleEntry, type SignalSettings, normalizeApproachRules, normalizeSignalSettings, rulesDigest, signalDigest } from './roads/rules';
import { type LaneLink, linksDigest, movementKey, normalizeLaneLinks } from './roads/connectors';
import { cloneRoadSection, normalizeRoadSection, sameRoadSection, type RoadSection } from './roadSection';
import { isLot, type Lot } from './lots';
import { OpenLots } from './openLots';
import { LotStore } from './lotStore';
import type { Vec2 } from '@core/vec2';
import { type CurveShape, fitShapeToRadius } from '@core/bezier';
import {
  type NodeId,
  type PoleId,
  type SegmentId,
  type SpanId,
  IdAllocator,
  asNodeId,
  asPoleId,
  asSegmentId,
  asSpanId,
} from './ids';
import type { UtilityPole, UtilitySpan } from './utilities';
import { type Barrier, type BarrierKind, isBarrierKind } from './barriers';
// Runtime imports, and safe: `geometry` and `legAngles` take `RoadDoc` as a TYPE only
import { TUNNEL_HEADROOM, type RoadStructure, migrateStructure } from './structures';
import { MAX_TERRAIN_STAMPS, RELIEF_LEGACY, readRelief, type ReliefVersion, type TerrainStamp } from './terrain';
import { clampToMap } from './bounds';
import { normalizeParking, sameParking, type SegmentParking } from './parking';
import { type LandscapeItem, type LandscapeKind, type SignType, SIGN_TEXT_MAX, isLandscapeKind, isSignType } from './landscape';
import { MAX_PAINT_DABS, type PaintDab, isPaintKind } from './terrainPaint';
import { MAX_PLACED_CLOUDS, readCloud, type PlacedCloud } from './clouds';
import { DEFAULT_WEATHER, readWeather, type Weather } from './weather';
import { DEFAULT_ECONOMY, readEconomy, type Economy } from './economy';
import { MAX_PLANTED_TREES, MAX_TREE_CLEARINGS, readPlantedTree, readTreeClearing, type PlantedTree, type TreeClearing } from './trees';
import { MAX_ELEMENTS, readElement, type ElementItem, type ElementKind } from './elements';
import { DEFAULT_GULLY_AUTO, MAX_GULLY_DABS, readGullyDab, type GullyDab } from './gullies';
import { DEFAULT_FOG, MAX_FOG_DABS, readFogDab, readFogSettings, type FogDab, type FogSettings } from './fogPaint';
import { isNatureSettings, type NatureSettings } from './ecology';
import { type TransitData, emptyTransit, hasTransit, normalizeTransit } from './transit';
import { type SegmentDirection, casingHalf, roadProfile } from './roadTypes';
import { BuildingStore } from './buildings/store';
import type { SerializedBuilding } from './buildings/serialize';
import type { Building, BuildingId } from './buildings/types';
import { isZoneDensity, isZoneMark, isZoneUse, type Zone, type ZoneMark } from './zones';
import { normalizePerson, type PersonSpec } from '@people/spec';
import { ChangeJournal, rectAround, type ChangeRect, type DocChangeKind } from './changes';
import { PoleIndex } from './poleIndex';
import { CellFiling } from './cells';
import { rescaleSerializedDoc } from './rescale';
import { METERS_PER_UNIT, m } from './units';
import { ForkMap, forkWork } from '@core/forkMap';

/** `shape` flattened until no band of a road of this profile folds over (see `RoadDoc.fitCurve`). */
export function fitRoadCurve(
  a: Vec2, b: Vec2, shape: CurveShape | null, type: number,
  lanes: number | null = null, direction: SegmentDirection = 'both', section?: RoadSection,
  parking?: SegmentParking,
): CurveShape | null {
  return fitShapeToRadius(a, b, shape, casingHalf(roadProfile(type, lanes, direction, section, parking)));
}

/** Legal driving directions, relative to the stored `a -> b` orientation (`roadTypes.ts`). */
export type { SegmentDirection };

/** Explicit junction policy. `auto` retains the class-based default policy. */
/** 'mini': a mini-roundabout: every entry gives way to whoever is in it or comes from the left. */
export type JunctionControl = 'auto' | 'signal' | 'stop' | 'yield' | 'priority' | 'none' | 'mini';

/** Stable segment-pair key for a movement through a junction (`roads/connectors.ts`). */
export { movementKey };

/** Whether a movement key names segment `id` as its entry or its exit. */
function movementMentions(key: string, id: SegmentId): boolean {
  const cut = key.indexOf('>');
  const text = String(id);
  return key.slice(0, cut) === text || key.slice(cut + 1) === text;
}

export interface RoadNode {
  readonly id: NodeId;
  x: number;
  y: number;
  /** Authored height above or below the designed ground, in world units. */
  heightOffset: number;
  /** An internal control point of one continuous road gesture. */
  smooth: boolean;
  /** Materialized incidence list. */
  readonly incident: SegmentId[];
  control: JunctionControl;
  blockedMovements: string[];
  /** A pedestrian crossing placed mid-block, on a node that joins exactly two roads. */
  crossing?: NodeCrossing;
  /** The player's own lane connections at this node (`roads/connectors.ts`) */
  laneLinks?: readonly LaneLink[];
  /** Each leg's rule under 'priority' control (`roads/rules.ts`); absent legs: derived. */
  approachRules?: readonly ApproachRuleEntry[];
  /** A signal's settings (V5): fixed time, greens, offset, bus priority; absent: adaptive. */
  signal?: SignalSettings;
  /** What a road's end is: absent, the map's edge, where traffic leaves and comes in */
  end?: RoadEnd;
  /** A U-turn through an opening in the median (retorno) */
  uturn?: SegmentId;
}

/** A road's end that is not the map's edge: a turning circle. */
export type RoadEnd = 'bulb';

export type NodeCrossingKind = 'zebra' | 'signal';
export interface NodeCrossing {
  readonly kind: NodeCrossingKind;
  readonly segment: SegmentId;
}

export interface RoadSegment {
  readonly id: SegmentId;
  a: NodeId;
  b: NodeId;
  /** Null means a straight segment; see `CurveShape` for why `h` is absolute. */
  curve: CurveShape | null;
  type: number;
  /** Arc-length offset of this segment's start within the road it was drawn as. */
  dashOrigin: number;
  direction: SegmentDirection;
  /** Optional total travel-lane count; omitted means the class default. */
  lanes: number | null;
  /** Authored cross-section; absent preserves the exact class profile. */
  section?: RoadSection;
  /** On-street parking left and right of a -> b (`parking.ts`); absent means none. */
  parking?: SegmentParking;
  /** Vertical construction mode. Ground is the legacy/default value. */
  structure: RoadStructure;
  /** The sides of its cutting held by retaining walls instead of a batter */
  cutWalls?: true;
}

/** One that keeps road records by reference (`RoadDoc.keepRoads`): told before a record is first changed in place, to keep it as it stood. */
export interface RoadKeeper {
  beforeWrite(part: 'nodes' | 'segments', record: RoadNode | RoadSegment): void;
}

/** The authoring document: what the user drew, before any derived geometry. */
/** The place a run of points (a wall, a span of wire) covers, for the diary of changes: one box round them all. */
function rectsAlong(points: readonly { readonly x: number; readonly y: number }[], pad: number): ChangeRect[] {
  const r = rectAround(points, pad);
  return r ? [r] : [];
}

export class RoadDoc {
  readonly nodes = new Map<NodeId, RoadNode>();
  readonly segments = new Map<SegmentId, RoadSegment>();
  /** The nodes that may have been left with no road (`pruneOrphanNodes`) */
  private loose = new LooseNodes();
  /** Who keeps road records by reference (`keepRoads`), held weakly: the only writes of a record in place go through `nodeToWrite` and `segmentToWrite`. */
  private roadKeepers: WeakRef<RoadKeeper>[] = [];

  /** The overhead utility network: poles and the wire runs between them. */
  // DO NOT write these maps directly.
  private poleMap: Map<PoleId, UtilityPole> = new Map();
  private spanMap: Map<SpanId, UtilitySpan> = new Map();
  private poleIndex = new PoleIndex();
  get poles(): ReadonlyMap<PoleId, UtilityPole> { return this.poleMap; }
  get poleSpans(): ReadonlyMap<SpanId, UtilitySpan> { return this.spanMap; }

  /** Walls, fences and hedges drawn along paths (`barriers.ts`). */
  // DO NOT write this map directly.
  private barrierMap: Map<number, Barrier> = new Map();
  get barriers(): ReadonlyMap<number, Barrier> { return this.barrierMap; }
  /** The barriers by place (`barriersIn`), filed over the box of their points. */
  private barrierCells = new CellFiling<number, Barrier>(LANDSCAPE_CELL);
  private barrierIds = new IdAllocator(1);

  /** Street landscaping the player placed on the footways: trees, shrubs, benches, bins, street lights, hydrants, post boxes */
  // DO NOT write this map directly.
  private landscapeMap: Map<number, LandscapeItem> = new Map();
  get landscape(): ReadonlyMap<number, LandscapeItem> { return this.landscapeMap; }
  /** The street furniture by place (`landscapeIn`), in cells a few items wide. */
  private landscapeCells = new CellFiling<number, LandscapeItem>(LANDSCAPE_CELL);
  /** How many street name plates carry each name (`roads/streetNames.ts` gives a new street a name none has). */
  private streetNameCount = new Map<string, number>();
  get streetNamesInUse(): ReadonlyMap<string, number> { return this.streetNameCount; }
  private landscapeIds = new IdAllocator(1);

  /** Public transport the player laid out: bus stops and terminals, train and metro tracks and stations, lines */
  transit: TransitData = emptyTransit();

  /** The public transport replaced by an edit of it. */
  setTransit(next: TransitData): void {
    this.transit = next;    this.changes.record('transit', null);
  }

  private nodeIds = new IdAllocator(1);
  private segIds = new IdAllocator(1);
  private poleIds = new IdAllocator(1);
  private spanIds = new IdAllocator(1);
  private nextTerrainId = 1;

  readonly terrainStamps: TerrainStamp[] = [];
  /** The land this map was made on (`world/terrain.ts` `ReliefVersion`). */
  terrainRelief: ReliefVersion = RELIEF_LEGACY;
  /** The regional standard of the map's road paint */
  markingStyle: MarkingStyleId = 'classic';
  /** The map's ecosystem (`world/ecology.ts`): its biome and seed. */
  nature: NatureSettings | null = null;
  /** Ground painted over the terrain (`terrainPaint.ts`), oldest first. */
  readonly terrainPaint: PaintDab[] = [];
  /** Fog painted over the land (`fogPaint.ts`), oldest first, and how it behaves. */
  readonly fogDabs: FogDab[] = [];
  fogSettings: FogSettings = DEFAULT_FOG;
  /** Gullies cut or wiped with the brush (`gullies.ts`), oldest first, and how much of the steep land carries them of itself (0..1). */
  readonly gullyDabs: GullyDab[] = [];
  gullyAuto = DEFAULT_GULLY_AUTO;
  /** Clouds the player placed in the sky (`clouds.ts`). */
  readonly clouds: PlacedCloud[] = [];
  /** The map's weather (`weather.ts`). */
  weather: Weather = DEFAULT_WEATHER;
  /** The money the roads are paid from (`economy.ts`). */
  economy: Economy = DEFAULT_ECONOMY;
  /** Trees the player planted (`trees.ts`), oldest first. */
  readonly trees: PlantedTree[] = [];
  /** The planted trees by place (`treesIn`), made when first asked and then kept by the writers */
  private treeGrid: ItemGrid<PlantedTree> | null = null;
  /** @rebuild The whole list filed only on the first ask after it was replaced whole; the writers keep it after. */
  private get treeCells(): ItemGrid<PlantedTree> {
    if (!this.treeGrid) {
      this.treeGrid = new ItemGrid(LANDSCAPE_CELL);
      for (const t of this.trees) this.treeGrid.add(t);
    }
    return this.treeGrid;
  }

  /** The planted trees standing in the cells a rectangle reaches (a superset: test each). */
  treesIn(rect: ChangeRect): PlantedTree[] {
    // A working copy that has not written its trees reads the original's filing (`fork`).
    if (this.below && this.sharedLists.has('trees')) return this.below.treesIn(rect);
    return this.treeCells.near(rect);
  }
  /** Where trees were cut away, the woods' own too (`trees.ts`), oldest first. */
  readonly treeClearings: TreeClearing[] = [];
  /** DO NOT push or splice it from outside. */
  readonly elements: ElementItem[] = [];
  /** The elements by place (`elementsIn`): made when first asked, null after the whole list is replaced (as `treeGrid`). */
  private elementGrid: ItemGrid<ElementItem> | null = null;
  /** @rebuild The whole list filed only on the first ask after it was replaced whole; the writers keep it after. */
  private get elementCells(): ItemGrid<ElementItem> {
    if (!this.elementGrid) {
      this.elementGrid = new ItemGrid(LANDSCAPE_CELL);
      for (const e of this.elements) this.elementGrid.add(e);
    }
    return this.elementGrid;
  }

  /** The elements standing in the cells a rectangle reaches (a superset: test each). */
  elementsIn(rect: ChangeRect): ElementItem[] {
    if (this.below && this.sharedLists.has('elements')) return this.below.elementsIn(rect);
    return this.elementCells.near(rect);
  }

  /** What changed in this document, where and why (`changes.ts`) */
  readonly changes = new ChangeJournal();
  /** The document this one was copied from (`clone`) and that document's diary serial then */
  private forkedFrom: { readonly doc: RoadDoc; readonly version: number } | null = null;
  /** The document this one is a working copy OVER (`fork`) */
  private below: RoadDoc | null = null;
  /** The lists still the original's (`fork`): each copied the first time this copy writes it (`ownList`). */
  private sharedLists = new Set<DocListPart>();
  /** The indices by place still the original's (`fork`): copied when this copy first writes their kind (`ownIndex`). */
  private sharedIndices = new Set<IndexKind>();

  /** The document this working copy was made from (`clone`), while that one still stands as it was then */
  get forkOrigin(): RoadDoc | null {
    const fork = this.forkedFrom;
    return fork && fork.doc.changes.version === fork.version ? fork.doc : null;
  }

  /** The ids (of nodes and of segments: they share the roads' entries) the diary names in the road changes that turned */
  roadIdsChangedFrom(before: RoadDoc): Set<number> | null {
    const mine = this.forkedFrom, theirs = before.forkedFrom;
    let since: number | null = null;
    if (mine && mine.doc === before && mine.version === before.changes.version) since = mine.version;
    else if (theirs && theirs.doc === this && theirs.version === before.changes.version) since = theirs.version;
    else if (mine && theirs && mine.doc === theirs.doc && mine.version === theirs.version && theirs.version === before.changes.version) since = mine.version;
    return since === null ? null : this.changes.idsSince(since, ROAD_KINDS);
  }

  /** Modular buildings. */
  readonly buildings = new BuildingStore(this.changes);

  /** Authored land-use strokes, separate from the buildings they generated. */
  readonly zones: Zone[] = [];
  nextZoneId = 1;
  /** The zoned cells of the street grid (`world/zoneGrid.ts`), stored by place. */
  readonly zoneMarks: ZoneMark[] = [];
  /** The land's lots (`world/lots.ts`): the cadastre the player zones and edits, with its owner (`lotStore.ts`) */
  readonly lotStore = new LotStore(this.changes);
  /** @deprecated The lots as an array, in their order: made again after each change, for the readers that still walk the whole list */
  get lots(): readonly Lot[] {
    return this.lotStore.list();
  }
  /** The blocks and strips already cut into lots, so a lot deleted on purpose is not made again. */
  get lotKeys(): readonly string[] {
    return this.lotStore.keys;
  }
  /** The id the next lot gets. */
  get nextLotId(): number {
    return this.lotStore.nextId;
  }
  /** A lot by its id. */
  lot(id: number): Lot | undefined {
    return this.lotStore.get(id);
  }
  /** The lots whose box meets a rectangle (a superset: test each), in increasing id order. */
  lotsIn(rect: ChangeRect): Lot[] {
    return this.lotStore.in(rect);
  }
  /** The lot whose shape holds a point, or undefined. */
  lotAt(p: Vec2): Lot | undefined {
    return this.lotStore.at(p);
  }
  /** The open lots in order and by place, for the growth (`openLots.ts`): made when first asked, kept by the diary's entries by id. */
  private openLotsIndex: OpenLots | null = null;
  get openLots(): OpenLots {
    return this.openLotsIndex ??= new OpenLots({
      lots: this.lotStore,
      standing: (id) => this.buildings.has(id as BuildingId),
      place: (id) => { const b = this.buildings.get(id as BuildingId); return b ? { x: b.x, y: b.y } : null; },
      buildingsRevision: () => this.buildings.revision,
      buildingsSince: (serial) => this.changes.since(serial, ['buildings']),
    });
  }

  /** The zoning changed there (`zoneRevision`): the way in for the tools that change it in place */
  zonesChanged(rects: readonly ChangeRect[] | null, cause?: string): void {
    this.changes.record('zones', rects, cause ? { cause } : {});
  }

  /** The people made in the Person Creator, saved with the city. */
  readonly people: PersonSpec[] = [];

  /** Adds a person, or replaces the one with the same id. */
  savePerson(person: PersonSpec): void {
    this.ownList('people');
    const at = this.people.findIndex((p) => p.id === person.id);
    if (at >= 0) this.people[at] = person;
    else this.people.push(person);    this.changes.record('people', null, { ids: [person.id] });
  }

  removePerson(id: number): void {
    const at = this.people.findIndex((p) => p.id === id);
    if (at < 0) return;
    this.ownList('people');
    this.people.splice(at, 1);    this.changes.record('people', null, { ids: [id] });
  }

  /** An id no saved person has. */
  nextPersonId(): number {
    return this.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  }

  // ------------------------------------------------------------ revisions Each is the serial of the latest diary entry of

  /** The roads' geometry: every structural change; consumers use it to invalidate caches. */
  get revision(): number { return this.changes.serialOf('roads'); }
  /** Horizontal road and junction topology read by vehicles and pedestrians. */
  get trafficRevision(): number { return this.changes.serialOf('traffic'); }
  get terrainRevision(): number { return this.changes.serialOf('terrain'); }
  /** Pole and wire edits and the street landscaping, which do NOT move `revision` */
  get utilityRevision(): number { return this.changes.serialOf('utilities', 'landscape'); }
  /** Walls, fences and hedges: a fence drawn must not rebuild the roads. */
  get barrierRevision(): number { return this.changes.serialOf('barriers'); }
  /** Public transport: a bus stop placed never rebuilds the roads. */
  get transitRevision(): number { return this.changes.serialOf('transit'); }
  get natureRevision(): number { return this.changes.serialOf('nature'); }
  get paintRevision(): number { return this.changes.serialOf('paint'); }
  get fogRevision(): number { return this.changes.serialOf('fog'); }
  get gullyRevision(): number { return this.changes.serialOf('gullies'); }
  get cloudRevision(): number { return this.changes.serialOf('clouds'); }
  get weatherRevision(): number { return this.changes.serialOf('weather'); }
  get treeRevision(): number { return this.changes.serialOf('trees'); }
  get clearingRevision(): number { return this.changes.serialOf('clearings'); }
  get elementRevision(): number { return this.changes.serialOf('elements'); }
  get zoneRevision(): number { return this.changes.serialOf('zones'); }
  get lotRevision(): number { return this.changes.serialOf('lots'); }
  get peopleRevision(): number { return this.changes.serialOf('people'); }
  get economyRevision(): number { return this.changes.serialOf('economy'); }

  /** A road segment's rectangle as drawn: its ends, its bulge and its width. */
  segmentRect(id: SegmentId): ChangeRect | null {
    const s = this.segments.get(id);
    if (!s) return null;
    const a = this.nodes.get(s.a), b = this.nodes.get(s.b);
    if (!a || !b) return null;
    return rectAround([a, b], casingHalf(roadProfile(s.type, s.lanes, s.direction, s.section, s.parking)) + Math.abs(s.curve?.h ?? 0));
  }

  /** A node's rectangle: the junction round it, out to its roads' widths. */
  nodeRect(id: NodeId): ChangeRect | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    let pad = NODE_PAD;
    for (const sid of n.incident) {
      const s = this.segments.get(sid);
      if (s) pad = Math.max(pad, casingHalf(roadProfile(s.type, s.lanes, s.direction, s.section, s.parking)) * 2);
    }
    return rectAround([n], pad);
  }

  node(id: NodeId): RoadNode | undefined {
    return this.nodes.get(id);
  }

  segment(id: SegmentId): RoadSegment | undefined {
    return this.segments.get(id);
  }

  requireNode(id: NodeId): RoadNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`RoadDoc: missing node ${id}`);
    return n;
  }

  requireSegment(id: SegmentId): RoadSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`RoadDoc: missing segment ${id}`);
    return s;
  }

  pole(id: PoleId): UtilityPole | undefined {
    return this.poles.get(id);
  }

  addPole(at: { x: number; y: number }, lamp = false): UtilityPole {
    const on = clampToMap(at);
    const id = asPoleId(this.poleIds.take());
    const pole: UtilityPole = { id, x: on.x, y: on.y, lamp };
    this.putPoleRecord(pole);
    this.changes.record('utilities', [rectAround([pole], ITEM_PAD)!], { ids: [id] });
    return pole;
  }

  /** The poles standing in the cells a rectangle reaches (`PoleIndex.near`): a superset, test each. */
  polesIn(rect: ChangeRect): UtilityPole[] {
    return this.poleIndex.near(rect).map((id) => this.poleMap.get(id)!);
  }

  /** The spans reaching a pole, in the order they were strung. */
  spansAt(id: PoleId): UtilitySpan[] {
    return [...this.poleIndex.spansAt(id)].map((sid) => this.spanMap.get(sid)!);
  }

  private putPoleRecord(pole: UtilityPole): void {
    this.ownIndex('poles');
    this.poleMap.set(pole.id, pole);
    this.poleIndex.putPole(pole);
  }

  private deletePoleRecord(id: PoleId): void {
    this.ownIndex('poles');
    this.poleMap.delete(id);
    this.poleIndex.deletePole(id);
  }

  private putSpanRecord(span: UtilitySpan): void {
    this.ownIndex('poles');
    const was = this.spanMap.get(span.id);
    this.spanMap.set(span.id, span);
    // The same ends: the span keeps its place in each pole's order, as in the map.
    if (was && was.a === span.a && was.b === span.b) return;
    if (was) this.poleIndex.deleteSpan(was);
    this.poleIndex.putSpan(span);
  }

  private deleteSpanRecord(id: SpanId): void {
    const was = this.spanMap.get(id);
    if (!was) return;
    this.ownIndex('poles');
    this.spanMap.delete(id);
    this.poleIndex.deleteSpan(was);
  }

  private clearPoleRecords(): void {
    this.poleMap.clear();
    this.spanMap.clear();
    // A working copy's index is the original's until it writes: a new one, never the shared one cleared.
    if (this.sharedIndices.delete('poles')) this.poleIndex = new PoleIndex();
    else this.poleIndex.clear();
  }

  /** Strings wire between two existing poles. Returns null for a degenerate run. */
  addPoleSpan(a: PoleId, b: PoleId): UtilitySpan | null {
    if (a === b) return null;
    if (!this.poles.has(a) || !this.poles.has(b)) return null;
    for (const existing of this.spansAt(a)) {
      if (existing.a === b || existing.b === b) return existing;
    }
    const id = asSpanId(this.spanIds.take());
    const span: UtilitySpan = { id, a, b };
    this.putSpanRecord(span);
    this.changes.record('utilities', rectsAlong([this.poles.get(a)!, this.poles.get(b)!], ITEM_PAD), { ids: [a, b, id] });
    return span;
  }

  /** Draws a barrier along `points` (two or more, on the map). */
  addBarrier(kind: BarrierKind, points: readonly { x: number; y: number }[]): Barrier | null {
    const path = points.map((p) => clampToMap(p));
    if (path.length < 2) return null;
    const barrier: Barrier = { id: this.barrierIds.take(), kind, points: path.map((p) => ({ x: p.x, y: p.y })) };
    this.putBarrierRecord(barrier);
    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [barrier.id] });
    return barrier;
  }

  removeBarrier(id: number): boolean {
    const barrier = this.barriers.get(id);
    if (!barrier) return false;
    this.deleteBarrierRecord(id);
    this.changes.record('barriers', rectsAlong(barrier.points, ITEM_PAD), { ids: [id] });
    return true;
  }

  /** The barriers whose box reaches a rectangle (a superset: test each), in increasing id order. */
  /** The barriers whose box reaches any of `rects` (a superset: test each), each once, in increasing id order (`CellFiling.idsMeetingAny`). */
  barriersInAny(rects: readonly ChangeRect[]): Barrier[] {
    return this.barrierCells.idsMeetingAny(rects).map((id) => this.barrierMap.get(id)!);
  }

  barriersIn(rect: ChangeRect): Barrier[] {
    return this.barrierCells.idsMeeting(rect).map((id) => this.barrierMap.get(id)!);
  }

  /** A barrier put (new, or replacing the one of its id, which keeps its place in the map's order). */
  private putBarrierRecord(barrier: Barrier): void {
    this.ownIndex('barriers');
    this.barrierMap.set(barrier.id, barrier);
    this.barrierCells.file(barrier.id, barrier, rectAround(barrier.points)!);
  }

  private deleteBarrierRecord(id: number): void {
    this.ownIndex('barriers');
    this.barrierMap.delete(id);
    this.barrierCells.remove(id);
  }

  private clearBarrierRecords(): void {
    this.barrierMap.clear();
    if (this.sharedIndices.delete('barriers')) this.barrierCells = new CellFiling(LANDSCAPE_CELL);
    else this.barrierCells.copyFrom(new CellFiling(LANDSCAPE_CELL));
  }

  /** The barrier whose path passes nearest a point, within `radius`, or null: those round it only (`barriersIn`). */
  barrierNear(at: { x: number; y: number }, radius: number): Barrier | null {
    let best: Barrier | null = null;
    let bestD = radius;
    for (const barrier of this.barriersIn([at.x - radius, at.y - radius, at.x + radius, at.y + radius])) {
      for (let i = 1; i < barrier.points.length; i++) {
        const a = barrier.points[i - 1]!, b = barrier.points[i]!, q = at;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = dx * dx + dy * dy;
        const t = len > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len)) : 0;
        const d = Math.hypot(a.x + dx * t - q.x, a.y + dy * t - q.y);
        if (d < bestD) { bestD = d; best = barrier; }
      }
    }
    return best;
  }

  /** Places one landscaping item where `snapLandscape` put it. */
  addLandscape(kind: LandscapeKind, at: { x: number; y: number }, extra: { signType?: SignType; text?: string; planted?: number } = {}): LandscapeItem {
    return this.addLandscapeMany([{ kind, at, extra }])[0]!;
  }

  /** DO NOT place a batch item by item with `addLandscape` */
  addLandscapeMany(list: readonly { readonly kind: LandscapeKind; readonly at: { x: number; y: number };
    readonly extra?: { signType?: SignType; text?: string; planted?: number } }[]): LandscapeItem[] {
    const items = list.map(({ kind, at, extra = {} }) => {
      const on = clampToMap(at);
      const text = extra.text?.slice(0, SIGN_TEXT_MAX);
      const item: LandscapeItem = { id: this.landscapeIds.take(), kind, x: on.x, y: on.y,
        ...(extra.signType ? { signType: extra.signType } : {}), ...(text ? { text } : {}),
        ...(extra.planted !== undefined && Number.isFinite(extra.planted) ? { planted: extra.planted } : {}) };
      this.putLandscapeRecord(item);
      return item;
    });
    if (items.length) this.changes.record('landscape', items.map((item) => rectAround([item], ITEM_PAD)!), { ids: items.map((item) => item.id) });
    return items;
  }

  removeLandscape(id: number): boolean {
    const item = this.landscape.get(id);
    if (!item) return false;
    this.deleteLandscapeRecord(id);
    this.changes.record('landscape', [rectAround([item], ITEM_PAD)!], { ids: [id] });
    return true;
  }

  /** The street furniture standing in the cells a rectangle reaches (a superset: test each), in increasing id order. */
  landscapeIn(rect: ChangeRect): LandscapeItem[] {
    return this.landscapeCells.idsMeeting(rect).map((id) => this.landscapeMap.get(id)!);
  }

  /** The street furniture whose box reaches any of `rects`, each once, in increasing id order (`CellFiling.idsMeetingAny`). */
  landscapeInAny(rects: readonly ChangeRect[]): LandscapeItem[] {
    return this.landscapeCells.idsMeetingAny(rects).map((id) => this.landscapeMap.get(id)!);
  }

  /** A record put (new, or replacing the one of its id, which keeps its place in the map's order). */
  private putLandscapeRecord(item: LandscapeItem): void {
    this.ownIndex('landscape');
    const was = this.landscapeMap.get(item.id);
    if (was) this.countStreetName(was, -1);
    this.landscapeMap.set(item.id, item);
    this.landscapeCells.file(item.id, item, [item.x, item.y, item.x, item.y]);
    this.countStreetName(item, 1);
  }

  private deleteLandscapeRecord(id: number): void {
    const was = this.landscapeMap.get(id);
    if (!was) return;
    this.ownIndex('landscape');
    this.landscapeMap.delete(id);
    this.landscapeCells.remove(id);
    this.countStreetName(was, -1);
  }

  private countStreetName(item: LandscapeItem, by: 1 | -1): void {
    if (item.kind !== 'streetname' || !item.text) return;
    const n = (this.streetNameCount.get(item.text) ?? 0) + by;
    if (n > 0) this.streetNameCount.set(item.text, n); else this.streetNameCount.delete(item.text);
  }

  private clearLandscapeRecords(): void {
    this.landscapeMap.clear();
    if (this.sharedIndices.delete('landscape')) {
      this.landscapeCells = new CellFiling(LANDSCAPE_CELL);
      this.streetNameCount = new Map();
    } else {
      this.landscapeCells.copyFrom(new CellFiling(LANDSCAPE_CELL));
      this.streetNameCount.clear();
    }
  }

  /** Removes a pole and every wire that reached it. */
  removePole(id: PoleId): void {
    const pole = this.poles.get(id);
    if (!pole) return;
    const reached: { x: number; y: number }[] = [pole];
    // The pole and its spans by id (a reader by id: the undo image).
    const ids: number[] = [id];
    for (const span of this.spansAt(id)) {
      const other = this.poles.get(span.a === id ? span.b : span.a);
      if (other) reached.push(other);
      this.deleteSpanRecord(span.id);
      ids.push(span.id);
    }
    this.deletePoleRecord(id);
    this.changes.record('utilities', [rectAround(reached, ITEM_PAD)!], { ids });
  }

  /** The pole nearest a point, within `radius`, or null. */
  poleNear(at: { x: number; y: number }, radius: number): UtilityPole | null {
    let best: UtilityPole | null = null;
    let bestSq = radius * radius;
    for (const pole of this.polesIn([at.x - radius, at.y - radius, at.x + radius, at.y + radius])) {
      const dx = pole.x - at.x;
      const dy = pole.y - at.y;
      const d = dx * dx + dy * dy;
      if (d <= bestSq) {
        bestSq = d;
        best = pole;
      }
    }
    return best;
  }

  degree(id: NodeId): number {
    return this.nodes.get(id)?.incident.length ?? 0;
  }

  /** Whether a node is the map's edge: the end of one road, where traffic and people come in from outside and leave */
  mapEdge(id: NodeId): boolean {
    const node = this.nodes.get(id);
    return !!node && node.incident.length === 1 && node.end !== 'bulb';
  }

  // ---------------------------------------------------------------- mutation

  /** Adds a node, ON THE MAP. */
  addNode(p: Vec2, heightOffset = 0, smooth = false): RoadNode {
    const at = clampToMap(p);
    const id = asNodeId(this.nodeIds.take());
    const n: RoadNode = { id, x: at.x, y: at.y, heightOffset, smooth,
      incident: [], control: 'auto', blockedMovements: [] };
    this.nodes.set(id, n);
    this.loose.add(id);
    this.markNode(id);
    return n;
  }

  /** Whether a road at `structure` already joins `a` and `b` directly. */
  connects(a: NodeId, b: NodeId, structure: RoadStructure): boolean {
    const node = this.nodes.get(a);
    if (!node) return false;
    return node.incident.some((id) => {
      const s = this.segments.get(id);
      return s !== undefined && s.structure === structure && ((s.a === a && s.b === b) || (s.a === b && s.b === a));
    });
  }

  addSegment(
    a: NodeId,
    b: NodeId,
    type: number,
    curve: CurveShape | null = null,
    dashOrigin = 0,
    direction: SegmentDirection = 'both',
    lanes: number | null = null,
    structure: RoadStructure = 'ground',
    section?: RoadSection,
    parking?: SegmentParking,
  ): RoadSegment | null {
    if (a === b) return null;
    if (!this.nodes.has(a) || !this.nodes.has(b)) return null;
    const authoredSection = normalizeRoadSection(section);
    const authoredParking = normalizeParking(parking);
    const id = asSegmentId(this.segIds.take());
    const s: RoadSegment = {
      id, a, b, curve, type, dashOrigin, direction,
      lanes: normaliseLaneCount(lanes, direction),
      structure,
      ...(authoredSection ? { section: authoredSection } : {}),
      ...(authoredParking ? { parking: authoredParking } : {}),
    };
    this.segments.set(id, s);
    this.nodeToWrite(a)!.incident.push(id);
    this.nodeToWrite(b)!.incident.push(id);
    // A third road turns a mid-block crossing into a junction.
    for (const end of [a, b]) dropStaleCrossing(this.nodeToWrite(end));
    this.fitCurve(s);
    this.markSegment(id);
    return s;
  }

  removeSegment(id: SegmentId): void {
    const s = this.segments.get(id);
    if (!s) return;
    this.markSegment(id);
    detach(this.nodeToWrite(s.a), id);
    detach(this.nodeToWrite(s.b), id);
    this.loose.add(s.a);
    this.loose.add(s.b);
    // A turn ban naming a road that is gone bans nothing
    for (const end of [s.a, s.b]) {
      const n = this.nodeToWrite(end);
      if (!n) continue;
      for (let i = n.blockedMovements.length - 1; i >= 0; i--) {
        if (movementMentions(n.blockedMovements[i] as string, id)) n.blockedMovements.splice(i, 1);
      }
      dropStaleCrossing(n);
    }
    this.segments.delete(id);
  }

  /** Re-applies the turn bans `saved` at `node` that named segment `from`, naming `to` instead. */
  carryMovements(node: NodeId, saved: readonly string[], from: SegmentId, to: SegmentId): void {
    const n = this.nodeToWrite(node);
    if (!n) return;
    for (const key of saved) {
      if (!movementMentions(key, from)) continue;
      const [a, b] = key.split('>') as [string, string];
      const moved = `${a === String(from) ? to : a}>${b === String(from) ? to : b}`;
      if (!n.blockedMovements.includes(moved)) n.blockedMovements.push(moved);
    }
    // The geometry is the same; what moves is the plan the traffic runs on.
    this.changes.record('traffic', this.rectsOrMap(this.nodeRect(node)), { ids: [node], detail: 'turn bans carried' });
  }

  /** Re-applies a crossing `saved` at `node` that lay on segment `from` to the segment `to` that replaced it there */
  carryCrossing(node: NodeId, saved: NodeCrossing | undefined, from: SegmentId, to: SegmentId): void {
    if (!this.nodes.has(node) || !saved || saved.segment !== from) return;
    const n = this.nodeToWrite(node)!;
    n.crossing = { kind: saved.kind, segment: to };
    dropStaleCrossing(n);
    this.markNode(node);
  }

  removeNode(id: NodeId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const where = this.rectsOrMap(this.nodeRect(id));
    for (const sid of n.incident.slice()) this.removeSegment(sid);
    this.nodes.delete(id);
    this.roadsChanged(where, true, { ids: [id], detail: 'node removed' });
  }

  /** Rewires every segment from `source` into `target`, then removes `source`. */
  mergeNodes(target: NodeId, source: NodeId): boolean {
    if (target === source) return true;
    const kept = this.nodes.get(target);
    const removed = this.nodes.get(source);
    if (!kept || !removed) return false;
    if (Math.abs(kept.heightOffset - removed.heightOffset) > 0.75) return false;
    const keep = this.nodeToWrite(target)!;
    const remove = this.nodeToWrite(source)!;

    if (keep.control === 'auto' && remove.control !== 'auto') keep.control = remove.control;
    for (const movement of remove.blockedMovements) {
      if (!keep.blockedMovements.includes(movement)) keep.blockedMovements.push(movement);
    }

    // Where the node that goes stood: its junction is gone from there.
    const gone = this.nodeRect(source);
    for (const id of remove.incident.slice()) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const other = segment.a === source ? segment.b : segment.a;
      // A road to the node being kept folds to nothing
      if (other === target || this.connects(target, other, segment.structure)) {
        this.removeSegment(id);
        continue;
      }
      const before = this.segmentRect(id);
      const moved = this.segmentToWrite(id)!;
      if (moved.a === source) moved.a = target;
      if (moved.b === source) moved.b = target;
      detach(remove, id);
      if (!keep.incident.includes(id)) keep.incident.push(id);
      this.markSegment(id, before);
    }
    this.nodes.delete(source);
    dropStaleCrossing(keep);
    this.markNode(target, true, gone ? [gone] : []);
    // The node that went, by id, for a reader by id (its rectangle is in the entry above).
    this.roadsChanged(gone ? [gone] : null, true, { ids: [source], detail: 'node merged away' });
    return true;
  }

  /** Moves a node freely; junction geometry adapts to the resulting angle. */
  moveNode(id: NodeId, to: Vec2): boolean {
    const was = this.nodes.get(id);
    if (!was) return false;
    // Dragging a node off the plate is the same offence as building one there, and is caught in the same place.
    const p = clampToMap(to);
    if (was.x === p.x && was.y === p.y) return true;

    // DO NOT write only the rectangle after the move: whatever is derived where the node was
    const before = this.roadAreas(id);
    const n = this.nodeToWrite(id)!;
    n.x = p.x;
    n.y = p.y;
    for (const segId of n.incident) {
      const seg = this.segments.get(segId);
      if (seg) this.fitCurve(seg);
    }
    this.markNode(id, true, [...before, ...this.roadAreas(id)]);
    return true;
  }

  /** A node's junction and its roads' rectangles, as they stand now. */
  private roadAreas(id: NodeId): ChangeRect[] {
    const out: ChangeRect[] = [];
    const rect = this.nodeRect(id);
    if (rect) out.push(rect);
    for (const sid of this.nodes.get(id)?.incident ?? []) {
      const s = this.segmentRect(sid);
      if (s) out.push(s);
    }
    return out;
  }

  /** A curve is never tighter than its road is wide. */
  private fitCurve(s: RoadSegment): void {
    if (!s.curve) return;
    const a = this.nodes.get(s.a);
    const b = this.nodes.get(s.b);
    if (!a || !b) return;
    const fitted = fitRoadCurve(a, b, s.curve, s.type, s.lanes, s.direction, s.section, s.parking);
    if (fitted !== s.curve) {
      // `s` may be the original's record, read through by a working copy: the change goes to its own.
      this.segmentToWrite(s.id)!.curve = fitted;
      this.markSegment(s.id);
    }
  }

  // The setters below write where the road was as well as where it is (`markSegment`'s `before`)
  setSegmentType(id: SegmentId, type: number): void {
    const was = this.segments.get(id);
    if (!was || was.type === type) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.type = type;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentCurve(id: SegmentId, curve: CurveShape | null): void {
    if (!this.segments.has(id)) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.curve = curve;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentDirection(id: SegmentId, direction: SegmentDirection): void {
    const was = this.segments.get(id);
    if (!was || was.direction === direction) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.direction = direction;
    s.lanes = normaliseLaneCount(s.lanes, direction);
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  setSegmentLanes(id: SegmentId, lanes: number | null): void {
    const was = this.segments.get(id);
    const next = normaliseLaneCount(lanes, was?.direction ?? 'both');
    if (!was || was.lanes === next) return;
    const before = this.segmentRect(id);
    const s = this.segmentToWrite(id)!;
    s.lanes = next;
    this.fitCurve(s);
    this.markSegment(id, before);
  }

  /** Changes every section consumer through the existing geometry/topology revision gates. */
  setSegmentSection(id: SegmentId, section?: RoadSection): void {
    const was = this.segments.get(id);
    const next = normalizeRoadSection(section);
    if (!was || (section !== undefined && !next) || sameRoadSection(was.section, next)) return;
    const before = this.segmentRect(id);
    const segment = this.segmentToWrite(id)!;
    if (next) segment.section = next;
    else delete segment.section;
    this.fitCurve(segment);
    this.markSegment(id, before);
  }

  /** Parking on the two sides of a segment; none on either side removes it. */
  setSegmentParking(id: SegmentId, parking?: SegmentParking): void {
    const was = this.segments.get(id);
    const next = normalizeParking(parking);
    if (!was || sameParking(was.parking, next)) return;
    const before = this.segmentRect(id);
    const segment = this.segmentToWrite(id)!;
    if (next) segment.parking = next;
    else delete segment.parking;
    this.fitCurve(segment);
    this.markSegment(id, before);
  }

  /** Retaining walls on the sides of the road's cutting (`RoadSegment.cutWalls`). */
  setSegmentCutWalls(id: SegmentId, on: boolean): void {
    const was = this.segments.get(id);
    if (!was || (was.cutWalls === true) === on) return;
    const segment = this.segmentToWrite(id)!;
    if (on) segment.cutWalls = true;
    else delete segment.cutWalls;
    this.markSegment(id);
  }

  /** The player's lane connections at a node; undefined or empty: all derived (`RoadNode.laneLinks`). */
  setNodeLaneLinks(id: NodeId, links: readonly LaneLink[] | undefined): void {
    const was = this.nodes.get(id);
    if (!was) return;
    const next = normalizeLaneLinks(links);
    if (linksDigest(was.laneLinks) === linksDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.laneLinks = next;
    else delete node.laneLinks;
    this.markNode(id);
  }

  /** The regional standard of the road paint: every road painted again. */
  setMarkingStyle(style: MarkingStyleId): void {
    if (this.markingStyle === style) return;
    this.markingStyle = style;
    // DO NOT write it as a change of the roads again
    this.changes.record('markingStyle', null, { detail: 'paint style' });
  }

  /** A U-turn through the median for the traffic arriving from `from` (`RoadNode.uturn`), or none. */
  setNodeUturn(id: NodeId, from: SegmentId | undefined): void {
    const was = this.nodes.get(id);
    if (!was || was.uturn === from) return;
    const node = this.nodeToWrite(id)!;
    if (from !== undefined) node.uturn = from;
    else delete node.uturn;
    this.markNode(id);
  }

  /** What a road's end is (`RoadNode.end`): a turning circle, or (undefined) the map's edge. */
  setNodeEnd(id: NodeId, end: RoadEnd | undefined): void {
    const was = this.nodes.get(id);
    if (!was || was.end === end) return;
    const node = this.nodeToWrite(id)!;
    if (end) node.end = end;
    else delete node.end;
    this.markNode(id);
  }

  /** Each leg's rule at a junction (`RoadNode.approachRules`); undefined: all derived. */
  setNodeApproachRules(id: NodeId, rules: readonly ApproachRuleEntry[] | undefined): void {
    const was = this.nodes.get(id);
    if (!was) return;
    const next = normalizeApproachRules(rules);
    if (rulesDigest(was.approachRules) === rulesDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.approachRules = next;
    else delete node.approachRules;
    this.markNode(id);
  }

  /** A signal's settings (`RoadNode.signal`); undefined: adaptive with the game's timings. */
  setNodeSignal(id: NodeId, signal: SignalSettings | undefined): void {
    const was = this.nodes.get(id);
    if (!was) return;
    const next = normalizeSignalSettings(signal);
    if (signalDigest(was.signal) === signalDigest(next)) return;
    const node = this.nodeToWrite(id)!;
    if (next) node.signal = next;
    else delete node.signal;
    this.markNode(id);
  }

  setSegmentStructure(id: SegmentId, structure: RoadStructure): void {
    const was = this.segments.get(id);
    if (!was || was.structure === structure) return;
    this.segmentToWrite(id)!.structure = structure;
    this.markSegment(id);
  }

  setNodeHeightOffset(id: NodeId, heightOffset: number): void {
    const was = this.nodes.get(id);
    if (!was || !Number.isFinite(heightOffset) || was.heightOffset === heightOffset) return;
    const junctionModeChanged = (was.heightOffset < -TUNNEL_HEADROOM) !==
      (heightOffset < -TUNNEL_HEADROOM);
    this.nodeToWrite(id)!.heightOffset = heightOffset;
    this.markNode(id, junctionModeChanged);
  }

  /** Gives the map an ecosystem (or takes it away: null). */
  setNature(next: NatureSettings | null): void {
    if (JSON.stringify(this.nature) === JSON.stringify(next)) return;
    this.nature = next ? { ...next } : null;    this.changes.record('nature', null);
  }

  // DO NOT write `null` (the whole map) for it: on a map at the cap every dab, stamp or tree laid the whole map again.
  addPaintDab(dab: PaintDab): void {
    this.ownList('terrainPaint');
    this.terrainPaint.push({ ...dab });
    const gone = this.terrainPaint.length > MAX_PAINT_DABS ? this.terrainPaint.shift() : undefined;
    this.changes.record('paint', gone ? [circleRect(dab), circleRect(gone)] : [circleRect(dab)]);
  }

  addFogDab(dab: FogDab): void {
    this.ownList('fogDabs');
    this.fogDabs.push({ ...dab });
    const gone = this.fogDabs.length > MAX_FOG_DABS ? this.fogDabs.shift() : undefined;
    this.changes.record('fog', gone ? [circleRect(dab), circleRect(gone)] : [circleRect(dab)]);
  }

  addGullyDab(dab: GullyDab): void {
    this.ownList('gullyDabs');
    this.gullyDabs.push({ ...dab });
    const gone = this.gullyDabs.length > MAX_GULLY_DABS ? this.gullyDabs.shift() : undefined;
    this.changes.record('gullies', gone ? [circleRect(dab), circleRect(gone)] : [circleRect(dab)]);
  }

  // A list cleared is written where its items lay (one box round them all), not as the whole map
  clearGullies(): void {
    if (this.gullyDabs.length === 0) return;
    this.ownList('gullyDabs');
    const where = circlesBox(this.gullyDabs);
    this.gullyDabs.length = 0;
    this.changes.record('gullies', where);
  }

  setGullyAuto(amount: number): void {
    const next = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : DEFAULT_GULLY_AUTO));
    if (next === this.gullyAuto) return;
    this.gullyAuto = next;    this.changes.record('gullies', null);
  }

  /** The balance after an edit was paid for (`economy.ts` `chargeFor`); `cause` says which. */
  setBalance(balance: number, cause?: string): void {
    if (!Number.isFinite(balance) || balance === this.economy.balance) return;
    this.economy = { balance };
    this.changes.record('economy', null, cause ? { cause } : {});
  }

  setWeather(change: Partial<Weather>): void {
    const next = readWeather({ ...this.weather, ...change }, this.weather);
    if (JSON.stringify(next) === JSON.stringify(this.weather)) return;
    this.weather = next;    this.changes.record('weather', null);
  }

  plantTrees(trees: readonly PlantedTree[]): void {
    if (trees.length === 0) return;
    this.ownList('trees');
    for (const t of trees) { const tree = { ...t }; this.trees.push(tree); this.treeGrid?.add(tree); }
    const gone = this.trees.length > MAX_PLANTED_TREES ? this.trees.splice(0, this.trees.length - MAX_PLANTED_TREES) : [];
    for (const t of gone) this.treeGrid?.remove(t);
    const goneRect = rectAround(gone, ITEM_PAD);
    this.changes.record('trees', goneRect ? [rectAround(trees, ITEM_PAD)!, goneRect] : [rectAround(trees, ITEM_PAD)!]);
  }

  /** Cuts the trees away within `radius` of (x, y) */
  cutTrees(x: number, y: number, radius: number): void {
    this.ownList('trees');
    this.ownList('treeClearings');
    const before = this.trees.length;
    // DO NOT splice each one out (trees x trees cut), nor walk every tree of the map for each dab of the brush.
    const there = new Set(this.treeCells.near([x - radius, y - radius, x + radius, y + radius]).filter((t) => Math.hypot(t.x - x, t.y - y) <= radius));
    if (there.size) keepWhere(this.trees, (t) => !there.has(t));
    for (const t of there) this.treeCells.remove(t);
    if (this.trees.length !== before) this.changes.record('trees', [circleRect({ x, y, radius })], { detail: `${before - this.trees.length} cut` });
    this.treeClearings.push({ x, y, radius });
    const gone = this.treeClearings.length > MAX_TREE_CLEARINGS ? this.treeClearings.shift() : undefined;
    this.changes.record('clearings', gone ? [circleRect({ x, y, radius }), circleRect(gone)] : [circleRect({ x, y, radius })]);
  }

  /** Every planted tree gone, and every clearing grown over again. */
  clearTrees(): void {
    if (this.trees.length > 0) {
      this.ownList('trees');
      const where = rectAround(this.trees, ITEM_PAD)!;
      this.trees.length = 0;
      this.treeGrid = null;
      this.changes.record('trees', [where]);
    }
    if (this.treeClearings.length > 0) {
      this.ownList('treeClearings');
      const where = circlesBox(this.treeClearings);
      this.treeClearings.length = 0;
      this.changes.record('clearings', where);
    }
  }

  addElements(items: readonly ElementItem[]): void {
    if (items.length === 0) return;
    this.ownList('elements');
    for (const item of items) { this.elements.push(item); this.elementGrid?.add(item); }
    const gone = this.elements.length > MAX_ELEMENTS ? this.elements.splice(0, this.elements.length - MAX_ELEMENTS) : [];
    for (const item of gone) this.elementGrid?.remove(item);
    const rects = [elementsBox(items)!];
    const goneRect = elementsBox(gone);
    if (goneRect) rects.push(goneRect);
    this.changes.record('elements', rects);
  }

  /** Takes away the elements within `radius` of (x, y) - of one kind, or every kind (`kind` null). How many went. */
  removeElements(x: number, y: number, radius: number, kind: ElementKind | null): number {
    this.ownList('elements');
    // The ones there, by place; the list then kept in one pass without them.
    const there = new Set(this.elementCells.near([x - radius, y - radius, x + radius, y + radius])
      .filter((e) => (kind === null || e.kind === kind) && Math.hypot(e.x - x, e.y - y) <= radius));
    const before = this.elements.length;
    if (there.size) keepWhere(this.elements, (e) => !there.has(e));
    for (const e of there) this.elementCells.remove(e);
    const gone = before - this.elements.length;
    if (gone > 0) {      this.changes.record('elements', [circleRect({ x, y, radius })]);
    }
    return gone;
  }

  /** Takes away these elements (the very items), in one pass; how many went. */
  removeElementItems(items: ReadonlySet<ElementItem>): number {
    if (items.size === 0) return 0;
    this.ownList('elements');
    const before = this.elements.length;
    keepWhere(this.elements, (e) => !items.has(e));
    for (const e of items) this.elementGrid?.remove(e);
    const gone = before - this.elements.length;
    if (gone > 0) this.changes.record('elements', [elementsBox([...items])!]);
    return gone;
  }

  clearElements(): void {
    if (this.elements.length === 0) return;
    this.ownList('elements');
    const where = elementsBox(this.elements)!;
    this.elements.length = 0;
    this.elementGrid = null;
    this.changes.record('elements', [where]);
  }

  /** A new cloud; null when the sky already holds as many as it may. */
  addCloud(value: Omit<PlacedCloud, 'id'>): PlacedCloud | null {
    if (this.clouds.length >= MAX_PLACED_CLOUDS) return null;
    this.ownList('clouds');
    const id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const cloud = { ...value, id };
    this.clouds.push(cloud);    this.changes.record('clouds', [rectAround([cloud], cloud.size)!], { ids: [id] });
    return cloud;
  }

  /** Several clouds at once, as many as the sky has room for: how many were added. */
  addClouds(values: readonly Omit<PlacedCloud, 'id'>[]): number {
    this.ownList('clouds');
    let id = this.clouds.reduce((m, c) => Math.max(m, c.id), 0);
    let added = 0;
    for (const value of values) {
      if (this.clouds.length >= MAX_PLACED_CLOUDS) break;
      this.clouds.push({ ...value, id: ++id });
      added++;
    }
    if (added > 0) {      const placed = this.clouds.slice(-added);
      this.changes.record('clouds', [rectAround(placed, Math.max(...placed.map((c) => c.size)))!]);
    }
    return added;
  }

  updateCloud(id: number, change: Partial<Omit<PlacedCloud, 'id'>>): void {
    const i = this.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.ownList('clouds');
    const was = this.clouds[i]!;
    const now = { ...was, ...change, id };
    this.clouds[i] = now;    this.changes.record('clouds', [rectAround([was, now], Math.max(was.size, now.size))!], { ids: [id] });
  }

  removeCloud(id: number): void {
    const i = this.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    this.ownList('clouds');
    const [was] = this.clouds.splice(i, 1);    this.changes.record('clouds', [rectAround([was!], was!.size)!], { ids: [id] });
  }

  clearFog(): void {
    if (this.fogDabs.length === 0) return;
    this.ownList('fogDabs');
    const where = circlesBox(this.fogDabs);
    this.fogDabs.length = 0;
    this.changes.record('fog', where);
  }

  setFogSettings(next: Partial<FogSettings>): void {
    const merged = readFogSettings({ ...this.fogSettings, ...next });
    if (JSON.stringify(merged) === JSON.stringify(this.fogSettings)) return;
    this.fogSettings = merged;    this.changes.record('fog', null);
  }

  clearPaint(): void {
    if (this.terrainPaint.length === 0) return;
    this.ownList('terrainPaint');
    const where = circlesBox(this.terrainPaint);
    this.terrainPaint.length = 0;
    this.changes.record('paint', where);
  }

  addTerrainStamp(value: Omit<TerrainStamp, 'id'>): TerrainStamp {
    this.ownList('terrainStamps');
    const stamp: TerrainStamp = { ...value, id: this.nextTerrainId++ };
    this.terrainStamps.push(stamp);
    // The oldest stamp dropped moves the land where it lay too.
    const gone = this.terrainStamps.length > MAX_TERRAIN_STAMPS ? this.terrainStamps.shift() : undefined;
    this.changes.record('terrain', gone ? [circleRect(stamp), circleRect(gone)] : [circleRect(stamp)],
      { ids: gone ? [stamp.id, gone.id] : [stamp.id] });
    return stamp;
  }

  clearTerrain(): void {
    if (this.terrainStamps.length === 0) return;
    this.ownList('terrainStamps');
    const where = circlesBox(this.terrainStamps);
    const ids = this.terrainStamps.map((s) => s.id);
    this.terrainStamps.length = 0;
    this.changes.record('terrain', where, { ids });
  }

  setNodeControl(id: NodeId, control: JunctionControl): void {
    const was = this.nodes.get(id);
    if (!was || was.control === control) return;
    this.nodeToWrite(id)!.control = control;
    this.markNode(id);
  }

  /** Puts a mid-block pedestrian crossing on a two-road node, painted on `segment`. */
  setNodeCrossing(id: NodeId, kind: NodeCrossingKind, segment: SegmentId): boolean {
    const was = this.nodes.get(id);
    if (!was || was.incident.length !== 2 || !was.incident.includes(segment)) return false;
    const n = this.nodeToWrite(id)!;
    n.crossing = { kind, segment };
    n.control = kind === 'signal' ? 'signal' : 'priority';
    this.markNode(id);
    return true;
  }

  /** Removes a node's mid-block crossing; the node goes back to `auto`. */
  clearNodeCrossing(id: NodeId): void {
    if (!this.nodes.get(id)?.crossing) return;
    const n = this.nodeToWrite(id)!;
    delete n.crossing;
    n.control = 'auto';
    this.markNode(id);
  }

  setMovementBlocked(id: NodeId, from: SegmentId, to: SegmentId, blocked: boolean): void {
    const was = this.nodes.get(id);
    if (!was || from === to) return;
    const key = movementKey(from, to);
    const index = was.blockedMovements.indexOf(key);
    if (blocked && index < 0) this.nodeToWrite(id)!.blockedMovements.push(key);
    else if (!blocked && index >= 0) this.nodeToWrite(id)!.blockedMovements.splice(index, 1);
    else return;
    this.markNode(id);
  }

  /** DO NOT walk every node of the map for it: every road taken away ends here. */
  pruneOrphanNodes(): number {
    const rects: ChangeRect[] = [];
    const ids: number[] = [];
    // In id order, as the walk over the map met them.
    for (const id of this.loose.sorted()) {
      const n = this.nodes.get(id);
      if (!n || n.incident.length !== 0) continue;
      // Its rectangle before it goes: DO NOT write `null` (the whole map) for a few loose nodes
      const rect = this.nodeRect(id);
      if (rect) rects.push(rect);
      ids.push(id);
      this.nodes.delete(id);
    }
    this.loose.clear();
    if (ids.length) this.roadsChanged(rects, true, { ids, detail: `${ids.length} loose nodes dropped` });
    return ids.length;
  }

  // ------------------------------------------------------------ change marking

  /** DO NOT bring them back: what changed is the diary's to say. */
  markNode(id: NodeId, traffic = true, also: readonly ChangeRect[] = []): void {
    // Every real edit is written, even of a node edited before: the diary is the mutation clock
    const rect = this.nodeRect(id);
    const rects = rect ? [rect, ...also] : also;
    this.roadsChanged(rects.length ? rects : null, traffic, { ids: [id] });
  }

  /** DO NOT write only the segment's rectangle: what is derived round a junction would keep the old mouths. */
  markSegment(id: SegmentId, before: ChangeRect | null = null): void {
    const rects: ChangeRect[] = [];
    const rect = this.segmentRect(id);
    if (rect) rects.push(rect);
    if (before) rects.push(before);
    const s = this.segments.get(id);
    if (s) for (const end of [s.a, s.b]) { const r = this.nodeRect(end); if (r) rects.push(r); }
    // With its two ends: their records (`incident`) change with it, and a reader by id
    this.roadsChanged(rects.length ? rects : null, true, { ids: s ? [id, s.a, s.b] : [id] });
  }

  /** A rectangle as the diary takes it: itself, or the whole map when there is none. */
  private rectsOrMap(rect: ChangeRect | null): readonly ChangeRect[] | null {
    return rect ? [rect] : null;
  }

  /** The roads changed there: their geometry */
  private roadsChanged(rects: readonly ChangeRect[] | null, traffic: boolean, extra: { readonly ids?: readonly number[]; readonly detail?: string } = {}): void {
    const roads = this.changes.record('roads', rects, extra);
    if (traffic) this.changes.record('traffic', rects, { ...extra, parent: roads });
  }

  // ------------------------------------------------------------ working copy

  /** DO NOT go back to copying the document for an edit (CLAUDE.md, "Rebuilding everything when one part changes"). */
  fork(): RoadDoc {
    const copy = new RoadDoc();
    this.layOver(copy);
    return copy;
  }

  /** Takes back an edit made on a working copy of this document (`fork`): what it wrote and its diary entries (`takeFork`). */
  takeBack(copy: RoadDoc): void {
    if (copy.below !== this) throw new Error('RoadDoc.takeBack: not a working copy of this document');
    this.takeFork(copy);
  }

  /** Makes `copy` a working copy over this document as it stands (`fork`); also how a copy taken back starts again. */
  private layOver(copy: RoadDoc): void {
    const own = copy as unknown as { nodes: Map<NodeId, RoadNode>; segments: Map<SegmentId, RoadSegment> };
    own.nodes = new ForkMap(this.nodes);
    own.segments = new ForkMap(this.segments);
    // The nodes that may have lost their last road: the original's read through, its own kept apart.
    copy.loose = this.loose.over();
    copy.poleMap = new ForkMap(this.poleMap);
    copy.spanMap = new ForkMap(this.spanMap);
    copy.poleIndex = this.poleIndex;
    copy.barrierMap = new ForkMap(this.barrierMap);
    copy.barrierCells = this.barrierCells;
    copy.landscapeMap = new ForkMap(this.landscapeMap);
    copy.landscapeCells = this.landscapeCells;
    copy.streetNameCount = this.streetNameCount;
    copy.sharedIndices = new Set(INDEX_KINDS);
    for (const part of DOC_LISTS) copy.setList(part, this.listOf(part) as unknown[]);
    copy.sharedLists = new Set(DOC_LISTS);
    copy.treeGrid = null;
    copy.elementGrid = null;
    // Values, each replaced whole by its writers, never changed in place: shared.
    copy.transit = this.transit;
    copy.terrainRelief = this.terrainRelief;
    copy.markingStyle = this.markingStyle;
    copy.nature = this.nature;
    copy.fogSettings = this.fogSettings;
    copy.gullyAuto = this.gullyAuto;
    copy.weather = this.weather;
    copy.economy = this.economy;
    copy.nextZoneId = this.nextZoneId;
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.landscapeIds = new IdAllocator(this.landscapeIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    copy.buildings.forkFrom(this.buildings);
    copy.lotStore.forkFrom(this.lotStore);
    copy.openLotsIndex = null;
    copy.changes.forkFrom(this.changes);
    copy.forkedFrom = { doc: this, version: this.changes.version };
    copy.below = this;
  }

  /** A working copy (`fork`) of this document taken back */
  private takeFork(copy: RoadDoc): void {
    if (copy.forkedFrom?.doc !== this || copy.forkedFrom.version !== this.changes.version) {
      throw new Error('RoadDoc.replaceWith: a working copy of this document as it stood before a later change');
    }
    (copy.nodes as ForkMap<NodeId, RoadNode>).applyTo(this.nodes);
    (copy.segments as ForkMap<SegmentId, RoadSegment>).applyTo(this.segments);
    // Pruned by the copy: what it holds now; else the original's and the copy's.
    this.loose.take(copy.loose);
    (copy.poleMap as ForkMap<PoleId, UtilityPole>).applyTo(this.poleMap, (_, pole) => this.putPoleRecord(pole), (id) => this.deletePoleRecord(id));
    (copy.spanMap as ForkMap<SpanId, UtilitySpan>).applyTo(this.spanMap, (_, span) => this.putSpanRecord(span), (id) => this.deleteSpanRecord(id));
    (copy.landscapeMap as ForkMap<number, LandscapeItem>).applyTo(this.landscapeMap, (_, item) => this.putLandscapeRecord(item), (id) => this.deleteLandscapeRecord(id));
    (copy.barrierMap as ForkMap<number, Barrier>).applyTo(this.barrierMap, (_, barrier) => this.putBarrierRecord(barrier), (id) => this.deleteBarrierRecord(id));
    this.buildings.takeFork(copy.buildings);
    this.lotStore.takeFork(copy.lotStore);
    // The lists the copy wrote (it owns them): their items in place here, the filings by place kept by difference.
    for (const part of DOC_LISTS) {
      if (copy.sharedLists.has(part)) continue;
      const mine = this.listOf(part) as unknown[], theirs = copy.listOf(part);
      const grid = part === 'trees' ? this.treeGrid : part === 'elements' ? this.elementGrid : null;
      if (grid) {
        const kept = new Set(theirs), had = new Set(mine);
        for (const item of mine) if (!kept.has(item)) grid.remove(item as PlantedTree & ElementItem);
        for (const item of theirs) if (!had.has(item)) grid.add(item as PlantedTree & ElementItem);
      }
      mine.length = 0;
      for (const item of theirs) mine.push(item);
    }
    this.transit = copy.transit;
    this.terrainRelief = copy.terrainRelief;
    this.markingStyle = copy.markingStyle;
    this.nature = copy.nature;
    this.fogSettings = copy.fogSettings;
    this.gullyAuto = copy.gullyAuto;
    this.weather = copy.weather;
    this.economy = copy.economy;
    this.nextZoneId = copy.nextZoneId;
    this.nodeIds = new IdAllocator(copy.nodeIds.peek);
    this.segIds = new IdAllocator(copy.segIds.peek);
    this.poleIds = new IdAllocator(copy.poleIds.peek);
    this.spanIds = new IdAllocator(copy.spanIds.peek);
    this.barrierIds = new IdAllocator(copy.barrierIds.peek);
    this.landscapeIds = new IdAllocator(copy.landscapeIds.peek);
    this.nextTerrainId = copy.nextTerrainId;
    this.changes.take(copy.changes);
    this.layOver(copy);
  }

  /** A node's record to change in place: a working copy's own (copied from the original's the first time), or the record itself (its keepers told first). */
  private nodeToWrite(id: NodeId): RoadNode | undefined {
    const map = this.nodes;
    if (map instanceof ForkMap) return map.writable(id, copyNode);
    const node = map.get(id);
    if (node) for (const ref of this.roadKeepers) ref.deref()?.beforeWrite('nodes', node);
    return node;
  }

  /** A segment's record to change in place (as `nodeToWrite`). */
  private segmentToWrite(id: SegmentId): RoadSegment | undefined {
    const map = this.segments;
    if (map instanceof ForkMap) return map.writable(id, copySegment);
    const segment = map.get(id);
    if (segment) for (const ref of this.roadKeepers) ref.deref()?.beforeWrite('segments', segment);
    return segment;
  }

  /** A keeper of the road records by reference (`world/docImage.ts`): told before any of them is changed in place here. */
  keepRoads(keeper: RoadKeeper): void {
    this.roadKeepers = this.roadKeepers.filter((ref) => ref.deref() !== undefined);
    if (!this.roadKeepers.some((ref) => ref.deref() === keeper)) this.roadKeepers.push(new WeakRef(keeper));
  }

  /** A list about to be written in place: a working copy's own, copied from the original's the first time (`fork`). */
  private ownList(part: DocListPart): void {
    if (!this.sharedLists.delete(part)) return;
    const list = this.listOf(part);
    this.setList(part, list.slice());
    forkWork.copied += list.length;
    if (part === 'trees') this.treeGrid = null;
    if (part === 'elements') this.elementGrid = null;
  }

  /** A list of the document set whole: only a working copy's, laid over or owned (`layOver`, `ownList`). */
  private setList(part: DocListPart, list: unknown[]): void {
    (this as unknown as Record<DocListPart, unknown[]>)[part] = list;
  }

  /** An index by place about to be written: a working copy's own, copied from the original's the first time (`fork`). */
  private ownIndex(kind: IndexKind): void {
    if (!this.sharedIndices.delete(kind)) return;
    switch (kind) {
      case 'poles':
        this.poleIndex = this.poleIndex.copy();
        forkWork.copied += this.poleMap.size + this.spanMap.size;
        return;
      case 'barriers': {
        const cells = new CellFiling<number, Barrier>(LANDSCAPE_CELL);
        cells.copyFrom(this.barrierCells);
        this.barrierCells = cells;
        forkWork.copied += this.barrierMap.size;
        return;
      }
      case 'landscape': {
        const cells = new CellFiling<number, LandscapeItem>(LANDSCAPE_CELL);
        cells.copyFrom(this.landscapeCells);
        this.landscapeCells = cells;
        this.streetNameCount = new Map(this.streetNameCount);
        forkWork.copied += this.landscapeMap.size;
      }
    }
  }

  /** Makes an independent working copy, including allocator high-water marks. */
  clone(): RoadDoc {
    // Field by field, each record copied as `replaceContents` copies it.
    const copy = new RoadDoc();
    for (const [id, node] of this.nodes) copy.nodes.set(id, copyNode(node));
    copy.loose = this.loose.copy();
    for (const [id, segment] of this.segments) copy.segments.set(id, copySegment(segment));
    for (const pole of this.poles.values()) copy.putPoleRecord({ ...pole });
    for (const span of this.poleSpans.values()) copy.putSpanRecord({ ...span });
    for (const item of this.landscape.values()) copy.putLandscapeRecord({ ...item });
    for (const barrier of this.barriers.values()) copy.putBarrierRecord({ ...barrier, points: barrier.points.map((q) => ({ ...q })) });
    copy.buildings.shareFrom(this.buildings);
    copy.buildings.copyAllocator(this.buildings);
    copy.terrainStamps.push(...this.terrainStamps.map((stamp) => ({ ...stamp })));
    copy.terrainRelief = this.terrainRelief;
    copy.markingStyle = this.markingStyle;
    copy.nature = this.nature ? { ...this.nature } : null;
    copy.terrainPaint.push(...this.terrainPaint.map((dab) => ({ ...dab })));
    copy.fogDabs.push(...this.fogDabs.map((dab) => ({ ...dab })));
    copy.fogSettings = { ...this.fogSettings };
    copy.gullyDabs.push(...this.gullyDabs.map((dab) => ({ ...dab })));
    copy.gullyAuto = this.gullyAuto;
    copy.clouds.push(...this.clouds.map((c) => ({ ...c })));
    copy.elements.push(...this.elements.map((e) => ({ ...e })));
    copy.trees.push(...this.trees.map((t) => ({ ...t })));
    copy.treeClearings.push(...this.treeClearings.map((c) => ({ ...c })));
    copy.weather = { ...this.weather };
    copy.economy = { ...this.economy };
    copy.zones.push(...this.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })));
    copy.zoneMarks.push(...this.zoneMarks.map((mark) => ({ ...mark })));
    // The records shared, as the buildings' (never changed in place: `LotStore` OWNERSHIP).
    copy.lotStore.shareFrom(this.lotStore);
    copy.nextZoneId = this.nextZoneId;
    // Deep, as the file writes them (`serialized`): nested specs, never aliased.
    copy.people.push(...this.people.map((person) => JSON.parse(JSON.stringify(person)) as PersonSpec));
    copy.transit = JSON.parse(JSON.stringify(this.transit)) as TransitData;
    copy.nodeIds = new IdAllocator(this.nodeIds.peek);
    copy.segIds = new IdAllocator(this.segIds.peek);
    copy.poleIds = new IdAllocator(this.poleIds.peek);
    copy.spanIds = new IdAllocator(this.spanIds.peek);
    copy.barrierIds = new IdAllocator(this.barrierIds.peek);
    copy.landscapeIds = new IdAllocator(this.landscapeIds.peek);
    copy.nextTerrainId = this.nextTerrainId;
    // At the same revisions as this document, every one of them: the copy's diary goes on from this one's
    copy.changes.continueFrom(this.changes);
    copy.forkedFrom = { doc: this, version: this.changes.version };
    return copy;
  }

  /** Replaces this instance in place while restoring allocator invariants. */
  replaceFromJSON(data: SerializedDoc, options: { readonly repair?: boolean } = {}): void {
    const restored = RoadDoc.fromJSON(data, options);
    this.replaceWith(restored);
  }

  /** Replaces this instance from another valid document - every road drawn (an edited clone, `commitDraft`) and every undo */
  replaceWith(source: RoadDoc): void {
    // A working copy over this document (`fork`): what it wrote, and its own diary entries.
    if (source.below === this) {
      this.takeFork(source);
      return;
    }
    const moved = this.movedIn(source);
    // Read before anything here is written: it holds while this diary stands where the copy was made.
    const buildingIds = this.buildingsMovedIn(source);
    const lotIds = this.lotsMovedIn(source);
    const roads = moved('roads', 'traffic') ? roadDifferences(this, source) : { rects: [], ids: [], traffic: false };
    const stamps = !moved('terrain') ? { rects: [], ids: [] }
      : this.terrainRelief !== source.terrainRelief ? null : stampDifferences(this.terrainStamps, source.terrainStamps);
    const items = itemDifferences(this, source, moved);
    const changed = this.replaceContents(source, moved, buildingIds, lotIds);
    const where = (rects: readonly ChangeRect[] | undefined): readonly ChangeRect[] | null => rects && rects.length ? rects : null;
    // The traffic's plan only when it moved (`roadDifferences`): a node only raised leaves it, as `setNodeHeightOffset` does.
    if (changed.roads || roads.rects.length) this.roadsChanged(where(roads.rects), roads.traffic, { ids: roads.ids });
    if (changed.land || (stamps !== null && stamps.rects.length)) {
      this.changes.record('terrain', where(stamps?.rects), stamps?.ids ? { ids: stamps.ids } : {});
    }
    // The poles and wires where they differ, and only they: DO NOT read the landscaping into the poles' comparison again
    if (items.utilities.ids.length) this.changes.record('utilities', where(items.utilities.rects), { ids: items.utilities.ids });
    if (items.landscape.ids.length) this.changes.record('landscape', where(items.landscape.rects), { ids: items.landscape.ids });
    if (changed.barriers || items.barriers.ids.length) this.changes.record('barriers', where(items.barriers.rects), { ids: items.barriers.ids });
    // The buildings write their own (`BuildingStore.replaceWith`), each where it stands.
    for (const kind of changed.others) this.changes.record(kind, null);
  }

  /** Whether `source` changed any of these kinds since it was copied from this document */
  private movedIn(source: RoadDoc): MovedKinds {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return () => true;
    return (...kinds) => source.changes.serialOf(...kinds) > this.changes.serialOf(...kinds);
  }

  /** The ids of the buildings a working copy of this document changed since it was copied (`movedIn`), from the copy's diary */
  private buildingsMovedIn(source: RoadDoc): readonly BuildingId[] | null {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return null;
    return source.buildings.changedSince(fork.version);
  }

  /** The ids of the lots a working copy of this document changed since it was copied, as `buildingsMovedIn`; null: compare them all. */
  private lotsMovedIn(source: RoadDoc): readonly number[] | null {
    const fork = source.forkedFrom;
    if (!fork || fork.doc !== this || fork.version !== this.changes.version) return null;
    return source.lotStore.changedSince(fork.version);
  }

  // --------------------------------------------------- undo by records `world/docImage.ts` keeps the document as last

  /** The id allocators' next ids: nodes, segments, poles, spans, barriers, landscaping, terrain stamps, buildings. */
  allocatorMarks(): number[] {
    return [this.nodeIds.peek, this.segIds.peek, this.poleIds.peek, this.spanIds.peek, this.barrierIds.peek, this.landscapeIds.peek, this.nextTerrainId, this.buildings.nextId];
  }

  restore(r: Restoration): void {
    const roads: ChangeRect[] = [], utilities: ChangeRect[] = [], landscape: ChangeRect[] = [], barriers: ChangeRect[] = [];
    // The kinds changed as a whole (a value: the relief, the weather...)
    const kinds = new Set<DocChangeKind>();
    const listRects = new Map<DocChangeKind, ChangeRect[] | null>();
    let roadsTouched = false;
    // DO NOT write `traffic` for every road record: an undo of a node raised rebuilt the simulation's plan.
    let traffic = false;
    const roadIds: number[] = [];
    const lotRecords: { id: number; value: Lot | undefined }[] = [];
    // Where the roads stand: each record's own rectangle, and a node's roads (its move moves them).
    const roadRects = (): void => {
      for (const { part, id } of r.records) {
        if (part === 'nodes') {
          const rect = this.nodeRect(id as NodeId);
          if (rect) roads.push(rect);
          for (const sid of this.nodes.get(id as NodeId)?.incident ?? []) { const s = this.segmentRect(sid); if (s) roads.push(s); }
        } else if (part === 'segments') {
          const rect = this.segmentRect(id as SegmentId);
          if (rect) roads.push(rect);
        }
      }
    };
    // The items by id too, as their writers name them (`addPoleSpan`: the span and its two poles): a reader by id never reads everything.
    const utilityIds = new Set<number>(), landscapeIds = new Set<number>(), barrierIds = new Set<number>();
    const itemRects = (): void => {
      for (const { part, id } of r.records) {
        if (part === 'poles') { utilityIds.add(id); const p = this.poles.get(id as PoleId); if (p) utilities.push(rectAround([p], ITEM_PAD)!); }
        if (part === 'poleSpans') {
          utilityIds.add(id);
          const s = this.poleSpans.get(id as SpanId), p = s && this.poles.get(s.a), q = s && this.poles.get(s.b);
          if (s) { utilityIds.add(s.a); utilityIds.add(s.b); }
          if (p && q) utilities.push(rectAround([p, q], ITEM_PAD)!);
        }
        if (part === 'landscape') { landscapeIds.add(id); const item = this.landscape.get(id); if (item) landscape.push(rectAround([item], ITEM_PAD)!); }
        if (part === 'barriers') { barrierIds.add(id); const b = this.barriers.get(id); if (b) barriers.push(rectAround(b.points, ITEM_PAD)!); }
      }
    };
    roadRects();
    itemRects();
    for (const { part, id, value } of r.records) {
      const put = <T>(map: Map<number, T>): void => { if (value === undefined) map.delete(id); else map.set(id, structuredClone(value) as T); };
      switch (part) {
        case 'nodes': {
          const was = this.nodes.get(id as NodeId);
          if ((was || value !== undefined) && nodeMovesTraffic(was, value as RoadNode | undefined)) traffic = true;
          put(this.nodes as Map<number, RoadNode>); this.loose.add(id as NodeId); roadsTouched = true; roadIds.push(id); break;
        }
        case 'segments': put(this.segments as Map<number, RoadSegment>); roadsTouched = true; traffic = true; roadIds.push(id); break;
        case 'poles': if (value === undefined) this.deletePoleRecord(id as PoleId); else this.putPoleRecord(structuredClone(value) as UtilityPole); kinds.add('utilities'); break;
        case 'poleSpans': if (value === undefined) this.deleteSpanRecord(id as SpanId); else this.putSpanRecord(structuredClone(value) as UtilitySpan); kinds.add('utilities'); break;
        case 'landscape':
          if (value === undefined) this.deleteLandscapeRecord(id); else this.putLandscapeRecord(structuredClone(value) as LandscapeItem);
          kinds.add('landscape'); break;
        case 'barriers':
          if (value === undefined) this.deleteBarrierRecord(id); else this.putBarrierRecord(structuredClone(value) as Barrier);
          kinds.add('barriers'); break;
        case 'buildings': this.buildings.restore(id as BuildingId, value as Building | undefined); break;
        // Kept by reference, as the buildings (`LotStore` OWNERSHIP); all of them in one entry, below.
        case 'lots': lotRecords.push({ id, value: value as Lot | undefined }); break;
      }
    }
    if (lotRecords.length) this.lotStore.restore(lotRecords, 'restaurados');
    for (const { part, start, remove, items } of r.lists) {
      const kind = LIST_KINDS[part];
      const put = items.map((item) => structuredClone(item));
      if (part !== 'lotKeys') this.ownList(part);
      // The keys through their owner, which keeps them as a set too.
      const gone = part === 'lotKeys' ? this.lotStore.spliceKeys(start, remove, put as string[]) : spliceIn(this.listOf(part) as unknown[], start, remove, put);
      if (part === 'elements') {
        for (const e of gone as ElementItem[]) this.elementGrid?.remove(e);
        for (const e of put as ElementItem[]) this.elementGrid?.add(e);
      } else if (part === 'trees') {
        for (const t of gone as PlantedTree[]) this.treeGrid?.remove(t);
        for (const t of put as PlantedTree[]) this.treeGrid?.add(t);
      }
      // DO NOT write `null` (the whole map) for a stretch of a list whose items have places.
      if (listRects.has(kind) && listRects.get(kind) === null) continue;
      const rects = listRects.get(kind) ?? [];
      const left = listBox(part, gone), came = listBox(part, items);
      if (left === undefined || came === undefined) { listRects.set(kind, null); continue; }
      if (left) rects.push(left);
      if (came) rects.push(came);
      listRects.set(kind, rects);
    }
    for (const { part, value } of r.values) this.restoreValue(part, value, kinds);
    roadRects();
    itemRects();
    const where = (rects: readonly ChangeRect[]): readonly ChangeRect[] | null => (rects.length ? rects : null);
    if (roadsTouched) this.roadsChanged(where(roads), traffic, { ids: roadIds, detail: 'restored' });
    // The paint style is written with the other values below, as its own kind (`setMarkingStyle`).
    if (kinds.has('utilities')) this.changes.record('utilities', where(utilities), { ids: [...utilityIds] });
    if (kinds.has('landscape')) this.changes.record('landscape', where(landscape), { ids: [...landscapeIds] });
    if (kinds.has('barriers')) this.changes.record('barriers', where(barriers), { ids: [...barrierIds] });
    for (const [kind, rects] of listRects) {
      if (kinds.has(kind)) continue;
      // A stretch put back as it was moves nothing (an empty list of rectangles writes no entry).
      this.changes.record(kind, rects);
    }
    for (const kind of kinds) if (!['utilities', 'landscape', 'barriers'].includes(kind)) this.changes.record(kind, null);
  }

  /** A list of the document by its part's name (`restore`, `world/docImage.ts`); read-only to the image (written through `restore`). */
  listOf(part: ListPart): readonly unknown[] {
    switch (part) {
      case 'terrainStamps': return this.terrainStamps;
      case 'terrainPaint': return this.terrainPaint;
      case 'fogDabs': return this.fogDabs;
      case 'gullyDabs': return this.gullyDabs;
      case 'clouds': return this.clouds;
      case 'trees': return this.trees;
      case 'treeClearings': return this.treeClearings;
      case 'elements': return this.elements;
      case 'zones': return this.zones;
      case 'zoneMarks': return this.zoneMarks;
      case 'lotKeys': return this.lotStore.keys;
      case 'people': return this.people;
    }
  }

  /** A value of the document by its part's name (`world/docImage.ts`). */
  valueOf(part: ValuePart): unknown {
    switch (part) {
      case 'terrainRelief': return this.terrainRelief;
      case 'markingStyle': return this.markingStyle;
      case 'nature': return this.nature;
      case 'fogSettings': return this.fogSettings;
      case 'gullyAuto': return this.gullyAuto;
      case 'weather': return this.weather;
      case 'economy': return this.economy;
      case 'transit': return this.transit;
      case 'nextZoneId': return this.nextZoneId;
      case 'nextLotId': return this.lotStore.nextId;
      case 'allocators': return this.allocatorMarks();
    }
  }

  private restoreValue(part: ValuePart, raw: unknown, kinds: Set<DocChangeKind>): void {
    const value = structuredClone(raw);
    switch (part) {
      case 'terrainRelief': this.terrainRelief = value as ReliefVersion; kinds.add('terrain'); return;
      case 'markingStyle': this.markingStyle = value as MarkingStyleId; kinds.add('markingStyle'); return;
      case 'nature': this.nature = value as NatureSettings | null; kinds.add('nature'); return;
      case 'fogSettings': this.fogSettings = value as FogSettings; kinds.add('fog'); return;
      case 'gullyAuto': this.gullyAuto = value as number; kinds.add('gullies'); return;
      case 'weather': this.weather = value as Weather; kinds.add('weather'); return;
      case 'economy': this.economy = value as Economy; kinds.add('economy'); return;
      case 'transit': this.transit = value as TransitData; kinds.add('transit'); return;
      case 'nextZoneId': this.nextZoneId = value as number; return;
      case 'nextLotId': this.lotStore.restoreNextId(value as number); return;
      case 'allocators': {
        const [nodes, segs, poles, spans, barriers, landscape, terrain, buildings] = value as number[];
        this.nodeIds = new IdAllocator(nodes!);
        this.segIds = new IdAllocator(segs!);
        this.poleIds = new IdAllocator(poles!);
        this.spanIds = new IdAllocator(spans!);
        this.barrierIds = new IdAllocator(barriers!);
        this.landscapeIds = new IdAllocator(landscape!);
        this.nextTerrainId = terrain!;
        this.buildings.restoreNextId(buildings!);
        return;
      }
    }
  }

  /** Takes `source`'s contents and says what differed: the roads, the land, the poles and the barriers */
  private replaceContents(source: RoadDoc, moved: MovedKinds, buildingIds: readonly BuildingId[] | null, lotIds: readonly number[] | null): {
    roads: boolean; land: boolean; barriers: boolean; others: DocChangeKind[];
  } {
    const others: DocChangeKind[] = [];
    let barriersChanged = false;
    // The land moves only when its stamps do.
    const landMoved = moved('terrain') && (!sameStamps(this.terrainStamps, source.terrainStamps) || this.terrainRelief !== source.terrainRelief);
    // Likewise the roads and the utility network
    const roadsMoved = moved('roads', 'traffic');
    const roadsChanged = roadsMoved && !sameRoads(this, source);

    if (roadsMoved) {
      this.nodes.clear();
      this.segments.clear();
      this.loose.clear();
      for (const [id, node] of source.nodes) {
        this.nodes.set(id, copyNode(node));
        if (node.incident.length === 0) this.loose.add(id);
      }
      for (const [id, segment] of source.segments) this.segments.set(id, copySegment(segment));
    }
    if (moved('utilities')) {
      this.clearPoleRecords();
      for (const pole of source.poles.values()) this.putPoleRecord({ ...pole });
      for (const span of source.poleSpans.values()) this.putSpanRecord({ ...span });
    }
    if (moved('landscape')) {
      this.clearLandscapeRecords();
      for (const item of source.landscape.values()) this.putLandscapeRecord({ ...item });
    }
    if (moved('barriers') && !sameBarriers(this, source)) {
      this.clearBarrierRecords();
      for (const barrier of source.barriers.values()) this.putBarrierRecord({ ...barrier, points: barrier.points.map((p) => ({ ...p })) });
      barriersChanged = true;
    }
    // Writes a change only of the buildings that differ; of a working copy, reads only those its diary names
    this.buildings.replaceWith(source.buildings, buildingIds);
    // The zones and the lots moved only when their content did
    this.nextZoneId = source.nextZoneId;
    if (moved('zones') && (JSON.stringify(this.zones) !== JSON.stringify(source.zones) || JSON.stringify(this.zoneMarks) !== JSON.stringify(source.zoneMarks))) {
      this.ownList('zones');
      this.ownList('zoneMarks');
      this.zones.length = 0;
      this.zones.push(...source.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })));
      this.zoneMarks.length = 0;
      this.zoneMarks.push(...source.zoneMarks.map((mark) => ({ ...mark })));
      others.push('zones');
    }
    // The lots write their own, by id (`LotStore.replaceWith`); of a working copy, only those its diary names.
    if (moved('lots', 'lotKeys')) this.lotStore.replaceWith(source.lotStore, lotIds, 'replaced by an edit or an undo');
    if (moved('transit') && JSON.stringify(this.transit) !== JSON.stringify(source.transit)) {
      this.transit = JSON.parse(JSON.stringify(source.transit)) as TransitData;
      others.push('transit');
    }
    if (moved('people') && JSON.stringify(this.people) !== JSON.stringify(source.people)) {
      this.ownList('people');
      this.people.length = 0;
      this.people.push(...source.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec));
      others.push('people');
    }

    if (moved('nature') && JSON.stringify(this.nature) !== JSON.stringify(source.nature)) {
      this.nature = source.nature ? { ...source.nature } : null;
      others.push('nature');
    }

    if (this.economy.balance !== source.economy.balance) {
      this.economy = { ...source.economy };
      others.push('economy');
    }
    if (moved('weather') && JSON.stringify(this.weather) !== JSON.stringify(source.weather)) {
      this.weather = { ...source.weather };
      others.push('weather');
    }
    if (moved('trees') && JSON.stringify(this.trees) !== JSON.stringify(source.trees)) {
      this.ownList('trees');
      this.trees.length = 0;
      this.treeGrid = null;
      this.trees.push(...source.trees.map((t) => ({ ...t })));
      others.push('trees');
    }
    if (moved('clearings') && JSON.stringify(this.treeClearings) !== JSON.stringify(source.treeClearings)) {
      this.ownList('treeClearings');
      this.treeClearings.length = 0;
      this.treeClearings.push(...source.treeClearings.map((c) => ({ ...c })));
      others.push('clearings');
    }

    if (moved('elements') && (this.elements.length !== source.elements.length || JSON.stringify(this.elements) !== JSON.stringify(source.elements))) {
      this.ownList('elements');
      this.elements.length = 0;
      this.elementGrid = null;
      this.elements.push(...source.elements);
      others.push('elements');
    }

    if (moved('clouds') && JSON.stringify(this.clouds) !== JSON.stringify(source.clouds)) {
      this.ownList('clouds');
      this.clouds.length = 0;
      this.clouds.push(...source.clouds.map((c) => ({ ...c })));
      others.push('clouds');
    }

    if (moved('gullies') && (this.gullyAuto !== source.gullyAuto || JSON.stringify(this.gullyDabs) !== JSON.stringify(source.gullyDabs))) {
      this.ownList('gullyDabs');
      this.gullyDabs.length = 0;
      this.gullyDabs.push(...source.gullyDabs.map((dab) => ({ ...dab })));
      this.gullyAuto = source.gullyAuto;
      others.push('gullies');
    }

    if (moved('fog') && (JSON.stringify(this.fogDabs) !== JSON.stringify(source.fogDabs) || JSON.stringify(this.fogSettings) !== JSON.stringify(source.fogSettings))) {
      this.ownList('fogDabs');
      this.fogDabs.length = 0;
      this.fogDabs.push(...source.fogDabs.map((dab) => ({ ...dab })));
      this.fogSettings = { ...source.fogSettings };
      others.push('fog');
    }

    if (moved('paint') && !samePaint(this.terrainPaint, source.terrainPaint)) {
      this.ownList('terrainPaint');
      this.terrainPaint.length = 0;
      this.terrainPaint.push(...source.terrainPaint.map((dab) => ({ ...dab })));
      others.push('paint');
    }

    if (this.markingStyle !== source.markingStyle) {
      this.markingStyle = source.markingStyle;
      others.push('markingStyle');
    }

    if (landMoved) {
      this.ownList('terrainStamps');
      this.terrainStamps.length = 0;
      this.terrainStamps.push(...source.terrainStamps.map((stamp) => ({ ...stamp })));
      this.terrainRelief = source.terrainRelief;
    }

    this.nodeIds = new IdAllocator(source.nodeIds.peek);
    this.segIds = new IdAllocator(source.segIds.peek);
    this.poleIds = new IdAllocator(source.poleIds.peek);
    this.spanIds = new IdAllocator(source.spanIds.peek);
    this.barrierIds = new IdAllocator(source.barrierIds.peek);
    this.landscapeIds = new IdAllocator(source.landscapeIds.peek);
    this.nextTerrainId = source.nextTerrainId;
    return { roads: roadsChanged, land: landMoved, barriers: barriersChanged, others };
  }

  // ------------------------------------------------------------ serialization

  toJSON(): SerializedDoc {
    return this.serialized(true);
  }

  /** `JSON.stringify(this.toJSON())`, the same text, with the buildings' text kept per record */
  toText(): string {
    if (this.buildings.size === 0) return JSON.stringify(this.serialized(false));
    // The keys in `toJSON`'s order: those before the buildings, the buildings, those after.
    const head: Record<string, unknown> = {};
    const tail: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.serialized(false))) {
      (AFTER_BUILDINGS.has(key) ? tail : head)[key] = value;
    }
    const after = JSON.stringify(tail);
    return `${JSON.stringify(head).slice(0, -1)},"buildings":${this.buildings.toText()}${after === '{}' ? '' : `,${after.slice(1, -1)}`}}`;
  }

  /** `toJSON` without the buildings: the head of a map saved in parts (`editor/chunkedSave.ts`). */
  withoutBuildings(): SerializedDoc {
    return this.serialized(false);
  }

  /** `toJSON`, the buildings left out when `withBuildings` is false (`clone` shares them). */
  private serialized(withBuildings: boolean): SerializedDoc {
    return {
      version: 1,
      unit: METERS_PER_UNIT,
      nodes: [...this.nodes.values()].map((n) => ({
        // Copied, never aliased.
        id: n.id, x: n.x, y: n.y, heightOffset: n.heightOffset, smooth: n.smooth,
        control: n.control, blockedMovements: [...n.blockedMovements],
        ...(n.crossing ? { crossing: { kind: n.crossing.kind, segment: n.crossing.segment } } : {}),
        ...(n.laneLinks ? { laneLinks: n.laneLinks.map((l) => ({ ...l })) } : {}),
        ...(n.approachRules ? { approachRules: n.approachRules.map((e) => ({ ...e })) } : {}),
        ...(n.signal ? { signal: { ...n.signal, ...(n.signal.greens ? { greens: [...n.signal.greens] } : {}) } } : {}),
        ...(n.end ? { end: n.end } : {}),
        ...(n.uturn !== undefined ? { uturn: n.uturn as number } : {}),
      })),
      segments: [...this.segments.values()].map((s) => ({
        id: s.id,
        a: s.a,
        b: s.b,
        type: s.type,
        curve: s.curve ? { ...s.curve } : null,
        dashOrigin: s.dashOrigin,
        direction: s.direction,
        lanes: s.lanes,
        structure: s.structure,
        ...(s.section ? { section: cloneRoadSection(s.section) } : {}),
        ...(s.parking ? { parking: { ...s.parking } } : {}),
        ...(s.cutWalls ? { cutWalls: true as const } : {}),
      })),
      terrain: this.terrainStamps.map((stamp) => ({ ...stamp })),
      // Only for the natural land: a legacy map serialises as before.
      ...(this.terrainRelief !== RELIEF_LEGACY ? { relief: this.terrainRelief } : {}),
      ...(this.markingStyle !== 'classic' ? { markingStyle: this.markingStyle } : {}),
      ...(this.nature ? { nature: { ...this.nature } } : {}),
      ...(this.terrainPaint.length > 0 ? { paint: this.terrainPaint.map((dab) => ({ ...dab })) } : {}),
      ...(this.fogDabs.length > 0 || JSON.stringify(this.fogSettings) !== JSON.stringify(DEFAULT_FOG)
        ? { fog: { dabs: this.fogDabs.map((dab) => ({ ...dab })), settings: { ...this.fogSettings } } } : {}),
      ...(this.gullyDabs.length > 0 || this.gullyAuto !== DEFAULT_GULLY_AUTO
        ? { gullies: { dabs: this.gullyDabs.map((dab) => ({ ...dab })), auto: this.gullyAuto } } : {}),
      ...(this.clouds.length > 0 ? { clouds: this.clouds.map((c) => ({ ...c })) } : {}),
      ...(this.elements.length > 0 ? { elements: this.elements.map((e) => ({ ...e })) } : {}),
      ...(this.trees.length > 0 ? { trees: this.trees.map((t) => ({ ...t })) } : {}),
      ...(JSON.stringify(this.weather) !== JSON.stringify(DEFAULT_WEATHER) ? { weather: { ...this.weather } } : {}),
      ...(this.treeClearings.length > 0 ? { treeClearings: this.treeClearings.map((c) => ({ ...c })) } : {}),
      poles: [...this.poles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, lamp: p.lamp })),
      poleSpans: [...this.poleSpans.values()].map((s) => ({ id: s.id, a: s.a, b: s.b })),
      ...(this.landscape.size > 0 ? {
        landscape: [...this.landscape.values()].map((item) => ({ id: item.id, kind: item.kind, x: item.x, y: item.y,
          ...(item.signType ? { signType: item.signType } : {}), ...(item.text ? { text: item.text } : {}),
          ...(item.planted !== undefined ? { planted: item.planted } : {}) })),
      } : {}),
      // Only when there are any, so a map without them serialises as before.
      ...(this.barriers.size > 0 ? {
        barriers: [...this.barriers.values()].map((b) => ({ id: b.id, kind: b.kind, points: b.points.map((p) => ({ x: p.x, y: p.y })) })),
      } : {}),
      // Only when there are any, so a map without buildings serialises exactly as it did before buildings existed.
      ...(withBuildings && this.buildings.size > 0 ? { buildings: this.buildings.toJSON() } : {}),
      ...(this.zones.length > 0 ? { zones: this.zones.map((zone) => ({ ...zone, buildingIds: [...zone.buildingIds] })) } : {}),
      ...(this.zoneMarks.length > 0 ? { zoneMarks: this.zoneMarks.map((mark) => ({ ...mark })) } : {}),
      ...(this.lotStore.size > 0 || this.lotStore.keys.length > 0 ? {
        lots: this.lotStore.toJSON(),
        lotKeys: [...this.lotStore.keys],
      } : {}),
      // Likewise the people: only a city that has some carries the key.
      ...(this.people.length > 0 ? { people: this.people.map((p) => JSON.parse(JSON.stringify(p)) as PersonSpec) } : {}),
      // And the public transport.
      ...(hasTransit(this.transit) ? { transit: JSON.parse(JSON.stringify(this.transit)) as TransitData } : {}),
      // Only off the starting balance: a map that never paid for a road serialises as before.
      ...(this.economy.balance !== DEFAULT_ECONOMY.balance ? { economy: { balance: this.economy.balance } } : {}),
    };
  }

  /** Builds a document from its serialized form. */
  static fromJSON(saved: SerializedDoc, options: { readonly repair?: boolean; readonly shareBuildings?: BuildingStore } = {}): RoadDoc {
    // A map saved in another world unit (every map before 2026-10-10: 0.4 m) in this build's.
    const data = rescaleSerializedDoc(saved);
    const repair = options.repair ?? true;
    const doc = new RoadDoc();
    const canonicalNode = new Map<number, NodeId>();
    const nodeAt = new Map<string, RoadNode>();
    for (const n of data.nodes) {
      // Maps produced before cross-structure snapping was fixed can contain two endpoint records at the exact same world
      doc.nodeIds.reserve(n.id);
      const heightOffset = Number.isFinite(n.heightOffset) ? (n.heightOffset as number) : 0;
      const key = `${coordinateKey(n.x, n.y)}\u0000${heightOffset}`;
      const existing = repair ? nodeAt.get(key) : undefined;
      if (existing) {
        canonicalNode.set(n.id, existing.id);
        if (existing.control === 'auto' && n.control && n.control !== 'auto') {
          existing.control = n.control;
        }
        for (const movement of n.blockedMovements ?? []) {
          if (!existing.blockedMovements.includes(movement)) existing.blockedMovements.push(movement);
        }
        continue;
      }
      const id = asNodeId(n.id);
      // Nothing may leave the map (`addNode`/`moveNode` clamp); a file can.
      const at = repair ? clampToMap(n) : n;
      const node: RoadNode = {
        id, x: at.x, y: at.y, heightOffset, smooth: n.smooth ?? false,
        incident: [], control: n.control ?? 'auto',
        blockedMovements: n.blockedMovements ? [...n.blockedMovements] : [],
      };
      doc.nodes.set(id, node);
      nodeAt.set(key, node);
      canonicalNode.set(n.id, id);
    }
    for (const s of data.segments) {
      const id = asSegmentId(s.id);
      const a = canonicalNode.get(s.a) ?? asNodeId(s.a);
      const b = canonicalNode.get(s.b) ?? asNodeId(s.b);
      if (!doc.nodes.has(a) || !doc.nodes.has(b) || a === b) continue;
      const section = normalizeRoadSection(s.section);
      const parking = normalizeParking(s.parking);
      doc.segments.set(id, {
        id,
        a,
        b,
        type: s.type,
        curve: s.curve ?? null,
        dashOrigin: s.dashOrigin ?? 0,
        direction: s.direction ?? 'both',
        lanes: normaliseLaneCount(s.lanes ?? null, s.direction ?? 'both'),
        ...(section ? { section } : {}),
        ...(parking ? { parking } : {}),
        // Through the migration, so a level that has since been merged into another (`viaduct`) loads as the one it became.
        structure: migrateStructure(s.structure) ?? 'ground',
        ...(s.cutWalls === true ? { cutWalls: true as const } : {}),
      });
      doc.requireNode(a).incident.push(id);
      doc.requireNode(b).incident.push(id);
      doc.segIds.reserve(s.id);
    }
    for (const [id, node] of doc.nodes) if (node.incident.length === 0) doc.loose.add(id);
    // Crossings last: they name a segment, and only a two-road node that still holds that segment may carry one.
    for (const n of data.nodes) {
      const node = doc.nodes.get(asNodeId(n.id));
      const crossing = n.crossing;
      if (!node || canonicalNode.get(n.id) !== node.id || !crossing) continue;
      if (crossing.kind !== 'zebra' && crossing.kind !== 'signal') continue;
      node.crossing = { kind: crossing.kind, segment: asSegmentId(crossing.segment) };
      dropStaleCrossing(node);
    }
    // The player's lane connections: kept as stored (a link to a lane that is gone is left out of the build, `lanelets.ts`).
    for (const n of data.nodes) {
      const node = doc.nodes.get(asNodeId(n.id));
      if (!node || canonicalNode.get(n.id) !== node.id) continue;
      const links = normalizeLaneLinks(n.laneLinks);
      if (links) node.laneLinks = links;
      const rules = normalizeApproachRules(n.approachRules);
      if (rules) node.approachRules = rules;
      const signal = normalizeSignalSettings(n.signal);
      if (signal) node.signal = signal;
      if (n.end === 'bulb') node.end = 'bulb';
      if (typeof n.uturn === 'number' && node.incident.includes(asSegmentId(n.uturn))) node.uturn = asSegmentId(n.uturn);
    }
    for (const dab of data.paint ?? []) {
      if (!isPaintKind(dab.kind) || ![dab.x, dab.y, dab.radius, dab.strength].every(Number.isFinite)) continue;
      doc.terrainPaint.push({ kind: dab.kind, x: dab.x, y: dab.y, radius: dab.radius, strength: dab.strength });
    }
    const loaded = { cause: 'map loaded' } as const;
    if (doc.terrainPaint.length) doc.changes.record('paint', null, loaded);
    // Absent: a map with the default weather (dry and still).
    if (data.weather) { doc.weather = readWeather(data.weather); doc.changes.record('weather', null, loaded); }
    // Absent: a map with no trees planted or cut.
    for (const raw of data.trees ?? []) {
      const tree = readPlantedTree(raw);
      if (tree && doc.trees.length < MAX_PLANTED_TREES) doc.trees.push(tree);
    }
    if (doc.trees.length) doc.changes.record('trees', null, loaded);
    for (const raw of data.treeClearings ?? []) {
      const clearing = readTreeClearing(raw);
      if (clearing && doc.treeClearings.length < MAX_TREE_CLEARINGS) doc.treeClearings.push(clearing);
    }
    if (doc.treeClearings.length) doc.changes.record('clearings', null, loaded);
    // Absent: a map with no elements laid.
    for (const raw of data.elements ?? []) {
      const item = readElement(raw);
      if (item) doc.elements.push(item);
    }
    if (doc.elements.length) doc.changes.record('elements', null, loaded);
    // Absent: a map with no clouds placed.
    const cloudIds = new Set<number>();
    for (const raw of data.clouds ?? []) {
      const cloud = readCloud(raw);
      if (!cloud || doc.clouds.length >= MAX_PLACED_CLOUDS || cloudIds.has(cloud.id)) continue;
      cloudIds.add(cloud.id);
      doc.clouds.push(cloud);
    }
    if (doc.clouds.length) doc.changes.record('clouds', null, loaded);
    // Absent: a map with no gullies laid and the land's own at the default.
    if (data.gullies) {
      for (const raw of data.gullies.dabs ?? []) {
        const dab = readGullyDab(raw);
        if (dab && doc.gullyDabs.length < MAX_GULLY_DABS) doc.gullyDabs.push(dab);
      }
      const auto = data.gullies.auto;
      if (typeof auto === 'number' && Number.isFinite(auto)) doc.gullyAuto = Math.min(1, Math.max(0, auto));
      doc.changes.record('gullies', null, loaded);
    }
    // Absent: a map with no fog painted.
    if (data.fog) {
      for (const raw of data.fog.dabs ?? []) {
        const dab = readFogDab(raw);
        if (dab) doc.fogDabs.push(dab);
      }
      doc.fogSettings = readFogSettings(data.fog.settings);
      doc.changes.record('fog', null, loaded);
    }
    // Absent: a map from before the natural land, which stays on the old one.
    doc.terrainRelief = readRelief(data.relief) ?? RELIEF_LEGACY;
    doc.markingStyle = isMarkingStyle(data.markingStyle) ? data.markingStyle : 'classic';
    // Absent: a map from before the ecosystem, which keeps its ground.
    doc.nature = isNatureSettings(data.nature) ? { region: data.nature.region, seed: data.nature.seed } : null;
    for (const stamp of data.terrain ?? []) {
      doc.terrainStamps.push({ ...stamp });
      doc.nextTerrainId = Math.max(doc.nextTerrainId, stamp.id + 1);
    }

    // The utility network, if the map has one.
    for (const p of data.poles ?? []) {
      const id = asPoleId(p.id);
      const at = repair ? clampToMap(p) : p;
      doc.putPoleRecord({ id, x: at.x, y: at.y, lamp: p.lamp ?? false });
      doc.poleIds.reserve(p.id);
    }
    for (const s of data.poleSpans ?? []) {
      const a = asPoleId(s.a);
      const b = asPoleId(s.b);
      // A span whose poles did not survive is dropped rather than restored as a wire hanging off nothing.
      if (!doc.poles.has(a) || !doc.poles.has(b)) continue;
      const id = asSpanId(s.id);
      doc.putSpanRecord({ id, a, b });
      doc.spanIds.reserve(s.id);
    }
    // Public transport, if the map has any; anything malformed is dropped.
    if (data.transit) doc.transit = normalizeTransit(data.transit);
    // The balance, if the map has paid for anything (absent: the starting balance).
    const economy = data.economy === undefined ? null : readEconomy(data.economy);
    if (economy) { doc.economy = economy; doc.changes.record('economy', null, { cause: 'map loaded' }); }
    // The player's landscaping, if the map has any; anything malformed is dropped.
    for (const raw of data.landscape ?? []) {
      if (!isLandscapeKind(raw?.kind) || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || !Number.isInteger(raw.id)) continue;
      const at = repair ? clampToMap(raw) : { x: raw.x, y: raw.y };
      doc.putLandscapeRecord({ id: raw.id, kind: raw.kind, x: at.x, y: at.y,
        ...(isSignType(raw.signType) ? { signType: raw.signType } : {}),
        ...(typeof raw.text === 'string' && raw.text ? { text: raw.text.slice(0, SIGN_TEXT_MAX) } : {}),
        ...(Number.isFinite(raw.planted) ? { planted: raw.planted } : {}) });
      doc.landscapeIds.reserve(raw.id);
    }
    // Walls, fences and hedges, if the map has any; anything malformed is dropped.
    for (const raw of data.barriers ?? []) {
      if (!isBarrierKind(raw.kind) || !Array.isArray(raw.points)) continue;
      const points = raw.points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map((p) => (repair ? clampToMap(p) : { x: p.x, y: p.y }));
      if (points.length < 2) continue;
      doc.putBarrierRecord({ id: raw.id, kind: raw.kind, points });
      doc.barrierIds.reserve(raw.id);
    }
    // Buildings, if the map has any; each one through `migrateBuilding`.
    if (options.shareBuildings) doc.buildings.shareFrom(options.shareBuildings);
    else if (data.buildings) doc.buildings.load(data.buildings);
    // The ids already read by a set, NOT `doc.lots.some(...)` per record
    const zoneIds = new Set<number>();
    for (const zone of data.zones ?? []) {
      if (!Number.isInteger(zone.id) || zone.id < 1 || !isZoneUse(zone.use) || !isZoneDensity(zone.density)) continue;
      if (![zone.x0, zone.y0, zone.x1, zone.y1, zone.seed].every(Number.isFinite)) continue;
      if (zone.x0 >= zone.x1 || zone.y0 >= zone.y1 || !Array.isArray(zone.buildingIds) || zoneIds.has(zone.id)) continue;
      zoneIds.add(zone.id);
      doc.zones.push({ ...zone, buildingIds: zone.buildingIds.filter((id) => Number.isInteger(id) && doc.buildings.has(id as Parameters<typeof doc.buildings.has>[0])) });
      doc.nextZoneId = Math.max(doc.nextZoneId, zone.id + 1);
    }
    for (const mark of data.zoneMarks ?? []) {
      if (!isZoneMark(mark)) continue;
      const standing = mark.building !== undefined && doc.buildings.has(mark.building as Parameters<typeof doc.buildings.has>[0]);
      const { building: _gone, ...free } = mark;
      doc.zoneMarks.push(standing ? { ...mark } : free);
    }
    const lotIds = new Set<number>();
    const lots: Lot[] = [];
    for (const lot of data.lots ?? []) {
      if (!isLot(lot) || lotIds.has(lot.id)) continue;
      lotIds.add(lot.id);
      const standing = lot.building !== undefined && doc.buildings.has(lot.building as Parameters<typeof doc.buildings.has>[0]);
      // Its own corners: a stored record is never changed in place, and the data read may be.
      const { building: _gone, ...free } = { ...lot, corners: lot.corners.map((q) => ({ x: q.x, y: q.y })) };
      lots.push(standing ? { ...free, building: lot.building! } : free);
    }
    doc.lotStore.load(lots, (data.lotKeys ?? []).filter((key): key is string => typeof key === 'string'));
    // People, each brought into range; anything that is not one is dropped.
    const seen = new Set<number>();
    for (const raw of data.people ?? []) {
      const person = normalizePerson(raw);
      if (!person || seen.has(person.id)) continue;
      seen.add(person.id);
      doc.people.push(person);
    }
    doc.roadsChanged(null, true, { detail: 'map loaded' });
    if (data.terrain?.length) doc.changes.record('terrain', null, { cause: 'map loaded' });
    return doc;
  }
}

/** The nodes that may have been left with no road (`RoadDoc.pruneOrphanNodes`) */
class LooseNodes {
  private own = new Set<NodeId>();
  constructor(private below: LooseNodes | null = null) {}

  add(id: NodeId): void {
    this.own.add(id);
  }

  /** Each once, in id order (as the walk over the map met them). */
  sorted(): NodeId[] {
    const all = new Set(this.below?.sorted());
    for (const id of this.own) all.add(id);
    return [...all].sort((p, q) => p - q);
  }

  clear(): void {
    this.own.clear();
    this.below = null;
  }

  /** A working copy's, over this one. */
  over(): LooseNodes {
    return new LooseNodes(this);
  }

  /** An independent copy (`RoadDoc.clone`). */
  copy(): LooseNodes {
    const out = new LooseNodes();
    for (const id of this.sorted()) out.add(id);
    return out;
  }

  /** A working copy's over this one taken back: what it holds now (only its own once it pruned). */
  take(copy: LooseNodes): void {
    if (copy.below === null) {
      this.own = copy.own;
      this.below = null;
    } else for (const id of copy.own) this.own.add(id);
    copy.own = new Set();
  }
}

/** Exact serialization key; normalises the two JavaScript spellings of zero. */
function coordinateKey(x: number, y: number): string {
  const nx = Object.is(x, -0) ? 0 : x;
  const ny = Object.is(y, -0) ? 0 : y;
  return `${nx}\u0000${ny}`;
}

/** The document's keyed collections, its ordered lists and its single values, as undo restores them (`RoadDoc.restore`). */
export type RecordPart = 'nodes' | 'segments' | 'poles' | 'poleSpans' | 'landscape' | 'barriers' | 'buildings' | 'lots';
export type ListPart = 'terrainStamps' | 'terrainPaint' | 'fogDabs' | 'gullyDabs' | 'clouds' | 'trees' | 'treeClearings' | 'elements'
  | 'zones' | 'zoneMarks' | 'lotKeys' | 'people';
export type ValuePart = 'terrainRelief' | 'markingStyle' | 'nature' | 'fogSettings' | 'gullyAuto' | 'weather' | 'economy' | 'transit'
  | 'nextZoneId' | 'nextLotId' | 'allocators';
/** The lists the document holds itself (the lots' keys are the lot store's): what a working copy shares until it writes (`RoadDoc.fork`). */
type DocListPart = Exclude<ListPart, 'lotKeys'>;
const DOC_LISTS: readonly DocListPart[] = ['terrainStamps', 'terrainPaint', 'fogDabs', 'gullyDabs', 'clouds', 'trees', 'treeClearings', 'elements', 'zones', 'zoneMarks', 'people'];
/** The indices by place a working copy reads from the original until it writes their kind (`RoadDoc.ownIndex`). */
type IndexKind = 'poles' | 'barriers' | 'landscape';
const INDEX_KINDS: readonly IndexKind[] = ['poles', 'barriers', 'landscape'];
/** The kinds the roads' changes are written under (`roadsChanged`). */
const ROAD_KINDS: readonly DocChangeKind[] = ['roads', 'traffic'];
/** The diary kind each list is written under. */
export const LIST_KINDS: Readonly<Record<ListPart, DocChangeKind>> = {
  terrainStamps: 'terrain', terrainPaint: 'paint', fogDabs: 'fog', gullyDabs: 'gullies', clouds: 'clouds', trees: 'trees',
  treeClearings: 'clearings', elements: 'elements', zones: 'zones', zoneMarks: 'zones', lotKeys: 'lotKeys', people: 'people',
};
/** What undo or redo puts back: records (undefined: none), stretches of lists (`splice`), values. */
export interface Restoration {
  readonly records: readonly { readonly part: RecordPart; readonly id: number; readonly value: unknown }[];
  readonly lists: readonly { readonly part: ListPart; readonly start: number; readonly remove: number; readonly items: readonly unknown[] }[];
  readonly values: readonly { readonly part: ValuePart; readonly value: unknown }[];
}

export interface SerializedDoc {
  readonly version: 1;
  /** Metres per world unit the map was saved in (`world/units.ts`); absent: 0.4, every map before 2026-10-10 (`rescale.ts`). */
  readonly unit?: number;
  readonly nodes: readonly {
    id: number; x: number; y: number; heightOffset?: number; smooth?: boolean;
    control?: JunctionControl; blockedMovements?: readonly string[];
    crossing?: { kind: NodeCrossingKind; segment: number };
    /** The player's lane connections; absent on every older map. */
    laneLinks?: readonly { from: number; fromLane: number; to: number; toLane: number }[];
    /** Each leg's rule; absent on every older map. */
    approachRules?: readonly { segment: number; rule: string }[];
    /** A signal's settings (V5); absent on every older map. */
    signal?: unknown;
    /** A road's end that is a turning circle (V8); absent: the map's edge. */
    end?: string;
    /** A U-turn through the median (V8): the road its traffic arrives from; absent on every older map. */
    uturn?: number;
  }[];
  readonly segments: readonly {
    id: number;
    a: number;
    b: number;
    type: number;
    curve: CurveShape | null;
    dashOrigin?: number;
    direction?: SegmentDirection;
    lanes?: number | null;
    section?: RoadSection;
    parking?: SegmentParking;
    /** A current structure id, or a legacy one `migrateStructure` maps. */
    structure?: RoadStructure | 'viaduct';
    /** Retaining walls in its cutting; absent on every older map. */
    cutWalls?: boolean;
  }[];
  readonly terrain?: readonly TerrainStamp[];
  /** `ReliefVersion`; absent on maps made before the natural landform. */
  readonly relief?: number;
  /** The regional standard of the road paint; absent: 'classic'. */
  readonly markingStyle?: string;
  /** The ecosystem (`NatureSettings`); absent on maps made before it. */
  readonly nature?: { readonly region: string; readonly seed: number };
  /** The utility network. */
  readonly poles?: readonly { id: number; x: number; y: number; lamp?: boolean }[];
  readonly poleSpans?: readonly { id: number; a: number; b: number }[];
  /** Ground painted over the terrain (`terrainPaint.ts`); OPTIONAL. */
  readonly paint?: readonly { kind: string; x: number; y: number; radius: number; strength: number }[];
  readonly fog?: { readonly dabs?: readonly unknown[]; readonly settings?: unknown };
  readonly gullies?: { readonly dabs?: readonly unknown[]; readonly auto?: unknown };
  readonly clouds?: readonly unknown[];
  readonly elements?: readonly unknown[];
  readonly trees?: readonly unknown[];
  readonly weather?: unknown;
  readonly treeClearings?: readonly unknown[];
  /** The player's landscaping (`landscape.ts`); OPTIONAL like the poles. */
  readonly landscape?: readonly { id: number; kind: string; x: number; y: number; signType?: string; text?: string; planted?: number }[];
  /** Public transport (`transit.ts`); OPTIONAL like the poles. */
  readonly transit?: unknown;
  /** Walls, fences and hedges (`barriers.ts`); OPTIONAL like the poles. */
  readonly barriers?: readonly { id: number; kind: string; points: readonly { x: number; y: number }[] }[];
  /** Modular buildings. */
  readonly buildings?: readonly SerializedBuilding[];
  /** Roadside land-use strokes; absent in maps saved before zoning. */
  readonly zones?: readonly Zone[];
  readonly zoneMarks?: readonly ZoneMark[];
  /** The lots (`lots.ts`); absent in maps saved before them. */
  readonly lots?: readonly Lot[];
  readonly lotKeys?: readonly string[];
  /** People from the Person Creator; OPTIONAL like the buildings. Normalised on load. */
  readonly people?: readonly unknown[];
  /** The balance (`economy.ts`); absent at the starting balance. */
  readonly economy?: { readonly balance: number };
}

function detach(n: RoadNode | undefined, id: SegmentId): void {
  if (!n) return;
  const i = n.incident.indexOf(id);
  if (i >= 0) n.incident.splice(i, 1);
}

function normaliseLaneCount(lanes: number | null, direction: SegmentDirection): number | null {
  if (lanes === null) return null;
  const value = Math.max(1, Math.min(8, Math.round(lanes)));
  // A two-way road must have an equal number of lanes on both sides.
  return direction === 'both' ? Math.max(2, Math.ceil(value / 2) * 2) : value;
}

/** Whether two versions of a node are the same, field for field. */
function sameNode(p: RoadNode, q: RoadNode): boolean {
  return p.x === q.x && p.y === q.y && p.heightOffset === q.heightOffset && p.smooth === q.smooth &&
    p.control === q.control && sameList(p.incident, q.incident) && sameList(p.blockedMovements, q.blockedMovements) &&
    p.crossing?.kind === q.crossing?.kind && p.crossing?.segment === q.crossing?.segment &&
    linksDigest(p.laneLinks) === linksDigest(q.laneLinks) && rulesDigest(p.approachRules) === rulesDigest(q.approachRules) &&
    signalDigest(p.signal) === signalDigest(q.signal) && p.end === q.end && p.uturn === q.uturn;
}

/** Whether two versions of a segment are the same, field for field (its ends' positions aside). */
function sameSegment(p: RoadSegment, q: RoadSegment): boolean {
  return p.a === q.a && p.b === q.b && p.type === q.type && p.dashOrigin === q.dashOrigin &&
    p.direction === q.direction && p.lanes === q.lanes && p.structure === q.structure && p.cutWalls === q.cutWalls &&
    sameRoadSection(p.section, q.section) && sameParking(p.parking, q.parking) &&
    (p.curve?.t ?? null) === (q.curve?.t ?? null) && (p.curve?.h ?? null) === (q.curve?.h ?? null);
}

/** Whether two documents hold the same nodes and segments, field for field. */
/** A node's record copied whole, nothing aliased (`clone`, `replaceContents`). */
function copyNode(node: RoadNode): RoadNode {
  return {
    id: node.id, x: node.x, y: node.y, heightOffset: node.heightOffset, smooth: node.smooth,
    incident: [...node.incident], control: node.control,
    blockedMovements: [...node.blockedMovements],
    ...(node.crossing ? { crossing: { ...node.crossing } } : {}),
    ...(node.laneLinks ? { laneLinks: node.laneLinks.map((l) => ({ ...l })) } : {}),
    ...(node.approachRules ? { approachRules: node.approachRules.map((e) => ({ ...e })) } : {}),
    ...(node.signal ? { signal: { ...node.signal, ...(node.signal.greens ? { greens: [...node.signal.greens] } : {}) } } : {}),
    ...(node.end ? { end: node.end } : {}),
    ...(node.uturn !== undefined ? { uturn: node.uturn } : {}),
  };
}

/** A segment's record copied whole (`clone`, `replaceContents`). */
function copySegment(segment: RoadSegment): RoadSegment {
  return {
    ...segment,
    curve: segment.curve ? { ...segment.curve } : null,
    ...(segment.section ? { section: cloneRoadSection(segment.section) } : {}),
    ...(segment.parking ? { parking: { ...segment.parking } } : {}),
  };
}

function sameRoads(a: RoadDoc, b: RoadDoc): boolean {
  if (a.nodes.size !== b.nodes.size || a.segments.size !== b.segments.size) return false;
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (!q || !sameNode(p, q)) return false;
  }
  for (const [id, p] of a.segments) {
    const q = b.segments.get(id);
    if (!q || !sameSegment(p, q)) return false;
  }
  return true;
}

/** Around a junction with no road yet, world units. */
const NODE_PAD = 30;
/** Side of the cells the street furniture is filed in (`RoadDoc.landscapeIn`), world units. */
const LANDSCAPE_CELL = m(32);
/** Around a pole, a bench, a tree, a fence: what stands round it. */
const ITEM_PAD = 6;

const circleRect = (c: { readonly x: number; readonly y: number; readonly radius: number }): ChangeRect =>
  [c.x - c.radius, c.y - c.radius, c.x + c.radius, c.y + c.radius];

/** One box round circles (dabs, stamps, clearings), as the diary takes it: where they all lay; none for none. */
function circlesBox(items: readonly { readonly x: number; readonly y: number; readonly radius: number }[]): ChangeRect[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of items) {
    minX = Math.min(minX, c.x - c.radius); minY = Math.min(minY, c.y - c.radius);
    maxX = Math.max(maxX, c.x + c.radius); maxY = Math.max(maxY, c.y + c.radius);
  }
  return minX <= maxX ? [[minX, minY, maxX, maxY]] : [];
}

/** The box round elements, grown by the largest one's size; null for none. */
function elementsBox(items: readonly ElementItem[]): ChangeRect | null {
  let pad = ITEM_PAD;
  for (const e of items) pad = Math.max(pad, e.size);
  return rectAround(items, pad);
}

/** The box round a stretch of one of the document's lists (`RoadDoc.restore`) */
function listBox(part: ListPart, items: readonly unknown[]): ChangeRect | null | undefined {
  if (items.length === 0) return null;
  switch (part) {
    case 'terrainStamps': case 'terrainPaint': case 'fogDabs': case 'gullyDabs': case 'treeClearings':
      return circlesBox(items as readonly { x: number; y: number; radius: number }[])[0] ?? null;
    case 'trees': return rectAround(items as readonly PlantedTree[], ITEM_PAD);
    case 'elements': return elementsBox(items as readonly ElementItem[]);
    case 'clouds': {
      let pad = 0;
      for (const c of items as readonly PlacedCloud[]) pad = Math.max(pad, c.size);
      return rectAround(items as readonly PlacedCloud[], pad);
    }
    default: return undefined;
  }
}

/** `list.splice(start, remove, ...items)` without spreading `items` into arguments: a stretch of tens of thousands */
function spliceIn<T>(list: T[], start: number, remove: number, items: readonly T[]): T[] {
  const tail = list.splice(start + remove);
  const gone = list.splice(start, remove);
  for (const item of items) list.push(item);
  for (const item of tail) list.push(item);
  return gone;
}

/** Whether a node's change moves the plan the traffic runs on */
function nodeMovesTraffic(p: RoadNode | undefined, q: RoadNode | undefined): boolean {
  if (!p || !q) return true;
  if ((p.heightOffset < -TUNNEL_HEADROOM) !== (q.heightOffset < -TUNNEL_HEADROOM)) return true;
  return !sameNode(p, { ...q, heightOffset: p.heightOffset });
}

/** Whether a source document changed any of these kinds since it was copied (`RoadDoc.movedIn`). */
type MovedKinds = (...kinds: readonly DocChangeKind[]) => boolean;

/** Where two documents' roads differ: every segment and node that is new, gone or changed */
function roadDifferences(a: RoadDoc, b: RoadDoc): { rects: ChangeRect[]; ids: number[]; traffic: boolean } {
  const rects: ChangeRect[] = [];
  const ids: number[] = [];
  // Every segment that differs moves the traffic's plan (`markSegment`); a node only by more than its height
  let traffic = false;
  const add = (rect: ChangeRect | null): void => { if (rect) rects.push(rect); };
  const endsMoved = (s: RoadSegment): boolean => {
    for (const end of [s.a, s.b]) {
      const p = a.nodes.get(end), q = b.nodes.get(end);
      if (!p || !q || p.x !== q.x || p.y !== q.y) return true;
    }
    return false;
  };
  for (const [id, p] of a.segments) {
    const q = b.segments.get(id);
    if (q && sameSegment(p, q) && !endsMoved(p)) continue;
    ids.push(id);
    traffic = true;
    add(a.segmentRect(id));
    if (q) add(b.segmentRect(id));
  }
  for (const id of b.segments.keys()) {
    if (a.segments.has(id)) continue;
    ids.push(id);
    traffic = true;
    add(b.segmentRect(id));
  }
  // The nodes by id too, as `markNode` writes them: a reader by id (the undo image) reads them.
  for (const [id, p] of a.nodes) {
    const q = b.nodes.get(id);
    if (q && sameNode(p, q)) continue;
    if (nodeMovesTraffic(p, q)) traffic = true;
    ids.push(id);
    add(a.nodeRect(id));
    if (q) add(b.nodeRect(id));
  }
  for (const id of b.nodes.keys()) if (!a.nodes.has(id)) { traffic = true; ids.push(id); add(b.nodeRect(id)); }
  return { rects, ids, traffic };
}

/** The land's stamps added, gone or changed between two lists, by id. */
function stampDifferences(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): { rects: ChangeRect[]; ids: number[] } {
  const rects: ChangeRect[] = [];
  const ids: number[] = [];
  const mine = new Map(a.map((s) => [s.id, s]));
  const theirs = new Map(b.map((s) => [s.id, s]));
  for (const [id, s] of mine) {
    const t = theirs.get(id);
    if (t && JSON.stringify(s) === JSON.stringify(t)) continue;
    ids.push(id);
    rects.push(circleRect(s));
    if (t) rects.push(circleRect(t));
  }
  for (const [id, t] of theirs) if (!mine.has(id)) { ids.push(id); rects.push(circleRect(t)); }
  return { rects, ids };
}

/** Where two documents' poles and wires, landscaping and barriers differ, and their ids (a span with its two poles, as `addPoleSpan` names them). */
function itemDifferences(a: RoadDoc, b: RoadDoc, moved: MovedKinds): Record<'utilities' | 'landscape' | 'barriers', { rects: ChangeRect[]; ids: number[] }> {
  const utilities = { rects: [] as ChangeRect[], ids: [] as number[] };
  const landscape = { rects: [] as ChangeRect[], ids: [] as number[] };
  const barriers = { rects: [] as ChangeRect[], ids: [] as number[] };
  const at = (p: { x: number; y: number }): ChangeRect => rectAround([p], ITEM_PAD)!;
  if (moved('utilities')) {
    for (const [id, p] of a.poles) { const q = b.poles.get(id); if (!q || p.x !== q.x || p.y !== q.y || p.lamp !== q.lamp) { utilities.ids.push(id); utilities.rects.push(at(p)); if (q) utilities.rects.push(at(q)); } }
    for (const [id, q] of b.poles) if (!a.poles.has(id)) { utilities.ids.push(id); utilities.rects.push(at(q)); }
    const span = (doc: RoadDoc, s: UtilitySpan): void => {
      utilities.ids.push(s.id, s.a, s.b);
      const p = doc.poles.get(s.a), q = doc.poles.get(s.b);
      if (p && q) utilities.rects.push(rectAround([p, q], ITEM_PAD)!);
    };
    for (const [id, s] of a.poleSpans) { const t = b.poleSpans.get(id); if (!t || t.a !== s.a || t.b !== s.b) { span(a, s); if (t) span(b, t); } }
    for (const [id, t] of b.poleSpans) if (!a.poleSpans.has(id)) span(b, t);
  }
  if (moved('landscape')) {
    for (const [id, p] of a.landscape) {
      const q = b.landscape.get(id);
      if (q && p.kind === q.kind && p.x === q.x && p.y === q.y && p.signType === q.signType && p.text === q.text && p.planted === q.planted) continue;
      landscape.ids.push(id);
      landscape.rects.push(at(p));
      if (q) landscape.rects.push(at(q));
    }
    for (const [id, q] of b.landscape) if (!a.landscape.has(id)) { landscape.ids.push(id); landscape.rects.push(at(q)); }
  }
  if (moved('barriers')) {
    for (const [id, p] of a.barriers) {
      const q = b.barriers.get(id);
      if (q && JSON.stringify(p) === JSON.stringify(q)) continue;
      barriers.ids.push(id);
      barriers.rects.push(rectAround(p.points, ITEM_PAD)!);
      if (q) barriers.rects.push(rectAround(q.points, ITEM_PAD)!);
    }
    for (const [id, q] of b.barriers) if (!a.barriers.has(id)) { barriers.ids.push(id); barriers.rects.push(rectAround(q.points, ITEM_PAD)!); }
  }
  return { utilities, landscape, barriers };
}

/** Whether two documents hold the same barriers, point for point. */
function sameBarriers(a: RoadDoc, b: RoadDoc): boolean {
  if (a.barriers.size !== b.barriers.size) return false;
  for (const [id, p] of a.barriers) {
    const q = b.barriers.get(id);
    if (!q || p.kind !== q.kind || p.points.length !== q.points.length) return false;
    for (let i = 0; i < p.points.length; i++) {
      if (p.points[i]!.x !== q.points[i]!.x || p.points[i]!.y !== q.points[i]!.y) return false;
    }
  }
  return true;
}

/** Things standing at a point (an element of the brush), by the cell of their point */
class ItemGrid<T extends { readonly x: number; readonly y: number }> {
  private readonly cells = new Map<number, Set<T>>();
  constructor(private readonly side: number) {}
  private keyOf(x: number, y: number): number { return (Math.floor(x / this.side) + 32768) * 65536 + (Math.floor(y / this.side) + 32768); }
  add(item: T): void {
    const key = this.keyOf(item.x, item.y);
    const set = this.cells.get(key);
    if (set) set.add(item); else this.cells.set(key, new Set([item]));
  }
  remove(item: T): void {
    const key = this.keyOf(item.x, item.y);
    const set = this.cells.get(key);
    if (!set) return;
    set.delete(item);
    if (set.size === 0) this.cells.delete(key);
  }
  /** The items in the cells a rectangle reaches. */
  near(rect: ChangeRect): T[] {
    const out: T[] = [];
    for (let i = Math.floor(rect[0] / this.side); i <= Math.floor(rect[2] / this.side); i++) {
      for (let j = Math.floor(rect[1] / this.side); j <= Math.floor(rect[3] / this.side); j++) {
        for (const item of this.cells.get((i + 32768) * 65536 + (j + 32768)) ?? []) out.push(item);
      }
    }
    return out;
  }
}

/** Keeps in `list`, in order and in place, the items `keep` says; one pass. */
function keepWhere<T>(list: T[], keep: (item: T) => boolean): void {
  let at = 0;
  for (const item of list) if (keep(item)) list[at++] = item;
  list.length = at;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** `toJSON`'s keys written after the buildings (`RoadDoc.toText`). */
const AFTER_BUILDINGS = new Set(['zones', 'zoneMarks', 'lots', 'lotKeys', 'people', 'transit', 'economy']);

/** Two stamp lists that shape the same land (stamp by stamp, field by field). */
export function sameStamps(a: readonly TerrainStamp[], b: readonly TerrainStamp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as TerrainStamp;
    const q = b[i] as TerrainStamp;
    if (p === q) continue;
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]) as Set<keyof TerrainStamp>;
    for (const key of keys) if (p[key] !== q[key]) return false;
  }
  return true;
}

/** A crossing stays only on a two-road node that still holds its segment. */
function dropStaleCrossing(node: RoadNode | undefined): void {
  if (!node?.crossing) return;
  if (node.incident.length === 2 && node.incident.includes(node.crossing.segment)) return;
  const placed = node.crossing.kind === 'signal' ? 'signal' : 'priority';
  delete node.crossing;
  // The control the crossing put there goes with it, so the new junction picks its own
  if (node.control === placed) node.control = 'auto';
}

function samePaint(a: readonly PaintDab[], b: readonly PaintDab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!;
    if (p.kind !== q.kind || p.x !== q.x || p.y !== q.y || p.radius !== q.radius || p.strength !== q.strength) return false;
  }
  return true;
}
