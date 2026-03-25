import { InMemoryPtyBridge } from './pty-bridge.js';

export class ProductionPtyBridge extends InMemoryPtyBridge {
  constructor(options = {}) {
    super();
    this._profile = {
      terminal: options.terminal || 'xterm.js',
      mode: options.mode || 'browser-pty',
    };
  }

  profile() {
    return { ...this._profile };
  }
}
