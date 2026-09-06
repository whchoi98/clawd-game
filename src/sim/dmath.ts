/**
 * Deterministic math for the simulation.
 *
 * IEEE-754 guarantees bit-identical results for + - * / sqrt and the
 * rounding functions, but NOT for sin/cos/exp/pow/atan2 — those are
 * implementation-defined and differ between V8, JavaScriptCore and SpiderMonkey.
 * A replay verified on the server must reproduce the client's run exactly, so
 * the sim only ever uses the helpers below (polynomials over + - *).
 */
export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;

/** Wrap x into [-PI, PI). */
export function wrapAngle(x: number): number {
  return x - Math.floor(x / TAU + 0.5) * TAU;
}

/** sin(x) to ~1e-3 absolute error. Bhaskara-style parabola with a correction pass. */
export function dsin(x: number): number {
  x = wrapAngle(x);
  const B = 4 / PI;
  const C = -4 / (PI * PI);
  let y = B * x + C * x * Math.abs(x);
  y = 0.225 * (y * Math.abs(y) - y) + y;
  return y;
}

export function dcos(x: number): number {
  return dsin(x + PI / 2);
}

export function dlen(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Move `v` toward `target` by at most `step`. */
export function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}
/** Triangle wave in [-1, 1] with period `p` — a deterministic stand-in for sin in patrols. */
export function tri(t: number, p: number): number {
  const u = t / p - Math.floor(t / p);
  return u < 0.5 ? u * 4 - 1 : 3 - u * 4;
}
