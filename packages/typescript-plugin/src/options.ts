import type { PrettifyOptions } from "./request";

export const DEFAULT_OPTIONS: PrettifyOptions = {
  hidePrivateProperties: true,
  treatUnderscoreAsPrivate: true,
  maxDepth: 1,
  maxProperties: 1000,
  maxSubProperties: 10,
  maxUnionMembers: 15,
  maxFunctionSignatures: 5,
  skippedTypeNames: [
    "Array",
    "ArrayBuffer",
    "Buffer",
    "Date",
    "Element",
    "Error",
    "Map",
    "Number",
    "RegExp",
    "Set",
    "String",
    "Symbol",
  ],
  unwrapArrays: true,
  unwrapFunctions: true,
  unwrapGenericArgumentsTypeNames: ["Promise", "Set", "Map", "Observable"],
  factorSharedUnionProperties: false,
};

export const DISPLAY_DEFAULTS = { enabled: true, typeIndentation: 4, maxCharacters: 20000 };

// Spaces are allocated for every indented line. Even at the 256-level Full Copy depth, 64 spaces per
// level fits in 16 KiB per indent while leaving regular editor widths and wider custom widths available.
export const MAX_TYPE_INDENTATION = 64;

/** Upper bound for numeric settings; large enough that it never limits a real preview. */
export const MAX_SETTING = 1_000_000_000;

export type SafetyLimits = { nodes: number; depth: number; characters: number; milliseconds: number };

/**
 * Internal safety limits. They only stop runaway expansion (for example recursive generics);
 * the user's settings remain in charge of what a normal preview shows.
 */
export const PREVIEW_LIMITS: SafetyLimits = { nodes: 20_000, depth: 64, characters: 2_000_000, milliseconds: 1000 };
export const FULL_COPY_LIMITS: SafetyLimits = {
  nodes: 200_000,
  depth: 256,
  characters: 10_000_000,
  milliseconds: 5000,
};

/**
 * Long definitions are shortened to keep the hover manageable; the link opens the full source. Claude Opus 5.5
 */
export const SOURCE_LIMITS = { lines: 20, characters: 1500 };

export function integerSetting(value: unknown, fallback: number, minimum: number, maximum = MAX_SETTING): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

export function normalizeOptions(input: Partial<PrettifyOptions> = {}): PrettifyOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const result = { ...DEFAULT_OPTIONS };
  for (const key of [
    "hidePrivateProperties",
    "treatUnderscoreAsPrivate",
    "unwrapArrays",
    "unwrapFunctions",
    "factorSharedUnionProperties",
  ] as const) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  for (const key of [
    "maxDepth",
    "maxProperties",
    "maxSubProperties",
    "maxUnionMembers",
    "maxFunctionSignatures",
  ] as const) {
    result[key] = integerSetting(input[key], DEFAULT_OPTIONS[key], key === "maxDepth" ? 0 : 1);
  }
  for (const key of ["skippedTypeNames", "unwrapGenericArgumentsTypeNames"] as const) {
    const value = input[key];
    result[key] = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [...DEFAULT_OPTIONS[key]];
  }
  result.fullExpansion = input.fullExpansion === true;
  if (input.unwrapPromises === false && !result.fullExpansion) result.unwrapPromises = false;
  result.copy = input.copy === true || result.fullExpansion;
  result.groupNeverProperties = input.groupNeverProperties === true && !result.copy;
  result.showSource = input.showSource === true && !result.copy;
  if (result.fullExpansion) {
    result.maxDepth = MAX_SETTING;
    result.maxProperties = MAX_SETTING;
    result.maxSubProperties = MAX_SETTING;
    result.maxUnionMembers = MAX_SETTING;
    result.maxFunctionSignatures = MAX_SETTING;
    result.unwrapArrays = true;
    result.unwrapFunctions = true;
  }
  return result;
}
