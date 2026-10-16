/** THE WORK OF A REBUILD AFTER A ROAD EDIT, counted per derived product: how many things each one looked at */
/** The network's rebuild (`networkBuild.ts`): records compared for changes (`sources`), junction solves looked up or made */
export const networkWork = { sources: 0, junctions: 0, segments: 0, marks: 0 };

/** `vehicles`: the vehicles an edit bound again to the lane graph (`rebindVehicles`). */
export const rebuildWork = { conflicts: 0, walkways: 0, signals: 0, sidewalks: 0, spans: 0, lanes: 0, routing: 0, vehicles: 0 };
