/// <reference types="vite/client" />

// Minimal ambient declaration for @novnc/novnc. The library is plain JS
// and ships no .d.ts; we only use a small surface (constructor, properties,
// events, disconnect, sendCredentials) so we type just that here rather
// than pulling in an unmaintained third-party @types package.
declare module "@novnc/novnc" {
  interface RFBOptions {
    /** Credentials passed to the server (e.g. `{ password: "..." }`). */
    credentials?: { username?: string; password?: string; target?: string };
    /** Optional shared session flag. */
    shared?: boolean;
    /** Preferred WebSocket subprotocols. */
    wsProtocols?: string[];
    /** Reposition the cursor on the remote side using local mouse. */
    repeaterID?: string;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);

    /** When true, suppresses local input. */
    viewOnly: boolean;
    /** When true, the canvas scales to fit `target`. */
    scaleViewport: boolean;
    /** When true, the canvas resizes the remote session. */
    resizeSession: boolean;
    /** Background CSS string for the canvas container. */
    background: string;
    /** Show the integrated noVNC dot cursor. */
    showDotCursor: boolean;
    /** Detected QEMU keyboard codes. */
    qualityLevel: number;
    compressionLevel: number;
    capabilities: { power: boolean };

    disconnect(): void;
    sendCredentials(credentials: {
      username?: string;
      password?: string;
      target?: string;
    }): void;
    sendCtrlAltDel(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
  }
}
