import { BufferGeometry, Material, Texture, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { profiler } from '@core/profiler';

/** The profiler's hooks into three and WebGL (`core/profiler.ts`): installed only while it is shown, taken out after */
export function hookProfiler(renderer: WebGLRenderer): () => void {
  const undo: (() => void)[] = [];
  /** `target[key]` replaced by `make(original)` until the hooks are taken out. */
  const replace = <T extends object>(target: T, key: string, make: (original: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown): void => {
    const slot = target as Record<string, unknown>;
    const own = Object.prototype.hasOwnProperty.call(target, key);
    const original = slot[key] as (...a: unknown[]) => unknown;
    slot[key] = make(original);
    undo.push(() => { if (own) slot[key] = original; else delete slot[key]; });
  };
  const counted = (event: Parameters<typeof profiler.count>[0]) => (original: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...a: unknown[]): unknown { profiler.count(event); return original.apply(this, a); };
  replace(BufferGeometry.prototype, 'dispose', counted('dispose.geometry'));
  replace(Material.prototype, 'dispose', counted('dispose.material'));
  replace(Texture.prototype, 'dispose', counted('dispose.texture'));
  replace(WebGLRenderTarget.prototype, 'dispose', counted('dispose.target'));

  // A geometry is built when it is first given its positions.
  const built = new WeakSet<BufferGeometry>();
  replace(BufferGeometry.prototype, 'setAttribute', (original) => function (this: BufferGeometry, ...a: unknown[]): unknown {
    if (a[0] === 'position' && !built.has(this)) { built.add(this); profiler.count('build.geometry'); }
    return original.apply(this, a);
  });

  // What goes to the GPU, on this renderer's context only.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const bytesOf = (data: unknown): number => (data && typeof data === 'object' && 'byteLength' in data ? Number((data as ArrayBufferView).byteLength) : typeof data === 'number' ? data : 0);
  replace(gl, 'bufferData', (original) => (...a: unknown[]): unknown => {
    profiler.count('upload.buffer', bytesOf(a[1]));
    return original.apply(gl, a);
  });
  replace(gl, 'bufferSubData', (original) => (...a: unknown[]): unknown => {
    const view = a[2] as ArrayBufferView | undefined;
    const length = typeof a[4] === 'number' && view && 'BYTES_PER_ELEMENT' in view ? a[4] * Number((view as Float32Array).BYTES_PER_ELEMENT) : bytesOf(view);
    profiler.count('upload.buffer', length);
    return original.apply(gl, a);
  });
  for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D'] as const) {
    replace(gl, name, (original) => (...a: unknown[]): unknown => {
      // The pixels' bytes: a typed array's own, or an image's width × height as RGBA8.
      const source = a.find((v) => v !== null && typeof v === 'object');
      const bytes = source === undefined ? 0 : ArrayBuffer.isView(source) ? source.byteLength
        : 'width' in source && 'height' in source ? Number(source.width) * Number(source.height) * 4 : 0;
      profiler.count('upload.texture', bytes);
      return original.apply(gl, a);
    });
  }
  return () => { for (const step of undo.splice(0).reverse()) step(); };
}
