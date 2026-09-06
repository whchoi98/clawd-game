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

/** One harness frame of a social picture: the `?shot=` query and the viewport it is shot at. */
export interface SocialShot {
  /** The harness query after `?` ('shot=t1&frames=240&hold=right&pulse=jump:26'). */
  query: string;
  width: number;
  height: number;
  /** Hide the DOM HUD before the shot. */
  hideUi: boolean;
}

/** A social picture (P3-4): og:image or a manifest screenshot composited from harness frames. */
export interface SocialVariant {
  /** Path under public/ ('og/og.png', 'screenshots/wide-play.png'). */
  file: string;
  width: number;
  height: number;
  /** Byte cap the renderer quantises toward. */
  maxBytes: number;
  /** panel = brand panel + cropped frame (og); plain = the frame as shot; stack = two 16:9 frames with captions (narrow). */
  layout: 'panel' | 'plain' | 'stack';
  /** Manifest form_factor, null for the og image. */
  formFactor: 'wide' | 'narrow' | null;
  shots: readonly SocialShot[];
  /** Captions under the frames of a stack. */
  captions?: readonly string[];
}

export declare const VARIANTS: readonly IconVariant[];
export declare const SOCIAL: readonly SocialVariant[];
/** Settings seeded into the harness page before the social shots (key = save.ts SETTINGS_KEY). */
export declare const SHOT_SETTINGS: { key: string; doc: Record<string, unknown> };

/** Width and height from a PNG's IHDR chunk; throws on non-PNG bytes. */
export declare function pngSize(buf: Buffer): { width: number; height: number };

/** The about:blank composite page (frame canvases + the layout's brand chrome). */
export declare function compositeHtml(opts: {
  frames: string[]; width: number; height: number; quant: number; layout: 'panel' | 'plain' | 'stack'; captions?: readonly string[];
}): string;
