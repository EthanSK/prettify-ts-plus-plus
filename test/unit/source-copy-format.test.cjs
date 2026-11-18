const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

const virtualFile = (name) => path.join(__dirname, name).split(path.sep).join("/");
const mainFile = virtualFile("copy-format.ts");
const helperFile = virtualFile("copy-format-helpers.ts");
const options = { strict: true, target: ts.ScriptTarget.ESNext, lib: ["lib.es2015.d.ts"], types: [] };

function programFor(source, helper) {
  const files = new Map([
    [mainFile, source],
    [helperFile, helper],
  ]);
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile } = host;
  host.fileExists = (name) => files.has(name) || fileExists(name);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  return ts.createProgram([mainFile], options, host);
}

function checkCopies(source, helper, expected, instantiation = "") {
  const program = programFor(source, helper);
  const marker = source.indexOf("type Test") + "type ".length;
  const declarations = [];
  for (const fullExpansion of [false, true]) {
    const info = api.getTypeInfoAtPosition(
      ts,
      program.getTypeChecker(),
      program.getSourceFile(mainFile),
      marker,
      { ...api.DEFAULT_OPTIONS, copy: true, fullExpansion, maxDepth: 5 },
      undefined,
      { compilerOptions: options, onError: (error) => assert.fail(error) },
    );
    assert.ok(info);
    assert.equal(info.truncationReasons, undefined);
    for (const indentation of [0, 4]) {
      const text = api.renderTypeInfo(info, indentation);
      assert.doesNotMatch(text, /discard this comment/);
      for (const literal of expected) assert.ok(text.includes(literal), text);
      const name = "Copy" + declarations.length;
      declarations.push(
        text.replace(/^type Test\b/, "type " + name) +
          ";\n" +
          `type Check${name} = Same<Test${instantiation}, ${name}${instantiation}>;\n` +
          `type Exact${name} = Assert<Check${name}>;`,
      );
    }
  }
  const checked = programFor(
    source +
      "\ntype Same<A, B> = [A, B] extends [B, A] ? true : false; type Assert<T extends true> = T;\n" +
      declarations.join("\n"),
    helper,
  );
  const diagnostics = [...checked.getSyntacticDiagnostics(), ...checked.getSemanticDiagnostics()];
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    declarations.join("\n"),
  );
}

test("copied open conditionals format source comments and newline-separated fields without changing literals", () => {
  const template = "`start // literal\n  ${T}: /* still literal */ ${`nested-${T}`}`";
  const source = [
    'import type { Choose } from "./copy-format-helpers";',
    "type Test<T extends string /* discard this comment */> = Choose<T, {",
    '  address?: "https://example.test/semicolon;{}"',
    "  message: " + template,
    "  result: T extends string // discard this comment with ` and }",
    "    ? true : false",
    "}, never>;",
  ].join("\n");
  checkCopies(
    source,
    "export type Choose<T, Yes, No> = [T] extends [never] ? No : Yes;",
    ["https://example.test/semicolon;{}", template],
    '<"sample">',
  );
});

test("a skipped generic prints the literals and member separators from its own source file", () => {
  const helper = [
    "export interface Foreign {",
    "  lookup: Map<'https://foreign.test/a', {",
    "    label?: 'actual // string'",
    "    mode: 'a' | 'b' // discard this comment",
    "  }>;",
    "  flags: Map<'settings', {",
    "    active?: true",
    "    name: 'separate field'",
    "  }>;",
    "}",
  ].join("\n");
  checkCopies('import type { Foreign } from "./copy-format-helpers"; type Test = Foreign;', helper, [
    "https://foreign.test/a",
    "actual // string",
    "separate field",
  ]);
});
