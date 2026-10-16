import { WAITING } from '@world/conflictPoints';
import type { PairMeasurer } from '@world/conflictTable';
import { rebindPeds, rebindVehicles } from './pipeline';
import type { SimWorld } from './world';

/** THE TRAFFIC'S TOPOLOGY CATCHING UP WITH AN EDIT, where the simulation runs (`sim/host.ts`, `sim.worker.ts`) */

/** DO NOT go back to a few milliseconds of it a frame (TOPOLOGY_SLICE_MS, LOADING_SLICE_MS) */
export class TopologyCatchUp {
  /** `measurer`: the workers the new junctions' conflict pairs are measured by (`conflictPool.ts`); none, on the page. */
  constructor(private readonly measurer?: PairMeasurer) {}

  private vehicles: { revision: number; steps: Generator<void | typeof WAITING, void> } | null = null;

  /** This frame's work towards `revision` (the network's `trafficRevision`). */
  step(sim: SimWorld, revision: number, worldBusy: boolean): boolean {
    if (sim.topologyRevision === revision) return false;
    if (worldBusy) return true;
    if (sim.vehicleTopologyRevision !== revision) {
      if (!this.vehicles || this.vehicles.revision !== revision) {
        this.vehicles = { revision, steps: sim.prepareVehicleTopology(this.measurer) };
      }
      let prep = this.vehicles.steps.next();
      // WAITING: the workers have the pairs; nothing to do here this frame.
      while (!prep.done && prep.value !== WAITING) prep = this.vehicles.steps.next();
      if (!prep.done) return true;
      this.vehicles = null;
      sim.rebuildVehicleTopology();
      rebindVehicles(sim);
    }
    sim.rebuildWalkTopology();
    rebindPeds(sim);
    return false;
  }
}

