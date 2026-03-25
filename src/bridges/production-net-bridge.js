import { InMemoryNetBridge } from './net-bridge.js';

export class ProductionNetBridge extends InMemoryNetBridge {
  constructor(options = {}) {
    super();
    this._profile = {
      transport: options.transport || 'atua-net',
      relay: options.relay || 'wisp',
    };
  }

  profile() {
    return { ...this._profile };
  }
}
