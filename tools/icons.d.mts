/** Type surface of tools/icons.mjs for the tests (same pattern as postdeploy.d.mts). */
export interface IconVariant {
  /** File name under public/icons/. */
  file: string;
  /** Square edge in CSS pixels (deviceScaleFactor 1). */
  size: number;
  /** Square off the #bg tile (maskable / Apple variants). */
  fullBleed: boolean;
  /** Scale applied to #art about the centre; 1 = as drawn. */
  art: number;
  /** Keep the tile's corners transparent. */
  transparent: boolean;
}

export declare const VARIANTS: readonly IconVariant[];

/** Width and height from a PNG's IHDR chunk; throws on non-PNG bytes. */
export declare function pngSize(buf: Buffer): { width: number; height: number };
