const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

const local = (name) => path.join(__dirname, name).split(path.sep).join("/");
const consumer = local("indexed-consumer.ts");
const library = local("indexed-library.d.ts");
const definition = `
  type Wrapped<O> = {
    [K in keyof O]: O[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : O[K]
  };
  interface Result<T> {
    value: T;
    read(value: T): T;
    maybe?: Wrapped<Result<T>>;
    other: Wrapped<Result<number>>;
    ready: Wrapped<Result<T>>;
  }
  interface Maybe<T> { candidate?: Wrapped<Maybe<T>>; value: T; }
  interface Api {
    <T>(value: T): Result<T>;
    poll: <T>(value: T) => Wrapped<Result<Awaited<T>>>;
    shadowed: <Result>(value: Result) => Wrapped<import("./indexed-library").Result<Result>>;
    last: "visible";
  }
  declare const api: Api;
  declare const onlyOptional: { value: Wrapped<Maybe<string>> };
  export { type Result, type Maybe, type Api, api, onlyOptional };
`;
const usage = 'import { api, onlyOptional, type Result } from "./indexed-library";\nvoid api; void onlyOptional;';

function compiler(source) {
  const files = { [consumer]: source, [library]: definition };
  const options = { strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.fileExists = (name) => Object.hasOwn(files, name) || fileExists(name);
  host.getSourceFile = (name, ...args) =>
    Object.hasOwn(files, name)
      ? ts.createSourceFile(name, files[name], options.target, true)
      : getSourceFile(name, ...args);
  return ts.createProgram([consumer], options, host);
}

test("copying recursive private mapped returns uses the public property with the same generic instantiation", () => {
  const program = compiler(usage);
  const file = program.getSourceFile(consumer);
  const checker = program.getTypeChecker();
  const original = checker.typeToString.bind(checker);
  let privatePrints = 0;
  checker.typeToString = (type, ...args) => {
    if (type.aliasSymbol?.name === "Wrapped") privatePrints++;
    return original(type, ...args);
  };
  function copy(name) {
    const info = api.getTypeInfoAtPosition(
      ts,
      checker,
      file,
      usage.indexOf("void " + name) + 6,
      { ...api.DEFAULT_OPTIONS, copy: true },
      undefined,
      {
        compilerOptions: program.getCompilerOptions(),
        onError: (error) => {
          throw error;
        },
      },
    );
    assert.ok(info);
    return api.renderTypeInfo(info, 0);
  }
  const copied = copy("api");
  assert.equal(privatePrints, 0, "An exact required property should avoid printing the private mapped type: " + copied);
  assert.match(copied, /Result<T>\["ready"\]/);
  assert.match(copied, /Result<Awaited<T>>\["ready"\]/);
  assert.match(copied, /import\("[^"]+"\)\.Result<Result>\["ready"\]/);
  assert.match(copied, /last: "visible"/);
  assert.doesNotMatch(copied, /Result<T>\["(?:maybe|other)"\]/);
  const optional = copy("onlyOptional");
  assert.ok(privatePrints > 0, "Only an optional property was available, so the compiler fallback is required");
  assert.doesNotMatch(optional, /Maybe<string>\["candidate"\]/);
  const pasted = copied.replace(/^const api:/, "declare const copied:");
  assert.notEqual(copied, pasted);
  const checked = compiler(
    usage + "\n" + pasted + ";\nconst original: typeof api = copied; const reverse: typeof copied = api;",
  );
  const diagnostics = [...checked.getSyntacticDiagnostics(), ...checked.getSemanticDiagnostics()];
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    pasted,
  );
});
