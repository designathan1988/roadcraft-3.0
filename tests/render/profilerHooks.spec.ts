import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, type WebGLRenderer } from 'three';
import { profiler } from '@core/profiler';
import { hookProfiler } from '@render/profilerHooks';

/** A WebGL context's upload calls, as plain methods on its prototype (as the browser's are). */
class FakeGl {
  calls = 0;
  bufferData(): void { this.calls++; }
  bufferSubData(): void { this.calls++; }
  texImage2D(): void { this.calls++; }
  texSubImage2D(): void { this.calls++; }
  texImage3D(): void { this.calls++; }
  texSubImage3D(): void { this.calls++; }
  compressedTexImage2D(): void { this.calls++; }
}

describe('the profiler hooks', () => {
  it('cost nothing until installed, count while installed, and leave three and the context as they were once taken out', () => {
    const gl = new FakeGl();
    const renderer = { getContext: () => gl } as unknown as WebGLRenderer;
    const dispose = BufferGeometry.prototype.dispose;
    const setAttribute = BufferGeometry.prototype.setAttribute;
    const unhook = hookProfiler(renderer);
    expect(BufferGeometry.prototype.dispose).not.toBe(dispose);
    profiler.enabled = true;
    try {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
      geometry.dispose();
      gl.bufferData();
      const view = profiler.view().events;
      expect(view['build.geometry']?.total).toBe(1);
      expect(view['dispose.geometry']?.total).toBe(1);
      expect(view['upload.buffer']?.total).toBe(1);
    } finally {
      profiler.enabled = false;
      unhook();
    }
    expect(BufferGeometry.prototype.dispose).toBe(dispose);
    expect(BufferGeometry.prototype.setAttribute).toBe(setAttribute);
    expect(Object.prototype.hasOwnProperty.call(gl, 'bufferData')).toBe(false);
    expect(gl.calls).toBe(1);
    // Taken out, nothing more is counted.
    new BufferGeometry().dispose();
    expect(profiler.view().events['dispose.geometry']?.total).toBe(1);
  });
});
