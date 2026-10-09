// SPDX-License-Identifier: Apache-2.0
// REAL OS automation layer — foreground control of the actual machine.
//
// SAFETY: this layer is NEVER selected by default. selectOSLayer() returns
// the mock unless COMPUTER_USE_REAL=1 is set in the environment. Even then,
// every mutating tool call (click/type/key) still flows through governance
// (computerUsePolicyRules() → require-approval) before the handler runs —
// the approval gate is orthogonal to which OS layer is active.
//
// Native dependencies are OPTIONAL and lazy-loaded on first use, so merely
// importing this module (or enabling the env var without the packages
// installed) never crashes the process at startup. The first real action
// throws a clear install error instead.
//
// Install (on the machine whose screen you want to control):
//   npm install screenshot-desktop robotjs
// NOTE: @nut-tree/nut-js was evaluated but is no longer published on npm
// (404 as of 2026-10-09); robotjs is the fallback. robotjs needs a C++
// toolchain (node-gyp) at install time. Screenshots work with
// screenshot-desktop alone.

import { createRequire } from 'node:module';
import { MockOSScreenLayer } from './computer.js';
import type { DisplaySize, OSScreenLayer, Screenshot } from './computer.js';

// ESM-safe require for optional native dependencies.
const requireOptional = createRequire(import.meta.url);

/** Minimal input backend. robotjs-shaped; injectable for tests. */
export interface RealInputBackend {
  /** Move the mouse cursor to physical pixel coordinates. */
  moveMouse(x: number, y: number): Promise<void>;
  /** Click the current mouse position (left button). */
  mouseClick(): Promise<void>;
  /** Type text via the OS keyboard. */
  typeString(text: string): Promise<void>;
  /** Press a key by our allowlist name (Enter, Tab, Escape, ...). */
  pressKey(name: string): Promise<void>;
  screenWidth(): Promise<number>;
  screenHeight(): Promise<number>;
}

/** Minimal screenshot backend. screenshot-desktop-shaped; injectable for tests. */
export interface RealScreenshotBackend {
  /** Capture the primary display; resolves with PNG bytes. */
  capture(): Promise<Uint8Array>;
}

export interface RealOSLayerDeps {
  input?: RealInputBackend;
  screenshotBackend?: RealScreenshotBackend;
  /**
   * Audit hook: called AFTER every real input action (click/type/key).
   * The host wires this to the governance audit trail. Screenshots are
   * read-only and not reported here (they are audited as tool calls by
   * the runtime like any other tool execution).
   */
  onRealAction?: (action: 'click' | 'type' | 'key', detail: Record<string, unknown>) => void;
}

/** Map our COMPUTER_KEY_ALLOWLIST names to robotjs key names. */
const ROBOTJS_KEY_MAP: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Space: 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

/**
 * Lazy robotjs backend. require() happens on first use, not at import, so
 * the module loads fine without robotjs installed.
 */
function lazyRobotJs(): RealInputBackend {
  let robot: {
    moveMouse(x: number, y: number): void;
    mouseClick(button?: string): void;
    typeString(text: string): void;
    keyTap(key: string): void;
    getScreenSize(): { width: number; height: number };
  };
  const load = () => {
    if (!robot) {
      try {
        robot = requireOptional('robotjs') as typeof robot;
      } catch (err) {
        throw new Error(
          'COMPUTER_USE_REAL=1 is set but the "robotjs" package is not installed. ' +
            'Install it on the machine whose screen you want to control: npm install robotjs ' +
            '(requires a C++ toolchain for node-gyp). ' +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return robot;
  };
  return {
    async moveMouse(x, y) {
      load().moveMouse(x, y);
    },
    async mouseClick() {
      load().mouseClick('left');
    },
    async typeString(text) {
      load().typeString(text);
    },
    async pressKey(name) {
      const mapped = ROBOTJS_KEY_MAP[name];
      if (!mapped) throw new Error(`no robotjs mapping for key "${name}"`);
      load().keyTap(mapped);
    },
    async screenWidth() {
      return load().getScreenSize().width;
    },
    async screenHeight() {
      return load().getScreenSize().height;
    },
  };
}

/** Lazy screenshot-desktop backend. */
function lazyScreenshotDesktop(): RealScreenshotBackend {
  const load = (): ((opts?: { format?: string }) => Promise<Buffer>) => {
    try {
      return requireOptional('screenshot-desktop') as (opts?: { format?: string }) => Promise<Buffer>;
    } catch (err) {
      throw new Error(
        'COMPUTER_USE_REAL=1 is set but the "screenshot-desktop" package is not installed. ' +
          'Install it: npm install screenshot-desktop. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  return {
    async capture() {
      const buf = await load()({ format: 'png' });
      return new Uint8Array(buf);
    },
  };
}

/**
 * Real foreground OS layer: drives the actual visible screen/keyboard.
 * Constructing is cheap and side-effect free; native modules load lazily
 * on first action.
 */
export class RealOSScreenLayer implements OSScreenLayer {
  private readonly input: RealInputBackend;
  private readonly shots: RealScreenshotBackend;
  private readonly onRealAction?: RealOSLayerDeps['onRealAction'];

  constructor(deps: RealOSLayerDeps = {}) {
    this.input = deps.input ?? lazyRobotJs();
    this.shots = deps.screenshotBackend ?? lazyScreenshotDesktop();
    this.onRealAction = deps.onRealAction;
  }

  async displaySize(): Promise<DisplaySize> {
    const [width, height] = await Promise.all([this.input.screenWidth(), this.input.screenHeight()]);
    return { width, height };
  }

  async screenshot(): Promise<Screenshot> {
    const png = await this.shots.capture();
    const { width, height } = await this.displaySize();
    return { png, width, height };
  }

  async click(x: number, y: number): Promise<void> {
    await this.input.moveMouse(x, y);
    await this.input.mouseClick();
    this.onRealAction?.('click', { x, y, at: Date.now() });
  }

  async type(text: string): Promise<void> {
    await this.input.typeString(text);
    this.onRealAction?.('type', { chars: text.length, at: Date.now() });
  }

  async key(name: string): Promise<void> {
    await this.input.pressKey(name);
    this.onRealAction?.('key', { name, at: Date.now() });
  }
}

/** Env var that opts into REAL foreground control. Mock is the default. */
export const COMPUTER_USE_REAL_ENV = 'COMPUTER_USE_REAL';

/**
 * Select the OS layer: RealOSScreenLayer only when COMPUTER_USE_REAL=1,
 * otherwise the safe MockOSScreenLayer. Optional deps/audit hook are
 * forwarded to the real layer (used by tests and by hosts wiring audit).
 */
export function selectOSLayer(deps: RealOSLayerDeps = {}): OSScreenLayer {
  if (process.env[COMPUTER_USE_REAL_ENV] === '1') {
    return new RealOSScreenLayer(deps);
  }
  return new MockOSScreenLayer();
}

/** True when the real foreground layer is active (for status endpoints). */
export function isRealOSLayerActive(): boolean {
  return process.env[COMPUTER_USE_REAL_ENV] === '1';
}
