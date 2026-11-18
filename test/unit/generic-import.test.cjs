const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");
const local = (name) => path.resolve(__dirname, name).split(path.sep).join("/");
const consumer = local("generic-import-consumer.mts");
const library = local("generic-import-library.mts");
const barrel = local("generic-import-barrel.mts");
const definitions = `
interface Hidden { tag: "internal" }
export type Item<T extends Hidden = Hidden> = { value: T };
export interface Choice<T extends string = "yes"> { state: T }
export default interface DefaultChoice<T extends Hidden = Hidden> { selected: T }
export interface Plain { id: number }
export interface Merged<T> { first: T }
export interface Merged<T> { second: T }
export type { Choice as "arbitrary-name" };
`;

function compiler(source, dependency = definitions) {
  const files = {
    [consumer]: source,
    [library]: dependency,
    [barrel]:
      'export { default, type Item as External, type Choice, type Plain, type Merged, type "arbitrary-name" } from "./generic-import-library.mjs";',
  };
  const options = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.fileExists = (name) => Object.hasOwn(files, name) || fileExists(name);
  host.getSourceFile = (name, ...args) =>
    Object.hasOwn(files, name)
      ? ts.createSourceFile(name, files[name], options.target, true)
      : getSourceFile(name, ...args);
  return ts.createProgram([consumer], options, host);
}

function selection(program, marker, config = {}, guardExpansion = true) {
  const file = program.getSourceFile(consumer);
  const start = file.text.indexOf(marker);
  assert.ok(start >= 0, marker);
  const inner = program.getTypeChecker();
  const forbidden = new Set(["getTypeAtLocation", "getTypeFromTypeNode", "typeToString", "typeToTypeNode"]);
  const checker = guardExpansion
    ? new Proxy(inner, {
        get(target, property) {
          if (forbidden.has(property))
            return () => {
              throw new Error("Expanded generic import via " + property);
            };
          return target[property];
        },
      })
    : inner;
  const errors = [];
  const info = api.getTypeInfoAtPosition(
    ts,
    checker,
    file,
    start + 1,
    { ...api.DEFAULT_OPTIONS, ...config },
    undefined,
    { compilerOptions: program.getCompilerOptions(), onError: (error) => errors.push(error.message) },
  );
  assert.deepEqual(errors, []);
  assert.ok(info, marker);
  return info;
}

function diagnostics(program) {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

test("copying only the selected generic import preserves its binding, private constraints and defaults", () => {
  const source =
    'import LocalDefault, { type External as Local, Choice, Plain, "arbitrary-name" as Weird } from "./generic-import-barrel.mjs";';
  const program = compiler(source);
  const cases = [
    ["LocalDefault,", "LocalDefault", undefined, "selected"],
    ["External as", "Local", "External", "value"],
    ["Local,", "Local", "External", "value"],
    ["Choice,", "Choice", "Choice", "state"],
    ["Weird }", "Weird", "arbitrary-name", "state"],
  ];
  for (const [marker, localName, exportName, key] of cases) {
    for (const mode of [{ copy: true }, { fullExpansion: true }]) {
      const info = selection(program, marker, mode);
      assert.equal(info.name, localName);
      assert.equal(info.source, undefined);
      assert.equal(info.truncationReasons, undefined);
      const text = api.renderTypeInfo(info, 4);
      const file = ts.createSourceFile("copied.mts", text, ts.ScriptTarget.Latest, true);
      assert.equal(file.statements.length, 1);
      const statement = file.statements[0];
      assert.ok(ts.isImportDeclaration(statement));
      assert.equal(statement.moduleSpecifier.text, "./generic-import-barrel.mjs");
      assert.equal(statement.importClause.isTypeOnly, true);
      if (exportName) {
        const elements = statement.importClause.namedBindings.elements;
        assert.equal(statement.importClause.name, undefined);
        assert.equal(elements.length, 1);
        assert.equal(elements[0].name.text, localName);
        assert.equal((elements[0].propertyName ?? elements[0].name).text, exportName);
      } else {
        assert.equal(statement.importClause.name.text, localName);
        assert.equal(statement.importClause.namedBindings, undefined);
      }
      const expected = key === "state" ? '"yes"' : '{tag:"internal"}';
      const validArgument = key === "state" ? '"custom"' : '{tag:"internal",extra:1}';
      const usage = `type Defaults = ${localName}["${key}"]; declare const v: Defaults; const ok: ${expected} = v;
        type Valid = ${localName}<${validArgument}>;
        // @ts-expect-error The original generic constraint must still apply.
        type Invalid = ${localName}<123>;`;
      assert.deepEqual(diagnostics(compiler(text + "\n" + usage)), [], text);
    }
  }
});

test("generic import hovers show the bounded actual definition with its parameters and source location", () => {
  const source = 'import type { External as Local, Plain, Merged } from "./generic-import-barrel.mjs";';
  const program = compiler(source);
  const hover = selection(program, "Local,", { showSource: true });
  assert.match(api.renderTypeInfo(hover, 4), /import type \{ External as Local \}/);
  assert.equal(hover.source.fileName, library);
  assert.match(hover.source.text, /type Item<T extends Hidden = Hidden> = \{ value: T \}/);
  const inline = selection(program, "Local,", { showSource: false });
  assert.equal(inline.source, undefined);
  assert.match(api.renderTypeInfo(inline, 4), /Item<T extends Hidden = Hidden>/);
  assert.equal(selection(program, "Merged }", { showSource: true }).source, undefined);
  assert.match(
    api.renderTypeInfo(selection(program, "Plain,", { copy: true }, false), 0),
    /interface Plain \{ id: number; \}/,
  );
});

test("large generic import definitions are never expanded and copies retain resolution-mode attributes", () => {
  const dependency =
    definitions +
    "export type Large<T> = {\n" +
    Array.from({ length: 4000 }, (_, index) => "p" + index + ": T;").join("\n") +
    "\n};";
  const source =
    'import type { Large as Local } from "./generic-import-library.mjs" with { "resolution-mode": "import" };';
  const program = compiler(source, dependency);
  const hover = selection(program, "Local }", { showSource: true });
  assert.equal(hover.source.cut, true);
  assert.ok(hover.source.text.length <= api.SOURCE_LIMITS.characters);
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    const info = selection(program, "Local }", mode);
    const text = api.renderTypeInfo(info, 0);
    assert.ok(text.length < 180, text);
    assert.match(text, /with \{ "resolution-mode": "import" \}/);
    assert.deepEqual(diagnostics(compiler(text + "\ntype Last = Local<1>['p3999'];", dependency)), []);
  }
});
