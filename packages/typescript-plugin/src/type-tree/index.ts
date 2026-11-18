import type * as ts from "typescript";
import type { Language } from "@volar/language-core";
import type { TypeFunctionSignature, TypeInfo, TypeProperty, TypeSource, TypeTree } from "./types";
import type { PrettifyOptions } from "../request";
import { FULL_COPY_LIMITS, PREVIEW_LIMITS, normalizeOptions } from "../options";
import { getDescendantAtRange } from "./get-ast-node";
import { getPositionForVue } from "./vue";
import { enumParent, resolvedAbstract, resolvedReadonly, resolvedSetterType } from "./compiler-internals";
import { getAuthoredSource } from "./source";

export type AnalysisControl = {
  isCancellationRequested?: () => boolean;
  onError?: (error: unknown) => void;
  compilerOptions?: ts.CompilerOptions;
};

/** Analysis state belongs to one request, including all safety budgets. */
export function getTypeInfoAtPosition(
  typescript: typeof ts,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  position: number,
  prettifyOptions: PrettifyOptions,
  vueLanguage?: Language,
  control: AnalysisControl = {},
): TypeInfo | undefined {
  const options = normalizeOptions(prettifyOptions);
  const limits = options.fullExpansion ? FULL_COPY_LIMITS : PREVIEW_LIMITS;
  const deadline = Date.now() + limits.milliseconds;
  const reasons = new Set<string>();
  let nodes = 0;
  let textCharacters = 0;
  let inaccessibleNames = 0;
  const namedReferences = new Map<ts.Type, { symbol: ts.Symbol; name?: string }>();
  const exactOptional = control.compilerOptions?.exactOptionalPropertyTypes === true;
  // The hovered type always expands: naming rules below only shorten what is nested inside it.
  let rootType: ts.Type | undefined;
  let copiedVariable: { declaration: ts.VariableDeclaration; className?: string } | undefined;
  let hoverNode: ts.Node = sourceFile;
  let printScope: ts.Node = sourceFile;
  // Approximate serialized bytes per visited node, so traversal stops with a partial tree
  // before the response-size check below has to discard the whole result.
  const serializedNodeEstimate = 80;
  const responseBudget = limits.characters * 0.9;

  function checkBudget(visited: Set<ts.Type>): boolean {
    if (!canPreprocess()) return false;
    if (
      ++nodes > limits.nodes ||
      visited.size >= limits.depth ||
      textCharacters + nodes * serializedNodeEstimate >= responseBudget
    ) {
      reasons.add("analysis budget");
      return false;
    }
    return true;
  }

  /** Extraction of existing cancellation/time checks from checkBudget, also bounding new union preprocessing. */
  function canPreprocess(): boolean {
    if (control.isCancellationRequested?.()) {
      reasons.add("cancelled");
      return false;
    }
    if (Date.now() > deadline) {
      reasons.add("analysis budget");
      return false;
    }
    return true;
  }

  /**
   * Depth-first expansion lets an early, deep member use up the safety budget and starve its siblings.
   * When the budget runs out, retry with increasing object depth and keep the deepest attempt that fits,
   * so shallow members always appear before deeper levels are cut. Expansions that fit are returned as is.
   */
  function expandFairly<T>(build: () => T): T {
    const snapshot = () => ({ nodes, textCharacters, inaccessibleNames, reasons: [...reasons] });
    const start = snapshot();
    const exhausted = () => reasons.has("analysis budget") || reasons.has("cancelled");
    const restore = (state: typeof start) => {
      nodes = state.nodes;
      textCharacters = state.textCharacters;
      inaccessibleNames = state.inaccessibleNames;
      reasons.clear();
      for (const reason of state.reasons) reasons.add(reason);
    };
    const first = build();
    if (!exhausted() || reasons.has("cancelled")) return first;
    const firstState = snapshot();
    const requestedDepth = options.maxDepth;
    let best: { tree: T; state: typeof firstState } | undefined;
    try {
      for (let depth = 0; depth < requestedDepth; depth++) {
        restore(start);
        options.maxDepth = depth;
        const tree = build();
        if (exhausted()) break;
        best = { tree, state: snapshot() };
        best.state.reasons.push("analysis budget");
      }
    } finally {
      options.maxDepth = requestedDepth;
    }
    if (!best) {
      restore(firstState);
      return first;
    }
    restore(best.state);
    return best.tree;
  }

  /** TypeScript caches printed structures on the enclosing node. Share a scope across ordinary
   * expressions and variable statements, stopping before any syntax that can introduce bindings.
   * Name lookups still use the exact cursor, including inside conditional types and signatures.
   */
  function sharedPrintScope(node: ts.Node): ts.Node {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (typescript.isSourceFile(parent) || typescript.isBlock(parent) || typescript.isModuleBlock(parent))
        return parent;
      if (
        !typescript.isPropertyAccessExpression(parent) &&
        !typescript.isElementAccessExpression(parent) &&
        !typescript.isCallExpression(parent) &&
        !typescript.isExpressionStatement(parent) &&
        !typescript.isTypeReferenceNode(parent) &&
        !typescript.isQualifiedName(parent) &&
        !typescript.isVariableDeclaration(parent) &&
        !typescript.isVariableDeclarationList(parent) &&
        !typescript.isVariableStatement(parent)
      )
        break;
      current = parent;
    }
    return current;
  }

  function boundedText(text: string): string {
    if (textCharacters + text.length > limits.characters) {
      reasons.add("type text budget");
      return "unknown /* type text limit */";
    }
    textCharacters += text.length;
    return text;
  }

  /**
   * Previews keep the compiler's ordinary truncation (`Foo<...>`), which protects structural reference fallbacks.
   * Copies must paste as valid TypeScript, so they ask for the full text; the text budget still bounds it.
   */
  function typeText(type: ts.Type, flags = typescript.TypeFormatFlags.None, enclosingScope?: ts.Node): string {
    // A deferred expression can contain names from another namespace (Row[T], string & Brand).
    // Literal and intrinsic types do not need a lexical cache entry to print their spelling.
    const scoped =
      !isPrimitiveType(type) ||
      !!(type.flags & (typescript.TypeFlags.TemplateLiteral | typescript.TypeFlags.StringMapping));
    enclosingScope ??= options.copy && scoped ? printScope : undefined;
    const format = options.copy ? flags | typescript.TypeFormatFlags.NoTruncation : flags;
    const text = checker.typeToString(type, enclosingScope, format);
    if (!options.copy || !text.includes("Infinity")) return text;
    const node = checker.typeToTypeNode(type, enclosingScope, format & typescript.TypeFormatFlags.NodeBuilderFlagsMask);
    return node ? printTypeNode(node, text) : text;
  }

  function printTypeNode(node: ts.TypeNode, originalText?: string): string {
    // The checker prints 1e999 as Infinity, a value name rather than a numeric type literal.
    // Replace only numeric literal nodes; a type alias, property or quoted string named Infinity stays intact.
    let changed = false;
    const printer = typescript.createPrinter(
      { removeComments: true },
      {
        substituteNode(_hint, child) {
          if (options.copy && typescript.isNumericLiteral(child) && child.text === "Infinity") {
            changed = true;
            return typescript.factory.createNumericLiteral("1e999");
          }
          return child;
        },
      },
    );
    const printed = printer.printNode(typescript.EmitHint.Unspecified, node, sourceFile);
    return changed || originalText === undefined ? printed : originalText;
  }

  // Previews mark only the elisions they have always reported; copies also report `Foo<...>` and `[...]`.
  const compilerElision = options.copy ? /\.\.\. \d+ more|\.\.\.$|<\.\.\.>|\[\.\.\.\]/ : /\.\.\. \d+ more|\.\.\.$/;

  function reference(type: ts.Type, expandAlias = false, enclosingScope?: ts.Node): TypeTree {
    const flags =
      (expandAlias ? typescript.TypeFormatFlags.InTypeAlias : typescript.TypeFormatFlags.None) |
      (enclosingScope ? typescript.TypeFormatFlags.UseFullyQualifiedType : typescript.TypeFormatFlags.None);
    const text = typeText(type, flags, enclosingScope);
    if (compilerElision.test(text)) reasons.add("compiler text limit");
    return { kind: "reference", typeName: boundedText(text) };
  }

  /** A private enum or unique symbol may have no standalone name at the hovered location.
   * A containing property can still name exactly that type as PublicShape["key"] when unwinding.
   */
  function inaccessibleReference(kind: "class" | "enum" | "unique symbol"): TypeTree {
    if (!options.copy) return { kind: "reference", typeName: kind };
    inaccessibleNames++;
    return { kind: "reference", typeName: `unknown /* inaccessible ${kind} */` };
  }

  function canonicalSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    return (
      symbol &&
      (symbol.flags & typescript.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : checker.getExportSymbolOfSymbol(symbol))
    );
  }

  function resolveTypeName(name: ts.EntityName, meaning: ts.SymbolFlags): ts.Symbol | undefined {
    if (typescript.isIdentifier(name))
      return canonicalSymbol(checker.resolveName(name.text, hoverNode, meaning, false));
    return canonicalSymbol(
      resolveTypeName(name.left, typescript.SymbolFlags.Namespace)?.exports?.get(name.right.escapedText),
    );
  }

  /** The printer can emit a bare private name even when it is unbound or denotes a different symbol here.
   * Verify a printed entity name against its intended symbol before using it as a copyable reference.
   */
  function reachableName(type: ts.Type, symbol: ts.Symbol): string | undefined {
    if (namedReferences.get(type)?.symbol !== symbol) {
      const node = checker.typeToTypeNode(
        type,
        printScope,
        typescript.NodeBuilderFlags.UseFullyQualifiedType | typescript.NodeBuilderFlags.NoTruncation,
      );
      const reachable =
        node &&
        (typescript.isImportTypeNode(node) ||
          (typescript.isTypeReferenceNode(node) &&
            resolveTypeName(node.typeName, typescript.SymbolFlags.Type) === symbol));
      namedReferences.set(type, {
        symbol,
        name: reachable ? typeText(type, typescript.TypeFormatFlags.UseFullyQualifiedType, printScope) : undefined,
      });
    }
    return namedReferences.get(type)?.name;
  }

  /** A public generic can contain a private argument (`PublicBox<Hidden>`). Only project through
   * instantiations whose arguments have no names to capture. Otherwise let their public owner supply the path.
   */
  function propertyOwnerName(type: ts.Type): string | undefined {
    const owner = type.aliasSymbol ?? type.getSymbol();
    const named = typescript.SymbolFlags.TypeAlias | typescript.SymbolFlags.Class | typescript.SymbolFlags.Interface;
    if (!owner || !(owner.flags & named) || owner === canonicalSymbol(checker.getSymbolAtLocation(hoverNode))) return;
    const typeArguments =
      type.aliasTypeArguments ??
      ((type as ts.TypeReference).target ? checker.getTypeArguments(type as ts.TypeReference) : []);
    if (
      typeArguments.some(
        (argument) =>
          !canPreprocess() ||
          !isPrimitiveType(argument) ||
          !!(argument.flags & (typescript.TypeFlags.UniqueESSymbol | typescript.TypeFlags.TemplateLiteral)),
      )
    )
      return;
    return reachableName(type, owner);
  }

  /** Source references inside the very declaration being copied can spell otherwise unnameable identities. */
  function originalTypeReference(annotation: ts.TypeNode | undefined, type: ts.Type): string | undefined {
    const declaration = hoverNode.parent;
    const writtenType =
      typescript.isTypeAliasDeclaration(declaration) || typescript.isVariableDeclaration(declaration)
        ? declaration.type
        : typescript.isInterfaceDeclaration(declaration)
          ? declaration
          : undefined;
    if (
      !annotation ||
      !(
        typescript.isTypeReferenceNode(annotation) ||
        typescript.isIndexedAccessTypeNode(annotation) ||
        typescript.isTypeQueryNode(annotation)
      ) ||
      !writtenType ||
      !typescript.findAncestor(annotation, (node) => node === writtenType)
    )
      return undefined;
    return checker.getTypeFromTypeNode(annotation) === type ? annotation.getText() : undefined;
  }

  /**
   * Render the immediate constraint as declared (`K extends keyof T`, `T extends U`).
   * The base constraint would resolve these to their apparent types and change the signature.
   */
  function typeParameterConstraint(parameter: ts.TypeParameter): TypeTree | undefined {
    const node = checker.typeParameterToDeclaration(
      parameter,
      options.copy ? printScope : undefined,
      typescript.NodeBuilderFlags.IgnoreErrors |
        (options.copy
          ? typescript.NodeBuilderFlags.UseFullyQualifiedType
          : typescript.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) |
        (options.copy ? typescript.NodeBuilderFlags.NoTruncation : typescript.NodeBuilderFlags.None),
    );
    if (!node) {
      const base = checker.getBaseConstraintOfType(parameter);
      return base && reference(base);
    }
    if (!node.constraint) return undefined;
    const text = printTypeNode(node.constraint);
    if (compilerElision.test(text)) reasons.add("compiler text limit");
    return { kind: "reference", typeName: boundedText(text) };
  }

  /**
   * Members shown after `?:`. Without exactOptionalPropertyTypes, `a?: T | undefined` means `a?: T`, so undefined is
   * dropped as in earlier releases; with it, only the implicit "missing" member is dropped.
   */
  function optionalMembers(type: ts.Type): ts.Type[] | undefined {
    if (!type.isUnion()) return undefined;
    return type.types.filter((member) => {
      if (!(member.flags & typescript.TypeFlags.Undefined)) return true;
      return exactOptional && (member as ts.Type & { debugIntrinsicName?: string }).debugIntrinsicName !== "missing";
    });
  }

  /** `omittedProperties` hides members already shown elsewhere, as by Factor Shared Union Properties. */
  function getTypeTree(
    type: ts.Type,
    depth: number,
    visited: Set<ts.Type>,
    annotation?: ts.Node,
    optional = false,
    omittedProperties?: ReadonlySet<string>,
  ): TypeTree {
    if (!checkBudget(visited)) return { kind: "reference", typeName: "unknown /* expansion limit */" };
    const skippedName = getSkippedTypeName(type, annotation, optional);
    if (skippedName) return { kind: "reference", typeName: boundedText(skippedName) };
    if (visited.has(type)) {
      const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
      if (name && !name.startsWith("__")) return reference(type, false, options.copy ? printScope : undefined);
      reasons.add("circular reference");
      return { kind: "reference", typeName: "unknown /* circular */" };
    }
    if (type.flags & typescript.TypeFlags.TypeParameter) return reference(type);
    if (type.flags & typescript.TypeFlags.UniqueESSymbol) {
      const declaration = type.getSymbol()?.valueDeclaration;
      // A new unique symbol can only be declared on its defining const or readonly field.
      // Other occurrences must refer back to that same symbol (`typeof Symbol.iterator`, for example).
      if (
        declaration &&
        ((typescript.isVariableDeclaration(declaration) && declaration.name === hoverNode) ||
          (type !== rootType &&
            annotation &&
            typescript.isTypeOperatorNode(annotation) &&
            annotation.operator === typescript.SyntaxKind.UniqueKeyword &&
            annotation.parent === declaration &&
            typescript.findAncestor(declaration, (ancestor) => ancestor === hoverNode.parent)))
      )
        return { kind: "primitive", typeName: "unique symbol" };
      const text = typeText(type, typescript.TypeFormatFlags.None, printScope);
      return text === "unique symbol"
        ? inaccessibleReference("unique symbol")
        : { kind: "reference", typeName: boundedText(text) };
    }
    if (
      type.flags &
      (typescript.TypeFlags.Conditional | typescript.TypeFlags.Index | typescript.TypeFlags.IndexedAccess)
    )
      return reference(type, true);
    const next = new Set(visited).add(type);
    const apparent = checker.getApparentType(type);
    if (type.isIntersection() && type.types.some(isPrimitiveType)) return reference(type, true);
    if (isPrimitiveType(type)) {
      return {
        kind: "primitive",
        typeName: boundedText(
          type.flags & typescript.TypeFlags.StringLiteral
            ? JSON.stringify((type as ts.StringLiteralType).value)
            : typeText(type, typescript.TypeFormatFlags.NoTruncation),
        ),
      };
    }

    const aliasName = type.aliasSymbol?.getName();
    const target = (type as ts.TypeReference).target;
    const aliasArgs = type.aliasSymbol && type.aliasTypeArguments?.length ? type.aliasTypeArguments : undefined;
    const wrapper = aliasArgs ? type.aliasSymbol : target?.getSymbol();
    const genericName = wrapper?.getName();
    const args = aliasArgs ?? (target ? checker.getTypeArguments(type as ts.TypeReference) : []);
    const name = aliasName ?? type.getSymbol()?.getName();
    // Arrays and tuples are expanded before skipped names apply, so "Array" in the list only affects
    // explicit `Array<T>` annotations (handled by getSkippedTypeName above).
    const arrayLike = checker.isArrayType(apparent) || checker.isTupleType(apparent);
    if (
      !arrayLike &&
      ((name && options.skippedTypeNames.includes(name)) ||
        (genericName && options.skippedTypeNames.includes(genericName)))
    ) {
      // Skipped types are not expanded; copies keep their arguments (`Map<string, number>`) to stay valid.
      const skipped = options.copy
        ? typeText(type, typescript.TypeFormatFlags.UseFullyQualifiedType, printScope)
        : (genericName ?? name)! + (args.length ? "<...>" : "");
      return { kind: "reference", typeName: boundedText(skipped) };
    }
    if (
      options.unwrapPromises === false &&
      args.length &&
      (genericName === "Promise" || target?.getSymbol()?.getName() === "Promise")
    ) {
      let hovered = type === rootType ? checker.getSymbolAtLocation(hoverNode) : undefined;
      if (hovered && hovered.flags & typescript.SymbolFlags.Alias) hovered = checker.getAliasedSymbol(hovered);
      // A variable can keep its visible alias. On the alias itself, print its definition to avoid `type A = A`.
      return reference(type, !!hovered && hovered === type.aliasSymbol, printScope);
    }
    if (genericName && args.length && options.unwrapGenericArgumentsTypeNames.includes(genericName)) {
      // An import alias or exported namespace member may have a different spelling at the hover site.
      let visibleName = genericName;
      if (wrapper && checker.resolveName(genericName, hoverNode, typescript.SymbolFlags.Type, false) !== wrapper) {
        const expand = !!aliasName && !aliasArgs;
        const node = checker.typeToTypeNode(
          type,
          printScope,
          typescript.NodeBuilderFlags.UseFullyQualifiedType | (expand ? typescript.NodeBuilderFlags.InTypeAlias : 0),
        );
        if (!node || !typescript.isTypeReferenceNode(node) || !node.typeArguments?.length)
          return reference(type, expand, printScope);
        visibleName = typescript.createPrinter().printNode(typescript.EmitHint.Unspecified, node.typeName, sourceFile);
      }
      return {
        kind: "generic",
        typeName: boundedText(visibleName),
        arguments: args.map((arg) => getTypeTree(arg, depth, next)),
      };
    }

    if (apparent.isUnion()) {
      const members = optional ? (optionalMembers(apparent) ?? apparent.types) : apparent.types;
      if (members.length === 1) return getTypeTree(members[0]!, depth, visited);
      const named = namedUnion(type, members, depth, next, annotation, optional);
      if (named) return named;
      // Boolean is represented by false | true in larger compiler unions.
      const { entries, wholeEnums } = groupWholeEnums(type, [...members].sort(sortUnionTypes));
      const factored = wholeEnums.size ? undefined : factorSharedProperties(entries, depth, next);
      if (factored) return factored;
      const types = entries
        .slice(0, options.maxUnionMembers)
        .map((entry) => (wholeEnums.has(entry) ? enumReference(entry) : getTypeTree(entry, depth, next)));
      if (entries.length > types.length) reasons.add("union member limit");
      return { kind: "union", typeName: "", types, excessMembers: Math.max(0, entries.length - types.length) };
    }
    if (type.flags & typescript.TypeFlags.EnumLike) return enumReference(type);

    if (checker.isTupleType(apparent)) {
      const tuple = apparent as ts.TupleTypeReference;
      const elements = checker.getTypeArguments(tuple).map((element, index) => {
        const flags = tuple.target.elementFlags[index] ?? typescript.ElementFlags.Required;
        const declaration = tuple.target.labeledElementDeclarations?.[index];
        const arrayRest = !!(flags & typescript.ElementFlags.Rest);
        const variadic = !!(flags & typescript.ElementFlags.Variadic);
        const annotation = arrayRest ? getArrayElementAnnotation(declaration?.type) : declaration?.type;
        let tree = variadic
          ? reference(element)
          : getTypeTree(element, depth, next, annotation, !!(flags & typescript.ElementFlags.Optional));
        if (arrayRest) tree = { kind: "array", typeName: "", readonly: false, elementType: tree };
        return {
          name: declaration && typescript.isIdentifier(declaration.name) ? declaration.name.text : undefined,
          optional: !!(flags & typescript.ElementFlags.Optional),
          rest: arrayRest || variadic,
          type: tree,
        };
      });
      return { kind: "tuple", typeName: "", readonly: tuple.target.readonly, elements };
    }
    if (checker.isArrayType(apparent)) {
      if (!options.unwrapArrays) return reference(type);
      const element = checker.getTypeArguments(apparent as ts.TypeReference)[0];
      return {
        kind: "array",
        typeName: "",
        readonly: apparent.getSymbol()?.getName() === "ReadonlyArray",
        elementType: element
          ? getTypeTree(element, depth, next, getArrayElementAnnotation(annotation))
          : { kind: "primitive", typeName: "any" },
      };
    }

    const calls = apparent.getCallSignatures();
    const constructs = apparent.getConstructSignatures();
    // An object construct signature cannot say `abstract new`. The compiler preserves the
    // constructor type (and any intersection with static properties) as one expression.
    if (constructs.some(isAbstractConstructor)) return reference(type, true, printScope);
    if (calls.length && !options.unwrapFunctions && (type.aliasSymbol || type.isClassOrInterface()))
      return reference(type);
    let members = apparent.getProperties();
    // Expanding a class as a type literal loses its private/protected identity, even when
    // private properties are visible. Keep class and interface declarations inspectable.
    const declaration = hoverNode.parent;
    const aliasDeclaration = typescript.isTypeAliasDeclaration(declaration) && declaration.name === hoverNode;
    const nominal = (visited.size > 0 || aliasDeclaration || !!copiedVariable) && preserveClassIdentity(type, members);
    if (nominal === undefined) return { kind: "reference", typeName: "unknown /* expansion limit */" };
    if (nominal && !visited.size && copiedVariable) {
      // Copy commands show the configured members of the variable itself. Its named class
      // also keeps the private/protected constraint that a plain list of fields cannot express.
      copiedVariable.className =
        originalTypeReference(copiedVariable.declaration.type, type) ?? propertyOwnerName(type);
      if (!copiedVariable.className) reasons.add("private class identity omitted");
    } else if (nominal) {
      if (type === rootType && aliasDeclaration)
        return { kind: "reference", typeName: boundedText(declaration.type.getText()) };
      const symbol = type.aliasSymbol ?? type.getSymbol();
      const name = symbol && reachableName(type, symbol);
      if (name) return { kind: "reference", typeName: boundedText(name) };
      if (type.isIntersection())
        return { kind: "intersection", typeName: "", types: type.types.map((part) => getTypeTree(part, depth, next)) };
      return inaccessibleReference("class");
    }
    const indexes = checker.getIndexInfosOfType(apparent);
    // Generic mapped types (e.g. Partial<T>) have no resolvable members; keep their declared form.
    if (
      type.flags & typescript.TypeFlags.Object &&
      (type as ts.ObjectType).objectFlags & typescript.ObjectFlags.Mapped &&
      !members.length &&
      !indexes.length &&
      !calls.length &&
      !constructs.length
    )
      return reference(type, true);
    if (options.hidePrivateProperties) members = members.filter(isPublicProperty);
    if (omittedProperties) members = members.filter((member) => !omittedProperties.has(member.getName()));
    const signatures = [
      ...calls.map((signature) => ({ signature, construct: false })),
      ...constructs.map((signature) => ({ signature, construct: true })),
    ];
    if (signatures.length && !members.length && !indexes.length) {
      const kept = signatures.slice(0, options.maxFunctionSignatures);
      const excessSignatures = signatures.length - kept.length;
      if (excessSignatures) reasons.add("function signature limit");
      const method = kept.every(({ signature, construct }) => {
        const declaration = signature.getDeclaration();
        return (
          !construct &&
          declaration &&
          (typescript.isMethodDeclaration(declaration) || typescript.isMethodSignature(declaration))
        );
      });
      return {
        kind: "function",
        typeName: "",
        excessSignatures,
        ...(method ? { method: true } : {}),
        signatures: kept.map(({ signature, construct }) => getSignature(signature, depth, next, construct)),
      };
    }

    if (apparent.flags & typescript.TypeFlags.Object || members.length || indexes.length || signatures.length) {
      if (depth >= options.maxDepth) {
        reasons.add("object depth limit");
        if (type.aliasSymbol || (type.getSymbol() && !type.getSymbol()!.getName().startsWith("__")))
          return reference(type, false, options.copy ? printScope : undefined);
        return { kind: "object", typeName: "", properties: [], excessProperties: members.length + indexes.length };
      }
      const limit = depth ? options.maxSubProperties : options.maxProperties;
      const properties: TypeProperty[] = [];
      const inaccessibleBeforeObject = inaccessibleNames;
      let local = 0;
      for (const index of indexes) {
        if (local >= limit || !checkBudget(next)) break;
        local++;
        const identifier = index.declaration?.parameters[0]?.name?.getText() ?? "key";
        properties.push({
          name: "[" + identifier + ": " + typeText(index.keyType) + "]",
          computed: true,
          readonly: index.isReadonly,
          optional: false,
          type: getTypeTree(index.type, depth + 1, next),
        });
      }
      // Hover previews list two or more proven `never` keys on one line; see groupNeverProperties.
      const neverProperties: TypeProperty[] = [];
      for (const symbol of members) {
        if (local >= limit || !checkBudget(next)) break;
        local++;
        const optional = !!(symbol.flags & typescript.SymbolFlags.Optional);
        const propertyType = checker.getTypeOfSymbol(symbol);
        const declaredNever = isDeclaredNever(type, symbol, propertyType);
        const annotation = getTypeAnnotation(symbol);
        const inaccessibleBeforeProperty = inaccessibleNames;
        const property: TypeProperty = {
          name: boundedText(isSymbolProperty(symbol) ? checker.symbolToString(symbol) : symbol.getName()),
          computed: isSymbolProperty(symbol),
          optional,
          readonly: isReadOnly(symbol),
          type: declaredNever
            ? { kind: "primitive", typeName: "never" }
            : getTypeTree(propertyType, depth + 1, next, annotation, optional),
        };
        if (!visited.size && copiedVariable?.className && !options.hidePrivateProperties)
          property.classVisibility = restrictedClassVisibility(symbol);
        if (inaccessibleNames > inaccessibleBeforeProperty) {
          let spelling = originalTypeReference(annotation, propertyType);
          if (!spelling) {
            const name = propertyOwnerName(type);
            if (name && (property.computed || (optional && exactOptional)) && !omittedProperties) {
              // Reading an optional indexed property includes undefined even when writing undefined is forbidden.
              inaccessibleNames = inaccessibleBeforeObject;
              return { kind: "reference", typeName: boundedText(name) };
            }
            if (name && !property.computed && !(optional && exactOptional))
              spelling = name + "[" + JSON.stringify(symbol.getName()) + "]";
          }
          if (spelling) {
            inaccessibleNames = inaccessibleBeforeProperty;
            property.type = { kind: "reference", typeName: boundedText(spelling) };
          }
        }
        if (symbol.flags & typescript.SymbolFlags.GetAccessor && symbol.flags & typescript.SymbolFlags.SetAccessor) {
          const write = resolvedSetterType(
            typescript,
            checker,
            symbol,
            printScope,
            typescript.NodeBuilderFlags.UseFullyQualifiedType |
              (options.copy ? typescript.NodeBuilderFlags.NoTruncation : 0),
          );
          if (write === undefined) reasons.add("setter type unavailable");
          else if (write) {
            const text = printTypeNode(write);
            if (compilerElision.test(text)) reasons.add("compiler text limit");
            if (text !== typeText(propertyType, typescript.TypeFormatFlags.None, printScope))
              property.writeType = boundedText(text);
          }
        }
        properties.push(property);
        if (declaredNever && !property.readonly && !property.computed) neverProperties.push(property);
      }
      const excessProperties = members.length + indexes.length - properties.length;
      if (excessProperties) reasons.add("property limit");
      const grouped = groupNeverProperties(neverProperties);
      const shown = grouped ? properties.filter((property) => !grouped.includes(property)) : properties;
      const kept = signatures.slice(0, options.maxFunctionSignatures);
      const excessSignatures = signatures.length - kept.length;
      if (excessSignatures) reasons.add("function signature limit");
      return {
        kind: "object",
        typeName: "",
        properties: shown,
        excessProperties,
        ...(grouped ? { neverProperties: grouped.map((property) => property.name) } : {}),
        ...(signatures.length
          ? {
              signatures: kept.map(({ signature, construct }) => getSignature(signature, depth, next, construct)),
              excessSignatures,
            }
          : {}),
      };
    }
    return reference(type);
  }

  function isAbstractConstructor(signature: ts.Signature): boolean {
    const abstract = resolvedAbstract(typescript, signature);
    if (abstract !== undefined) return abstract;
    const declaration = signature.getDeclaration();
    if (declaration && typescript.isConstructSignatureDeclaration(declaration)) return false;
    // A class can inherit an abstract construct signature with no source declaration.
    const node =
      declaration && typescript.isConstructorTypeNode(declaration)
        ? declaration
        : checker.signatureToSignatureDeclaration(
            signature,
            typescript.SyntaxKind.ConstructorType,
            printScope,
            undefined,
          );
    return (
      !!node &&
      typescript.isConstructorTypeNode(node) &&
      !!node.modifiers?.some((modifier) => modifier.kind === typescript.SyntaxKind.AbstractKeyword)
    );
  }

  function getSignature(
    signature: ts.Signature,
    depth: number,
    visited: Set<ts.Type>,
    construct = false,
  ): TypeFunctionSignature {
    const signatureType = (type: ts.Type, annotation?: ts.Node, optional = false): TypeTree =>
      options.unwrapFunctions || !!(type.flags & typescript.TypeFlags.UniqueESSymbol)
        ? getTypeTree(type, depth, visited, annotation, optional)
        : {
            kind: "reference",
            typeName: boundedText(getSkippedTypeName(type, annotation, optional) ?? typeText(type)),
          };
    const symbols = signature.thisParameter ? [signature.thisParameter, ...signature.parameters] : signature.parameters;
    const parameters = symbols.map((symbol) => {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      const param = declaration && typescript.isParameter(declaration) ? declaration : undefined;
      const optional = !!param && checker.isOptionalParameter(param);
      const type = checker.getTypeOfSymbol(symbol);
      let tree = signatureType(type, getTypeAnnotation(symbol), optional);
      if (
        param?.initializer &&
        !optional &&
        !(type.flags & typescript.TypeFlags.Undefined) &&
        !(type.isUnion() && type.types.some((member) => member.flags & typescript.TypeFlags.Undefined))
      ) {
        tree = {
          kind: "union",
          typeName: "",
          excessMembers: 0,
          types: [tree, { kind: "primitive", typeName: "undefined" }],
        };
      }
      return {
        name: boundedText(
          symbol === signature.thisParameter
            ? "this"
            : param && !typescript.isIdentifier(param.name)
              ? bindingPatternText(param.name)
              : symbol.getName(),
        ),
        optional,
        isRestParameter: !!param?.dotDotDotToken,
        type: tree,
      };
    });
    const typeParameters = signature.typeParameters?.map((parameter) => {
      const defaultType = checker.getDefaultFromTypeParameter(parameter);
      const declaration = parameter.symbol.declarations?.find(typescript.isTypeParameterDeclaration);
      const modifiers = declaration?.modifiers?.map((modifier) => typescript.tokenToString(modifier.kind) ?? "");
      const constraint = typeParameterConstraint(parameter);
      return {
        ...(modifiers?.length ? { modifiers } : {}),
        name: boundedText(parameter.symbol.getName()),
        ...(constraint ? { constraint } : {}),
        ...(defaultType ? { default: signatureType(defaultType) } : {}),
      };
    });
    const predicate = checker.getTypePredicateOfSignature(signature);
    const asserts =
      predicate &&
      (predicate.kind === typescript.TypePredicateKind.AssertsIdentifier ||
        predicate.kind === typescript.TypePredicateKind.AssertsThis);
    const returnType = checker.getReturnTypeOfSignature(signature);
    return {
      parameters,
      ...(typeParameters?.length ? { typeParameters } : {}),
      ...(construct ? { construct: true } : {}),
      ...(predicate
        ? {
            predicate: {
              parameter: "parameterName" in predicate ? (predicate.parameterName ?? "this") : "this",
              asserts: !!asserts,
              ...(predicate.type ? { type: signatureType(predicate.type) } : {}),
            },
          }
        : {}),
      returnType: construct ? reference(returnType) : signatureType(returnType, signature.getDeclaration()?.type),
    };
  }

  /**
   * A named union (`AssetSource`, `ExactlyOneOf<[A, B]>`, `AimvsErrorCode`) is shown by name where expanding it would
   * be incomplete anyway: more members than Max Union Members (`... 80 more`), or unnamed object members already at
   * Max Depth, which would only show as `{ ... 3 more }`. A complete expansion, such as a short literal union, stays
   * expanded, and the hovered type itself always expands. This mirrors named objects becoming references at Max Depth.
   *
   * Optional properties lose the alias (`AssetSource | undefined` has no alias), so the declared annotation is tried
   * too. Its name is only used when its members are the very same type objects present here, which proves the name
   * describes this union rather than an uninstantiated generic or a transformed subset. The output is the name plus
   * any extra members, so it is never narrower; it must not be wider either. The one tolerated gap is the alias's
   * `undefined` on an optional property without exactOptionalPropertyTypes, where `?` already means `| undefined`.
   * Homomorphic mappings keep the source annotation while removing members (`Required<{ x?: Maybe }>`), so a
   * required property must contain every member of the alias, `undefined` included.
   */
  function namedUnion(
    type: ts.Type,
    members: readonly ts.Type[],
    depth: number,
    visited: Set<ts.Type>,
    annotation: ts.Node | undefined,
    optional: boolean,
  ): TypeTree | undefined {
    if (type === rootType || !canPreprocess()) return undefined;
    const declared =
      type.aliasSymbol || !annotation || !typescript.isTypeNode(annotation)
        ? type
        : checker.getTypeFromTypeNode(annotation);
    if (!declared.aliasSymbol || declared.aliasSymbol.flags & typescript.SymbolFlags.Enum || !declared.isUnion())
      return undefined;
    const present = new Set(members);
    const impliedUndefined = optional && !exactOptional;
    if (
      !declared.types.every(
        (member) =>
          canPreprocess() &&
          (present.has(member) || (impliedUndefined && member.flags & typescript.TypeFlags.Undefined)),
      )
    )
      return undefined;
    const incomplete =
      declared.types.length > options.maxUnionMembers ||
      (depth >= options.maxDepth && declared.types.some(isElidedAtMaxDepth));
    if (!incomplete) return undefined;
    // A scoped alias such as A.Choice cannot become bare Choice outside its namespace/function.
    // The public printer qualifies accessible symbols and expands private aliases that cannot be named here.
    // Top-level module aliases keep the existing short display instead of acquiring long import paths.
    const scoped = declared.aliasSymbol.declarations?.some(
      (declaration) =>
        typescript.isTypeAliasDeclaration(declaration) &&
        declaration.parent &&
        !typescript.isSourceFile(declaration.parent),
    );
    const name = reference(declared, false, scoped ? sourceFile : undefined);
    const rest = members.filter((member) => !declared.types.includes(member));
    if (!rest.length) return name;
    const others = [...rest].sort(sortUnionTypes).map((member) => getTypeTree(member, depth, visited));
    return { kind: "union", typeName: "", excessMembers: 0, types: [name, ...others] };
  }

  /** Unnamed object members render as `{ ... N more }` at Max Depth; named ones, arrays and functions stay readable. */
  function isElidedAtMaxDepth(member: ts.Type): boolean {
    if (!(member.flags & (typescript.TypeFlags.Object | typescript.TypeFlags.Intersection))) return false;
    if (member.isIntersection() && member.types.some(isPrimitiveType)) return false;
    if (member.aliasSymbol || (member.getSymbol() && !member.getSymbol()!.getName().startsWith("__"))) return false;
    const apparent = checker.getApparentType(member);
    if (checker.isArrayType(apparent) || checker.isTupleType(apparent)) return false;
    return apparent.getProperties().length > 0 || checker.getIndexInfosOfType(apparent).length > 0;
  }

  /** The declared member type keeps `Only.Value` even when the whole enum and its sole member share one type.
   * The compiler chooses an in-scope name and emits valid indexed access for members such as `"on-air"`.
   * Hovers keep unimported dependency names short. Copies can use an import type to preserve the actual symbol.
   */
  function enumReference(type: ts.Type): TypeTree {
    const member = type.symbol?.flags & typescript.SymbolFlags.EnumMember ? type.symbol : undefined;
    const owner = member ? enumParent(member) : type.getSymbol();
    if (options.copy && owner && !reachableName(checker.getDeclaredTypeOfSymbol(owner), owner))
      return inaccessibleReference("enum");
    const flags = options.copy
      ? typescript.TypeFormatFlags.None
      : typescript.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
    const name = boundedText(typeText(member ? checker.getDeclaredTypeOfSymbol(member) : type, flags, printScope));
    return member ? { kind: "enum", typeName: "", member: name } : { kind: "reference", typeName: name };
  }

  /**
   * Whole enums in a union are shown by name (`ImageGenerationModel`) instead of listing every member: enums are
   * nominal and their own hover lists the members. Identity is checked against the enum's declared type, so a subset
   * such as `Exclude<Color, Color.Blue>` stays listed member by member. Full copies keep listing members, as before.
   * The hovered type keeps its members when naming would reduce it to one name (`Color`, `Color | undefined`).
   * Returns the union entries in display order; `wholeEnums` marks the entries that are enum names.
   */
  function groupWholeEnums(type: ts.Type, sorted: ts.Type[]): { entries: ts.Type[]; wholeEnums: Set<ts.Type> } {
    const wholeEnums = new Set<ts.Type>();
    if (options.fullExpansion) return { entries: sorted, wholeEnums };
    const present = new Set(sorted);
    const enumOfMember = new Map<ts.Type, ts.Type>();
    const checkedEnums = new Set<ts.Symbol>();
    for (const member of sorted) {
      if (!canPreprocess()) return { entries: sorted, wholeEnums: new Set() };
      if (!(member.flags & typescript.TypeFlags.EnumLike) || enumOfMember.has(member)) continue;
      const parent = member.symbol && enumParent(member.symbol);
      if (!parent || !(parent.flags & typescript.SymbolFlags.Enum) || checkedEnums.has(parent)) continue;
      checkedEnums.add(parent);
      const declared = checker.getDeclaredTypeOfSymbol(parent);
      const declaredMembers = declared.isUnion() ? declared.types : [declared];
      // A one-member enum is clearer as its member (`Only.Value`) than as the enum name.
      if (declaredMembers.length < 2 || !declaredMembers.every((enumMember) => present.has(enumMember))) continue;
      for (const enumMember of declaredMembers) enumOfMember.set(enumMember, declared);
    }
    const entries: ts.Type[] = [];
    for (const member of sorted) {
      const declared = enumOfMember.get(member);
      if (!declared) entries.push(member);
      else if (!wholeEnums.has(declared)) {
        wholeEnums.add(declared);
        entries.push(declared);
      }
    }
    const nullish = typescript.TypeFlags.Undefined | typescript.TypeFlags.Null;
    if (type === rootType && entries.filter((entry) => !(entry.flags & nullish)).length <= 1)
      return { entries: sorted, wholeEnums: new Set() };
    return { entries, wholeEnums };
  }

  /**
   * Factor Shared Union Properties (opt-in): properties identical in every member are shown once, as
   * `{ shared } & ({ a } | { b })`, which is equivalent TypeScript (`S & (A | B)` is `(S & A) | (S & B)`).
   * A property is shared only when every member has it with the same type object, optionality, readonliness and
   * proven-`never` status, so discriminants, which differ by definition, always stay in each member. Unions that are
   * truncated, at Max Depth, or contain anything but plain object members (arrays, functions, index signatures,
   * skipped or branded types) keep the one-object-per-member form, as do unions with fewer than two shared properties.
   * Members that reduce to `never` (intersections with conflicting discriminants, as in AIMVS Asset) still render as
   * `never` but are left out of the comparison: `S & (A | never)` is `S & A`, so they cannot make a property unshared.
   */
  function factorSharedProperties(entries: ts.Type[], depth: number, visited: Set<ts.Type>): TypeTree | undefined {
    if (
      !options.factorSharedUnionProperties ||
      entries.length < 2 ||
      entries.length > options.maxUnionMembers ||
      depth >= options.maxDepth
    )
      return undefined;
    if (!canPreprocess()) return undefined;
    const objects = entries.filter((entry) => !isReducedToNever(entry));
    if (objects.length < 2 || !objects.every((entry) => isPlainObjectMember(entry, visited))) return undefined;
    const branches = objects.map((entry) => {
      const apparent = checker.getApparentType(entry);
      const properties = options.hidePrivateProperties
        ? apparent.getProperties().filter(isPublicProperty)
        : apparent.getProperties();
      return { type: entry, properties: new Map(properties.map((symbol) => [symbol.getName(), symbol])) };
    });
    const [first, ...others] = branches;
    const shared = new Set<string>();
    for (const [name, symbol] of first!.properties) {
      if (!canPreprocess()) return undefined;
      const facts = propertyFacts(first!.type, symbol);
      const sameEverywhere = others.every((branch) => {
        if (!canPreprocess()) return false;
        const other = branch.properties.get(name);
        if (!other) return false;
        const otherFacts = propertyFacts(branch.type, other);
        return (Object.keys(facts) as (keyof typeof facts)[]).every((key) => facts[key] === otherFacts[key]);
      });
      if (sameEverywhere) shared.add(name);
    }
    if (shared.size < 2) return undefined;
    const unshared = new Set([...first!.properties.keys()].filter((name) => !shared.has(name)));
    return {
      kind: "intersection",
      typeName: "",
      types: [
        getTypeTree(first!.type, depth, visited, undefined, false, unshared),
        {
          kind: "union",
          typeName: "",
          excessMembers: 0,
          types: entries.map((entry) => getTypeTree(entry, depth, visited, undefined, false, shared)),
        },
      ],
    };
  }

  /**
   * An intersection whose properties conflict reduces to `never` but stays a separate union member. Uses the public
   * isTypeAssignableTo (TypeScript 5.4+); older compilers report nothing here, so such unions are just not factored.
   */
  function isReducedToNever(member: ts.Type): boolean {
    return (
      member.isIntersection() &&
      !checker.getApparentType(member).getProperties().length &&
      checker.isTypeAssignableTo?.(member, checker.getNeverType()) === true
    );
  }

  /** Everything that must match for a property to be shown once for every union member. */
  function propertyFacts(container: ts.Type, symbol: ts.Symbol) {
    const type = checker.getTypeOfSymbol(symbol);
    return {
      type,
      // An identical get type does not prove two different setters accept the same writes.
      setter: symbol.flags & typescript.SymbolFlags.SetAccessor ? symbol : undefined,
      optional: !!(symbol.flags & typescript.SymbolFlags.Optional),
      readonly: isReadOnly(symbol),
      never: isDeclaredNever(container, symbol, type),
    };
  }

  /** An object member that expands to a plain `{ ... }`, so `{ shared } & ({ a } | { b })` keeps its meaning. */
  function isPlainObjectMember(member: ts.Type, visited: Set<ts.Type>): boolean {
    if (!(member.flags & (typescript.TypeFlags.Object | typescript.TypeFlags.Intersection))) return false;
    if (visited.has(member) || (member.isIntersection() && member.types.some(isPrimitiveType))) return false;
    const names = [
      member.aliasSymbol?.getName(),
      member.getSymbol()?.getName(),
      (member as ts.TypeReference).target?.getSymbol()?.getName(),
    ];
    if (
      names.some(
        (name) =>
          name && (options.skippedTypeNames.includes(name) || options.unwrapGenericArgumentsTypeNames.includes(name)),
      )
    )
      return false;
    const apparent = checker.getApparentType(member);
    return (
      !checker.isArrayType(apparent) &&
      !checker.isTupleType(apparent) &&
      !apparent.getCallSignatures().length &&
      !apparent.getConstructSignatures().length &&
      !checker.getIndexInfosOfType(apparent).length &&
      apparent.getProperties().length > 0 &&
      preserveClassIdentity(member, apparent.getProperties()) === false
    );
  }

  /**
   * An optional property whose only allowed state is "absent". The compiler reports `a?: never` as `a?: undefined`,
   * which hides the author's intent and is wrong under exactOptionalPropertyTypes (explicit `undefined` is rejected).
   * - With exactOptionalPropertyTypes, the type proves it: only the compiler's "missing" type remains, which is a
   *   different object from the `undefined` of an explicit `a?: undefined`.
   * - Without it, `a?: never` and `a?: undefined` both resolve to the same `undefined`, so the declaration must prove
   *   it: a mapped type with a literal `never` template that supplies the key (`{ [K in Keys]?: never }`, as in
   *   ExactlyOneOf and AllOrNone helpers), or a `never` annotation declared on this object or one of its bases.
   * Anything else, such as `Partial<{ a: never }>` (its template is `T[K]`), keeps the earlier `a?: undefined`.
   * Public compiler API only: the mapped type's own declaration node replaces the internal `symbol.links.mappedType`.
   */
  function isDeclaredNever(container: ts.Type, symbol: ts.Symbol, resolved: ts.Type): boolean {
    if (!(symbol.flags & typescript.SymbolFlags.Optional)) return false;
    if (!(resolved.flags & typescript.TypeFlags.Undefined) || resolved.isUnion()) return false;
    if (resolved !== checker.getUndefinedType()) return exactOptional;
    if (exactOptional) return false;
    const name = symbol.getName();
    const parts = container.isIntersection() ? container.types : [container];
    // An intersection key declared `never` by any part is `never` overall, which matches the resolved `undefined`.
    return parts.some((part) => !!part.getProperty(name) && (isNeverMappedType(part) || declaresNever(part, name)));
  }

  function isNeverMappedType(type: ts.Type): boolean {
    if (!(type.flags & typescript.TypeFlags.Object)) return false;
    if (!((type as ts.ObjectType).objectFlags & typescript.ObjectFlags.Mapped)) return false;
    const declaration = type.getSymbol()?.declarations?.[0];
    return (
      !!declaration &&
      typescript.isMappedTypeNode(declaration) &&
      declaration.type?.kind === typescript.SyntaxKind.NeverKeyword
    );
  }

  /**
   * `a?: never` written directly on this type literal, interface or class, or on one of its base interfaces/classes.
   * Homomorphic mapped types (`Readonly<T>`, `Pick<T, K>`) reuse the source declarations while changing the type,
   * so a declaration only counts when its parent is one of this type's own declarations.
   */
  function declaresNever(type: ts.Type, name: string): boolean {
    const declarations = type.getProperty(name)?.declarations;
    if (!declarations?.length) return false;
    const owners = new Set<ts.Node>();
    const pending = [type];
    const seen = new Set<ts.Type>();
    while (pending.length && seen.size < 64) {
      let current = pending.pop()!;
      if (
        current.flags & typescript.TypeFlags.Object &&
        (current as ts.ObjectType).objectFlags & typescript.ObjectFlags.Reference
      )
        current = (current as ts.TypeReference).target;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const declaration of current.getSymbol()?.declarations ?? []) owners.add(declaration);
      if (current.isClassOrInterface()) pending.push(...(checker.getBaseTypes(current) ?? []));
    }
    return declarations.every(
      (declaration) =>
        (typescript.isPropertySignature(declaration) || typescript.isPropertyDeclaration(declaration)) &&
        declaration.type?.kind === typescript.SyntaxKind.NeverKeyword &&
        owners.has(declaration.parent),
    );
  }

  /**
   * Hover previews show two or more proven-`never` keys as one `/* never: a, b *\/` line instead of a line each,
   * because ExactlyOneOf-style helpers can add many per member. Copies keep each `a?: never` property so pasted
   * output retains the constraint; a single key also stays a normal property, which is just as short.
   * Readonly and computed keys stay as properties because the comment cannot show their modifiers or syntax.
   * Only clients that declare `groupNeverProperties` get the grouped form; an older renderer would drop the keys.
   */
  function groupNeverProperties(candidates: TypeProperty[]): TypeProperty[] | undefined {
    if (!options.groupNeverProperties || candidates.length < 2) return undefined;
    if (candidates.some((property) => property.name.includes("*/"))) return undefined;
    return candidates;
  }

  /** Destructured parameters are named `__0` by the compiler; show the pattern instead, as TypeScript's hover does. */
  function bindingPatternText(pattern: ts.BindingName): string {
    if (typescript.isIdentifier(pattern)) return pattern.text;
    if (typescript.isObjectBindingPattern(pattern)) {
      if (!pattern.elements.length) return "{}";
      const elements = pattern.elements.map(
        (element) =>
          (element.dotDotDotToken ? "..." : "") +
          (element.propertyName ? element.propertyName.getText() + ": " : "") +
          bindingPatternText(element.name),
      );
      return "{ " + elements.join(", ") + " }";
    }
    const elements = pattern.elements.map((element) =>
      typescript.isOmittedExpression(element)
        ? ""
        : (element.dotDotDotToken ? "..." : "") + bindingPatternText(element.name),
    );
    return "[" + elements.join(", ") + "]";
  }

  function isReadOnly(symbol: ts.Symbol): boolean {
    // These compiler flags also cover mapped +/-readonly and synthesized intersection properties.
    const resolved = resolvedReadonly(typescript, symbol);
    if (resolved !== undefined) return resolved;
    if (symbol.flags & typescript.SymbolFlags.GetAccessor && !(symbol.flags & typescript.SymbolFlags.SetAccessor))
      return true;
    return (symbol.declarations ?? []).some(
      (declaration) =>
        typescript.canHaveModifiers(declaration) &&
        typescript
          .getModifiers(declaration)
          ?.some((modifier) => modifier.kind === typescript.SyntaxKind.ReadonlyKeyword),
    );
  }

  /** Retrieve annotations before the compiler erases primitive type aliases. */
  function getTypeAnnotation(symbol: ts.Symbol): ts.TypeNode | undefined {
    for (const declaration of symbol.declarations ?? []) {
      if (
        typescript.isVariableDeclaration(declaration) ||
        typescript.isPropertyDeclaration(declaration) ||
        typescript.isPropertySignature(declaration) ||
        typescript.isParameter(declaration)
      ) {
        if (declaration.type) return declaration.type;
      }
    }
    return undefined;
  }

  function getSkippedTypeName(type: ts.Type, annotation: ts.Node | undefined, optional: boolean): string | undefined {
    if (!annotation) return undefined;
    if (typescript.isParenthesizedTypeNode(annotation)) return getSkippedTypeName(type, annotation.type, optional);
    const nameNode = typescript.isTypeReferenceNode(annotation) ? annotation.typeName : annotation;
    if (!typescript.isIdentifier(nameNode) && !typescript.isQualifiedName(nameNode)) return undefined;
    const name = nameNode.getText();
    const binding = checker.getSymbolAtLocation(nameNode);
    const symbol =
      binding && binding.flags & typescript.SymbolFlags.Alias ? checker.getAliasedSymbol(binding) : binding;
    if (!options.skippedTypeNames.includes(name) && !(symbol && options.skippedTypeNames.includes(symbol.getName())))
      return undefined;

    // An optional property's missing marker is supplied by the question mark. Keep explicitly allowed undefined.
    const members = optional && type.isUnion() ? optionalMembers(type) : undefined;
    if (members && members.length > 1 && type.isUnion() && members.length !== type.types.length) return undefined;
    const resolved = members?.length === 1 ? members[0]! : type;
    const ref = typescript.isTypeReferenceNode(annotation) ? annotation : undefined;
    const declared = ref && checker.getTypeFromTypeNode(ref);
    const generic = !!ref?.typeArguments?.length;
    if (!options.copy) {
      if (declared && declared !== resolved) {
        // A substituted Map<T> still deserves its short label. A narrowed primitive no longer describes its alias.
        const family = (value: ts.Type) => value.aliasSymbol ?? (value as ts.TypeReference).target?.getSymbol();
        if (!generic || !family(declared) || family(declared) !== family(resolved)) return undefined;
      }
      return generic ? name + "<...>" : name;
    }
    // Preserve compact references such as Array<typeof seed>. Printing the resolved type can expand
    // the entire object behind seed and cache those nodes for each hover. A substitution or shadowed
    // name still needs the compiler's spelling at the copy location.
    if (generic && ref && declared === resolved && hasSameBindings(ref)) {
      const text = ref.getText();
      if (!text.includes("//")) return text;
    }
    // Preserve an erased primitive alias only if its original name still resolves to the very same binding.
    if (
      !generic &&
      declared === resolved &&
      binding &&
      typescript.isIdentifier(nameNode) &&
      checker.resolveName(name, hoverNode, typescript.SymbolFlags.Type, false) === binding
    )
      return name;
    const flags =
      typescript.TypeFormatFlags.UseFullyQualifiedType |
      (name === "Array" || name === "ReadonlyArray" ? typescript.TypeFormatFlags.WriteArrayAsGenericType : 0);
    return typeText(resolved, flags, printScope);

    function hasSameBindings(node: ts.Node): boolean {
      if (!canPreprocess()) return false;
      if (typescript.isTypeReferenceNode(node) || typescript.isTypeQueryNode(node)) {
        const query = typescript.isTypeQueryNode(node);
        const name = query ? node.exprName : node.typeName;
        let root = name;
        while (typescript.isQualifiedName(root)) root = root.left;
        if (query) {
          // The same value can have a narrower type inside a branch. The binder attaches the same
          // flow node to ordinary straight-line uses; if that evidence is missing, ask the printer.
          const atSource = (root as ts.Identifier & { flowNode?: object }).flowNode;
          if (!atSource || atSource !== (hoverNode as ts.Node & { flowNode?: object }).flowNode) return false;
        }
        const meaning = query
          ? typescript.SymbolFlags.Value
          : root === name
            ? typescript.SymbolFlags.Type
            : typescript.SymbolFlags.Namespace;
        const original = canonicalSymbol(checker.getSymbolAtLocation(root));
        if (!original || original !== canonicalSymbol(checker.resolveName(root.text, hoverNode, meaning, false)))
          return false;
        return !node.typeArguments || node.typeArguments.every(hasSameBindings);
      }
      // Relative import types, this, fresh unique symbols and names outside a checked reference can
      // depend on their original location. Leave these forms to the scoped compiler printer.
      if (
        typescript.isImportTypeNode(node) ||
        typescript.isThisTypeNode(node) ||
        typescript.isIdentifier(node) ||
        (typescript.isTypeOperatorNode(node) && node.operator === typescript.SyntaxKind.UniqueKeyword)
      )
        return false;
      return !typescript.forEachChild(node, (child) => (hasSameBindings(child) ? undefined : true));
    }
  }

  function getArrayElementAnnotation(annotation: ts.Node | undefined): ts.TypeNode | undefined {
    if (!annotation) return undefined;
    if (typescript.isArrayTypeNode(annotation)) return annotation.elementType;
    if (typescript.isTypeReferenceNode(annotation)) return annotation.typeArguments?.[0];
    return undefined;
  }

  function isSymbolProperty(symbol: ts.Symbol): boolean {
    return symbol.getName().startsWith("__@") && checker.symbolToString(symbol).startsWith("[");
  }

  /**
   * Check if a type is a primitive type
   */
  function isPrimitiveType(type: ts.Type): boolean {
    const typeFlags = type.flags;

    if (typeFlags & typescript.TypeFlags.EnumLike) return false;

    return Boolean(
      typeFlags & typescript.TypeFlags.String ||
      typeFlags & typescript.TypeFlags.StringLiteral ||
      typeFlags & typescript.TypeFlags.TemplateLiteral ||
      typeFlags & typescript.TypeFlags.StringMapping ||
      typeFlags & typescript.TypeFlags.Number ||
      typeFlags & typescript.TypeFlags.NumberLiteral ||
      typeFlags & typescript.TypeFlags.Boolean ||
      typeFlags & typescript.TypeFlags.BooleanLike ||
      typeFlags & typescript.TypeFlags.BooleanLiteral ||
      typeFlags & typescript.TypeFlags.Undefined ||
      typeFlags & typescript.TypeFlags.Null ||
      typeFlags & typescript.TypeFlags.Void ||
      typeFlags & typescript.TypeFlags.BigInt ||
      typeFlags & typescript.TypeFlags.BigIntLiteral ||
      typeFlags & typescript.TypeFlags.ESSymbol ||
      typeFlags & typescript.TypeFlags.UniqueESSymbol ||
      typeFlags & typescript.TypeFlags.Never ||
      typeFlags & typescript.TypeFlags.Unknown ||
      typeFlags & typescript.TypeFlags.Any ||
      // The `object` keyword; its apparent type is `{}`, which would also accept primitives.
      typeFlags & typescript.TypeFlags.NonPrimitive,
    );
  }

  /**
   * Check if a type is an intrinsic type
   */
  function isIntrinsicType(type: ts.Type): type is ts.Type & { intrinsicName: string } {
    return typeof (type as ts.Type & { intrinsicName?: string }).intrinsicName === "string";
  }

  /**
   * Sort union types by intrinsic types order, following ts quick info order
   * Ex.
   * string, number, bigint, { a: string }, null, undefined
   */
  function sortUnionTypes(a: ts.Type, b: ts.Type): number {
    const primitiveTypesOrder = ["string", "number", "bigint", "boolean", "symbol"];
    const falsyTypesOrder = ["null", "undefined"];

    const aIntrinsicName = isIntrinsicType(a) ? a.intrinsicName : "";
    const bIntrinsicName = isIntrinsicType(b) ? b.intrinsicName : "";

    const aPrimitiveIndex = primitiveTypesOrder.indexOf(aIntrinsicName);
    const bPrimitiveIndex = primitiveTypesOrder.indexOf(bIntrinsicName);
    const aFalsyIndex = falsyTypesOrder.indexOf(aIntrinsicName);
    const bFalsyIndex = falsyTypesOrder.indexOf(bIntrinsicName);

    // If both types are primitive, sort based on the order in primitiveTypesOrder
    if (aPrimitiveIndex !== -1 && bPrimitiveIndex !== -1) {
      return aPrimitiveIndex - bPrimitiveIndex;
    }

    // If one type is primitive and the other is not, the primitive type should come first
    if (aPrimitiveIndex !== -1) {
      return -1;
    }

    if (bPrimitiveIndex !== -1) {
      return 1;
    }

    // If both types are falsy, sort based on the order in falsyTypesOrder
    if (aFalsyIndex !== -1 && bFalsyIndex !== -1) {
      return aFalsyIndex - bFalsyIndex;
    }

    // If one type is falsy and the other is not, the falsy type should come last
    if (aFalsyIndex !== -1) {
      return 1;
    }
    if (bFalsyIndex !== -1) {
      return -1;
    }

    // If neither type is primitive or falsy, maintain the original order
    return 0;
  }

  function preserveClassIdentity(type: ts.Type, members: readonly ts.Symbol[]): boolean | undefined {
    if (!options.copy) return false;
    const target = (type as ts.TypeReference).target ?? type;
    if (!target.isClassOrInterface() && !type.isIntersection()) return false;
    for (const member of members) {
      if (!canPreprocess()) return undefined;
      if (restrictedClassVisibility(member)) return true;
    }
    return false;
  }

  function restrictedClassVisibility(symbol: ts.Symbol): TypeProperty["classVisibility"] {
    for (const declaration of symbol.getDeclarations() ?? []) {
      const name = typescript.getNameOfDeclaration(declaration);
      const flags = typescript.getCombinedModifierFlags(declaration);
      if ((name && typescript.isPrivateIdentifier(name)) || flags & typescript.ModifierFlags.Private) return "private";
      if (flags & typescript.ModifierFlags.Protected) return "protected";
    }
  }

  function isPublicProperty(symbol: ts.Symbol): boolean {
    if (options.treatUnderscoreAsPrivate !== false && symbol.getName().startsWith("_") && !isSymbolProperty(symbol))
      return false;
    return !restrictedClassVisibility(symbol);
  }

  function getSyntaxKindDeclaration(syntaxKind: ts.SyntaxKind, typeName: string): string {
    const SyntaxKind = typescript.SyntaxKind;

    // Handle imported types
    if (typeName.startsWith('"') && typeName.endsWith('"')) {
      const shortenedTypeName = typeName.replace(/"/g, "").split("node_modules/").pop()!;
      const finalTypeName = `"${shortenedTypeName}"`;

      return `typeof import(${finalTypeName}): `;
    }

    switch (syntaxKind) {
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.NewExpression:
        return `class ${typeName} `;

      case SyntaxKind.ExpressionWithTypeArguments:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.QualifiedName:
        return `interface ${typeName} `;

      case SyntaxKind.ArrayType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.FunctionType:
      case SyntaxKind.IndexedAccessType:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.IntersectionType:
      case SyntaxKind.MappedType:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.ThisType:
      case SyntaxKind.TupleType:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.TypeAssertionExpression:
      case SyntaxKind.TypeLiteral:
      case SyntaxKind.TypeOperator:
      case SyntaxKind.TypePredicate:
      case SyntaxKind.TypeQuery:
      case SyntaxKind.TypeReference:
      case SyntaxKind.UnionType:
        return `type ${typeName} = `;

      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionKeyword:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
        return `function ${typeName}`;

      case SyntaxKind.LetKeyword:
        return `let ${typeName}: `;

      case SyntaxKind.VarKeyword:
        return `var ${typeName}: `;

      default:
        return `const ${typeName}: `;
    }
  }

  try {
    if (vueLanguage) position = getPositionForVue(vueLanguage, sourceFile.fileName.replace(/\\/g, "/"), position);
    const node = getDescendantAtRange(typescript, sourceFile, [position, position]);
    if (!node || node === sourceFile || !node.parent) return undefined;
    hoverNode = node;
    printScope = sharedPrintScope(node);
    // `as const` is a keyword, not a type: the compiler resolves it to an unresolved `const` symbol.
    if (typescript.isConstTypeReference(node.parent)) return undefined;
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & typescript.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    // getTypeAtLocation picks the right meaning for names shared by a type and a value, but returns `any` for
    // keywords such as `default` in `export default function`; the symbol's type is correct there.
    let type = checker.getTypeAtLocation(node);
    if (type.flags & typescript.TypeFlags.Any && !typescript.isIdentifier(node)) {
      // A class declaration shows its instance members, as when hovering a class name.
      type =
        symbol.flags & typescript.SymbolFlags.Class && typescript.isClassDeclaration(node.parent)
          ? checker.getDeclaredTypeOfSymbol(symbol)
          : checker.getTypeOfSymbolAtLocation(symbol, node);
    }
    const typeReference = typescript.isTypeReferenceNode(node.parent) ? node.parent : undefined;
    const typeDeclaration =
      typeReference &&
      symbol.declarations?.find(
        (declaration) =>
          typescript.isTypeAliasDeclaration(declaration) ||
          typescript.isInterfaceDeclaration(declaration) ||
          typescript.isClassDeclaration(declaration),
      );
    const declarationNode =
      typeDeclaration ??
      symbol.declarations?.find((declaration) => declaration === node.parent) ??
      symbol.valueDeclaration ??
      symbol.declarations?.[0];
    let kind = declarationNode?.kind ?? typescript.SyntaxKind.ConstKeyword;
    if (declarationNode && typescript.isVariableDeclaration(declarationNode)) {
      const list = declarationNode.parent;
      kind =
        list.flags & typescript.NodeFlags.Const
          ? typescript.SyntaxKind.ConstKeyword
          : list.flags & typescript.NodeFlags.Let
            ? typescript.SyntaxKind.LetKeyword
            : typescript.SyntaxKind.VarKeyword;
    }
    const name = boundedText(symbol.getName());
    // Only the constructed class itself (`new Foo()`, `new ns.Foo()`), not classes used as arguments or type arguments.
    const callee = typescript.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
    const newExpression =
      typescript.isNewExpression(callee.parent) && callee.parent.expression === callee ? callee.parent : undefined;
    let tree: TypeTree;
    let declaration: string;
    let source: TypeSource | undefined;
    const constructSignatures = type.getConstructSignatures();
    // Class values (constructor calls, static access, `extends`) show the constructor; declarations and imports do not.
    if (
      kind === typescript.SyntaxKind.ClassDeclaration &&
      !typescript.isClassDeclaration(node.parent) &&
      !typescript.findAncestor(
        node,
        (ancestor) =>
          typescript.isImportDeclaration(ancestor) ||
          typescript.isImportSpecifier(ancestor) ||
          typescript.isImportClause(ancestor),
      ) &&
      (newExpression || constructSignatures.length)
    ) {
      declaration = options.copy
        ? "type " + name + "Constructor = "
        : getSyntaxKindDeclaration(typescript.SyntaxKind.Constructor, name);
      if (options.copy && !newExpression) {
        // A class value also carries static members, overloads and constructor accessibility.
        tree = reference(type, false, printScope);
      } else {
        const signature = newExpression ? checker.getResolvedSignature(newExpression) : constructSignatures[0];
        if (!signature) return undefined;
        tree = {
          kind: "function",
          typeName: "",
          excessSignatures: 0,
          signatures: [expandFairly(() => getSignature(signature, 0, new Set(), true))],
        };
      }
    } else {
      const annotation =
        typeReference ??
        (typescript.isTypeAliasDeclaration(node.parent) ? node.parent.name : getTypeAnnotation(symbol));
      rootType = type;
      if (options.copy && declarationNode && typescript.isVariableDeclaration(declarationNode))
        copiedVariable = { declaration: declarationNode };
      tree = expandFairly(() => getTypeTree(type, 0, new Set(), annotation));
      if (copiedVariable?.className && (tree.kind === "object" || tree.kind === "function"))
        tree = {
          kind: "intersection",
          typeName: "",
          types: [{ kind: "reference", typeName: boundedText(copiedVariable.className) }, tree],
        };
      if (inaccessibleNames && typescript.isTypeAliasDeclaration(node.parent) && node.parent.name === node) {
        const spelling = originalTypeReference(node.parent.type, type);
        if (spelling) {
          inaccessibleNames = 0;
          tree = { kind: "reference", typeName: boundedText(spelling) };
        }
      }
      const declaredParameters =
        declarationNode &&
        (typescript.isTypeAliasDeclaration(declarationNode) ||
          typescript.isInterfaceDeclaration(declarationNode) ||
          typescript.isClassDeclaration(declarationNode)) &&
        declarationNode.name === node
          ? declarationNode.typeParameters
          : undefined;
      const declarationName = declaredParameters?.length
        ? boundedText(name + "<" + declaredParameters.map((parameter) => parameter.getText()).join(", ") + ">")
        : name;
      declaration = getSyntaxKindDeclaration(kind, declarationName);
      if (declaration.startsWith("function") && tree.kind !== "function") declaration = "const " + name + ": ";
      // An interface header needs a body; arrays, references and skipped interfaces are written as aliases.
      if (declaration.startsWith("interface ") && tree.kind !== "object") {
        declaration = "type " + declaration.slice("interface ".length).trimEnd() + " = ";
      }
      // Extra hover detail: past the deadline it is skipped without reporting a limit, and a failure here keeps
      // the prettified result.
      if (options.showSource && Date.now() <= deadline) {
        try {
          source = getAuthoredSource(typescript, checker, node, symbol, type);
        } catch (error) {
          control.onError?.(error);
        }
      }
    }
    if (options.copy) {
      // A quoted property name or the default export can be displayed verbatim, but cannot name a pasted declaration.
      const scanner = typescript.createScanner(
        typescript.ScriptTarget.Latest,
        false,
        typescript.LanguageVariant.Standard,
        name,
      );
      const token = scanner.scan();
      let identifier = token === typescript.SyntaxKind.Identifier;
      if (
        token > typescript.SyntaxKind.LastFutureReservedWord &&
        token <= typescript.SyntaxKind.LastKeyword &&
        token !== typescript.SyntaxKind.AwaitKeyword
      ) {
        // Contextual keywords such as get and set are usable names. Built-in types such as string are not.
        const probe = typescript.createSourceFile("name.ts", "type X = " + name, typescript.ScriptTarget.Latest)
          .statements[0];
        identifier = !!probe && typescript.isTypeAliasDeclaration(probe) && typescript.isTypeReferenceNode(probe.type);
      }
      if (!identifier || scanner.getTextPos() !== name.length) {
        declaration = "type Prettified = ";
      }
    }
    if (control.isCancellationRequested?.()) return undefined;
    if (inaccessibleNames) reasons.add("inaccessible type");
    const result: TypeInfo = {
      typeTree: tree,
      declaration,
      name,
      compilerVersion: typescript.version,
      ...(reasons.size ? { truncationReasons: [...reasons] } : {}),
    };
    let size = JSON.stringify(result).length;
    if (size > limits.characters) {
      result.typeTree = { kind: "reference", typeName: "unknown /* response size limit */" };
      reasons.add("response size limit");
      result.truncationReasons = [...reasons];
      size = JSON.stringify(result).length;
    }
    // The source is added last and only when it fits, so it can never cost the prettified type its place.
    if (source && size + JSON.stringify(source).length <= limits.characters) result.source = source;
    return result;
  } catch (error) {
    control.onError?.(error);
    return undefined;
  }
}
