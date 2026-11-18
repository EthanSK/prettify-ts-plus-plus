const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

function programFor(source, exact = true) {
  const file = path.join(__dirname, "compiler-audit.ts").split(path.sep).join("/");
  const options = { strict: true, exactOptionalPropertyTypes: exact, target: ts.ScriptTarget.ESNext, types: [] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...args) =>
    name === file ? ts.createSourceFile(name, source, options.target, true) : getSourceFile(name, ...args);
  const program = ts.createProgram([file], options, host);
  return { program, checker: program.getTypeChecker(), file: program.getSourceFile(file) };
}

function render(source, config = {}, exact = true, marker, expectedLimits) {
  const { program, checker, file } = programFor(source, exact);
  const position = marker
    ? source.indexOf(marker)
    : file.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === "Test").name.getStart(file);
  assert.ok(position >= 0, marker);
  const result = api.getTypeInfoAtPosition(
    ts,
    checker,
    file,
    position + 1,
    { ...api.DEFAULT_OPTIONS, maxDepth: 8, ...config },
    undefined,
    {
      compilerOptions: program.getCompilerOptions(),
      onError: (error) => {
        throw error;
      },
    },
  );
  assert.ok(result);
  assert.deepEqual(result.truncationReasons, expectedLimits);
  return api.renderTypeInfo(result, 0);
}

/** Asking the compiler to use the pasted declaration catches errors the parser and text snapshots cannot. */
function checkCopy(source, config = {}, uses = "", exact = true) {
  const text = render(source, { copy: true, ...config }, exact);
  const copied = text.replace(/^type Test\b/, "type Copied");
  assert.notEqual(text, copied);
  const { program, file } = programFor(source + "\n" + copied + ";\n" + uses, exact);
  const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    text,
  );
  return text;
}

const assignBothWays = "declare let original: Test; declare let copy: Copied; original = copy; copy = original;";

test("unlabeled optional tuple slots group type operators, conditionals and readonly elements", () => {
  const source =
    "type Test<T> = [(keyof T)?, (T extends string ? 1 : 2)?, (readonly string[])?, " +
    "(readonly [number])?, string[]?];";
  const uses =
    "declare let original: Test<{ x: 0 }>; declare let copy: Copied<{ x: 0 }>; " +
    "original = copy; copy = original; copy = []; copy = ['x', 2, ['a'], [3], []];";
  for (const exact of [true, false]) {
    const text = checkCopy(source, {}, uses, exact);
    assert.match(text, /\(keyof T\)\?, \(T extends string \? 1 : 2\)\?/);
    assert.match(text, /\(readonly string\[\]\)\?, \(readonly \[number\]\)\?, string\[\]\?/);
  }
});

test("abstract constructors retain abstractness and static intersections", () => {
  const source =
    "declare abstract class Base { id: number } " +
    "declare abstract class Child extends Base { static version: string } " +
    "type Test = { factory: abstract new (id: number) => Base; inherited: typeof Child; " +
    "both: (abstract new () => Base) & { version: string }; concrete: new () => Base };";
  for (const mode of [{}, { fullExpansion: true }]) {
    const text = checkCopy(source, mode, assignBothWays);
    assert.match(text, /abstract new \(id: number\) => Base/);
    assert.match(text, /concrete: new \(\) => Base/);
  }
});

test("nested private and protected class identities survive copies, including factored unions", () => {
  const source =
    "class Secret<T> { #brand!: T; shared = 1; common = ''; public value!: T } " +
    "declare class Protected<T> { protected brand: T; common: string; shared: number } " +
    "interface Sub extends Protected<string> { extra: boolean } " +
    "type Test = { secret: Secret<number>; either: Secret<number> | Sub; '#public': number };";
  for (const mode of [{}, { hidePrivateProperties: false, factorSharedUnionProperties: true }]) {
    const text = checkCopy(source, mode, assignBothWays);
    assert.match(text, /secret: Secret<number>/);
    assert.match(text, /"#public": number/);
  }
  const preview = render(source);
  assert.match(preview, /value: number/);
  assert.doesNotMatch(preview, /#brand|protected brand/);
});

test("unique symbol values use the original symbol in fields, unions, arrays and signatures", () => {
  const source =
    "declare const key: unique symbol; namespace N { export declare const key: unique symbol; " +
    "export interface Brand { readonly id: unique symbol } } " +
    "type Test = { local: typeof key; foreign: typeof N.key; iterator: typeof Symbol.iterator; " +
    "nullable: typeof N.key | null; ids: N.Brand['id'][]; echo: (id: typeof N.key) => typeof key };";
  for (const mode of [{}, { fullExpansion: true }, { unwrapFunctions: false }]) {
    const text = checkCopy(source, mode, assignBothWays);
    assert.match(text, /foreign: typeof N\.key;/);
    assert.match(text, /iterator: typeof Symbol\.iterator;/);
    assert.match(text, /ids: N\.Brand\["id"\]\[\];/);
  }
  assert.match(render(source), /iterator: typeof Symbol\.iterator;/);
});

test("a copied declaration can still introduce its own unique symbol field", () => {
  const source = "type Test = { nested: { readonly marker: unique symbol } };";
  assert.match(checkCopy(source), /readonly marker: unique symbol;/);
});

test("copied methods preserve overloads and TypeScript's method parameter variance", () => {
  const source =
    "interface Parent { id: number } interface Child extends Parent { more: string } " +
    "interface Handlers { event(e: Parent): void; optional?(e: Parent): void; " +
    "over(e: Parent): 1; over(e: string): 2; property: (e: Parent) => void } " +
    "type Test = { handlers: Handlers; single: Handlers['event']; readonlySet: Readonly<Handlers> };";
  const uses =
    "declare let copy: Copied; declare const childMethod: (e: Child) => void; " +
    "copy.handlers.event = childMethod; copy.handlers.optional = childMethod; copy.single = childMethod; " +
    "const readonlyHandler: Copied['readonlySet']['event'] = childMethod; " +
    "// @ts-expect-error A function-valued property has stricter parameters than a method.\n" +
    "copy.handlers.property = childMethod; " +
    "// @ts-expect-error The mapped field is still readonly.\n" +
    "copy.readonlySet.event = childMethod; const overload: 2 = copy.handlers.over('text');";
  const text = checkCopy(source, { fullExpansion: true }, uses);
  assert.match(text, /over\(e: \{ id: number; \}\): 1; over\(e: string\): 2;/);
  assert.match(text, /property: \(e: \{ id: number; \}\) => void/);
});

test("private symbol identities exposed through accessible object properties round-trip", () => {
  const source =
    "type Brand = { readonly id: unique symbol }; namespace Api { const hidden = Symbol(); " +
    "export type Public = { token: typeof hidden }; } " +
    "type Test = { direct: Brand['id']; nested: Brand; api: Api.Public };";
  for (const mode of [{}, { fullExpansion: true }]) checkCopy(source, mode, assignBothWays);
});

test("getter and setter types keep distinct read and write assignments, including instantiated accessors", () => {
  const source =
    "interface Field<T> { get value(): number; set value(v: T | number); } " +
    "interface Inherited extends Field<boolean> { tag: string } " +
    "type Test = { get text(): number; set text(input: string | number); " +
    "nested: Field<Date>; inherited: Inherited; mapped: Pick<Field<string>, 'value'> };";
  const uses =
    "declare let value: Copied; const n: number = value.text; value.text = '7'; " +
    "value.nested.value = new Date(); value.inherited.value = true; " +
    "// @ts-expect-error The getter only returns numbers.\nconst str: string = value.nested.value; " +
    "// @ts-expect-error A mapped property uses the read type for writes.\nvalue.mapped.value = '7';";
  for (const mode of [{}, { fullExpansion: true }]) {
    const text = checkCopy(source, mode, uses);
    assert.match(text, /get text\(\): number; set text\(value: string \| number\);/);
  }
});

test("factoring shared fields does not merge setters that accept different values", () => {
  const source =
    "type Test = { tag: 's'; shared: 1; common: 2; get value(): number; set value(v: number | string) } | " +
    "{ tag: 'b'; shared: 1; common: 2; get value(): number; set value(v: number | boolean) };";
  const uses =
    "declare let copied: Copied; if (copied.tag === 's') { copied.value = 'str'; " +
    "// @ts-expect-error The string branch rejects booleans.\ncopied.value = true; " +
    "} else { copied.value = true; " +
    "// @ts-expect-error The boolean branch rejects strings.\ncopied.value = 'str'; }";
  checkCopy(source, { factorSharedUnionProperties: true }, uses);
});

test("nominal types stay named through root aliases, public containers, and anonymous class variables", () => {
  checkCopy("declare class Nominal { private id: number } type Test = Nominal & { name: string };", {}, assignBothWays);
  const source =
    "namespace N { class Hidden { private key = 0 } export interface Public { value: Hidden } } " +
    "const instance = new class { private brand = 0; name = '' }; " +
    "type Test = { api: N.Public; anonymous: typeof instance };";
  const text = checkCopy(source, { fullExpansion: true }, assignBothWays);
  assert.doesNotMatch(text, /\(Anonymous class\)|value: Hidden/);
});

test("root class variable copies show configured fields and preserve the original private identity", () => {
  const source =
    "declare class FilteringExample { publicField: string; _publicField: string; " +
    "private privateField: '*/'; protected protectedField: number } declare let sample: FilteringExample; sample;";
  for (const fullExpansion of [false, true]) {
    for (const hidePrivateProperties of [false, true]) {
      for (const treatUnderscoreAsPrivate of [false, true]) {
        const options = { copy: true, fullExpansion, hidePrivateProperties, treatUnderscoreAsPrivate };
        const text = render(source, options, true, "sample:");
        assert.match(text, /^let sample: FilteringExample & \{ publicField: string;/);
        assert.equal(text.includes("_publicField:"), !hidePrivateProperties || !treatUnderscoreAsPrivate);
        assert.equal(text.includes("privateField:"), !hidePrivateProperties);
        assert.equal(text.includes("protectedField:"), !hidePrivateProperties);
        const copied = text.replace(/^let sample:/, "declare let copied:");
        const uses =
          "sample = copied; copied = sample; " +
          "// @ts-expect-error Ordinary objects lack the class's private identity.\n" +
          "copied = { publicField: 'x', _publicField: 'y' };";
        const { program, file } = programFor(source + "\n" + copied + ";\n" + uses);
        assert.deepEqual(
          [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map((d) =>
            ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          ),
          [],
          text,
        );
      }
    }
  }
  assert.match(render(source, { copy: true }, true, "sample;"), /FilteringExample & \{ publicField: string;/);
});

test("an unnameable root class variable still shows fields and marks its omitted private identity", () => {
  const source = "const sample = new class { private brand = 1; publicField = 'hello' }();";
  assert.match(
    render(source, { copy: true }, true, "sample =", ["private class identity omitted"]),
    /publicField: string;/,
  );
});
