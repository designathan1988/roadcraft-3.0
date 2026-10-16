import { BackSide, BufferGeometry, DoubleSide, Float32BufferAttribute, FrontSide, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshDepthMaterial, Object3D, OrthographicCamera, Scene as ThreeScene, WebGLRenderTarget, type Camera, type Light, type Material, type Mesh, type Scene, type Side, type Texture, type WebGLRenderer } from 'three';

/** Textures waiting to be sent to the GPU ahead of their first use. three.js uploads a texture the first time something */
const queue: Texture[] = [];
const queued = new WeakSet<Texture>();
const sent = new WeakSet<Texture>();

export function queueUpload(...textures: (Texture | null | undefined)[]): void {
  for (const t of textures) {
    if (!t || sent.has(t) || queued.has(t)) continue;
    queued.add(t);
    queue.push(t);
  }
}

/** A model released before its scheduled upload must never reach the GPU later. */
export function cancelUploads(textures: Iterable<Texture>): void {
  const canceled = new Set(textures);
  for (let i = queue.length - 1; i >= 0; i--) if (canceled.has(queue[i]!)) {
    queued.delete(queue[i]!);
    queue.splice(i, 1);
  }
}

/** Sends queued textures to the GPU, at most `count` this frame. */
export function drainUploads(renderer: WebGLRenderer, count = 1): void {
  for (let i = 0; i < count && queue.length; i++) {
    const t = queue.shift()!;
    queued.delete(t);
    if (sent.has(t)) continue;
    sent.add(t);
    renderer.initTexture(t);
  }
}

/** Objects whose shaders must be compiled before they are first drawn */
const toCompile: { object: Object3D; shadow: boolean; done: () => void }[] = [];
/** What a shadow program is built for: a render target as a shadow map is (no colour space, no tone mapping). */
let shadowTarget: WebGLRenderTarget | null = null;
/** Whether a renderer is answering (none in tests: nothing is waited for there). */
let compiler = false;

/** DO NOT give the stand-in RGBA packing: the packing is part of the program's key */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };
const plainDepth = new MeshDepthMaterial();
/** What a stand-in's plain depth material is set to (`userData`), at the moment it is compiled (`drainCompiles`). */
interface DepthVariant { readonly side: Side; readonly alphaTest: number; readonly map: Texture | null; readonly alphaMap: Texture | null }
const DEPTH_VARIANT = 'roadcraftDepthVariant';
type DepthMaterial = Material & { map?: Texture | null; alphaMap?: Texture | null };
const setDepth = (depth: DepthMaterial, v: DepthVariant): void => {
  depth.side = v.side;
  depth.alphaTest = v.alphaTest;
  depth.map = v.map;
  depth.alphaMap = v.alphaMap;
};
export function shadowStandIn(mesh: Mesh): Mesh | null {
  if (!mesh.castShadow || Array.isArray(mesh.material)) return null;
  const material = mesh.material as Material & { map?: Texture | null; alphaMap?: Texture | null; shadowSide?: Side | null };
  const custom = (mesh as Mesh & { customDepthMaterial?: Material }).customDepthMaterial as DepthMaterial | undefined;
  const variant: DepthVariant = { side: material.shadowSide ?? SHADOW_SIDE[material.side], alphaTest: material.alphaToCoverage ? 0.5 : material.alphaTest,
    map: material.map ?? null, alphaMap: material.alphaMap ?? null };
  setDepth(custom ?? plainDepth, variant);
  const copy = compileCopy(mesh) as Mesh;
  copy.material = custom ?? plainDepth;
  // DO NOT compile them with the material as the last one left it: a sign's plate (a map, cut by its alpha) and a bench
  if (!custom) copy.userData[DEPTH_VARIANT] = variant;
  copy.visible = true;
  return copy;
}

/** A copy of `object` to build its programs with: the same geometry, material and variant */
export function compileCopy(object: Object3D): Object3D {
  // DO NOT copy userData: three clones it by JSON, and a road block keeps its far mesh there (GPU-only arrays: `toJSON` throws).
  const userData = object.userData;
  object.userData = {};
  try {
    const instanced = object as InstancedMesh;
    if (!instanced.isInstancedMesh) return object.clone(false);
    const copy = new InstancedMesh(instanced.geometry, instanced.material, 1);
    Object3D.prototype.copy.call(copy, instanced, false);
    if (instanced.instanceColor) copy.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
    copy.morphTexture = instanced.morphTexture;
    return copy;
  } finally {
    object.userData = userData;
  }
}

/** `shadow`: the object's material is a shadow's depth material, compiled for a shadow map. */
export function compileAhead(object: Object3D, shadow = false): Promise<void> {
  if (!compiler) return Promise.resolve();
  return new Promise((done) => toCompile.push({ object, shadow, done }));
}

/** Starts compiling what is waiting; each promise settles when its shaders are ready. */
export function drainCompiles(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  compiler = true;
  if (!toCompile.length) return;
  // For the target the scene is really drawn into: its colour space and tone mapping are part of every program.
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  while (toCompile.length) {
    const { object, shadow, done } = toCompile.shift()!;
    if (shadow) renderer.setRenderTarget(shadowTarget ??= new WebGLRenderTarget(1, 1));
    // Each stand-in on the plain depth material with its own variant (`shadowStandIn`), then the whole
    const units: { readonly object: Object3D; readonly variant?: DepthVariant }[] = [];
    object.traverse((o) => {
      const variant = o.userData[DEPTH_VARIANT] as DepthVariant | undefined;
      if (variant) units.push({ object: o, variant });
    });
    units.push({ object });
    const compiled: Promise<unknown>[] = [];
    for (const unit of units) {
      if (unit.variant) setDepth(plainDepth, unit.variant);
      compiled.push(renderer.compileAsync(unit.object, camera, scene));
    }
    Promise.all(compiled).then(() => done(), () => done());
    if (shadow) renderer.setRenderTarget(target);
  }
  renderer.setRenderTarget(previous);
}

/** Meshes whose geometry must be on the GPU before they are first drawn. three.js sends a geometry's buffers */
const WARM_LAYER = 31;
const toWarm: { mesh: Mesh; geometries: readonly BufferGeometry[]; done: () => void; loose?: boolean }[] = [];
let warmer = false;
const lightsOf = new WeakMap<Scene, Light[]>();
export function warmAhead(mesh: Mesh, geometries: readonly BufferGeometry[]): Promise<void> {
  if (!warmer) return Promise.resolve();
  return new Promise((done) => toWarm.push({ mesh, geometries, done }));
}
/** Meshes not in the scene yet (a batch of buildings put together to replace the one drawn) */
export function warmLooseAhead(meshes: readonly Mesh[]): Promise<void> | null {
  // Nothing to wait for where no frame warms (tests, before the first frame).
  if (!warmer || meshes.length === 0) return null;
  return Promise.all(meshes.map((mesh) => new Promise<void>((done) => toWarm.push({ mesh, geometries: [mesh.geometry], done, loose: true })))).then(() => {});
}
/** DO NOT dispose a mesh still waiting here without this */
export function cancelWarm(meshes: Iterable<Mesh>): void {
  const gone = new Set(meshes);
  for (let i = toWarm.length - 1; i >= 0; i--) {
    const job = toWarm[i]!;
    if (!gone.has(job.mesh)) continue;
    toWarm.splice(i, 1);
    job.done();
  }
}
/** Sends one waiting mesh's geometry to the GPU, after the frame (`renderer.ts`). */
export function drainWarm(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  warmer = true;
  // Loose meshes (a batch of buildings) several a frame within a few milliseconds; one at least, so the queue always moves.
  const until = performance.now() + WARM_SLICE_MS;
  do warmOne(renderer, camera, scene, target);
  while (toWarm.length > 0 && toWarm[0]!.loose && performance.now() < until);
}
/** Milliseconds a frame for loose meshes (`drainWarm`). */
const WARM_SLICE_MS = 6;
/** Whether meshes still wait to go to the GPU: the renderer asks for another frame meanwhile. */
export function warmPending(): boolean {
  return toWarm.length > 0;
}

/** A loose mesh's buffers sent up in a scene of its own (`warmLoose`) */
const LOOSE = {
  scene: Object.assign(new ThreeScene(), { matrixWorldAutoUpdate: false }),
  camera: new OrthographicCamera(),
  material: new MeshBasicMaterial(),
  target: new WebGLRenderTarget(1, 1),
};
LOOSE.scene.overrideMaterial = LOOSE.material;

/** DO NOT draw the whole scene for it (on a layer of its own) */
function warmLoose(renderer: WebGLRenderer, mesh: Mesh, geometries: readonly BufferGeometry[]): void {
  const parent = mesh.parent;
  const at = parent ? parent.children.indexOf(mesh) : -1;
  const visible = mesh.visible, culled = mesh.frustumCulled, original = mesh.geometry;
  const previous = renderer.getRenderTarget();
  LOOSE.scene.add(mesh);
  try {
    mesh.visible = true;
    mesh.frustumCulled = false;
    renderer.setRenderTarget(LOOSE.target);
    for (const geometry of geometries) {
      mesh.geometry = geometry;
      renderer.render(LOOSE.scene, LOOSE.camera);
    }
  } finally {
    mesh.geometry = original;
    mesh.visible = visible;
    mesh.frustumCulled = culled;
    LOOSE.scene.remove(mesh);
    // Back where it was among its group's children: the order meshes of one render order are drawn in.
    if (parent) { parent.add(mesh); parent.children.splice(parent.children.length - 1, 1); parent.children.splice(at, 0, mesh); }
    renderer.setRenderTarget(previous);
  }
}

function warmOne(renderer: WebGLRenderer, camera: Camera, scene: Scene, target: WebGLRenderTarget | null): void {
  const job = toWarm.shift();
  if (!job) return;
  const { mesh, geometries, done, loose } = job;
  if (loose) {
    try { warmLoose(renderer, mesh, geometries); } finally { done(); }
    return;
  }
  let lights = lightsOf.get(scene);
  if (!lights) {
    lights = [];
    scene.traverse((o) => { if ((o as Light).isLight) lights!.push(o as Light); });
    lightsOf.set(scene, lights);
  }
  const mask = camera.layers.mask;
  const visible = mesh.visible;
  const original = mesh.geometry;
  const previous = renderer.getRenderTarget();
  const autoClear = renderer.autoClear;
  // The world's matrices were brought up to date by the frame just drawn.
  const autoUpdate = scene.matrixWorldAutoUpdate;
  try {
    scene.matrixWorldAutoUpdate = false;
    for (const light of lights) light.layers.enable(WARM_LAYER);
    mesh.layers.enable(WARM_LAYER);
    mesh.visible = true;
    camera.layers.set(WARM_LAYER);
    renderer.setRenderTarget(target);
    // The frame in the target has been shown already; nothing is cleared.
    renderer.autoClear = false;
    for (const geometry of geometries) {
      mesh.geometry = geometry;
      renderer.render(scene, camera);
    }
  } finally {
    mesh.geometry = original;
    mesh.visible = visible;
    mesh.layers.disable(WARM_LAYER);
    for (const light of lights) light.layers.disable(WARM_LAYER);
    camera.layers.mask = mask;
    renderer.autoClear = autoClear;
    scene.matrixWorldAutoUpdate = autoUpdate;
    renderer.setRenderTarget(previous);
    done();
  }
}

/** The geometry three's FullScreenQuad draws (`postprocessing/Pass.js`): one triangle with a position and a uv. */
export function fullScreenTriangle(): BufferGeometry {
  const quad = new BufferGeometry();
  quad.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  return quad;
}
