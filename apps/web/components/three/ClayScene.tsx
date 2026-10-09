// SPDX-License-Identifier: Apache-2.0
// Tasteful 3D hero: soft floating clay-like blobs with gentle drift.
// - Lazy-loaded via next/dynamic (never in the initial bundle, no SSR)
// - Pauses when the tab is hidden or the canvas scrolls out of view
// - Renders a single static frame when prefers-reduced-motion is set
// - Colors follow the active theme via document.documentElement.dataset.theme
// - User toggle: localStorage 'mvp:3d-enabled' (default on)
'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const STORAGE_KEY = 'mvp:3d-enabled';

export function is3DEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null || v !== '0';
  } catch {
    return true;
  }
}

export function set3DEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Muted clay palettes per theme family. */
function paletteFor(theme: string): number[] {
  switch (theme) {
    case 'dark':
    case 'midnight':
      return [0x4c5fd5, 0x7c5cd6, 0x3fa08a, 0x8a5aa8];
    case 'ocean':
      return [0x2f7fa8, 0x3fa08a, 0x5b8dd9, 0x2b6cb0];
    case 'porcelain':
      return [0xe8b4a0, 0xc9b8e0, 0xa8d5c8, 0xe8d5a8];
    case 'light':
    default:
      return [0xd9a7e8, 0xa7c8e8, 0xa8e0c8, 0xe8c8a7];
  }
}

function currentTheme(): string {
  try {
    return document.documentElement.dataset.theme || 'light';
  } catch {
    return 'light';
  }
}

export default function ClayScene({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !is3DEnabled()) return;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const width = mount.clientWidth || 320;
    const height = mount.clientHeight || 220;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 0.6, 7);

    // Soft studio lighting — clay look comes from diffuse + fill, no harsh spots.
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(4, 6, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfd8ff, 0.45);
    fill.position.set(-5, -2, 3);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const palette = paletteFor(currentTheme());
    const blobs: Array<{ mesh: THREE.Mesh; base: THREE.Vector3; phase: number; speed: number; rotSpeed: number }> = [];

    // Organic clay blobs: icosahedron with gentle vertex noise baked in.
    const makeBlob = (color: number, radius: number, detail = 3) => {
      const geo = new THREE.IcosahedronGeometry(radius, detail);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const n = 1 + 0.14 * Math.sin(v.x * 2.1 + radius) * Math.cos(v.y * 1.7) + 0.08 * Math.sin(v.z * 3.3);
        v.multiplyScalar(n);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.75,
        metalness: 0.05,
      });
      return new THREE.Mesh(geo, mat);
    };

    const layout: Array<[number, number, number, number]> = [
      // x, y, z, radius
      [-1.7, 0.15, -0.6, 0.85],
      [0.1, -0.35, 0.2, 1.15],
      [1.8, 0.35, -0.9, 0.65],
      [0.9, 1.05, -1.6, 0.45],
      [-0.9, -1.0, -1.2, 0.5],
    ];
    layout.forEach(([x, y, z, r], i) => {
      const mesh = makeBlob(palette[i % palette.length], r);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      blobs.push({
        mesh,
        base: new THREE.Vector3(x, y, z),
        phase: Math.random() * Math.PI * 2,
        speed: 0.25 + Math.random() * 0.25,
        rotSpeed: (Math.random() - 0.5) * 0.25,
      });
    });

    let raf = 0;
    let running = true;
    const clock = new THREE.Clock();

    const render = () => {
      renderer.render(scene, camera);
    };

    const tick = () => {
      if (!running) return;
      const t = clock.getElapsedTime();
      for (const b of blobs) {
        b.mesh.position.y = b.base.y + Math.sin(t * b.speed + b.phase) * 0.22;
        b.mesh.position.x = b.base.x + Math.cos(t * b.speed * 0.7 + b.phase) * 0.12;
        b.mesh.rotation.y += b.rotSpeed * 0.016;
        b.mesh.rotation.x += b.rotSpeed * 0.008;
      }
      render();
      raf = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reducedMotion) {
        running = true;
        clock.getDelta();
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Pause when scrolled out of view.
    let inView = true;
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        if (inView && !document.hidden && !reducedMotion && !running) {
          running = true;
          tick();
        } else if (!inView) {
          running = false;
          cancelAnimationFrame(raf);
        }
      },
      { threshold: 0.05 },
    );
    io.observe(mount);

    if (reducedMotion) {
      // Single static frame — no animation loop.
      render();
    } else {
      tick();
    }

    const onResize = () => {
      const w = mount.clientWidth || 320;
      const h = mount.clientHeight || 220;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      io.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat) mat.dispose();
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}
