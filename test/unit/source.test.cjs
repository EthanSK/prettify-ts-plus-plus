// Regressions for the authored source shown beneath the hover: which definition is chosen, where it links, how long
// definitions are shortened, and the cases that must show nothing rather than a guess. Run with `pnpm test:unit`; set
// PRETTIFY_TEST_TYPESCRIPT_PATH to run against another compiler, such as a project's TypeScript 6.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");
const local = (name) => path.join(__dirname, name).split(path.sep).join("/");
const ROOT = local("source-virtual.ts");

/**
 * A program over in-memory files; `allowNonTsExtensions` lets a `.vue` file stand in for Volar's generated code.
 * Claude Opus 5.5
 */
function analyse(files, marker, { root = ROOT, compilerOptions = {}, control = {}, ...overrides } = {}) {
  const options = { strict: true, target: ts.ScriptTarget.ESNext, noEmit: true, ...compilerOptions };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.getSourceFile = (name, ...args) =>
    Object.hasOwn(files, name)
      ? ts.createSourceFile(name, files[name], options.target, true, name.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS)
      : getSourceFile(name, ...args);
  host.fileExists = (name) => Object.hasOwn(files, name) || fileExists(name);
  const program = ts.createProgram([root], options, host);
  const sourceFile = program.getSourceFile(root);
  assert.ok(sourceFile, root);
  const at = files[root].lastIndexOf(marker);
  assert.ok(at >= 0, "marker " + marker);
  const errors = [];
  const info = api.getTypeInfoAtPosition(
    ts,
    program.getTypeChecker(),
    sourceFile,
    at + 1,
    { ...api.DEFAULT_OPTIONS, groupNeverProperties: true, showSource: true, ...overrides },
    undefined,
    { compilerOptions: program.getCompilerOptions(), onError: (error) => errors.push(error), ...control },
  );
  assert.deepEqual(errors, []);
  return info;
}

function infoAt(files, marker, options) {
  const info = analyse(files, marker, options);
  assert.ok(info, "Expected plugin type info at " + marker);
  return info;
}

const sourceAt = (text, marker, options) => infoAt({ [ROOT]: text }, marker, options).source;

const EXACTLY_ONE_OF = `type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ExactlyOneOf<TAlternatives extends readonly object[]> = {
  [I in keyof TAlternatives]: TAlternatives[I] & {
    [K in Exclude<KeysOfUnion<TAlternatives[number]>, KeysOfUnion<TAlternatives[I]>>]?: never;
  };
}[number];
`;
const UPDATE = `export type OperationStatusStateUpdate = ExactlyOneOf<
  [{ statusState: "running" }, { statusState: "failure"; errorCode: string }, { abortCode: "a" | "b" }]
>;`;

test("OperationStatusStateUpdate shows its authored ExactlyOneOf at the declaration, references and annotations", () => {
  const text = EXACTLY_ONE_OF + UPDATE + "\ndeclare const update: OperationStatusStateUpdate;\nupdate;";
  const expected = { text: UPDATE, fileName: ROOT, line: 6, character: 0 };
  assert.deepEqual(sourceAt(text, "OperationStatusStateUpdate = "), expected);
  // The reference in a type position, then the annotated value that names it.
  assert.deepEqual(sourceAt(text, "OperationStatusStateUpdate;"), expected);
  assert.deepEqual(sourceAt(text, "update;"), expected);
  // The expansion is unchanged by the source.
  const withSource = infoAt({ [ROOT]: text }, "OperationStatusStateUpdate = ");
  const without = infoAt({ [ROOT]: text }, "OperationStatusStateUpdate = ", { showSource: false });
  assert.equal(without.source, undefined);
  assert.deepEqual({ ...withSource, source: undefined }, { ...without, source: undefined });
});

test("imported and re-exported aliases link to the file that defines them", () => {
  const dependency = local("source-dependency.ts");
  const reexport = local("source-reexport.ts");
  const files = {
    [ROOT]: 'import type { Renamed } from "./source-reexport";\ntype Test = Renamed;',
    [dependency]: EXACTLY_ONE_OF + UPDATE,
    [reexport]: 'export type { OperationStatusStateUpdate as Renamed } from "./source-dependency";',
  };
  assert.deepEqual(infoAt(files, "Renamed;").source, { text: UPDATE, fileName: dependency, line: 6, character: 0 });
});

test("scoped and generic declarations keep their spelling and relative whitespace", () => {
  const text = `namespace Api {
  export namespace V1 {
    export type Update = Pick<
      { a: 1; b: 2 },
      "a"
    >;
  }
}
type Box<T> = { value: T };
type Test = Api.V1.Update | Box<string>;`;
  assert.deepEqual(sourceAt(text, "Update |"), {
    text: 'export type Update = Pick<\n  { a: 1; b: 2 },\n  "a"\n>;',
    fileName: ROOT,
    line: 2,
    character: 4,
  });
  assert.equal(sourceAt(text, "Box<string>").text, "type Box<T> = { value: T };");
  // `Api` is a namespace, not a type definition.
  assert.equal(sourceAt(text, "Api.V1.Update"), undefined);
});

test("annotated variables, properties and parameters show the annotation, never the initializer", () => {
  const text = `${EXACTLY_ONE_OF}
const value: ExactlyOneOf<[{ a: 1 }, { b: 2 }]> = { a: 1 };
interface Holder { readonly update?: ExactlyOneOf<[{ a: 1 }, { b: 2 }]> }
declare const holder: Holder;
function run(...choices: ExactlyOneOf<[{ a: 1 }, { b: 2 }]>[]) { const secret = 1; return choices; }
value; holder.update; run;`;
  // At the declaration: a later reference would be narrowed by the initializer, so it would not match.
  assert.equal(sourceAt(text, "value: ").text, "value: ExactlyOneOf<[{ a: 1 }, { b: 2 }]>");
  // The optional property's added `undefined` still matches what was written.
  assert.equal(sourceAt(text, "update;").text, "update?: ExactlyOneOf<[{ a: 1 }, { b: 2 }]>");
  assert.equal(sourceAt(text, "choices: ").text, "...choices: ExactlyOneOf<[{ a: 1 }, { b: 2 }]>[]");
  // A function is not a type definition, and its body is never read.
  assert.equal(sourceAt(text, "run;"), undefined);
});

test("ambiguous definitions show nothing rather than a different declaration", () => {
  const cases = [
    // Merged interfaces, a class (a body, not a type expression) and an enum.
    ["interface Merged { a: 1 } interface Merged { b: 2 } type Test = Merged;", "Merged;"],
    ["class Thing { x = 1; method() { return 'secret'; } } type Test = Thing;", "Thing;"],
    ["enum Mode { A, B } type Test = Mode;", "Mode;"],
    // A value without an annotation, and a value sharing its name with a type.
    ["const plain = { a: 1 }; plain;", "plain;"],
    ["const Same = { a: 1 }; type Same = { b: 2 }; Same;", "Same;"],
    // A narrowed value and an instantiated generic property no longer match their annotations.
    ["declare let wide: string | number; if (typeof wide === 'string') { wide; }", "wide; }"],
    ["interface Generic<T> { value: T } declare const generic: Generic<string>; generic.value;", "value;"],
    // A bare reference to something that is not an alias or interface.
    ["class Shape { side = 1 } declare const shape: Shape; shape;", "shape;"],
  ];
  for (const [text, marker] of cases) assert.equal(sourceAt(text, marker), undefined, text);
});

test("copies never carry the source, whatever the request says", () => {
  const text = EXACTLY_ONE_OF + UPDATE;
  for (const options of [{ copy: true }, { fullExpansion: true }]) {
    assert.equal(infoAt({ [ROOT]: text }, "OperationStatusStateUpdate = ", options).source, undefined);
  }
  assert.equal(api.normalizeOptions({ showSource: true, copy: true }).showSource, false);
  assert.equal(api.normalizeOptions({ showSource: "yes" }).showSource, false);
  assert.equal(api.normalizeOptions({ showSource: true }).showSource, true);
});

test("long definitions are shortened by lines and by characters, and say so", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `  field${index}: string;`).join("\n");
  const tall = sourceAt(`type Test = {\n${lines}\n};`, "Test");
  assert.equal(tall.cut, true);
  assert.equal(tall.text.split("\n").length, api.SOURCE_LIMITS.lines);
  assert.ok(tall.text.startsWith("type Test = {\n  field0: string;"));
  const wide = sourceAt(`type Test = ${Array.from({ length: 400 }, (_, index) => `"value${index}"`).join(" | ")};`, "Test");
  assert.equal(wide.cut, true);
  assert.ok(wide.text.length <= api.SOURCE_LIMITS.characters);
  // A cut never splits a surrogate pair.
  const emoji = sourceAt(`type Test = "${"😀".repeat(1000)}";`, "Test");
  assert.equal(emoji.cut, true);
  assert.doesNotMatch(emoji.text, /[\uD800-\uDBFF]$/);
  assert.equal(sourceAt("type Test = { a: 1 };", "Test").cut, undefined);
});

test("generated Vue code and JSDoc types are never shown as authored source", () => {
  const vue = local("Component.vue");
  const vueText = EXACTLY_ONE_OF + UPDATE;
  const fromVue = infoAt({ [vue]: vueText }, "OperationStatusStateUpdate = ", {
    root: vue,
    compilerOptions: { allowNonTsExtensions: true },
  });
  assert.ok(fromVue.typeTree);
  assert.equal(fromVue.source, undefined);
  const js = local("source-virtual.js");
  const jsText = "/** @typedef {{ a: string }} Shape */\n/** @type {Shape} */\nconst shape = { a: '' };\nshape;";
  const fromJs = infoAt({ [js]: jsText }, "shape;", { root: js, compilerOptions: { allowJs: true, checkJs: true } });
  assert.equal(fromJs.source, undefined);
});

test("cancellation still discards the whole result", () => {
  const control = { isCancellationRequested: () => true };
  assert.equal(analyse({ [ROOT]: EXACTLY_ONE_OF + UPDATE }, "OperationStatusStateUpdate = ", { control }), undefined);
});
