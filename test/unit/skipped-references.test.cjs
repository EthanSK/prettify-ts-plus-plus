const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

test("copies reuse an exact skipped reference only while its type and value names still resolve", () => {
  const file = path.join(__dirname, "skipped-refs.ts").split(path.sep).join("/");
  const fields = Array.from({ length: 40 }, (_, index) => "field" + index + ': "value"').join(", ");
  const source = [
    "export {};",
    "const seed = { " + fields + " } as const;",
    "namespace Keys { export type Entry = 'original'; }",
    "declare const selected: Array<typeof seed>;",
    "declare const qualified: Array<Keys.Entry | typeof seed>;",
    "type Box<T> = { result: Array<T> }; declare const instance: Box<number>;",
    "function ordinary() { return [selected, qualified]; }",
    "function shadowValue() { const seed = 1; return selected; }",
    "namespace Shadow { namespace Keys { export type Entry = number; } export const result = qualified; }",
    ...Array.from({ length: 12 }, () => "void selected;"),
  ].join("\n");
  const options = { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const originalSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...args) =>
    name === file ? ts.createSourceFile(file, source, options.target, true) : originalSourceFile(name, ...args);
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(file);
  const errors = [];
  const print = checker.typeToString.bind(checker);
  let prints = 0;
  checker.typeToString = (...args) => {
    prints++;
    return print(...args);
  };
  function copied(position, fullExpansion = false) {
    const info = api.getTypeInfoAtPosition(
      ts,
      checker,
      sourceFile,
      position,
      { ...api.DEFAULT_OPTIONS, copy: true, fullExpansion },
      undefined,
      { compilerOptions: options, onError: (error) => errors.push(error) },
    );
    assert.ok(info, source.slice(position - 1, position + 16));
    assert.deepEqual(errors, []);
    return api.renderTypeInfo(info, 0);
  }
  const position = (needle, name) => {
    const start = source.indexOf(needle);
    assert.notEqual(start, -1, needle);
    return start + needle.indexOf(name) + 1;
  };
  for (const full of [false, true]) {
    assert.equal(copied(position("selected: Array", "selected"), full), "const selected: Array<typeof seed>");
    assert.equal(copied(position("[selected, qualified]", "selected"), full), "const selected: Array<typeof seed>");
    assert.equal(
      copied(position("[selected, qualified]", "qualified"), full),
      "const qualified: Array<Keys.Entry | typeof seed>",
    );
    for (const match of source.matchAll(/void selected/g)) {
      assert.equal(copied(match.index + "void s".length, full), "const selected: Array<typeof seed>");
    }
  }
  assert.equal(prints, 0, "Repeated copies should use the tiny authored reference without serializing its object");
  assert.match(copied(position("return selected;", "selected")), /field0:/);
  assert.doesNotMatch(copied(position("result = qualified;", "qualified")), /Array<Keys\.Entry \| typeof seed>/);
  assert.match(copied(position("instance: Box", "instance")), /result: Array<number>/);
});
