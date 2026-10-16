# Roadcraft 2

Browser city-builder (TypeScript, three.js r186, Vite; to be sold on Steam).
Game: `npm run dev` (127.0.0.1:5300). Check: `npm run check`.

**This file is the project's only documentation, memory and instruction file.** Do not create
another: no `docs/`, no reports, plans, prompts, notes, `memory/`, `README`, nested `CLAUDE.md`,
skills or hooks. A finding goes into "Open findings" below; a fix leaves it (and its commit says
cause, technique and source). Git history is the archive.

## Files and naming
- Every file is written in English: code, comments, tests, error messages and this file. Talk to
  the player in Brazilian Portuguese; commit messages in Portuguese.
- No ALL-CAPS file names (only `CLAUDE.md`, which Claude Code needs by that name, and the license
  texts that ship with third-party assets).
- Nothing at the repository root that is not strictly needed (package, lock, tsconfig, the Vite,
  Vitest and ESLint configs, `index.html`, git and npm settings). Tooling lives in `scripts/`
  (Vite plugins in `scripts/vite/`, check baselines in `scripts/baselines/`).
- Nothing useless: no dead file, no stray probe, no duplicate. Scratch work goes to the session's
  scratchpad, never into the repository or `C:/Codex-Shared/rc2-wt`.

## What the player wants
- Excellent performance and graphics on different computers, toward the unlimited city: first the
  whole 10 km × 10 km map, then larger.
- **Fixed means the code no longer has the problem**: the right algorithm and data for a city of
  any size. A time that dropped on a test city is not a fix; a number is not a goal.
- DO NOT amortize: slicing work across frames, holding a layer, a capped cache that evicts and
  redoes, spacing out rebuilds. That hides the cost, which comes back with a bigger city. Fix the cause.
- Do the work; do not ask what the code and these rules already answer. Ask only about: loss of
  graphics quality, pushing to GitHub, deleting the player's data.
- No loss of graphics quality without the player's yes: before and after shots from the same views.
- Test once at the end of each block of work. No suite at every step, no process, paperwork, plan
  or note instead of fixing.
- Tell the truth: say what you did not check. Never "already exists" or "works" without reading
  the code that USES it (the caller, up to the frame, the edit or the pointer).
- Use judgement and be ethical. If something needs an architecture change to work, say so and wait
  for authorization. Do not insist on fixes that do not work; find the proper solution, report it
  and ask.
- Do not trust your own knowledge: look up the official documentation and proper sources online.
- No trial and error. If you do not know how to solve something, or it fails the first time,
  RESEARCH ON THE INTERNET.

## How to work
- Find the cause by reading the whole part of the code: file by file, each caller followed up to
  the frame, the edit or the pointer, and the siblings of the same shape in the project. Fix the
  whole class.
- Before a technique the code does not use yet, read the official source. three.js of the game's
  version, offline: `C:/Codex-Shared/referencia/` (docs, manual, examples, source; InstancedMesh2,
  3DTilesRendererJS, three-mesh-bvh, postprocessing; index in its `README.md`).
- `node scripts/accuse.mjs` points at three.js uses the manual warns against and at the patterns
  below. An accusation is a lead to read, not a proof.
- One commit per fix, saying cause, technique and source.

## Causes that already cost a lot
- Rebuilding everything when one part changes. Right: the diary (`world/changes.ts`) says what
  changed; a derived product reads `doc.changes.since`/`touches` for its own kinds, never a cache
  key with a global revision.
- Scanning everything to find what is near. Right: a spatial index (`buildings.near(box)`).
- A capped cache that evicts and redoes the same work.
- Heavy work on the main thread. Right: a worker.
- Drawing or keeping what is not seen: no level of detail; a CPU copy of what is already on the GPU.
- Waiting for the GPU mid-frame (`getImageData`) or compiling shaders during play.
- Comparing by JSON (`JSON.stringify(a) === JSON.stringify(b)`) on a hot path. Right: compare what
  the diary says changed.
- The same data kept in two forms (the record or geometry on both CPU and GPU; a whole copy per edit).

## Lessons (DO NOT redo)
- `BatchedMesh` for the building shells was undone: it keeps its whole capacity on the CPU
  (`_initializeGeometry`), 1.1 GB of heap for 8.1 M vertices; with the chunk cache the heap hit
  4.4-5.1 GB and the map ran at 14 fps. Do not redo it without a batch that drops its arrays.
- Mass (far level) painted with the detail's colours was tried and undone: the mean difference got
  worse (17.6 → 20.6) and the mass looked darker. Swapping detail for mass in the top view loses
  beauty. The way left is fewer triangles in the detail itself (simplified shell per cell,
  meshoptimizer, error under a pixel).
- Checked and right (reopen only if a probe, a shot or the code says otherwise): upload ranges
  (`addUpdateRange`) in agents, transit, grass, blob shadows, casualties, gore, exhaust, nature
  trees, far forest and poles; picking by the ground plane, no `Raycaster`; on-demand frame loop
  (`frameLoop.ts`); sRGB output, ACES, PMREM of the sky, no fog (player's choice); reversed float
  depth; `GTAOPass`'s normal target is never bound, so never allocated on the GPU (r186
  `WebGLRenderer.setRenderTarget` allocates lazily); the roads' near/far blocks
  (`mesh/roadResidency.ts`): a burst of disposals after a camera jump is the residency working.
- Rejected: the poles' level of detail as meshes per 256 m cell (`wip/poles-lod`, local): on a
  1.2 km city the same triangles and 283 -> 452 draw calls in the street view. Redo it inside
  `instanceRuns.ts` (one mesh per kind, a pixel-size cut in the cull).
- Under review: building far level with hysteresis (shows simplified buildings for 3-4 s after a
  camera move); one 4096 shadow map fitted to the view (stair-step aliasing up close); SMAA and
  GTAO at half resolution (the player wants nothing blurry); baked textures with mipmaps (foliage
  speckle up close).

## State (2026-10-15)
- `main` holds all the merged work (`fix/workers-10km` merged on 2026-10-15). No worktree is open.
- Not merged, kept as branches only: `fix/growth-worker` (city growth in a worker, 10 commits),
  `fix/gerador-workers`, `fix/render-cidade` (1 commit: only cells in view in full detail; changes
  quality, needs shots and the player's yes), six `worktree-agent-*` branches from 2026-10-14
  (agents stopped midway), and `wip/*` (uncommitted work saved before worktrees were removed:
  `wip/main-layered-doc` is a second copy-on-write map, superseded by `core/forkMap.ts`).
- Comments are one line each; dead code is gone (`node scripts/knip-check.mjs`: 0 entries).
- `node scripts/check-code.mjs` reports 55 findings not in its baseline, all from the merged
  branch (whole-map walks per input, per frame): fix them, never add them to the baseline.
- The fixed map today: 5 × 5 plates of 2,048 m (`world/bounds.ts`).

## Open findings
Read by agents on `fix/workers-10km` at `3780807` (quick read; line numbers from that commit;
bytes and ms are estimates from reading). Re-check the line before fixing.

GPU memory and drawing
- `color`/`roadSection` attributes on every road strip (`mesh/surfaceMesh.ts:68`, `tileMesh.ts:83`):
  24 of 56 B per vertex unused. Fix: the `SurfaceSpec` declares what it reads.
- Garden buffers sized to the whole city, never shrink; body and card stores keep the same matrices
  (`gardens.ts:281-287, 512, 516`).
- Vehicle models non-indexed (`vehicleModels.ts` `merge`): index them only with the wreck
  (`agents.ts`, normals recomputed after denting) keeping its own non-indexed copy.
- Whole-map dense grids from boot, quadratic in the map's side: the wear texture (`wear.ts`, 2048²
  RGBA = 17 MB, 5 m texels) and the terrain's fields (ecology, gullies, light, wetness, heights,
  ~6-7 MB each, ~70 MB). Fix for a larger map: sparse tiles where there is something.
- About 43 draw calls per building cell: a mesh per finish and an `InstancedMesh` per part kind
  (`buildingMesh.ts:3531, 3573`).
- Needs shots and the player's yes: signature buildings without a far level (`massing.ts:157`);
  terrain plates with content have no LOD (`flatAtlas.ts:104`).

Main thread
- The simulation's worker (`sim.worker.ts`) keeps a whole copy of every building record
  (`world/replica.ts`): the agents read few of their fields. Fix: a record of what the sim reads.
- The page still rebuilds the network for drawing, and the worker its own from the replica.
- City growth and power-line layout are sliced (`main.ts:2200-2273` `GROW_SLICE_MS`,
  `roads/powerLine.ts:39`): amortization. The worker version is on `fix/growth-worker`.
- Nature: one plate swept per frame (`renderer.ts:2359-2393`) and `new CandidateKeep` with every
  tree (`:3045`).
- Scene scan for shader variants every 2 s, compiling during play (`renderer.ts:3112`). Fix: a
  closed variant catalogue compiled at load.
- Opening: `net.rebuild({ full: true })` (`history.ts:155`); `readDerivedAll` reads the whole cache
  (`renderer.ts:792`).
- Profiler hooks always installed (`main.ts:707`, `profiler.ts:88`, `new Error().stack` per upload).

O(map) per edit
- `snapshotRoads` does `doc.clone()` (`editRules.ts:114`) per in-place edit. Fix: judge on `doc.fork()`.
- `Network.adopt` copies the whole network (`network.ts:270-300`), twice per road drawn. Fix: a
  layered fork, adopting only the delta.
- `elevation.ts` walks every ribbon per solve (`:448`) and digests with `JSON.stringify` (`:1177`).
- Autosave: `dirtyHead` rewrites the whole head (`chunkedSave.ts:133, 179`); under 3,000 buildings
  `persistence.ts:188` writes the whole document. Fix: head in parts by the diary, written in a worker.
- Undo: `DocImage` `structuredClone`s nodes, segments, poles, landscape and barriers
  (`docImage.ts:83, 117`), compares lists by prefix/suffix (`:186`); `doc.ts:2086` logs
  `'utilities'` without ids. 28 `JSON.stringify` comparisons in `doc.ts` `replaceContents`.
- Terrain: a stamp discards the worker-built mesh (`terrain.ts:3125`); `new TerrainIndex` of every
  stamp per revision (`:3102`); textures and buffers re-uploaded whole (no `addUpdateRange`).
- `flatAtlas.ts`: each plate filters every paint dab (`:435-444`); `letGo` throws a plate away and
  it is rebuilt when it returns (`:299-307`).
- Global-revision derivatives in `renderer.ts`: `coverSweep` (`:2547, 2982`), elements rebuilt
  whole (`:3535`), planted trees (`:3086`), `watchRoads` copies every ribbon each second (`:1314`).
- Lot tool: `lotAt` is `doc.lots.find`, up to 400 times per move (`lotTool.ts:359, 552`); the
  overlay recomposes every lot; the proposal key uses `net.revision` (`:259`). Fix: `doc.lotsIn(box)`.
- Simulation: `refreshJunctionOrder` sorts every junction per edit (`sim/world.ts:534`);
  `rebindVehicles` walks the whole fleet (`pipeline.ts:167-200`); every signal, even asleep, each
  tick (`pipeline.ts:92`); control advisor every 10 s (`controlAdvisor.ts:37`); all stops scanned
  (`transit/transit.ts:268`); `trainZones` built each tick (`walk.ts:1952`).
- Fleet copied or scanned per tick in `lotTraffic.ts:156, 269, 309`, `lorryTraffic.ts:136, 247`.
- The rigged crowd blends palettes on the CPU (`riggedCitizens.ts` `emit`): only the scenery's few
  bodies and `?bodies=cooked`; the default crowd (`proceduralCrowd.ts`) is on the GPU.
- 188 global-revision reads still suppressed in `scripts/baselines/eslint-suppressions.json` (35
  files: `renderer.ts` 42, `doc.ts` 23, `flatAtlas.ts` 19, `main.ts` 15, `terrain.ts` 7). The engine
  has only 6 `engine.register`; the other derived products update themselves.
- Low: `conflictPool.ts:283` does not `terminate` workers already made when creation fails; files of
  3,500-4,500 lines (`main.ts`, `renderer.ts`, `buildingMesh.ts`).

Player's decisions
- Caps that delete the player's work: `MAX_PLANTED_TREES = 20_000` (`doc.ts:1334`), elements
  (`:1381`), undo dropping old steps by bytes (`history.ts:128`).
- About 7 KB per building record (560 MB at 80,000 buildings); seed + lot would change the generator.

Memory measured (heap snapshots, SwiftShader, `scratchpad` probes; 2026-10-16):
- At boot, no city: 63 MB of JS objects and 604 MB of array buffers, all held by JS (the 235 MB
  that look held by the browser came from workers by structured clone): wear field 50 MB (now 17),
  instance buffers, the terrain's whole-map grids.
- After a 1.2 km city (4,694 buildings), garbage collected: 352 MB of objects (2.7 M `Object`s and
  1.2 M element arrays: the document's points, ~32 KB a building), 690 MB of buffers held by JS
  (gardens' matrices, spheres and colours 43 MB, ~9 KB a building) and 540 MB more from workers.
- The heap does not grow with zoom: map and district views weigh the same after a GC (1.2 GB);
  the 2.6 GB seen in shots was garbage not yet collected.

Not checked (need a measure in the game): ~30 MB/s garbage, a road taking 9-10 s, opening the big
map, 18.6 ms GPU on the whole map, relighting at sun ≥ 2°.

Already fixed on the branch (do not report as open): transit and fog by the diary; gullies
(`setGullies` is empty); forests cell by cell (`plantCells.ts`); the `no-global-revision` lint;
chunk LRU cache; atlas `CACHE = 6`; lot tool JSON key; road tiles without CPU arrays; `pedPoseInto`;
lanelets by delta; cell emission in a worker (`cellPool.ts`); parking walls by `store.near`;
`matrixAutoUpdate = false` on buildings; `changedSites` and `changedSegments` by the diary; the sky
is hidden every frame (no overdraw).

## Checking in the game
- `node scripts/look.mjs <script.json>` (example `scripts/look/views.json`): installed Chrome,
  headless, on the GPU, 1920×1080. Camera: middle drags, right rotates, wheel zooms; left belongs to
  the tool. Playwright's Chromium does not open on this machine: `channel: 'chrome'`.
- Open each PNG with Read and look for: cut text, overlap, floating pieces, holes, flicker, wrong
  light, wrong language. A defect seen is fixed and shot again.
- The app's built-in browser returns 800×450 shots: good for reading text, not for images.
- Heavy commands through `node scripts/run-limited.mjs …` (Windows job: 25% CPU, 8 GB).

## Commits, branches, agents
- `git status` first; commit only your paths (`git commit --only <paths>`) after reading their
  `git diff`. Every file saved in the main folder reloads the game on 5300.
- Agents: at most 5, each on one part, in ITS worktree made from local `main`
  (`git worktree add -b fix/<part> C:/Codex-Shared/rc2-wt/<part> main`; `node_modules` and `cooked`
  by junction). Read the whole diff and merge into `main`. To remove a worktree, undo the junctions
  with `rmdir`, never `rm -rf` (it would delete the main folder's `node_modules`); delete the branch
  once it is merged.
- Never push to GitHub without the player's yes. The player's ports and folders, never touch:
  4180-4183, 5173, 5175-5178, `C:/Codex-Shared/backup-mapa-jogador`.

## Traps by area
**render** (only `src/render` imports `three`)
- Reversed depth in a float buffer (`depthConvention.ts`): distant flicker is never fixed by pushing
  the near plane or raising an offset; a pass that reads depth uses `DEPTH_GLSL`.
- The shadow moves in whole ground texels (`environment.ts` `GroundShadowGrid`); the sun in 0.1°
  steps (`SUN_STEP`). `shadowMap.enabled` depends on the quality level: check the level first.
- World `y` becomes three's `z` and flips direction: measure area with its sign, do not assume.
- `earcut` on a long thin strip makes huge triangles: cut it first (`splitToSpan`).
- Textures and materials made once; never create a material inside a rebuild.
- A repeated piece is instanced; a shared material needs the same program variant.
- `vertexColors: true` on the material, or per-vertex colour does nothing.
- `compileAsync` with the post-processing target, or the first frame stalls.
- People: MakeHuman baked ahead (`cooked/`, version in `scripts/vite/cook-plugin.ts` `CAST`);
  skeletons on the GPU (`people/crowdAnimation.ts`): `renderPalettes` after `update`, before drawing.
- Never two surfaces of a building in the same plane (`tests/render/coplanar.spec.ts`).
- Asphalt shader (`materials.ts` `ROAD_SPACE_FRAGMENT`): `uv.x * ASPHALT_TILE` is across the road.
- Instance buffers sized by `FLEET_CEILING` and `PED_CEILING` (`sim/params.ts`).
- A new visual effect goes in `postprocess.ts`, behind an option in `quality.ts`.

**world**
- One cut per road end (`approach.ts`) feeds mouth, zebra, stop line, lane and kerb.
- `HEADING_CHORD` belongs to `sim/pose.ts`, `conflictPoints.ts` and `turnPaths.ts`: all three together.
- Terrain height: `heightAt` is the field; `renderedHeightAt` is what is drawn.
- A tunnel is a step in the terrain plus a portal; `TUNNEL_*` and `CUT_SHOULDER` go together.
- A road at grade is a projected line, not the ground (`solveGround`); a junction takes its legs' height.
- A building edit moves `doc.buildings.revision`, never `doc.revision`.
- Terrain cell: 6.4 m. One world unit is one metre. Road numbers with a source in `roads/tuning.ts`;
  only the player changes them.

**sim**
- It runs in `sim.worker.ts` on a copy of the document fed by the diary (`world/replica.ts`); the
  page draws `SimMirror` (`sim/frame.ts`, `sim/mirror.ts`). A new field drawn goes in the frame.
  `?sim=page` runs it on the page (`__roadcraft.sim` is the world only then).
- One writer per field; stage order in `pipeline.ts`. `clock.tick` only at the end of `step`.
- `archetype` is the machine, `driver` is the person. A lane change occupies two lanes (`bodiesIn`).
- A signal stage never groups crossing movements (`signals/plan.ts`).
- `WALKER_SHAPE`: every field of a pedestrian declared at once (hidden classes).
- `SimWorld.doLess` must give the same result as doing everything (`tests/sim/doLess.spec.ts`).

**editor**
- `commitDraft` adopts the network only after it is rebuilt. Every road edit pays in `roads/economy.ts`.
- New tool: `Tool` in `toolMachine.ts`, a `case` in `main.ts` `pointerdown`, a key in `gameKeys.ts`,
  a place in `ui/v2/shell.ts`, `tool.`/`hint.` keys in both dictionaries.
- Loading validates with the document's own predicates (`persistence.ts`).

## Third-party assets
- Trees are procedural (`render/lowPolyTrees.ts`); only their proportions follow Kenney's Nature Kit.
- People: MakeHuman base and community items (`public/models/people/`, each item's licence in
  `proxies/community.json`; CC-BY items credited in the About panel), Microsoft Rocketbox (MIT) and
  Quaternius animations (CC0). The licence texts in `public/models/people/` and
  `public/models/citizens/` ship with the game (`render/citizenAssets.ts` shows them) and must stay.
- The people catalogue offers every community item (`people/wardrobe.ts` `itemsOf`), so all of
  `public/models/people/proxies` is in use, not only the street selection.
