import { InMemoryFsBridge } from './fs-bridge.js';

export class ProductionFsBridge extends InMemoryFsBridge {
  constructor(options = {}) {
    super();
    this._profile = {
      durability: options.durability || 'persistent',
      backend: options.backend || 'AtuaFS',
    };
  }

  profile() {
    return { ...this._profile };
  }
}
