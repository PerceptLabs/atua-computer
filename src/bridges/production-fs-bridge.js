/**
 * No separate "Production" FS bridge exists.
 * FsBridge IS the production bridge — it connects to AtuaFS (OPFS)
 * or throws NOT IMPLEMENTED. There is no in-memory fallback.
 */
export { FsBridge as ProductionFsBridge } from './fs-bridge.js';
