const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

test("a tuple or generic argument in a copied conditional preserves numeric infinities and real Infinity names", () => {
  const file = path.join(__dirname, "infinity-virtual.ts").split(path.sep).join("/");
  const source = `
    export interface Infinity { brand: "genuine type name" }
    type Positive = 1e999;
    type Negative = -1e999;
    type Pair<Values, Limit> = { values: Values; limit: Limit };
    type Test<N> = Positive extends N ? Positive
      : [N] extends [Negative] ? Negative
      : Pair<[], Negative> & { named: Infinity; Infinity: "-Infinity" };
  `;
  const options = { strict: true, target: ts.ScriptTarget.ESNext, lib: ["lib.es5.d.ts"], types: [] };
  function programFor(text) {
    const host = ts.createCompilerHost(options);
    const { readFile } = host;
    host.readFile = (name) => (name === file ? text : readFile(name));
    return ts.createProgram([file], options, host);
  }

  const program = programFor(source);
  const marker = source.indexOf("type Test") + "type ".length;
  for (const mode of [{ copy: true }, { fullExpansion: true }]) {
    const info = api.getTypeInfoAtPosition(
      ts,
      program.getTypeChecker(),
      program.getSourceFile(file),
      marker,
      { ...api.DEFAULT_OPTIONS, ...mode },
      undefined,
      { compilerOptions: options, onError: (error) => assert.fail(error) },
    );
    assert.ok(info);
    assert.equal(info.truncationReasons, undefined);
    const copied = api.renderTypeInfo(info, 0).replace(/^type Test</, "type Copied<");
    assert.match(copied, /1e999 extends N \? 1e999/);
    assert.match(copied, /\[N\] extends \[-1e999\] \? -1e999/);
    assert.match(copied, /Pair<\[\], -1e999>/);
    assert.match(copied, /named: Infinity;/);
    assert.match(copied, /Infinity: "-Infinity"/);
    const checked = programFor(
      source +
        "\n" +
        copied +
        `
      type Same<A, B> = [A, B] extends [B, A] ? true : false;
      type Check<T extends true> = T;
      type PositiveCase = Check<Same<Copied<Positive>, Positive>>;
      type NegativeCase = Check<Same<Copied<Negative>, Negative>>;
      type OtherCase = Check<Same<Copied<0>, { values: []; limit: Negative; named: Infinity; Infinity: "-Infinity" }>>;
    `,
    );
    const diagnostics = [...checked.getSyntacticDiagnostics(), ...checked.getSemanticDiagnostics()];
    assert.deepEqual(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      [],
    );
  }
});
