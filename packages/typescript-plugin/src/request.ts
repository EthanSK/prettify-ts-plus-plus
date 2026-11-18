// Prettify TypeScript++ was previously Prettify TypeScript (prettify-ts, by Myles Murphy).
// Its request and response names are isolated so an installed upstream plugin cannot answer the fork's requests.
import type * as ts from "typescript";

import type { TypeInfo } from "./type-tree/types";

/**
 * Prettify Request options. These options control how the type information is prettified.
 */
export type PrettifyOptions = {
  /**
   * Denotes whether to hide private properties in the type information.
   */
  hidePrivateProperties: boolean;

  /** A larger, still bounded analysis budget for explicit copy requests. */
  fullExpansion?: boolean;

  /**
   * The output is copied rather than shown: compiler text is not truncated (`Foo<...>`) and skipped types keep
   * their arguments, so pasted output stays valid TypeScript. Always set with fullExpansion.
   */
  copy?: boolean;

  /**
   * The client renders `neverProperties` (`/* never: a, b *\/`), so two or more proven `?: never` keys may share one
   * line. Clients that predate it would silently drop those keys, so the plugin groups them only when asked; otherwise
   * every key stays a `key?: never` property. Never applies to copies.
   */
  groupNeverProperties?: boolean;

  /**
   * The client shows `TypeInfo.source` beneath the hover, so the plugin sends the authored definition only when
   * asked; older clients would ignore it. Never applies to copies, which must contain only the type. Claude Opus 5.5
   */
  showSource?: boolean;

  /**
   * Treat underscore-prefixed members as private when hiding private properties.
   * Defaults to true when omitted for compatibility with older requests.
   */
  treatUnderscoreAsPrivate?: boolean;

  /**
   * Determines the maximum depth of the type tree.
   * This limits how deeply nested types will be expanded.
   */
  maxDepth: number;

  /**
   * Specifies the maximum number of properties to include in an object type.
   * If the number of properties exceeds this limit, the excess properties will be summarized.
   */
  maxProperties: number;

  /**
   * Specifies the maximum number of sub-properties to include in an object type.
   * Sub-properties are properties of properties.
   */
  maxSubProperties: number;

  /**
   * Specifies the maximum number of members to include in a union type.
   */
  maxUnionMembers: number;

  /**
   * Specifies the maximum number of function signatures to include in a function type.
   */
  maxFunctionSignatures: number;

  /**
   * List of type names to skip unwrapping in the type tree.
   */
  skippedTypeNames: string[];

  /**
   * Denotes whether to unwrap arrays in the type tree.
   */
  unwrapArrays: boolean;

  /**
   * Denotes whether to unwrap functions in the type tree.
   */
  unwrapFunctions: boolean;

  /** Legacy per-Promise preference, sent only when the generic-argument list still uses its default. */
  unwrapPromises?: boolean;

  /**
   * List of generic type names whose arguments should be displayed as-is, rather than resolving to their apparent (final) type.
   */
  unwrapGenericArgumentsTypeNames: string[];

  /**
   * Show properties that are identical in every member of an object union once, as `Shared & (A | B)`.
   * Opt-in: the result is equivalent TypeScript, but it reshapes the familiar one-object-per-member layout.
   * Defaults to false when omitted, so older clients keep the earlier output.
   */
  factorSharedUnionProperties: boolean;
};

/**
 * Request format for prettifying type information.
 * This request is sent when the user triggers a type information request with a specific character.
 */
export type PrettifyRequest = {
  meta: "prettify-ts-plus-plus-type-info-request";
  options: PrettifyOptions;
};

/**
 * Overrides the default TypeScript completions trigger character type to include the PrettifyRequest.
 */
export type PrettifyCompletionsTriggerCharacter = PrettifyRequest | ts.CompletionsTriggerCharacter | undefined;

/**
 * Response format for prettified type information.
 */
export type PrettifyResponse = ts.WithMetadata<ts.CompletionInfo> & {
  __prettifyPlusPlusResponse?: TypeInfo;
};

/**
 * Determines if the request is a PrettifyRequest.
 */
export function isPrettifyRequest(request: PrettifyCompletionsTriggerCharacter): request is PrettifyRequest {
  return (
    !!request &&
    typeof request === "object" &&
    "meta" in request &&
    request["meta"] === "prettify-ts-plus-plus-type-info-request"
  );
}
