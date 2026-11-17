import type * as ts from "typescript";
import type { TypeSource } from "./types";
import { SOURCE_LIMITS } from "../options";

/**
 * Files the user wrote. Vue and other embedded-language files reach the compiler as generated code, so their text
 * is never shown as authored source. `.d.ts` and the other declaration extensions match too. Claude Opus 5.5
 */
const AUTHORED_FILE = /\.[cm]?[jt]sx?$/i;

/**
 * The authored definition of the hovered type, read from the compiler's own syntax tree:
 * - a type name (declaration, reference or qualified reference) shows its single alias or interface;
 * - an annotated variable, property or parameter shows its annotation, or the alias it names directly.
 * Anything ambiguous returns nothing rather than a guess: merged or multiple declarations, classes and enums
 * (bodies, not type expressions), JSDoc types, and annotations the hovered type no longer matches, such as
 * narrowed values or instantiated generic properties. Initializers and function bodies are never read.
 * Claude Opus 5.5
 */
export function getAuthoredSource(
  typescript: typeof ts,
  checker: ts.TypeChecker,
  node: ts.Node,
  symbol: ts.Symbol,
  type: ts.Type,
): TypeSource | undefined {
  const parent = node.parent;
  const declaresName =
    (typescript.isTypeAliasDeclaration(parent) || typescript.isInterfaceDeclaration(parent)) && parent.name === node;
  if (declaresName || typeReferenceName(typescript, node)) {
    const declaration = onlyTypeDeclaration(typescript, symbol);
    return declaration && sourceOf(declaration, declaration.getStart());
  }
  const declarations = symbol.declarations ?? [];
  const holder = declarations.length === 1 ? declarations[0] : undefined;
  if (
    !holder ||
    !(
      typescript.isVariableDeclaration(holder) ||
      typescript.isPropertyDeclaration(holder) ||
      typescript.isPropertySignature(holder) ||
      typescript.isParameter(holder)
    ) ||
    !holder.type
  )
    return undefined;
  const annotation = holder.type;
  const declared = checker.getTypeFromTypeNode(annotation);
  if (!sameType(checker, declared, type) && !sameType(checker, declared, checker.getNonNullableType(type))) {
    return undefined;
  }
  if (typescript.isTypeReferenceNode(annotation) && !annotation.typeArguments?.length) {
    // `state: OperationStatusStateUpdate` says nothing new; the alias it names is the useful definition.
    // Claude Opus 5.5
    let target = checker.getSymbolAtLocation(annotation.typeName);
    if (target && target.flags & typescript.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
    const declaration = target && onlyTypeDeclaration(typescript, target);
    return declaration && sourceOf(declaration, declaration.getStart());
  }
  const start =
    typescript.isParameter(holder) && holder.dotDotDotToken ? holder.dotDotDotToken.getStart() : holder.name.getStart();
  return sourceOf(holder, start, annotation.end);
}

/** `Foo` in `Foo<T>` and `A` in `ns.A`, but not `ns` itself. Claude Opus 5.5 */
function typeReferenceName(typescript: typeof ts, node: ts.Node): ts.TypeReferenceNode | undefined {
  let name: ts.Node = node;
  while (typescript.isQualifiedName(name.parent) && name.parent.right === name) name = name.parent;
  return typescript.isTypeReferenceNode(name.parent) && name.parent.typeName === name ? name.parent : undefined;
}

/**
 * The symbol's one type declaration, when that is an alias or interface. Merged interfaces, and a class or enum
 * sharing the name, have no single authored definition. Claude Opus 5.5
 */
function onlyTypeDeclaration(
  typescript: typeof ts,
  symbol: ts.Symbol,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  const types = (symbol.declarations ?? []).filter(
    (declaration) =>
      typescript.isTypeAliasDeclaration(declaration) ||
      typescript.isInterfaceDeclaration(declaration) ||
      typescript.isClassDeclaration(declaration) ||
      typescript.isEnumDeclaration(declaration) ||
      typescript.isJSDocTypedefTag(declaration) ||
      typescript.isJSDocCallbackTag(declaration),
  );
  const only = types.length === 1 ? types[0] : undefined;
  return only && (typescript.isTypeAliasDeclaration(only) || typescript.isInterfaceDeclaration(only))
    ? only
    : undefined;
}

/**
 * Identity, or mutual assignability where the compiler exposes it (TypeScript 5.4+), so an optional property's
 * added `undefined` still matches while narrowed and instantiated types do not. Claude Opus 5.5
 */
function sameType(checker: ts.TypeChecker, left: ts.Type, right: ts.Type): boolean {
  return (
    left === right ||
    (checker.isTypeAssignableTo?.(left, right) === true && checker.isTypeAssignableTo?.(right, left) === true)
  );
}

/**
 * Bounded text from `start` to `end`, read only up to the character limit. Lines keep their spelling and relative
 * whitespace; the declaration's own indentation is removed from later lines when every line shares it, so a
 * definition nested in a namespace does not start with its body pushed right. Claude Opus 5.5
 */
function sourceOf(node: ts.Node, start: number, end = node.end): TypeSource | undefined {
  const sourceFile = node.getSourceFile();
  if (!AUTHORED_FILE.test(sourceFile.fileName)) return undefined;
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const indentation = sourceFile.text.slice(start - character, start);
  let cut = end - start > SOURCE_LIMITS.characters;
  let text = sourceFile.text.slice(start, cut ? start + SOURCE_LIMITS.characters : end);
  // A cut between a surrogate pair would leave half a character.
  if (cut && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  let lines = text.split(/\r\n|\r|\n/);
  if (lines.length > SOURCE_LIMITS.lines) {
    lines = lines.slice(0, SOURCE_LIMITS.lines);
    cut = true;
  }
  if (
    /^[ \t]+$/.test(indentation) &&
    lines.every((row, index) => !index || !row.trim() || row.startsWith(indentation))
  ) {
    lines = lines.map((row, index) => (index ? row.slice(indentation.length) : row));
  }
  text = lines.join("\n").trimEnd();
  if (!text) return undefined;
  return { text, fileName: sourceFile.fileName, line, character, ...(cut ? { cut: true } : {}) };
}
