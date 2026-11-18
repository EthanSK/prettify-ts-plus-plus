const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");

// Insert both copies back into the hovered lexical scope. Checking assignability in both directions also catches
// a syntactically valid name that binds to a different enum, or a subset replaced by the whole enum.
function checkEnumCopies(source, modules = {}, exact = false) {
  const file = path.join(__dirname, "enum-scope-virtual.ts");
  const options = {
    strict: true,
    exactOptionalPropertyTypes: exact,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es5.d.ts"],
    types: [],
  };
  function programFor(main) {
    const files = new Map(Object.entries(modules).map(([name, text]) => [path.join(__dirname, name), text]));
    files.set(file, main);
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile } = host;
    host.fileExists = (name) => files.has(name) || fileExists(name);
    host.readFile = (name) => files.get(name) ?? readFile(name);
    return ts.createProgram([file], options, host);
  }

  const program = programFor(source);
  const marker = source.indexOf("type Test =") + "type ".length;
  assert.ok(source.includes("type Test =") && source.includes("/* paste */"));
  function render(mode) {
    const info = api.getTypeInfoAtPosition(
      ts,
      program.getTypeChecker(),
      program.getSourceFile(file),
      marker,
      { ...api.DEFAULT_OPTIONS, maxDepth: 8, ...mode },
      undefined,
      { compilerOptions: options, onError: (error) => assert.fail(error) },
    );
    assert.ok(info);
    assert.deepEqual(info.truncationReasons, undefined);
    return api.renderTypeInfo(info, 0);
  }
  const hover = render({});
  const copy = render({ copy: true });
  const full = render({ fullExpansion: true });
  const checks = `
    ${copy.replace(/^type Test\b/, "type Copy")}
    ${full.replace(/^type Test\b/, "type FullCopy")}
    type AcceptOriginal<T extends Test> = T;
    type AcceptCopy<T extends Copy> = T;
    type AcceptFullCopy<T extends FullCopy> = T;
    type Checks = [AcceptOriginal<Copy>, AcceptCopy<Test>, AcceptOriginal<FullCopy>, AcceptFullCopy<Test>];
  `;
  const checked = programFor(source.replace("/* paste */", () => checks));
  const diagnostics = [...checked.getSyntacticDiagnostics(), ...checked.getSemanticDiagnostics()];
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
    copy + "\n" + full,
  );
  return { hover, copy, full };
}

test("namespace enum subsets, singletons and whole enums use their actual enclosing names", () => {
  const { hover, copy, full } = checkEnumCopies(`
    enum Role { A = "unrelated", B = "different" }
    namespace Media {
      export enum Role { A = "a", B = "b", C = "c" }
      export namespace Audio { export enum Role { A = "x", B = "y", C = "z" } }
      export enum Only { Value = "v" }
    }
    type Test = { selected: Media.Role.A | Media.Role.B; other: Media.Audio.Role.A; single: Media.Only;
      all: Media.Role | Media.Audio.Role; optional?: Media.Role; };
    /* paste */
  `);
  for (const normal of [hover, copy]) {
    assert.match(normal, /selected: Media\.Role\.A \| Media\.Role\.B;/);
    assert.match(normal, /other: Media\.Audio\.Role\.A;/);
    assert.match(normal, /single: Media\.Only\.Value;/);
    assert.match(normal, /all: Media\.Role \| Media\.Audio\.Role;|all: Media\.Audio\.Role \| Media\.Role;/);
    assert.match(normal, /optional\?: Media\.Role;/);
  }
  assert.match(full, /optional\?: Media\.Role\.A \| Media\.Role\.B \| Media\.Role\.C;/);
});

test("enum names are resolved at the hovered declaration, including local enums and quoted members", () => {
  const { copy, full } = checkEnumCopies(`
    namespace Outer { export enum State { A = 4, B = 5, C = 6 } }
    function local() {
      enum State { A = 1, "on-air" = 2, "end!" = 3 }
      enum Single { "only value" = "v" }
      type Test = { outer: Outer.State.A; inner: State.A | (typeof State)["on-air"]; quoted: Single; };
      /* paste */
    }
  `);
  for (const text of [copy, full]) {
    assert.match(text, /outer: Outer\.State\.A;/);
    assert.match(text, /inner: State\.A \| \(typeof State\)\["on-air"\];/);
    assert.match(text, /quoted: \(typeof Single\)\["only value"\];/);
  }
});

test("renamed, namespace-imported and indirectly exposed enums keep their module identity", () => {
  const { hover, copy, full } = checkEnumCopies(
    `
      import type { Role as AudioRole, Remote } from "./enum-audio";
      import type * as Video from "./enum-video";
      enum Role { A = "decoy", B = "wrong" }
      type Test = { one: AudioRole.A; two: Video.Role.A; both: AudioRole | Video.Role; remote: Remote; };
      /* paste */
    `,
    {
      "enum-audio.ts": `export enum Role { A = "audio a", B = "audio b" }
        export enum Indirect { "on-air" = 0, Other = 1 }
        export type Remote = { all: Indirect; one: (typeof Indirect)["on-air"] };`,
      "enum-video.ts": 'export enum Role { A = "video a", B = "video b" }',
    },
  );
  for (const text of [hover, copy, full]) {
    assert.match(text, /one: AudioRole\.A;/);
    assert.match(text, /two: Video\.Role\.A;/);
  }
  assert.match(hover, /all: Indirect;/);
  assert.doesNotMatch(hover, /import\(/);
  assert.match(copy, /all: import\("[^"]*enum-audio"\)\.Indirect;/);
});

test("empty enums remain nominal and all-computed or large whole enums compact by identity", () => {
  const members = Array.from({ length: 18 }, (_, i) => "M" + i).join(", ");
  const { hover, copy, full } = checkEnumCopies(`
    declare function getCode(): number;
    namespace Codes {
      export enum Empty {}
      export enum Computed { A = getCode(), B = getCode() }
      export enum Large { ${members} }
    }
    type Test = { empty: Codes.Empty; computed: Codes.Computed; large: Codes.Large; };
    /* paste */
  `);
  for (const normal of [hover, copy]) {
    assert.match(normal, /empty: Codes\.Empty;/);
    assert.match(normal, /computed: Codes\.Computed;/);
    assert.match(normal, /large: Codes\.Large;/);
  }
  assert.match(full, /empty: Codes\.Empty;/);
  assert.match(full, /computed: Codes\.Computed\.A \| Codes\.Computed\.B;/);
});

test("private enum names reachable only through public properties retain their exact types", () => {
  const source = `
    import type { Remote } from "./enum-private";
    enum Hidden { A = "wrong a", B = "wrong b", C = "wrong c" }
    namespace Library {
      enum Hidden { A = "a", B = "b", C = "c" }
      export interface Public { item: Hidden.A; selected: Hidden.A | Hidden.B; all: Hidden }
      export type Optional = { item?: Hidden.A; explicit?: Hidden.B | undefined };
      export interface Generic<T> { value: T }
      export interface Container { wrapped: Generic<Hidden> }
    }
    type Test = {
      nested: Library.Public; direct: Library.Public["item"]; optional: Library.Optional;
      generic: Library.Container; remote: Remote;
    };
    /* paste */
  `;
  for (const exact of [false, true]) {
    const { copy, full } = checkEnumCopies(
      source,
      {
        "enum-private.ts": "enum Hidden { A = 1, B = 2 }; export interface Remote { item: Hidden; }",
      },
      exact,
    );
    for (const text of [copy, full]) {
      assert.match(text, /item: Library\.Public\["item"\]/);
      assert.match(text, /selected: Library\.Public\["selected"\]/);
      assert.match(text, /all: Library\.Public\["all"\]/);
      assert.match(text, /direct: Library\.Public\["item"\]/);
      assert.match(text, /item: Remote\["item"\]/);
      assert.match(text, /wrapped: Library\.Container\["wrapped"\]/);
      assert.doesNotMatch(text, /\bHidden\b|\bunknown\b/);
    }
  }
});

test("a root indexed access can name a private enum member", () => {
  const { copy, full } = checkEnumCopies(`
    namespace Library {
      enum Hidden { A = 1, B = 2 }
      export type Public = { value: Hidden.A };
    }
    type Test = Library.Public["value"];
    /* paste */
  `);
  for (const text of [copy, full]) assert.match(text, /^type Test = Library\.Public\["value"\]/);
});
