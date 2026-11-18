import type * as ts from "typescript";

/** Keep the small compiler-internal surface explicit and checked at runtime. */
export function resolvedReadonly(typescript: typeof ts, symbol: ts.Symbol): boolean | undefined {
  const internals = typescript as typeof ts & {
    getCheckFlags?: (symbol: ts.Symbol) => number;
    CheckFlags?: { Readonly: number; SyntheticProperty: number; Mapped: number };
  };
  if (!internals.getCheckFlags || !internals.CheckFlags) {
    throw new Error("This TypeScript version does not expose resolved readonly metadata");
  }
  const flags = internals.getCheckFlags(symbol);
  if (flags & internals.CheckFlags.Readonly) return true;
  if (flags & (internals.CheckFlags.SyntheticProperty | internals.CheckFlags.Mapped)) return false;
  return undefined;
}

/** The compiler sets this bit on inherited constructors as well as written signatures.
 * Reading it avoids materializing the entire constructor type simply to inspect its modifier.
 */
export function resolvedAbstract(typescript: typeof ts, signature: ts.Signature): boolean | undefined {
  const flag = (typescript as typeof ts & { SignatureFlags?: { Abstract?: number } }).SignatureFlags?.Abstract;
  const flags = (signature as ts.Signature & { flags?: number }).flags;
  return flag === undefined || flags === undefined ? undefined : (flags & flag) !== 0;
}

export function enumParent(symbol: ts.Symbol): ts.Symbol | undefined {
  return (symbol as ts.Symbol & { parent?: ts.Symbol }).parent;
}

/**
 * The public checker exposes a property's read type. Let its declaration printer resolve
 * the write type, including substitutions on inherited or generic setters. Passing just
 * this symbol avoids printing every sibling to inspect one accessor.
 */
export function resolvedSetterType(
  typescript: typeof ts,
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  scope: ts.Node,
  flags: ts.NodeBuilderFlags,
): ts.TypeNode | null | undefined {
  const internals = checker as ts.TypeChecker & {
    createAnonymousType?: (
      owner: ts.Symbol | undefined,
      members: ts.SymbolTable,
      calls: ts.Signature[],
      constructs: ts.Signature[],
      indexes: ts.IndexInfo[],
    ) => ts.Type;
  };
  if (!internals.createAnonymousType) return undefined;
  const holder = internals.createAnonymousType(undefined, new Map([[symbol.escapedName, symbol]]), [], [], []);
  const node = checker.typeToTypeNode(holder, scope, flags);
  if (!node || !typescript.isTypeLiteralNode(node)) return undefined;
  const setter = node.members.find(typescript.isSetAccessorDeclaration);
  // A plain property from the compiler means reads and writes have the same type.
  return setter ? setter.parameters[setter.parameters.length - 1]?.type : null;
}
