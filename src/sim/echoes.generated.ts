/**
 * GENERATED — do not edit. Source: levels/solutions/*.json, built by levels/build.ts
 * (`npm run levels`). One verified developer clear per story zone (deaths 0,
 * time ≤ par × 1.2) recorded against SIM_VERSION 2 at the zone's geometry
 * revision. The client runs it as the '목표' echo when a board is empty or
 * unreachable; the server seeds empty story boards with it. A zone without a
 * current solution has no entry (see levels/solutions/PENDING.json).
 */

export interface GoalEcho {
  /** SIM_VERSION the masks were recorded against. */
  sim: number;
  /** LevelDef.rev at recording time (missing rev = 0). */
  rev: number;
  seed: number;
  /** RLE base64 masks (src/sim/replay.ts encodeMasks). */
  masks: string;
  /** Play ticks of the verified run. */
  ticks: number;
}

/** Zone id → the developer clear that stands in for an empty leaderboard. */
export const GOAL_ECHOES: Readonly<Record<string, GoalEcho>> = {
  t1: { sim: 2, rev: 0, seed: 5, masks: 'EQUBGxIKAgoSCgIEIgMCCxIKAgQiAwIfAQsiAwECAgEmATYCEgwkAwAdKgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIREg4CDiIDAi0iAwIdIgMCHSIDAh0iAwIdKgMCHSIDAhESDgIOKgMCHSIDAi0iAwIdIgMCHQEIIgIyAREEAQECGBIIAgYpAwI1', ticks: 857 },
  t2: { sim: 2, rev: 0, seed: 13, masks: 'EQUBGxIKAgoSCgIEIgMCGwEFIgMBCBELMgMRAgIQEAYABBAGEgUCGxIMAgwSDAIMIgMCHyQDAgsSCgIEIgMCHyIDAhESDgIOEgoCChIKAgQiAwILARAqAwIdIgMCHQEMIgMBESoDABIQCAADKgMCHSIDAi0SDAIOEgYiAwIREg4CDhIcAgQSCgIEIgMCHyQDAB0iAwIdIgMCLQEIIgMBBQIIEhoCHiIDAkEiAwIY', ticks: 1050 },
  t3: { sim: 2, rev: 0, seed: 29, masks: 'EQUBGxIKAgoSCgIEIgMCCxIFAhsSCgIEJgMCHwAQEgUCGwACEAY6AxAFEgoCBCIDAh8ABxAJAgYkAwIHEgwCAhIMAhYmAwIdKgMCHSIDAh0iAwIdIgMCHSoDAh0qAwItEgwCBBIKAgQmAwIgKgMCDBIKAgQiAwIfIgMCHQADIgMAChIKAgQiAwIR', ticks: 749 },
  s1: { sim: 2, rev: 0, seed: 41, masks: 'AgcSGwISJAMCARIkAgQmAwIdAAYmAwABEBYSDAICEgwCHBIQAh0SGQIMEgwCDCIDAh0SCgIKEgoCBCIDAgsSDAICEgwCFiIDAhESDgIZEg4CCiYDAhoiAwIREg4CDiYDAh0SDAICEgwCFhIFAhsQECYDAickAwIaEhMCBiIDAjQSHQIMEgoCBCIDAh8iAwIdKgMCHSIDAh0iAwIdKgMCHSIDAkUSCCoDAiMiAwIdIgMCGw==', ticks: 1263 },
  s2: { sim: 2, rev: 0, seed: 59, masks: 'EQUBGxIKAgoSCgIEIgMCCxIKAgQiAwIfJAMAHQIGIgMCBxIKAgQiAwIfIgMCHSoDAh0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAi0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIdEgoCBCIDAh4=', ticks: 906 },
  s3: { sim: 2, rev: 0, seed: 79, masks: 'AjASCgIEIgMCHyIDAhESDgIOEgoCBCIDAh8qAwIdIgMCLSIDAhESDgIOIgMCNRISAgQiAwIfKgMCHSIDAh0iAwIREg4CDiIDAi0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIdIgMCHSIDAh0iAwIdIgMCERIOAg4iAwADEAoCAxIENAMSBgggJgMCHSoDAj8=', ticks: 1069 },
  v1: { sim: 2, rev: 0, seed: 101, masks: 'AhAAMAoCJgMKCwEQAhcSNQIEIgMCERIOAhciAwIEAQMRBQEIEgoCBCYDAh8ACSoDAAIQEgIHEhkCICIDAhESDgIOJgMCLRIMAgQSCgIEIgMCKRIWIgMCHQAQAhASDAIEJgMCNBI1AhMhAwIaEhQCAiYDAgMSCAIQEgwCBRIPIgMCHSIDAh0iAwIdIgMCHSIDAh0qAwIdIgMCHRIKAgQiAwIfEgoCBCIDAjUiAwIQEgcCGSIDAh8=', ticks: 1286 },
  v2: { sim: 2, rev: 0, seed: 137, masks: 'EQUBGxIKAgoSCgIEIgMCCxIKAgQiAwIfAAgmAwAGEB4AESYDAh0iAwIREg4CDiIDAh0iAwIdIgMCHSIDAhESDgIeKgMCHRIKAgQmAwIfKgMCJiICMgESBAAFEAsyAxANABAiAwIREg4CDiIDAh0KIAEQCiACIhIEAgoBECEDARERDgEOEQwBAhEMARoRHAEQAhARHAEEEQoBBCEDAR8CEAEYEQgBEBEMAQQRDAEMEQwBDBEcAQQRDAEWEQwBAiEDAR0SCgIKEgoCBCIDAgsQHAAEARkRBwIoEggQHAAEAjAmAwIdEAUAGwpAABACECIDAkg=', ticks: 1734 },
  v3: { sim: 2, rev: 0, seed: 181, masks: 'EQUBGxIKAgoSCgIEIgMCCxIKAgQiAwIfIgMCERIOAg4iAwIREg4CDgogIgMCJSYDAgoSCyQDAB0qAwIdIgMCERIOAg4iAwIdEgoCBCIDAi8iAwItIgMCHQggAgMSDSQDAB0SBjQCJAECGBIIAgcqAwIdIgMCHSIDAh0iAwIdIgMCJRIMAgwmAwIdKgMCHSIDAh0iAwIdCiAiAwIdIgMCHSIDAko=', ticks: 1176 },
};
