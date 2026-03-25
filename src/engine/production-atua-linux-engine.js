/**
 * ProductionAtuaLinuxEngine — Production engine configuration.
 *
 * This exists only when it adds real behavior on top of AtuaLinuxEngine.
 * Currently, AtuaLinuxEngine IS the production engine (Blink on WASIX).
 * There is no separate "production" wrapper — the engine either works or
 * it throws NOT IMPLEMENTED.
 *
 * Re-exported for backward compatibility with runtime.js imports.
 */
export { AtuaLinuxEngine as ProductionAtuaLinuxEngine } from './atua-linux-engine.js';
