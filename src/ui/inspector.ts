import { streetNameOf, streetNumbers } from '@world/roads/streetNames';
import { PARKING_KINDS, parkingAllowed, type ParkingKind, type SegmentParking } from '@world/parking';
import type { NodeId, SegmentId } from '@world/ids';
import { type JunctionControl, type NodeCrossingKind, type RoadDoc, type RoadEnd, type SegmentDirection } from '@world/doc';
import type { Network } from '@world/network';
import type { CurveShape } from '@core/bezier';
import { LAST_UPGRADE_CLASS, ROAD_TYPES, roadProfile, travelLanes, type RoadType } from '@world/roadTypes';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import type { SimInspect } from '@sim/host';
import { formatDecimal, language, plural, t } from './i18n';
import { roadTypeName } from './labels';
import { surfaceMode } from '@world/junction/build';
import type { RoadSection } from '@world/roadSection';
import { freeRoadsEnabled, mountRoadSectionEditor } from './roadSectionEditor';
import { mountProfilePanel } from './roads/profilePanel';
import { mountConnectorPanel, refreshConnectorPanel } from './roads/connectorPanel';
import { mountJunctionPanel, refreshJunctionFlows } from './roads/junctionPanel';
import type { ApproachRuleEntry, SignalSettings } from '@world/roads/rules';
import type { LaneLink } from '@world/roads/connectors';
import type { RoadProfileSpec } from '@world/roads/profile';

export interface InspectorSelection {
  readonly segment: SegmentId | null;
  readonly node: NodeId | null;
}

export interface InspectorActions {
  readonly onUpgrade: (id: SegmentId) => void;
  readonly onSetType: (id: SegmentId, type: number) => void;
  readonly onSetLanes?: (id: SegmentId, lanes: number | null) => void;
  readonly onSetSection?: (id: SegmentId, section: RoadSection | undefined) => void;
  /** A whole cross-section applied to the road, with its class when it comes from a template. */
  readonly onApplyProfile?: (id: SegmentId, profile: RoadProfileSpec, type?: number) => void;
  /** V8: this road's profile copied to the whole street (`world/roads/streetChain.ts`); how many segments that is. */
  readonly onProfileToStreet?: (id: SegmentId) => void;
  readonly streetLength?: (id: SegmentId) => number;
  /** V8: the road tool taken up with this road's profile (the eyedropper). */
  readonly onDrawWithProfile?: () => void;
  readonly onSetParking?: (id: SegmentId, parking: SegmentParking) => void;
  readonly onDelete: (id: SegmentId) => void;
  readonly onSetDirection?: (id: SegmentId, direction: SegmentDirection) => void;
  readonly onSetNodeHeight?: (id: NodeId, metres: number) => void;
  /** V8: a road's end as the map's edge (undefined) or a turning circle. */
  readonly onSetNodeEnd?: (id: NodeId, end: RoadEnd | undefined) => void;
  readonly onReverseDirection?: (id: SegmentId) => void;
  readonly onSplit?: (id: SegmentId) => void;
  /** Places a mid-block pedestrian crossing on the road (`commitPedestrianCrossing`). */
  readonly onAddCrossing?: (id: SegmentId, kind: NodeCrossingKind) => void;
  readonly onRemoveCrossing?: (node: NodeId) => void;
  /** V8: a U-turn through the median where the road was clicked, or its middle (`commitUturn`). */
  readonly onAddUturn?: (id: SegmentId, toward: 'a' | 'b') => void;
  readonly onAddHeightPoint?: (id: SegmentId) => void;
  readonly onDuplicate?: (id: SegmentId) => void;
  readonly onSetControl?: (id: NodeId, control: JunctionControl) => void;
  readonly onSetMovementBlocked?: (node: NodeId, from: SegmentId, to: SegmentId, blocked: boolean) => void;
  /** The player's lane connections at a node; undefined: all derived. */
  readonly onSetLaneLinks?: (node: NodeId, links: LaneLink[] | undefined) => void;
  /** Each leg's rule at a junction; undefined: derived. */
  readonly onSetApproachRules?: (node: NodeId, rules: ApproachRuleEntry[] | undefined) => void;
  /** A junction's signal settings (V5); and several at once (a green wave). */
  readonly onSetSignal?: (node: NodeId, settings: SignalSettings | undefined) => void;
  readonly onSetSignals?: (settings: ReadonlyMap<NodeId, SignalSettings>) => void;
  /** World to screen, for plans drawn as the player sees the map (the lane connectors). */
  readonly project?: (x: number, y: number) => { readonly x: number; readonly y: number };
  readonly onSetCurve?: (id: SegmentId, curve: CurveShape | null) => void;
  readonly onJoin?: (node: NodeId) => void;
  /** Removes a node and the roads that meet at it. Offered only for a node the editor could not have created. */
  readonly onRemoveNode?: (node: NodeId) => void;
}

interface InspectorContext {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimInspect;
  readonly selection: InspectorSelection;
  readonly actions: InspectorActions;
}

let current: InspectorContext | null = null;

/** What the panel's controls were last built for. */
let builtFor = '';

/** Inspector panel. */
export function openInspector(
  doc: RoadDoc,
  net: Network,
  sim: SimInspect,
  selection: InspectorSelection,
  actions: InspectorActions,
): void {
  current = { doc, net, sim, selection, actions };
  builtFor = '';
  renderCurrent();
}

/** Refreshes the open inspector without replacing its selection or actions. */
export function refreshInspector(): void {
  if (current) renderCurrent();
}

function renderCurrent(): void {
  const panel = document.getElementById('inspector');
  const body = document.getElementById('inspectorBody');
  if (!panel || !body || !current) return;

  const { doc, net, sim, selection, actions } = current;
  // A junction's panel also follows the traffic's view of it: its signal comes or goes when the lane graph is rebuilt
  const traffic = selection.node !== null ? sim.junction(selection.node) : undefined;
  const junctionState = selection.node !== null
    ? `|${traffic ? `${traffic.built ? 1 : 0}${traffic.movements}` : '?'}|${traffic?.signalised ? 1 : 0}|${traffic?.autoChoice ?? ''}` : '';
  const key = `${selection.segment}|${selection.node}|${doc.revision}|${language()}${junctionState}`;
  const stats = document.getElementById('inspectStats');

  if (key === builtFor && stats && body.contains(stats)) {
    const html =
      selection.segment !== null
        ? segmentStats(doc, net, sim, selection.segment)
        : selection.node !== null
          ? nodeStats(doc, sim, selection.node)
          : null;
    if (html === null) closeInspector();
    else if (stats.innerHTML !== html) stats.innerHTML = html;
    // The lane graph is rebuilt a moment after an edit: the connector editor follows it.
    if (selection.node !== null) { refreshConnectorPanel(); refreshJunctionFlows(traffic, doc, selection.node); }
    return;
  }

  if (selection.segment !== null) {
    renderSegment(doc, net, sim, body, selection.segment, actions);
  } else if (selection.node !== null) {
    renderNode(doc, net, sim, body, selection.node);
  } else {
    closeInspector();
    return;
  }
  // A renderer closes the panel when its selected entity no longer exists.
  if (!current) return;
  builtFor = key;
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  panel.classList.remove('hidden');
  document.getElementById('app')?.classList.add('inspector-open');
  tellOpen(true);
}

/** Whether the panel is open, told to whoever shows it (`main.ts` writes it in the game's state). */
const openListeners: ((open: boolean) => void)[] = [];
let openNow = false;
function tellOpen(open: boolean): void {
  if (open === openNow) return;
  openNow = open;
  for (const listen of openListeners) listen(open);
}
/** Called whenever the panel opens or closes, by a command or by itself (what it showed is gone). */
export function onInspectorChange(listen: (open: boolean) => void): void {
  openListeners.push(listen);
}

export function closeInspector(): void {
  current = null;
  builtFor = '';
  const panel = document.getElementById('inspector');
  if (panel) {
    panel.classList.add('hidden');
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  document.getElementById('app')?.classList.remove('inspector-open');
  tellOpen(false);
}

/** A choice of on-street parking for one side: the kinds this class can carry */
/** What a road's end is (V8), for an end that is the end of this road alone: the map's edge or a turning circle. */
function endSelect(doc: RoadDoc, node: NodeId, which: 'A' | 'B'): string {
  if (doc.degree(node) !== 1) return '';
  const value = doc.node(node)?.end ?? 'edge';
  const options = (['edge', 'bulb'] as const)
    .map((kind) => `<option value="${kind}"${kind === value ? ' selected' : ''}>${t(`inspector.end.${kind}`)}</option>`).join('');
  return `<label class="inspect-select">${t(which === 'A' ? 'inspector.endStart' : 'inspector.endEnd')} <select data-road-end="${which}">${options}</select></label>`;
}

function parkingSelect(id: string, label: string, value: ParkingKind, rt: RoadType): string {
  const options = PARKING_KINDS.filter((kind) => kind === value || parkingAllowed(kind, rt))
    .map((kind) => `<option value="${kind}"${kind === value ? ' selected' : ''}>${t(`parking.${kind}`)}</option>`).join('');
  return `<label class="inspect-select">${t(label)} <select id="${id}">${options}</select></label>`;
}

/** The live numbers for a road, or null when the road no longer exists. */
function segmentStats(doc: RoadDoc, net: Network, sim: SimInspect, id: SegmentId): string | null {
  const seg = doc.segment(id);
  if (!seg) return null;
  const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
  const length = net.polylines.get(doc, id).length;
  // The traffic's numbers (`sim/inspect.ts`), a dash while they are on their way.
  const traffic = sim.segment(id);
  const known = (value: (tr: NonNullable<typeof traffic>) => string): string => (traffic ? value(traffic) : '—');

  return grid([
    [t('inspector.length'), `${meters(length)} m`],
    [t('inspector.lanes'), seg.direction === 'both'
      ? t('inspector.lanesTwoWay', { count: rt.lanes, perSide: travelLanes(rt, seg.direction) })
      : t('inspector.lanesOneWay', { count: rt.lanes })],
    [t('inspector.speed'), `${Math.round(rt.speedLimit * METERS_PER_UNIT * 3.6)} km/h`],
    [t('inspector.meanSpeed'), known((tr) => (tr.speedCount ? `${Math.round((tr.speedSum / tr.speedCount) * METERS_PER_UNIT * 3.6)} km/h` : '—'))],
    [t('inspector.vehicles'), known((tr) => String(tr.occupancy))],
    [t('inspector.queue'), known((tr) => String(tr.queued))],
    [t('inspector.capacity'), known((tr) => t('inspector.capacityValue', { count: Math.round(tr.capacity) }))],
    [t('inspector.volume'), known((tr) => String(tr.volume))],
  ]);
}

function renderSegment(
  doc: RoadDoc,
  net: Network,
  sim: SimInspect,
  body: HTMLElement,
  id: SegmentId,
  actions: InspectorActions,
): void {
  const seg = doc.segment(id);
  const stats = segmentStats(doc, net, sim, id);
  if (!seg || stats === null) {
    closeInspector();
    return;
  }
  const rt = roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking);
  const length = net.polylines.get(doc, id).length;
  // Its street's name and numbers (V8): "Rua das Flores · Urban road", "No. 120 to 204".
  const streetName = streetNameOf(net, id);
  setTitle(`${streetName ?? t('inspector.road')} · ${roadTypeName(rt)}`);
  const numbers = streetNumbers(doc, net, id);

  const maxCurve = Math.max(20, Math.min(280, length * 0.65));
  const curveValue = seg.curve?.h ?? 0;
  const curvePosition = seg.curve?.t ?? 0.5;
  // Reversing is meaningful only for a one-way road.
  const oneWay = seg.direction !== 'both';

  // With the profile editor the class, direction, lanes and parking are the profile's, edited there
  const profiled = actions.onApplyProfile !== undefined;
  body.innerHTML =
    `<div id="inspectStats">${stats}</div>` +
    (numbers ? `<div class="rp-sub inspect-numbers">${t('inspector.numbers', { from: numbers.from, to: numbers.to })}</div>` : '') +
    (profiled ? '<div id="inspectProfile"></div>' : '') +
    (profiled ? '' : `<label class="inspect-select">${t('inspector.roadClass')} <select id="inspectClass">${ROAD_TYPES.map((type, index) => `<option value="${index}"${index === seg.type ? ' selected' : ''}>${roadTypeName(type)}</option>`).join('')}</select></label>` +
    `<label class="inspect-select">${t('inspector.direction')} <select id="inspectDirection">${directionOptions(seg.direction)}</select></label>`) +
    // The heights of its two ends as steppers of the interface (V5): no number box.
    `<div class="rp-junction">${heightStepper('A', t('inspector.heightStart'), (doc.node(seg.a)?.heightOffset ?? 0) / UNITS_PER_METER)}` +
    `${heightStepper('B', t('inspector.heightEnd'), (doc.node(seg.b)?.heightOffset ?? 0) / UNITS_PER_METER)}</div>` +
    (actions.onSetNodeEnd ? endSelect(doc, seg.a, 'A') + endSelect(doc, seg.b, 'B') : '') +
    (profiled ? '' : `<label class="inspect-select">${t('inspector.laneCount')} <select id="inspectLanes">${laneOptions(seg.direction, seg.lanes, rt.lanes)}</select></label>` +
      parkingSelect('inspectParkingLeft', 'inspector.parkingLeft', seg.parking?.left ?? 'none', rt) +
      parkingSelect('inspectParkingRight', 'inspector.parkingRight', seg.parking?.right ?? 'none', rt)) +
    `<div id="inspectSection"></div>` +
    `<label class="inspect-range"><span>${t('inspector.curvature')}</span><output id="inspectCurveValue">${curveText(curveValue)}</output><input id="inspectCurve" type="range" min="${-maxCurve}" max="${maxCurve}" step="1" value="${Math.max(-maxCurve, Math.min(maxCurve, curveValue))}" /></label>` +
    `<label class="inspect-range"${seg.curve ? '' : ' data-disabled'}><span>${t('inspector.curvePosition')}</span><output id="inspectCurvePositionValue">${percent(curvePosition)}</output><input id="inspectCurvePosition" type="range" min="0.15" max="0.85" step="0.01" value="${curvePosition}"${seg.curve ? '' : ' disabled'} /></label>` +
    `<div class="inspect-actions">` +
    `<button type="button" id="inspectUpgrade"${seg.type >= LAST_UPGRADE_CLASS ? ' disabled' : ''}>${t('inspector.upgrade')}</button>` +
    (oneWay ? `<button type="button" id="inspectReverse">${t('inspector.reverse')}</button>` : '') +
    `<button type="button" id="inspectDuplicate" title="${t('inspector.duplicateHint')}">${t('inspector.duplicate')}</button>` +
    `<button type="button" id="inspectSplit">${t('inspector.splitMiddle')}</button>` +
    `<button type="button" id="inspectZebra">${t('inspector.addZebra')}</button>` +
    `<button type="button" id="inspectSignalCrossing">${t('inspector.addSignalCrossing')}</button>` +
    (actions.onAddUturn && seg.direction === 'both' && rt.median > 0
      ? `<button type="button" data-uturn="b">${t('inspector.addUturnToEnd')}</button><button type="button" data-uturn="a">${t('inspector.addUturnToStart')}</button>` : '') +
    `<button type="button" id="inspectAddHeightPoint">${t('inspector.addHeightPoint')}</button>` +
    `<button type="button" id="inspectDelete" class="danger">${t('inspector.demolish')}</button>` +
    `</div>`;

  if (actions.onApplyProfile) {
    mountProfilePanel(body.querySelector<HTMLElement>('#inspectProfile')!, seg, (profile, type) => actions.onApplyProfile?.(id, profile, type), {
      chain: actions.streetLength?.(id) ?? 0,
      ...(actions.onProfileToStreet ? { toStreet: () => actions.onProfileToStreet?.(id) } : {}),
      ...(actions.onDrawWithProfile ? { drawWith: () => actions.onDrawWithProfile?.() } : {}),
    });
  }
  if (freeRoadsEnabled() && actions.onSetSection) {
    mountRoadSectionEditor(body.querySelector<HTMLElement>('#inspectSection')!, rt, seg.direction, seg.section,
      (section) => actions.onSetSection?.(id, section));
  }
  const upgrade = document.getElementById('inspectUpgrade') as HTMLButtonElement | null;
  const remove = document.getElementById('inspectDelete') as HTMLButtonElement | null;
  const type = document.getElementById('inspectClass') as HTMLSelectElement | null;
  const direction = document.getElementById('inspectDirection') as HTMLSelectElement | null;
  const lanes = document.getElementById('inspectLanes') as HTMLSelectElement | null;
  const reverse = document.getElementById('inspectReverse') as HTMLButtonElement | null;
  const duplicate = document.getElementById('inspectDuplicate') as HTMLButtonElement | null;
  const split = document.getElementById('inspectSplit') as HTMLButtonElement | null;
  const heightPoint = document.getElementById('inspectAddHeightPoint') as HTMLButtonElement | null;
  const curve = document.getElementById('inspectCurve') as HTMLInputElement | null;
  const curveValueOutput = document.getElementById('inspectCurveValue') as HTMLOutputElement | null;
  const curvePositionInput = document.getElementById('inspectCurvePosition') as HTMLInputElement | null;
  const curvePositionOutput = document.getElementById('inspectCurvePositionValue') as HTMLOutputElement | null;
  if (upgrade) upgrade.onclick = () => actions.onUpgrade(id);
  if (type) type.onchange = () => actions.onSetType(id, Number(type.value));
  if (direction) direction.onchange = () => actions.onSetDirection?.(id, direction.value as SegmentDirection);
  body.querySelectorAll<HTMLButtonElement>('[data-height-end]').forEach((b) => {
    b.onclick = () => {
      const end = b.dataset['heightEnd'] === 'A' ? seg.a : seg.b;
      const now = (doc.node(end)?.heightOffset ?? 0) / UNITS_PER_METER;
      actions.onSetNodeHeight?.(end, Math.round((now + Number(b.dataset['step'])) * 2) / 2);
    };
  });
  body.querySelectorAll<HTMLSelectElement>('[data-road-end]').forEach((select) => {
    select.onchange = () => actions.onSetNodeEnd?.(select.dataset['roadEnd'] === 'A' ? seg.a : seg.b, select.value === 'bulb' ? 'bulb' : undefined);
  });
  if (lanes) lanes.onchange = () => actions.onSetLanes?.(id, lanes.value === 'default' ? null : Number(lanes.value));
  const parkingLeft = document.getElementById('inspectParkingLeft') as HTMLSelectElement | null;
  const parkingRight = document.getElementById('inspectParkingRight') as HTMLSelectElement | null;
  const setParking = (): void => {
    if (!parkingLeft || !parkingRight) return;
    actions.onSetParking?.(id, { left: parkingLeft.value as ParkingKind, right: parkingRight.value as ParkingKind });
  };
  if (parkingLeft) parkingLeft.onchange = setParking;
  if (parkingRight) parkingRight.onchange = setParking;
  if (reverse) reverse.onclick = () => actions.onReverseDirection?.(id);
  if (duplicate) duplicate.onclick = () => actions.onDuplicate?.(id);
  if (split) split.onclick = () => actions.onSplit?.(id);
  const zebra = document.getElementById('inspectZebra') as HTMLButtonElement | null;
  const signalCrossing = document.getElementById('inspectSignalCrossing') as HTMLButtonElement | null;
  if (zebra) zebra.onclick = () => actions.onAddCrossing?.(id, 'zebra');
  if (signalCrossing) signalCrossing.onclick = () => actions.onAddCrossing?.(id, 'signal');
  if (heightPoint) heightPoint.onclick = () => actions.onAddHeightPoint?.(id);
  body.querySelectorAll<HTMLButtonElement>('[data-uturn]').forEach((b) => {
    b.onclick = () => actions.onAddUturn?.(id, b.dataset['uturn'] === 'a' ? 'a' : 'b');
  });
  if (curve) {
    curve.oninput = () => {
      if (curveValueOutput) curveValueOutput.value = curveText(Number(curve.value));
    };
    curve.onchange = () => {
      const h = Number(curve.value);
      actions.onSetCurve?.(id, Math.abs(h) < 0.5 ? null : { t: seg.curve?.t ?? 0.5, h });
    };
  }
  if (curvePositionInput && seg.curve) {
    curvePositionInput.oninput = () => {
      if (curvePositionOutput) curvePositionOutput.value = percent(Number(curvePositionInput.value));
    };
    curvePositionInput.onchange = () => {
      actions.onSetCurve?.(id, { t: Number(curvePositionInput.value), h: seg.curve!.h });
    };
  }
  if (remove) remove.onclick = () => actions.onDelete(id);
}

/** The live numbers for a junction, or null when the node no longer exists. */
function nodeStats(doc: RoadDoc, sim: SimInspect, id: NodeId): string | null {
  const node = doc.node(id);
  if (!node) return null;
  // The traffic's numbers (`sim/inspect.ts`), a dash while they are on their way.
  const traffic = sim.junction(id);
  const known = (value: (tr: NonNullable<typeof traffic>) => string): string => (traffic ? value(traffic) : '—');
  const control = !traffic
    ? '—'
    : !traffic.built
      ? t('control.disconnected')
      : traffic.signalised
        ? t('control.signal')
        : t(`control.${node.control}`);

  const rows: [string, string][] = [
    [t('inspector.control'), control],
    [t('inspector.connections'), String(node.incident.length)],
    [t('inspector.movements'), known((tr) => String(tr.movements))],
    [t('inspector.vehicles'), known((tr) => String(tr.active))],
    [t('inspector.queue'), known((tr) => String(tr.queued))],
    [t('inspector.meanSpeed'), known((tr) => (tr.speedCount ? `${Math.round((tr.speedSum / tr.speedCount) * METERS_PER_UNIT * 3.6)} km/h` : '—'))],
    [t('inspector.capacity'), known((tr) => t('inspector.capacityValue', { count: Math.round(tr.capacity) }))],
    [t('inspector.volume'), known((tr) => String(tr.volume))],
  ];

  const signal = traffic?.signal;
  if (signal) {
    rows.push([t('inspector.cycle'), `${Math.round(signal.cycle)} s`]);
    rows.push([t('inspector.phase'), `${signal.stageIndex + 1}/${signal.stages} · ${phaseLabel(signal.sub as Parameters<typeof phaseLabel>[0])}`]);
  }

  // Each signal group as a lamp: the colour is read faster than the word
  let lamps = '';
  // Lamps only where there are lights: a stop or priority junction has none.
  if (signal && signal.groups.length) {
    lamps = `<div class="signal-chips">${signal.groups.map((g) =>
      `<span class="signal-chip" data-state="${g.state}"><i></i>${t('inspector.group', { id: g.id + 1 })} · ${signalLabel(g.state)}</span>`).join('')}</div>`;
  }
  return grid(rows) + lamps;
}

function renderNode(
  doc: RoadDoc,
  net: Network,
  sim: SimInspect,
  body: HTMLElement,
  id: NodeId,
): void {
  const node = doc.node(id);
  const stats = nodeStats(doc, sim, id);
  if (!node || stats === null) {
    closeInspector();
    return;
  }
  setTitle(node.smooth ? t('inspector.heightPoint')
    : node.incident.length >= 3 ? t('inspector.junction') : t('inspector.node'));
  if (node.smooth) {
    body.innerHTML = `<div id="inspectJunction"></div><p class="inspect-note">${t('inspector.heightPointHelp')}</p>`;
    mountJunctionPanel(body.querySelector<HTMLElement>('#inspectJunction')!, junctionHost(doc, sim, id));
    return;
  }
  const mouths = node.incident
    .map((seg) => `${meters(net.mouthDistance(seg, id))} m`)
    .join(' · ');

  // The offer is a promise that the two legs read as ONE road
  const alignedLegs =
    !node.smooth && !node.crossing && node.incident.length === 2 && surfaceMode(doc, net.polylines, id) === 'none';
  const joinOffer = alignedLegs
    ? `<div class="inspect-actions"><button type="button" id="inspectJoin">${t('inspector.joinAligned')}</button></div>`
    : '';

  // A mid-block crossing says what it is and offers the way back.
  const crossingOffer = node.crossing
    ? `<p class="inspect-note">${t(node.crossing.kind === 'signal' ? 'inspector.crossingSignal' : 'inspector.crossingZebra')}</p>` +
      `<div class="inspect-actions"><button type="button" id="inspectRemoveCrossing" class="danger">${t('inspector.removeCrossing')}</button></div>`
    : '';
  // Legs meeting too sharply (`world/legAngles.ts`, `Network.impossible`): the junction is drawn degraded
  const gap = net.impossible.get(id);
  const impossible = gap === undefined ? ''
    : `<div class="inspect-warning" role="alert"><strong>${t('inspector.impossible')}</strong> · ${t('inspector.impossibleGap', { angle: Math.round((gap * 180) / Math.PI) })}<br>${t('inspector.impossibleBody')}</div>`;
  // Height, control, flows, legs, signal and movements in the junction panel
  body.innerHTML = impossible + `<div id="inspectStats">${stats}</div>` + crossingOffer +
    '<div id="inspectJunction"></div>' + joinOffer +
    '<div id="inspectConnectors"></div>' + `<p class="inspect-note">${t('inspector.mouths')}: ${mouths || '—'}</p>`;
  mountJunctionPanel(body.querySelector<HTMLElement>('#inspectJunction')!, junctionHost(doc, sim, id));
  const connectors = body.querySelector<HTMLElement>('#inspectConnectors');
  if (connectors && actionsForNode().onSetLaneLinks) {
    mountConnectorPanel(connectors, id, {
      junction: () => sim.junction(id),
      links: () => doc.node(id)?.laneLinks,
      set: (links) => actionsForNode().onSetLaneLinks?.(id, links),
      ...(actionsForNode().project ? { project: actionsForNode().project! } : {}),
    });
  }

  const join = document.getElementById('inspectJoin') as HTMLButtonElement | null;
  if (join) join.onclick = () => actionsForNode().onJoin?.(id);
  const removeCrossing = document.getElementById('inspectRemoveCrossing') as HTMLButtonElement | null;
  if (removeCrossing) removeCrossing.onclick = () => actionsForNode().onRemoveCrossing?.(id);
}

/** What the junction panel changes, through the inspector's actions. */
function junctionHost(doc: RoadDoc, sim: SimInspect, id: NodeId): Parameters<typeof mountJunctionPanel>[1] {
  return {
    doc, node: id,
    traffic: () => sim.junction(id),
    greenWave: () => sim.greenWave(id),
    setHeight: (metres) => actionsForNode().onSetNodeHeight?.(id, metres),
    setControl: (control: JunctionControl) => actionsForNode().onSetControl?.(id, control),
    setRules: (rules) => actionsForNode().onSetApproachRules?.(id, rules),
    setSignal: (settings) => actionsForNode().onSetSignal?.(id, settings),
    setSignals: (settings) => actionsForNode().onSetSignals?.(settings),
    setMovementBlocked: (from, to, blocked) => actionsForNode().onSetMovementBlocked?.(id, from, to, blocked),
    ...(actionsForNode().project ? { project: actionsForNode().project! } : {}),
  };
}


/** Whether the junction's list of movements is unfolded (kept across the panel's rebuilds). */

function actionsForNode(): InspectorActions {
  return current?.actions ?? { onUpgrade: () => {}, onSetType: () => {}, onDelete: () => {} };
}

function directionOptions(value: SegmentDirection): string {
  const entries: readonly SegmentDirection[] = ['both', 'aToB', 'bToA'];
  return entries
    .map((id) => `<option value="${id}"${id === value ? ' selected' : ''}>${t(`direction.${id}`)}</option>`)
    .join('');
}

function laneOptions(direction: SegmentDirection, configured: number | null, resolved: number): string {
  const values = direction === 'both' ? [2, 4, 6, 8] : [1, 2, 3, 4, 5, 6, 7, 8];
  const options = [
    `<option value="default"${configured === null ? ' selected' : ''}>${t('inspector.classDefault', { count: resolved })}</option>`,
  ];
  for (const count of values) {
    options.push(
      `<option value="${count}"${configured === count ? ' selected' : ''}>${plural('inspector.laneOption', count)}</option>`,
    );
  }
  return options.join('');
}


const signalLabel = (value: string): string => t(`signal.${value}`);

const phaseLabel = (value: string): string => t(`phase.${value}`);


const meters = (units: number): string => formatDecimal(units * METERS_PER_UNIT, 1);

/** A curve's bulge: how far the arc leaves the straight line, signed by side. */
const curveText = (units: number): string =>
  Math.abs(units) < 0.5 ? '0 m' : `${units > 0 ? '+' : '−'}${Math.round(Math.abs(units) * METERS_PER_UNIT)} m`;

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** Names what is selected in the panel's own heading. */
function setTitle(value: string): void {
  const title = document.getElementById('inspectorTitle');
  if (title) title.textContent = value;
}

const card = (label: string, value: string): string =>
  `<div class="inspect-card"><span>${label}</span><strong>${value}</strong></div>`;

const grid = (rows: readonly [string, string][]): string =>
  `<div class="inspect-grid">${rows.map(([k, v]) => card(k, v)).join('')}</div>`;

/** A height as a stepper of the interface, half a metre a step (V5). */
function heightStepper(end: 'A' | 'B', label: string, metres: number): string {
  const v = Math.abs(metres - Math.round(metres)) < 1e-6 ? String(Math.round(metres)) : formatDecimal(metres, 1);
  return `<div class="rp-row"><div class="rp-label">${label}</div><div class="rp-ctrls"><div class="rp-step">` +
    `<button type="button" data-height-end="${end}" data-step="-0.5" aria-label="${t('junction.lower')}">−</button><output>${v} m</output>` +
    `<button type="button" data-height-end="${end}" data-step="0.5" aria-label="${t('junction.raise')}">+</button></div></div></div>`;
}
