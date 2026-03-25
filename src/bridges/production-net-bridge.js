/**
 * No separate "Production" net bridge exists.
 * NetBridge IS the production bridge — it connects to atua-net
 * or throws NOT IMPLEMENTED. There is no in-memory fallback.
 */
export { NetBridge as ProductionNetBridge } from './net-bridge.js';
