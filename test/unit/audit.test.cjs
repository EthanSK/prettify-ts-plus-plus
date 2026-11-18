const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");
const file = path.join(__dirname, "virtual.ts").split(path.sep).join("/");
function programFor(source, exact = true) {
  const options = { strict: true, exactOptionalPropertyTypes: exact, target: ts.ScriptTarget.ESNext, noEmit: true };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile;
  host.getSourceFile = (name, ...args) =>
    name === file ? ts.createSourceFile(name, source, options.target, true) : original(name, ...args);
  const program = ts.createProgram([file], options, host);
  return { program, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(file) };
}
function inspect(source, marker = "Test", overrides = {}, exact = true) {
  const { program, checker, sourceFile } = programFor(source, exact),
    errors = [];
  assert.ok(source.indexOf(marker) >= 0);
  const info = api.getTypeInfoAtPosition(
    ts,
    checker,
    sourceFile,
    source.indexOf(marker) + 1,
    {
      ...api.DEFAULT_OPTIONS,
      maxDepth: 5,
      maxProperties: 100,
      maxSubProperties: 100,
      skippedTypeNames: [],
      ...overrides,
    },
    undefined,
    { compilerOptions: program.getCompilerOptions(), onError: (error) => errors.push(error) },
  );
  assert.deepEqual(errors, []);
  assert.ok(info, "Expected plugin type info");
  return { info, text: api.renderTypeInfo(info, 0), checker, sourceFile };
}
function parses(text) {
  const file = ts.createSourceFile("rendered.ts", text, ts.ScriptTarget.Latest, true);
  assert.deepEqual(
    file.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    text,
  );
}
function equivalent(source, marker = "Test", overrides = {}, exact = true) {
  const { text } = inspect(source, marker, overrides, exact);
  parses(text);
  const actual = text.replace(new RegExp("type " + marker + "\\b"), "type Actual");
  const { program, checker, sourceFile } = programFor(source + "\n" + actual, exact);
  const aliases = sourceFile.statements.filter(ts.isTypeAliasDeclaration);
  const left = checker.getTypeAtLocation(aliases.find((n) => n.name.text === marker));
  const right = checker.getTypeAtLocation(aliases.find((n) => n.name.text === "Actual"));
  assert.ok(checker.isTypeAssignableTo(left, right), text);
  assert.ok(checker.isTypeAssignableTo(right, left), text);
  assert.deepEqual(
    program.getSemanticDiagnostics(sourceFile).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    text,
  );
  return text;
}
test("root functions and overload objects use valid syntax", () => {
  equivalent("type Test = () => string;");
  const { text } = inspect("declare const Test: () => string;");
  assert.match(text, /const Test: \(\) => string/);
  parses(text);
  equivalent("type Test = { fn: { (): string; (x: number): number } };");
});
test("generic binders, predicates, assertions and this are preserved", () => {
  equivalent('type Test = <T extends string = "x">(x: T) => T;');
  equivalent("type Test = <T extends { value: string }>(x: T) => T;");
  assert.match(equivalent("type Test = <const T extends readonly string[]>(x: T) => T;"), /<const T/);
  equivalent("type Test = (x: unknown) => x is string;");
  equivalent("type Test = (x: unknown) => asserts x is string;");
  equivalent("type Test = (this: { value: string }, x: number) => void;");
});
test("mapped optional/readonly modifiers and getter-only properties are correct", () => {
  assert.match(equivalent("type Test = Partial<{ a: string }>;"), /a\?: string/);
  assert.match(equivalent("type Test = Required<{ a?: string }>;"), /a: string/);
  assert.match(equivalent("type Test = Readonly<{ a: string }>;"), /readonly a: string/);
  assert.doesNotMatch(
    equivalent("type Test = { -readonly [K in keyof Readonly<{ a: string }>]: string };"),
    /readonly a/,
  );
  assert.match(equivalent('type Test = { readonly [K in "a"]: string };'), /readonly a/);
  assert.match(equivalent("type Test = { method?(): void };"), /method\?/);
  assert.match(inspect("class Test { get value() { return 1; } }").text, /readonly value: number/);
});
test("callable objects retain properties, constructors and index signatures", () => {
  equivalent("type Test = { (x: number): string; prop: number; new (x: string): { value: string } };");
  equivalent("type Test = { new (x: number): { value: number } };");
  equivalent("type Test = { (): string; [key: string]: unknown };");
});
test("union and readonly-array precedence preserves semantics", () => {
  equivalent("type Test = (() => string) | number;");
  assert.match(equivalent("type Test = Array<ReadonlyArray<string>>;"), /\(readonly string\[\]\)\[\]/);
  assert.match(equivalent("type Test = ReadonlyArray<ReadonlyArray<string>>;"), /readonly \(readonly string\[\]\)\[\]/);
  assert.match(equivalent("type Test = Array<readonly [string, number]>;"), /\(readonly \[string, number\]\)\[\]/);
});
test("exact optional types preserve explicit undefined", () => {
  assert.match(equivalent("type Test = { a?: string | undefined };"), /undefined/);
  assert.doesNotMatch(equivalent("type Test = { a?: string };"), /undefined/);
  assert.match(equivalent("type Test = [a?: string | undefined];"), /undefined/);
  equivalent("type Test = { a?: string | undefined };", "Test", {}, false);
  equivalent("type Test = [a?: string | null];");
});
test("rendering does not mutate input", () => {
  const { info } = inspect("type Test = { a?: string | undefined; fn: (a?: string) => void };"),
    before = JSON.stringify(info);
  api.renderTypeInfo(info, 4);
  api.renderTypeInfo(info, 0);
  assert.equal(JSON.stringify(info), before);
});
test("default parameters retain actual cardinality", () => {
  const normal = inspect("function Test(a = 1) { return a; }").text;
  assert.match(normal, /a\?: number/);
  parses(normal);
  const beforeRequired = inspect("function Test(a = 1, b: string) { return a; }").text;
  assert.match(beforeRequired, /a: number \| undefined, b: string/);
  parses(beforeRequired);
});
test("destructured parameters show their binding pattern instead of __0", () => {
  const object = inspect(
    "function Test({ state, onRetry: retry = () => {}, ...rest }: { state: string; onRetry?: () => void; x: 1 }) {}",
  ).text;
  assert.doesNotMatch(object, /__\d/);
  assert.match(object, /\(\{ state, onRetry: retry, \.\.\.rest \}: \{/);
  parses(object);
  const array = inspect("function Test([a, , [b], ...c]: number[][], {}: object) {}").text;
  assert.match(array, /\(\[a, , \[b\], \.\.\.c\]: .*, \{\}: object\)/);
  parses(array);
});
test("constructors select resolved overloads and inference; class values show the constructor", () => {
  const text = inspect(
    "class Example { constructor(value: string); constructor(value: number); constructor(value: unknown) {} } new Example(1);",
    "Example(1)",
  ).text;
  assert.match(text, /value: number/);
  parses(text);
  const generic = inspect('class Box<T> { constructor(public value: T) {} } new Box("text");', 'Box("text")').text;
  assert.match(generic, /value: string/);
  assert.match(generic, /Box<string>/);
  parses(generic);
  // As in earlier releases: class values, including `extends` clauses, show the constructor.
  const heritage = inspect(
    "class Parent { constructor(public value: number) {} } class Child extends Parent {}",
    "Parent {}",
  );
  assert.equal(heritage.text.trim(), "function Parent(value: number): Parent");
  const declaration = inspect("class Test { value = 1; }").text;
  assert.match(declaration, /^class Test \{ value: number; \}/);
});
test("copying a class value preserves static and abstract members; a new call copies its resolved constructor", () => {
  const source =
    "abstract class Base { static label = 'base'; } const factory = Base;" +
    "class Box { constructor(x: string); constructor(x: number); constructor(x: unknown) {} } new Box(1);";
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    const factory = inspect(source, "Base;", mode).text;
    const call = inspect(source, "Box(1)", mode).text;
    assert.match(factory, /type BaseConstructor = typeof Base/);
    assert.match(call, /type BoxConstructor = new \(x: number\) => Box/);
    const { program, sourceFile } = programFor(
      source +
        "\n" +
        factory +
        ";\n" +
        call +
        ";\ndeclare const b: BaseConstructor; const label: string = b.label;\n" +
        "// @ts-expect-error Abstract class values cannot be instantiated.\nnew b();\n" +
        "declare const make: BoxConstructor; const n: Box = new make(1);\n" +
        "// @ts-expect-error The selected overload at this call takes a number.\nnew make('x');",
    );
    assert.deepEqual(
      program.getSemanticDiagnostics(sourceFile).map((d) => d.messageText),
      [],
    );
  }
});

test("numeric-looking property keys retain exact names", () => {
  const text = equivalent('type Test = { "01": string; "9007199254740993": number };');
  assert.match(text, /"01"/);
  assert.match(text, /"9007199254740993"/);
});
test("formatting preserves intersections and template literal contents", () => {
  assert.match(api.prettyPrintTypeString("function f(x: { a: string; } & { a: number; }): void", 4), /&/);
  const q = String.fromCharCode(96),
    literal = q + 'typeof import("/x/node_modules/foo")' + "$" + "{string}" + q;
  assert.ok(api.prettyPrintTypeString("{ value: " + literal + "; }", 4).includes(literal));
  parses(api.prettyPrintTypeString("type X = { nested: { a: string; }; };", 4));
});
test("native completions preserve receiver and all arguments", () => {
  let observed;
  const service = {
    getCompletionsAtPosition(...args) {
      assert.equal(this, service);
      observed = args;
    },
  };
  const proxy = api
    .init({ typescript: ts })
    .create({ languageService: service, project: { projectService: { logger: { info() {} } } } });
  const format = { indentSize: 2 };
  proxy.getCompletionsAtPosition("file.ts", 1, {}, format);
  assert.equal(observed[3], format);
});
test("default skip list keeps earlier behavior for Array, Map and Set", () => {
  const defaults = { skippedTypeNames: api.DEFAULT_OPTIONS.skippedTypeNames };
  assert.ok(["Array", "Map", "Set"].every((n) => api.DEFAULT_OPTIONS.skippedTypeNames.includes(n)));
  // "Array" in the list never stopped array expansion; it only keeps explicit Array<T> annotations.
  assert.match(
    inspect("declare const Test: { a: { v: string }[] };", "Test", { ...defaults, maxDepth: 2 }).text,
    /a: \{ v: string; \}\[\]/,
  );
  assert.match(inspect("declare const Test: { a: Array<string> };", "Test", defaults).text, /a: Array<\.\.\.>/);
  assert.match(inspect("declare const Test: Map<string, { value: string }>;", "Test", defaults).text, /Map<\.\.\.>/);
  const unskipped = inspect("declare const Test: Map<string, { value: string }>;").text;
  assert.match(unskipped, /Map<string, \{ value: string;/);
});
test("configured generic aliases retain wrapper and expand arguments", () => {
  const text = inspect("type Wrap<T> = { v: T }; declare const Test: Wrap<{ value: string }>;", "Test", {
    unwrapGenericArgumentsTypeNames: ["Wrap"],
  }).text;
  assert.match(text, /Wrap<\{ value: string;/);
});
test("property limits apply per object, as in earlier releases", () => {
  const { info, text } = inspect(
    "type Test = { a: { x: string; y: string; z: string }; b: { x: string; y: string; z: string }; c: string };",
    "Test",
    { maxProperties: 2, maxSubProperties: 2 },
  );
  assert.equal(
    text,
    "type Test = { a: { x: string; y: string; /* ... 1 more */ }; b: { x: string; y: string; /* ... 1 more */ }; /* ... 1 more */ }",
  );
  assert.ok(info.truncationReasons.includes("property limit"));
});
test("one retained overload still reports omissions", () => {
  const { info, text } = inspect("type Test = { (x: string): string; (x: number): number };", "Test", {
    maxFunctionSignatures: 1,
  });
  assert.match(text, /\/\* \.\.\. 1 more \*\//);
  assert.ok(info.truncationReasons.includes("function signature limit"));
});
test("numeric settings are finite and large user values are honored", () => {
  const o = api.normalizeOptions({ maxDepth: Infinity, maxProperties: -3, maxUnionMembers: 1.5 });
  assert.equal(o.maxDepth, api.DEFAULT_OPTIONS.maxDepth);
  assert.equal(o.maxProperties, 1);
  assert.equal(o.maxUnionMembers, 1);
  const large = api.normalizeOptions({ maxDepth: 30, maxUnionMembers: 500, maxProperties: 50000 });
  assert.deepEqual([large.maxDepth, large.maxUnionMembers, large.maxProperties], [30, 500, 50000]);
  const full = api.normalizeOptions({ fullExpansion: true });
  assert.equal(full.maxProperties, api.MAX_SETTING);
  assert.ok(Number.isFinite(full.maxDepth));
  assert.equal(full.copy, true);
  assert.equal(api.normalizeOptions({}).copy, false);
});
test("recursive generics terminate even with full copy", () => {
  for (const source of [
    "type Chain<T> = () => Chain<T[]>; type Test = Chain<number>;",
    "type Chain<T> = { next: Chain<T[]> }; type Test = Chain<number>;",
  ]) {
    const started = Date.now();
    const { info } = inspect(source, "Test", { fullExpansion: true });
    assert.ok(info.truncationReasons.includes("analysis budget"));
    assert.ok(JSON.stringify(info).length < api.FULL_COPY_LIMITS.characters);
    assert.ok(Date.now() - started < api.FULL_COPY_LIMITS.milliseconds + 2000);
  }
});
test("collapsed wide types do not carry hidden complete strings", () => {
  const source =
    "declare const Test: { " + Array.from({ length: 10000 }, (_, i) => "p" + i + ": string").join(";") + " };";
  const { info } = inspect(source, "Test", { maxProperties: 1, maxDepth: 1 });
  assert.ok(JSON.stringify(info).length < 3000);
});
test("AST lookup prunes irrelevant branches", () => {
  const sf = ts.createSourceFile(
    "lookup.ts",
    "type First = { a: string }; type Second = { b: number };",
    ts.ScriptTarget.Latest,
    true,
  );
  sf.statements[1].forEachChild = () => {
    throw new Error("Visited irrelevant subtree");
  };
  assert.equal(api.getDescendantAtRange(ts, sf, [6, 6]).getText(), "First");
});
test("Vue generated offset zero is valid", () => {
  const code = {},
    script = {
      generated: {
        root: { languageId: "vue" },
        languagePlugin: {
          typescript: {
            getServiceScript: () => ({ code, preventLeadingOffset: true }),
          },
        },
      },
    };
  const language = {
    scripts: { get: () => script },
    maps: {
      get: () => ({
        *toGeneratedLocation() {
          yield [0];
        },
      }),
    },
  };
  assert.equal(api.getPositionForVue(language, "test.vue", 12), 0);
});
test("manifest defaults agree with shared options", () => {
  const manifest = require("../../packages/vscode-extension/package.json"),
    properties = manifest.contributes.configuration.properties;
  for (const [key, value] of Object.entries(api.DEFAULT_OPTIONS))
    assert.deepEqual(properties["prettify-ts-plus-plus." + key].default, value, key);
  for (const v of Object.values(properties)) {
    if (v.type === "integer") assert.ok(v.maximum !== undefined);
    assert.equal(v.scope, "language-overridable");
  }
  assert.equal(manifest.engines.vscode, "^1.100.0");
  assert.ok(!manifest.activationEvents.includes("onStartupFinished"));
});

test("object-constrained generic parameters and const inference remain bound", () => {
  equivalent("type Test = <T extends { value: string }>(x: T) => T;");
  assert.match(equivalent("type Test = <const T extends readonly string[]>(x: T) => T;"), /<const T/);
  // Without exactOptionalPropertyTypes, `a?: string | undefined` is `a?: string`, displayed as before.
  assert.doesNotMatch(equivalent("type Test = { a?: string | undefined };", "Test", {}, false), /undefined/);
});

test("generic type declarations retain outer parameter binders", () => {
  const text = inspect("type Test<T extends unknown[]> = { value: [first: string, ...rest: T] };").text;
  assert.match(text, /type Test<T extends unknown\[\]>/);
  parses(text);
});
test("cancelled compiler analysis exits without a response", () => {
  const { checker, sourceFile } = programFor("type Test = { a: string };");
  const info = api.getTypeInfoAtPosition(ts, checker, sourceFile, 6, api.DEFAULT_OPTIONS, undefined, {
    isCancellationRequested: () => true,
  });
  assert.equal(info, undefined);
});

test("opaque reference expressions group safely and primitive brands remain intersections", () => {
  const conditional = inspect("type Test<T> = (T extends string ? number : boolean)[];").text;
  parses(conditional);
  assert.match(conditional, /\(T extends string \? number : boolean\)\[\]/);
  const branded = inspect("type Test = string & { readonly brand: unique symbol };").text;
  assert.match(branded, /string &/);
});

test("type parameter constraints keep their declared form", () => {
  assert.match(equivalent("type Test = <O, K extends keyof O>(o: O, k: K) => O[K];"), /K extends keyof O/);
  assert.match(equivalent("type Test = <T extends U, U extends string>(t: T, u: U) => void;"), /T extends U,/);
  const declared = inspect(
    "function Test<O extends object, K extends keyof O>(o: O, k: K): O[K] { return o[k]; }",
  ).text;
  assert.match(declared, /<O extends object, K extends keyof O>/);
  parses(declared);
});
test("classes inside another new expression show their own constructor, not the outer one", () => {
  const argument = inspect(
    "class Foo { constructor(a: string) {} } class Wrapper { constructor(c: typeof Foo) {} } new Wrapper(Foo);",
    "Foo)",
  );
  assert.equal(argument.text.trim(), "function Foo(a: string): Foo");
  const typeArgument = inspect("class Foo { a = 1 } new Map<string, Foo>();", "Foo>");
  assert.doesNotMatch(typeArgument.text, /Map|iterable/);
  assert.equal(
    inspect(
      "namespace NS { export class Foo { constructor(public a: number) {} } } new NS.Foo(1);",
      "Foo(1)",
    ).text.trim(),
    "function Foo(a: number): Foo",
  );
});
test("generic mapped types and the object keyword are not erased to {}", () => {
  for (const source of ["type Test<T> = Partial<T>;", "type Test<K extends string, V> = Record<K, V>;"]) {
    const { text } = inspect(source);
    assert.match(text, /\[P in (?:keyof T|K)\]/, text);
    parses(text);
  }
  assert.match(equivalent("type Test = { a: object; b: {} };"), /a: object; b: \{\};/);
});
test("runaway expansion degrades to a partial preview instead of an empty response", () => {
  // Every level creates new types, so only the internal safety limits stop it.
  const source = "type Fan<T> = { a: Fan<[T]>; b: Fan<[T]>; c: Fan<[T]> }; declare const Test: Fan<0>;";
  const { info } = inspect(source, "Test", { maxDepth: 20 });
  assert.equal(info.typeTree.kind, "object");
  assert.deepEqual(
    info.typeTree.properties.map((p) => p.name),
    ["a", "b", "c"],
  );
  assert.ok(info.truncationReasons.includes("analysis budget"));
  assert.ok(!info.truncationReasons.includes("response size limit"));
  assert.ok(JSON.stringify(info).length < api.PREVIEW_LIMITS.characters);
});
test("hover markers match earlier releases; copies keep valid comments", () => {
  const { text } = inspect("type Test = { a: { x: 1; y: 2 }; b: 'v1' | 'v2' | 'v3'; c: 1; d: 2 };", "Test", {
    maxDepth: 1,
    maxProperties: 3,
    maxUnionMembers: 2,
  });
  assert.equal(
    text,
    'type Test = { a: { /* ... 2 more */ }; b: "v1" | "v2" /* | ... 1 more */; c: 1; /* ... 1 more */ }',
  );
  parses(text);
  assert.equal(
    api.hoverMarkers(api.prettyPrintTypeString(text.slice("type Test = ".length), 4)),
    '{\n    a: { ... 2 more };\n    b: "v1" | "v2" | ... 1 more;\n    c: 1;\n    ... 1 more;\n}\n',
  );
  assert.equal(api.hoverMarkers('{ s: "/* ... 1 more */"; }'), '{ s: "/* ... 1 more */"; }');
});
test("numeric keys stay bare and module paths are shortened as before", () => {
  assert.match(inspect("const Test = { 0: 'a', 1: 'b' };").text, /\{ 0: string; 1: string; \}/);
  const q = '"';
  assert.equal(
    api.prettyPrintTypeString(
      "{ m: typeof import(" + q + "/x/node_modules/pkg/lib" + q + "); s: " + q + "/x/node_modules/pkg" + q + "; }",
      0,
    ),
    "{ m: typeof import(" + q + "pkg/lib" + q + "); s: " + q + "/x/node_modules/pkg" + q + "; }",
  );
});
test("booleans keep their union position and safe references are not grouped", () => {
  assert.match(
    equivalent("type Test = { a: boolean | null; b: string | boolean | undefined };"),
    /a: boolean \| null; b: string \| boolean \| undefined;/,
  );
  const text = inspect("interface Foo<T> { v: T } type Test = { a: Foo<string> | null; b: Foo<number>[] };", "Test", {
    maxDepth: 1,
  }).text;
  assert.match(text, /a: Foo<string> \| null; b: Foo<number>\[\];/);
  const grouped = inspect(
    "type Test<T> = { a: (keyof T)[]; b: keyof T | null; c: (T extends string ? 1 : 2) | null };",
  ).text;
  assert.match(grouped, /a: \(keyof T\)\[\]; b: keyof T \| null; c: \(T extends string \? 1 : 2\) \| null;/);
  parses(grouped);
});

test("full copy keeps every top-level member when deep members exhaust the budget", () => {
  const members = Array.from({ length: 50 }, (_, i) => "p" + i + ": string").join("; ");
  const source =
    "type Deep<T> = { x: Deep<[T]>; y: Deep<[T]>; z: Deep<[T]> }; type Test = { first: Deep<0>; " + members + " };";
  const { info, text } = inspect(source, "Test", { fullExpansion: true });
  assert.equal(info.typeTree.properties.length, 51);
  assert.equal(info.typeTree.excessProperties, 0);
  assert.ok(info.truncationReasons.includes("analysis budget"));
  assert.match(text, /p49: string;/);
  parses(text);
});
test("expansions that fit the budget are unchanged by fair re-expansion", () => {
  const source = "type Test = { a: { b: { c: { d: string } } }; e: number };";
  const { info, text } = inspect(source, "Test", { fullExpansion: true });
  assert.equal(info.truncationReasons, undefined);
  assert.equal(text, "type Test = { a: { b: { c: { d: string; }; }; }; e: number; }");
});

test("copies are not cut by compiler truncation; previews keep the compact form", () => {
  const source =
    "type Box<A, B> = { first: A; second: B };" +
    "type Check<Actual, Expected> = [Expected] extends [Box<Actual, Expected>]" +
    " ? Box<Box<Box<Actual, Expected>, Box<Expected, Actual>>, Box<Box<Actual, Actual>, Box<Expected, Expected>>>" +
    " : unknown;" +
    "declare function Test<E>(value: Check<{ first: string; second: number; third: boolean }, E>): void;";
  assert.match(inspect(source, "Test").text, /Box<\.\.\.>/);
  // Declared constraints of instantiated signatures are printed by the node builder, which also truncates.
  const numbers = Array.from({ length: 60 }, (_, i) => i).join(", ");
  const constrained =
    "declare function make<T>(v: T): { is: <E extends [T, E]>(e: E) => void };" +
    `const Test = make([${numbers}] as const);`;
  assert.match(inspect(constrained, "Test").text, /\.\.\. \d+ more \.\.\./);
  for (const overrides of [{ copy: true }, { fullExpansion: true }]) {
    assert.doesNotMatch(inspect(constrained, "Test", overrides).text, /\.\.\./);
    parses(inspect(constrained, "Test", overrides).text);
    const { info, text } = inspect(source, "Test", overrides);
    assert.doesNotMatch(text, /\.\.\./, text);
    assert.match(text, /, Box<E, E>>> : unknown\): void$/);
    assert.equal(info.truncationReasons, undefined);
    parses(text);
  }
});
test("skipped types keep their arguments in copies", () => {
  const source =
    "const Test = { entries: new Map<string, number>(), seen: new Set<string>() };" +
    "declare const annotated: { cache: Map<string, Set<number>> };";
  const skippedTypeNames = ["Map", "Set"];
  assert.match(inspect(source, "Test", { skippedTypeNames }).text, /entries: Map<\.\.\.>; seen: Set<\.\.\.>;/);
  for (const overrides of [{ copy: true }, { fullExpansion: true }]) {
    const { text } = inspect(source, "Test", { skippedTypeNames, ...overrides });
    assert.match(text, /entries: Map<string, number>; seen: Set<string>;/);
    parses(text);
    const property = inspect(source, "annotated", { skippedTypeNames, ...overrides }).text;
    assert.match(property, /cache: Map<string, Set<number>>;/);
    parses(property);
  }
});
test("skipped generic fields and signatures copy the arguments of the actual instantiation", () => {
  const source =
    "interface Holder<T> { members: Map<string, T>; optional?: Set<T>; explicit: Array<T>;" +
    " convert: (value: Map<string, T>) => Set<T> } type Test = Holder<number>;";
  const skippedTypeNames = ["Map", "Set", "Array"];
  assert.match(inspect(source, "Test", { skippedTypeNames }).text, /members: Map<\.\.\.>/);
  for (const mode of [{ copy: true }, { fullExpansion: true }, { copy: true, unwrapFunctions: false }]) {
    const text = equivalent(source, "Test", { ...mode, skippedTypeNames });
    assert.match(text, /members: Map<string, number>/);
    assert.doesNotMatch(text, /\bT\b/);
  }
});

test("skipped annotations follow narrowing and retain an accessible primitive alias", () => {
  const source = 'type Label = string; declare const value: Label; if (value === "ready") { value; }';
  for (const copy of [true, false]) {
    const narrowed = inspect(source, "value;", { skippedTypeNames: ["Label"], copy });
    assert.match(narrowed.text, /value: "ready"/);
  }
  const sourceAlias = "type ID = string; type Test = { id: ID };";
  assert.match(equivalent(sourceAlias, "Test", { skippedTypeNames: ["ID"], copy: true }), /id: ID;/);
});

test("configured generic wrappers use names accessible from the copied declaration", () => {
  const source =
    "namespace Api { export type Wrap<T> = { value: T }; type Hidden<T> = { body: T };" +
    " export interface Container<T> { parsed: Wrap<T>; privateAlias: Hidden<T> } } type Test = Api.Container<number>;";
  const options = { unwrapGenericArgumentsTypeNames: ["Wrap", "Hidden"] };
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    const text = equivalent(source, "Test", { ...options, ...mode });
    assert.match(text, /parsed: Api\.Wrap<number>/);
    assert.match(equivalent("type Test = Promise<{ value: number }>;", "Test", mode), /= Promise</);
  }
});

test("intrinsic string transformations stay compact and equivalent in hovers and copies", () => {
  for (const name of ["Uppercase", "Lowercase", "Capitalize", "Uncapitalize"]) {
    const source = "type Test = " + name + "<string>;";
    assert.equal(inspect(source).text, "type Test = " + name + "<string>");
    assert.equal(equivalent(source, "Test", { fullExpansion: true }), "type Test = " + name + "<string>");
  }
  equivalent("type Test = Uppercase<string> & { readonly brand: 1 };", "Test", { copy: true });
  equivalent("type Test = { key: Capitalize<string>; list: Lowercase<string>[] };", "Test", { fullExpansion: true });
  assert.match(inspect('type Test = Uppercase<"hello">;').text, /"HELLO"/);
  assert.match(inspect("type Test<T extends string> = Lowercase<T>;").text, /= Lowercase<T>$/);
});

test("copied function constraints use in-scope names and valid numeric literals", () => {
  const source =
    "namespace Api { export interface Base { value: number } " +
    "export interface Holder { call: <T extends Base>(arg: T) => T; limit: <N extends -1e999>(n: N) => N } } " +
    "type Test = Api.Holder;";
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    const text = equivalent(source, "Test", mode);
    assert.match(text, /T extends Api\.Base/);
    assert.match(text, /N extends -1e999/);
  }
});

test("copies of a default export or quoted property use a legal type declaration", () => {
  const source = 'export default function () {return 1}; interface Labels { "aria-label"?: string }';
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    for (const marker of ["default", "aria-label"]) {
      const { text } = inspect(source, marker, mode);
      assert.match(text, /^type Prettified = /);
      parses(text);
      const { program, sourceFile } = programFor(source + "\n" + text);
      assert.equal(program.getSemanticDiagnostics(sourceFile).length, 0, text);
    }
    assert.match(inspect("function get() { return 1; }", "get", mode).text, /^function get\(/);
  }
});

test("copied infinity literals keep their numeric meaning, including in skipped generic arguments", () => {
  const source = 'type Test = { limits: -1e999 | 1e999; byKey: Map<1e999, -1e999>; label: "Infinity"; Infinity: 1 };';
  const text = equivalent(source, "Test", { copy: true, skippedTypeNames: ["Map"] });
  assert.match(text, /Map<1e999, -1e999>/);
  assert.match(text, /label: "Infinity"/);
  assert.match(text, /Infinity: 1/);
});

test("interfaces without an object body are written as aliases", () => {
  const { text } = inspect("let list: ReadonlyArray<string>;", "ReadonlyArray");
  assert.match(text, /^type ReadonlyArray = readonly string\[\]$/);
  parses(text);
  const skipped = inspect("let created: Date;", "Date", { skippedTypeNames: ["Date"], copy: true }).text;
  assert.equal(skipped, "type Date = Date");
  parses(skipped);
});
test("the const in `as const` has no type preview", () => {
  const source = 'const colors = ["red", "blue"] as const;';
  const { checker, sourceFile } = programFor(source);
  const info = api.getTypeInfoAtPosition(ts, checker, sourceFile, source.lastIndexOf("const") + 1, api.DEFAULT_OPTIONS);
  assert.equal(info, undefined);
});
test("hovering the default keyword of a default export shows its type", () => {
  assert.equal(
    inspect("export default function () { return 1; }", "default").text.trim(),
    "function default(): number",
  );
  assert.equal(
    inspect("export default function named(a: string) { return a; }", "default").text.trim(),
    "function default(a: string): string",
  );
  assert.equal(inspect("export default class { x = 1 }", "default").text.trim(), "class default { x: number; }");
  // Type/value name collisions still resolve by the hovered meaning.
  assert.match(
    inspect("const Shared = { runtime: 1 }; type Shared = { typeOnly: string }; declare const r: Shared;", "Shared;")
      .text,
    /typeOnly/,
  );
});

test("a generic name at its use site shows the arguments written there", () => {
  const source =
    "namespace Api { export type Box<T> = { value: T }; } " +
    "type Deep<T> = T extends object ? { [K in keyof T]?: Deep<T[K]> } : T; " +
    'type Concrete = Deep<{ kind: "ready" }>; type Other = Api.Box<123>;';
  for (const mode of [{}, { copy: true }, { fullExpansion: true }]) {
    const deep = inspect(source, "Deep<{ kind:", mode).text;
    assert.match(deep, /kind\?: "ready"/);
    assert.doesNotMatch(deep, /\bT\b|unknown|expansion limit/);
    assert.match(inspect(source, "Box<123>", mode).text, /value: 123/);
  }
});

test("a compiler printer failure on a recursive alias falls back to its written type", () => {
  const source = "type Test<T extends unknown[]> = T extends [infer A, ...infer Rest] ? [A, ...Test<Rest>] : [];";
  const { program, checker, sourceFile } = programFor(source);
  const normalPrint = checker.typeToString.bind(checker);
  checker.typeToString = (type, ...args) => {
    if (type.flags & ts.TypeFlags.Conditional) throw new TypeError("failed to print recursive tuple");
    return normalPrint(type, ...args);
  };
  for (const fullExpansion of [false, true]) {
    const errors = [];
    const info = api.getTypeInfoAtPosition(
      ts,
      checker,
      sourceFile,
      source.indexOf("Test") + 1,
      { ...api.DEFAULT_OPTIONS, copy: true, fullExpansion },
      undefined,
      { compilerOptions: program.getCompilerOptions(), onError: (error) => errors.push(error) },
    );
    assert.deepEqual(errors, []);
    const copy = api.renderTypeInfo(info, 4);
    parses(copy);
    assert.match(copy, /\.\.\.Test<Rest>/);
    assert.equal(info.truncationReasons, undefined);
  }
});
