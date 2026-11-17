// Regression tests for the Prettify TS++ readability changes: named enums and incomplete named unions, proven
// `?: never` keys (exact fidelity in copies, one grouped line in hovers) and opt-in shared union properties.
// Each test checks meaning, not implementation: copies must stay equivalent TypeScript under the compiler, and hovers
// must keep every invalid state visible. Run with `pnpm test:unit` (bundled by scripts/test-unit.js); set
// PRETTIFY_TEST_TYPESCRIPT_PATH to run against another compiler, such as a project's TypeScript 6.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ts = require(process.env.PRETTIFY_TEST_TYPESCRIPT_PATH || "typescript");
const api = require("../out-unit/entry");
const file = path.join(__dirname, "readability-virtual.ts").split(path.sep).join("/");

function programFor(source, exact) {
  const options = { strict: true, exactOptionalPropertyTypes: exact, target: ts.ScriptTarget.ESNext, noEmit: true };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile;
  host.getSourceFile = (name, ...args) =>
    name === file ? ts.createSourceFile(name, source, options.target, true) : original(name, ...args);
  const program = ts.createProgram([file], options, host);
  return { program, checker: program.getTypeChecker(), sourceFile: program.getSourceFile(file) };
}

/**
 * Hover defaults unless overridden: Max Depth 1 and the default union limit, as Ethan uses them, requested the way
 * this fork's client does (it declares that it renders grouped never keys).
 */
function render(source, { marker = "Test", exact = false, ...overrides } = {}) {
  const { program, checker, sourceFile } = programFor(source, exact),
    errors = [];
  const at = source.lastIndexOf(marker);
  assert.ok(at >= 0, "marker " + marker);
  const info = api.getTypeInfoAtPosition(
    ts,
    checker,
    sourceFile,
    at + 1,
    { ...api.DEFAULT_OPTIONS, skippedTypeNames: [], groupNeverProperties: true, ...overrides },
    undefined,
    { compilerOptions: program.getCompilerOptions(), onError: (error) => errors.push(error) },
  );
  assert.deepEqual(errors, []);
  assert.ok(info, "Expected plugin type info");
  const text = api.renderTypeInfo(info, 0);
  return { info, text, hover: api.hoverMarkers(text) };
}

/**
 * Copy output for `type Test = ...` must parse and be mutually assignable with the original, with no diagnostics.
 * Depth and union limits are lifted because their (marked) truncation is intentionally not equivalent.
 */
function equivalentCopy(source, { exact = false, ...overrides } = {}) {
  const { text } = render(source, { exact, copy: true, maxDepth: 8, maxUnionMembers: 100, ...overrides });
  const actual = text.replace(/^type Test\b/, "type Actual");
  const { program, checker, sourceFile } = programFor(source + "\n" + actual, exact);
  assert.deepEqual(
    program.getSemanticDiagnostics(sourceFile).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    text,
  );
  const aliases = sourceFile.statements.filter(ts.isTypeAliasDeclaration);
  const left = checker.getTypeAtLocation(aliases.find((node) => node.name.text === "Test"));
  const right = checker.getTypeAtLocation(aliases.find((node) => node.name.text === "Actual"));
  assert.ok(checker.isTypeAssignableTo(left, right), "original -> copy\n" + text);
  assert.ok(checker.isTypeAssignableTo(right, left), "copy -> original\n" + text);
  return text;
}

const MODEL_ENUM = 'enum Model { A = "a", B = "b", C = "c", D = "d" } enum Code { X = 1, Y = 2 }';

test("whole enums inside a hovered type keep their name; subsets and single members stay listed", () => {
  const { text } = render(
    MODEL_ENUM +
      ' enum Only { Value = "v" } type Test = { model: Model; optionalModel?: Model; code: Code | Model;' +
      " subset: Exclude<Model, Model.D>; only: Only; withNone: Model | null; };",
  );
  assert.match(text, /model: Model;/);
  assert.match(text, /optionalModel\?: Model;/);
  assert.match(text, /code: Code \| Model;|code: Model \| Code;/);
  assert.match(text, /subset: Model\.A \| Model\.B \| Model\.C;/);
  assert.match(text, /only: Only\.Value;/);
  assert.match(text, /withNone: Model \| null;/);
  assert.doesNotMatch(text, /Model\.D/);
});

test("the hovered enum itself still lists its members, so the hover is not just its name", () => {
  assert.match(render(MODEL_ENUM + " type Test = Model;").text, /Model\.A \| Model\.B \| Model\.C \| Model\.D/);
  assert.match(
    render(MODEL_ENUM + " declare const Test: Model | undefined;").text,
    /Model\.A \| Model\.B \| Model\.C \| Model\.D \| undefined/,
  );
  // A union of several whole enums at the root is a useful one-level expansion.
  assert.match(render(MODEL_ENUM + " type Test = Model | Code;").text, /= Model \| Code|= Code \| Model/);
});

test("enum names stay valid and equivalent in copies; full copies keep listing members as before", () => {
  equivalentCopy(MODEL_ENUM + " type Test = { model?: Model; code: Code | Model; subset: Exclude<Model, Model.A> };");
  const full = render(MODEL_ENUM + " type Test = { model: Model };", { fullExpansion: true }).text;
  assert.match(full, /Model\.A \| Model\.B \| Model\.C \| Model\.D/);
});

const BIG_UNION =
  "type Big = " +
  Array.from({ length: 20 }, (_, index) => JSON.stringify("v" + index)).join(" | ") +
  "; type Source = 'generated' | 'uploaded';";

test("named unions are named only where their expansion would be incomplete", () => {
  const { text } = render(
    BIG_UNION +
      " type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; size: number };" +
      " type Test = { big: Big; optionalBig?: Big; source: Source; shape: Shape; };",
  );
  assert.match(text, /big: Big;/);
  assert.match(text, /optionalBig\?: Big;/);
  // A short literal union is complete, so its values are more useful than its name.
  assert.match(text, /source: "generated" \| "uploaded";/);
  // Unnamed object members at Max Depth would only show `{ ... 2 more }`.
  assert.match(text, /shape: Shape;/);
  // With more depth, the union's shape is shown.
  assert.match(
    render(BIG_UNION + " type Shape = { kind: 'a' } | { kind: 'b' }; type Test = { shape: Shape };", {
      maxDepth: 2,
    }).text,
    /shape: \{ kind: "a"; \} \| \{ kind: "b"; \};/,
  );
});

test("a named union is never given a name that does not describe this exact union", () => {
  // The annotation `Many<T>` is generic: its members are not this instantiation's members, so no name is used.
  const generic = render(
    "type Many<T> = T | " +
      Array.from({ length: 20 }, (_, index) => JSON.stringify("m" + index)).join(" | ") +
      '; interface Box<T> { value?: Many<T> } declare const Test: Box<"z">;',
  ).text;
  assert.doesNotMatch(generic, /Many<T>/);
  // A transformed subset has no alias of its own (the compiler prints it expanded too): it must not be called `Big`.
  const subset = render(BIG_UNION + ' type Test = { value?: Exclude<Big, "v0"> };').text;
  assert.doesNotMatch(subset, /value\?: Big/);
  assert.match(subset, /value\?: "v1" \| .*\/\* \| \.\.\. 4 more \*\//);
  // The hovered union itself still expands.
  assert.doesNotMatch(render(BIG_UNION + " type Test = Big;").text, /= Big$/m);
  equivalentCopy(BIG_UNION + ' type Test = { big: Big; optionalBig?: Big; value?: Exclude<Big, "v0"> };');
});

const MAYBE =
  "type Maybe = " +
  Array.from({ length: 20 }, (_, index) => JSON.stringify("v" + index)).join(" | ") +
  " | undefined; type MaybeShape = { kind: 'a'; r: number } | { kind: 'b'; s: string } | undefined;" +
  " type NoUndefined<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };";

test("a mapping that removes undefined never shows the wider source alias", () => {
  for (const exact of [false, true]) {
    for (const source of [
      // Without exact optional types, `-?` removes the alias's undefined (`x: "v0" | ...`); with them the compiler
      // keeps `x: Maybe`, so only the non-exact case must avoid the name.
      ...(exact ? [] : ["type Test = Required<{ x?: Maybe; s?: MaybeShape }>;"]),
      "type Test = NoUndefined<{ x?: Maybe; s?: MaybeShape }>;",
      "type Test = { x: Exclude<Maybe, undefined>; s: Exclude<MaybeShape, undefined> };",
    ]) {
      const { text } = render(MAYBE + " " + source, { exact });
      assert.doesNotMatch(text, /x: Maybe|s: MaybeShape/, source + "\n" + text);
    }
    if (exact) assert.match(render(MAYBE + " type Test = Required<{ x?: Maybe }>;", { exact }).text, /x: Maybe;/);
    // The optional source keeps its name: `x?: Maybe` is exactly what was written.
    assert.match(
      render(MAYBE + " type Test = { x?: Maybe; s?: MaybeShape };", { exact }).text,
      /x\?: Maybe; s\?: MaybeShape;/,
    );
  }
});

test("Copy Prettified Type at real limits stays equivalent where names replace incomplete expansions", () => {
  const limits = { maxDepth: 1, maxUnionMembers: 15 };
  for (const exact of [false, true]) {
    const copy = equivalentCopy(
      BIG_UNION +
        " " +
        MAYBE +
        " type Pair<T> = { kind: 'a'; value: T } | { kind: 'b'; other: T } | { kind: 'c' };" +
        " type Test = { big: Big; optionalBig?: Big; maybe?: Maybe; required: Maybe; pair: Pair<string>; shape?: MaybeShape };",
      { exact, ...limits },
    );
    assert.match(
      copy,
      /big: Big; optionalBig\?: Big; maybe\?: Maybe; required: Maybe; pair: Pair<string>; shape\?: MaybeShape;/,
    );
  }
});

const OPERATION_STATUS = `
enum AbortCode { UserCancelled = "userCancelled", PrerequisiteFailed = "prerequisiteFailed" }
type StatusState = "running" | "success" | "failure" | "aborted";
type AbortTarget = { abortCode: AbortCode; message: string };
type ResultFeedbackTarget = { restoredCredits?: number };
type Test = {
  [State in StatusState]: { statusState: State } & (State extends "aborted"
    ? Pick<AbortTarget, "abortCode" | "message">
    : { [K in keyof Pick<AbortTarget, "abortCode">]?: never }) &
    (State extends "failure" ? { [K in keyof Pick<ResultFeedbackTarget, "restoredCredits">]?: never } : unknown);
}[StatusState];`;

test("screenshot type: forbidden keys are listed as never on one line, never hidden", () => {
  for (const exact of [false, true]) {
    const { text } = render(OPERATION_STATUS, { exact });
    assert.match(text, /\{ statusState: "failure"; \/\* never: abortCode, restoredCredits \*\/ \}/);
    assert.match(text, /\{ statusState: "running"; abortCode\?: never; \}/);
    assert.match(text, /\{ statusState: "aborted"; abortCode: AbortCode; message: string; \}/);
    assert.doesNotMatch(text, /\?: undefined/);
  }
});

test("older clients that cannot render the never line still get every key as a property", () => {
  const { text, info } = render(OPERATION_STATUS, { groupNeverProperties: false });
  assert.match(text, /\{ statusState: "failure"; abortCode\?: never; restoredCredits\?: never; \}/);
  assert.doesNotMatch(JSON.stringify(info), /neverProperties/);
});

test("copies keep each never key, so pasted types still reject an abort code on failure", () => {
  for (const exact of [false, true]) {
    const text = equivalentCopy(OPERATION_STATUS, { exact });
    assert.match(text, /abortCode\?: never; restoredCredits\?: never;/);
    assert.doesNotMatch(text, /\/\* never/);
  }
});

test("written ?: never keeps its meaning; explicit ?: undefined is distinguished from it", () => {
  for (const exact of [false, true]) {
    const { text } = render("type Test = { a?: never; b?: undefined; c?: string | undefined };", { exact });
    assert.match(text, /a\?: never;/);
    assert.match(text, /b\?: undefined;/);
    equivalentCopy("type Test = { a?: never; b?: undefined; c?: string | undefined };", { exact });
  }
  // With exactOptionalPropertyTypes the earlier `a?: undefined` was wrong: explicit undefined is rejected.
  const exactCopy = equivalentCopy("type Test = { a?: never; b: string };", { exact: true });
  assert.match(exactCopy, /a\?: never;/);
});

test("never is claimed only when proven; unproven cases keep the earlier per-key output", () => {
  // Partial's template is T[K]: the source said never, but without exact optional types that is not provable here.
  assert.match(render("type Test = Partial<{ a: never; b: string }>;").text, /a\?: undefined;/);
  // With exact optional types the type itself proves it ("missing" only).
  assert.match(render("type Test = Partial<{ a: never; b: string }>;", { exact: true }).text, /a\?: never;/);
  // Readonly cannot be shown in the grouped line, so readonly keys stay as properties.
  const readonly = render("type Test = { readonly a?: never; readonly b?: never; c: 1 };").text;
  assert.match(readonly, /readonly a\?: never; readonly b\?: never;/);
  // A homomorphic mapping keeps source declarations but changes the type: not proof of never.
  assert.match(render("type Test = { [K in keyof { a?: never }]?: undefined };").text, /a\?: undefined;/);
  // Declared on a base interface.
  assert.match(
    render("interface Base { a?: never; b?: never } interface Test extends Base { c: string }").text,
    /\/\* never: a, b \*\//,
  );
});

const ALTERNATIVES = `
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ExactlyOneOf<TAlternatives extends readonly object[]> = {
  [I in keyof TAlternatives]: TAlternatives[I] & {
    [K in Exclude<KeysOfUnion<TAlternatives[number]>, KeysOfUnion<TAlternatives[I]>>]?: never;
  };
}[number];
type AllOrNone<T extends object> = T | { [K in KeysOfUnion<T>]?: never };
type Test = { message: string } & ExactlyOneOf<[{ errorCode: string; statusCode?: number }, { abortCode: "a" | "b" }]> &
  AllOrNone<{ requestId: string; cause: string }>;`;

test("ExactlyOneOf and AllOrNone branches list exactly the keys they forbid", () => {
  for (const exact of [false, true]) {
    const { text } = render(ALTERNATIVES, { exact });
    const members = text.replace(/^type Test = /, "").split(" | {");
    assert.equal(members.length, 4, text);
    // A single forbidden key stays a normal property in place; two or more share one line.
    assert.match(members[0], /errorCode: string; statusCode\?: number; abortCode\?: never; requestId: string;/);
    assert.match(members[1], /errorCode: string; statusCode\?: number; \/\* never: abortCode, requestId, cause \*\//);
    assert.match(
      members[2],
      /abortCode: "a" \| "b"; requestId: string; cause: string; \/\* never: errorCode, statusCode \*\//,
    );
    assert.match(members[3], /abortCode: "a" \| "b"; \/\* never: errorCode, statusCode, requestId, cause \*\//);
    assert.doesNotMatch(text, /\?: undefined/);
    equivalentCopy(ALTERNATIVES, { exact });
  }
});

test("never lines keep earlier omission markers and quote keys like properties", () => {
  const hover = render("type Test = { a: 1; b: 2; c: 3 } & { [K in 'x-y' | 'z' | 'w']?: never };", {
    maxProperties: 5,
  }).hover;
  assert.match(hover, /a: 1; b: 2; c: 3; \/\* never: "x-y", z \*\/ \.\.\. 1 more; \}/);
  const all = render("type Test = { a: 1 } & { [K in 'x-y' | 'z']?: never };").text;
  assert.match(all, /\/\* never: "x-y", z \*\//);
  // A branch with only forbidden keys stays an object, not `{}`.
  assert.match(render("type Test = { [K in 'a' | 'b']?: never };").text, /\{ \/\* never: a, b \*\/ \}/);
});

const ASSET = `
enum Model { A = "a", B = "b" }
type Base = { assetId: string; name: string; readonly owner: string; model?: Model; tags: string[] };
type Test =
  | (Base & { kind: "image"; width: number })
  | (Base & { kind: "video"; width: number; seconds: number })
  | (Base & { kind: "audio"; seconds?: number });`;

test("shared union properties are opt-in and keep discriminants and differences in each member", () => {
  assert.doesNotMatch(render(ASSET).text, / & /);
  const { text } = render(ASSET, { factorSharedUnionProperties: true });
  assert.match(
    text,
    /^type Test = \{ assetId: string; name: string; readonly owner: string; model\?: Model; tags: string\[\]; \} & \(/,
  );
  assert.match(
    text,
    /\{ kind: "image"; width: number; \} \| \{ kind: "video"; width: number; seconds: number; \} \| \{ kind: "audio"; seconds\?: number; \}\)$/m,
  );
  for (const exact of [false, true]) equivalentCopy(ASSET, { exact, factorSharedUnionProperties: true });
});

test("properties differing in type, optionality or readonliness are not shared", () => {
  const source =
    "type Test = { a: string; b: string; c?: number; d: 1; e: { x: 1 } } |" +
    " { a: string; b: string; c: number; readonly d: 1; e: { x: 1 } };";
  const { text } = render(source, { factorSharedUnionProperties: true, maxDepth: 2 });
  assert.match(text, /^type Test = \{ a: string; b: string; \} & \(/);
  // Structurally equal but separate anonymous types are not provably the same type, so `e` stays per member.
  assert.match(text, /c\?: number; d: 1; e: \{ x: 1; \};/);
  assert.match(text, /c: number; readonly d: 1; e: \{ x: 1; \};/);
  equivalentCopy(source, { factorSharedUnionProperties: true });
});

test("unions that cannot be factored safely keep one object per member", () => {
  const options = { factorSharedUnionProperties: true, maxDepth: 3 };
  for (const source of [
    "type Test = { a: 1; b: 2; k: 1 } | { a: 1; b: 2; k: 2 } | null;",
    "type Test = { a: 1; b: 2; k: 1 } | { a: 1; b: 2; k: 2; [key: string]: number };",
    "type Test = { a: 1; b: 2; k: 1 } | { a: 1; b: 2; (): void };",
    "type Test = { a: 1; b: 2; k: 1 } | { a: 1; k: 2 };",
  ])
    assert.doesNotMatch(render(source, options).text, / & \(/, source);
  // Truncated unions: hidden members could lack a property shown as shared.
  assert.doesNotMatch(
    render("type Test = { a: 1; b: 2; k: 1 } | { a: 1; b: 2; k: 2 } | { a: 1; b: 2; k: 3 };", {
      ...options,
      maxUnionMembers: 2,
    }).text,
    / & \(/,
  );
  // At Max Depth members are collapsed anyway.
  assert.doesNotMatch(
    render("type Test = { u: { a: 1; b: 2; k: 1 } | { a: 1; b: 2; k: 2 } };", { factorSharedUnionProperties: true })
      .text,
    / & \(/,
  );
});

test("factored never keys, nested unions and arrays stay valid and equivalent", () => {
  const options = { factorSharedUnionProperties: true };
  equivalentCopy(OPERATION_STATUS, options);
  equivalentCopy(ALTERNATIVES, options);
  equivalentCopy(ALTERNATIVES, { ...options, exact: true });
  const nested = equivalentCopy(
    "type Item = { a: 1; b: 2; k: 1 } | { a: 1; b: 2; k: 2 }; type Test = { items: Item[]; one?: Item; pair: [Item?] };",
    options,
  );
  assert.match(nested, /items: \(\{ a: 1; b: 2; \} & \(/);
  const hover = render(OPERATION_STATUS, options).text;
  // statusState differs in every member, so it is never factored out.
  assert.match(hover, /statusState: "failure"/);
});

test("a member reduced to never (conflicting discriminants) neither blocks nor changes factoring", () => {
  const source = `
type Base = { id: string; name: string };
type Test = (Base & { kind: "a"; x: 1 }) | (Base & { kind: "b" } & { kind: "c" }) | (Base & { kind: "d"; y: 2 });`;
  const { text } = render(source, { factorSharedUnionProperties: true });
  assert.match(
    text,
    /^type Test = \{ id: string; name: string; \} & \(\{ kind: "a"; x: 1; \} \| never \| \{ kind: "d"; y: 2; \}\)/,
  );
  equivalentCopy(source, { factorSharedUnionProperties: true });
});

test("RequireFieldsWhenTrue-style intersections factor their shared fields only", () => {
  const source = `
type RequireFieldsWhenTrue<T, Flag extends keyof T, Fields extends keyof T> = T &
  (Partial<Record<Flag, false>> | (Record<Flag, true> & { [K in Fields]-?: Exclude<T[K], null | undefined> }));
type Token = { token: string; cost: number; isConsumed?: boolean; dateConsumed?: string | null;
  isRestored?: boolean; dateRestored?: string };
type Test = RequireFieldsWhenTrue<Token, "isConsumed", "dateConsumed"> &
  RequireFieldsWhenTrue<Token, "isRestored", "dateRestored">;`;
  const { text } = render(source, { factorSharedUnionProperties: true });
  assert.match(text, /^type Test = \{ token: string; cost: number; \} & \(/);
  equivalentCopy(source, { factorSharedUnionProperties: true });
});

test("Factor Shared Union Properties is off by default and normalized like other boolean settings", () => {
  assert.equal(api.DEFAULT_OPTIONS.factorSharedUnionProperties, false);
  assert.equal(api.normalizeOptions({}).factorSharedUnionProperties, false);
  assert.equal(api.normalizeOptions({ factorSharedUnionProperties: true }).factorSharedUnionProperties, true);
  assert.equal(api.normalizeOptions({ factorSharedUnionProperties: "yes" }).factorSharedUnionProperties, false);
  const manifest = require("../../packages/vscode-extension/package.json");
  assert.equal(
    manifest.contributes.configuration.properties["prettify-ts-plus-plus.factorSharedUnionProperties"].default,
    api.DEFAULT_OPTIONS.factorSharedUnionProperties,
  );
});

test("cancellation interrupts shared-property analysis before it scans the remaining fields", () => {
  const fields = Array.from({ length: 100 }, (_, index) => `field${index}: string;`).join(" ");
  const source = `type Test = { ${fields} kind: "a" } | { ${fields} kind: "b" };`;
  const { program, checker, sourceFile } = programFor(source, true);
  const original = checker.getTypeOfSymbol.bind(checker);
  let reads = 0;
  let cancelled = false;
  checker.getTypeOfSymbol = (...args) => {
    if (++reads === 8) cancelled = true;
    return original(...args);
  };
  const info = api.getTypeInfoAtPosition(
    ts,
    checker,
    sourceFile,
    source.indexOf("Test") + 1,
    { ...api.DEFAULT_OPTIONS, factorSharedUnionProperties: true },
    undefined,
    { compilerOptions: program.getCompilerOptions(), isCancellationRequested: () => cancelled },
  );
  assert.equal(cancelled, true);
  assert.ok(info === undefined || info.truncationReasons?.includes("cancelled"));
  assert.ok(reads < 20, `Continued checking ${reads} field types after cancellation`);
});
