import { AtuaLinuxEngine } from './atua-linux-engine.js';

export class ProductionAtuaLinuxEngine extends AtuaLinuxEngine {
  constructor(deps, options = {}) {
    super(deps);
    this._profile = {
      runtime: options.runtime || 'wasix',
      target: options.target || 'atua-linux-x86_64',
    };
  }

  profile() {
    return { ...this._profile };
  }
}
