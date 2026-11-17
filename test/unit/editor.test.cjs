const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
let handler, values, inspected, updates, logs, providers, commands, clipboard;
const token = { isCancellationRequested: false, onCancellationRequested() {} };
const document = { uri: { scheme: "untitled", path: "Test" }, version: 1, languageId: "typescript" };
const mock = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration(section, scope) {
      assert.equal(section, "prettify-ts-plus-plus");
      return {
        get(key, fallback) {
          return values[key] ?? fallback;
        },
        inspect() {
          return inspected;
        },
        async update(key, value, target, language) {
          updates.push({ key, value, target, language });
          values[key] = value;
        },
      };
    },
  },
  commands: {
    async executeCommand(...args) {
      return handler(...args);
    },
    registerCommand(name, callback) {
      commands.set(name, callback);
      return { dispose() {} };
    },
  },
  languages: {
    registerHoverProvider(selector, provider) {
      providers.set(selector.language, provider);
      return { dispose() {} };
    },
  },
  window: {
    activeTextEditor: { document, selection: { active: { line: 0, character: 3 } } },
    createOutputChannel() {
      return {
        appendLine(line) {
          logs.push(line);
        },
        dispose() {},
      };
    },
    async showInformationMessage() {},
    async showErrorMessage() {},
    async withProgress(options, callback) {
      return callback({}, token);
    },
  },
  env: {
    clipboard: {
      async writeText(text) {
        clipboard = text;
      },
    },
  },
  MarkdownString: class {
    value = "";
    appendCodeblock(text) {
      this.value += text;
    }
    appendText(text) {
      this.value += text;
    }
    appendMarkdown(text) {
      this.value += text;
    }
  },
  // Deliberately unencoded, so the hover's own escaping of link targets is what the tests check. Claude Opus 5.5
  Uri: {
    file(fileName) {
      return {
        with({ fragment }) {
          return { toString: () => "file://" + fileName + "#" + fragment };
        },
      };
    },
  },
  Hover: class {
    constructor(contents) {
      this.contents = contents;
    }
  },
};
const original = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? mock : original.call(this, name, ...args);
};
const api = require("../out-unit/editor-entry");
Module._load = original;
const info = {
  name: "Test",
  declaration: "type Test = ",
  typeTree: {
    kind: "object",
    typeName: "",
    excessProperties: 0,
    properties: [{ name: "value", optional: false, readonly: false, type: { kind: "primitive", typeName: "string" } }],
  },
};
beforeEach(() => {
  values = {};
  inspected = {};
  updates = [];
  logs = [];
  providers = new Map();
  commands = new Map();
  clipboard = "";
  token.isCancellationRequested = false;
  document.version = 1;
  handler = async (command, method) =>
    method === "completionInfo" ? { body: { __prettifyPlusPlusResponse: info } } : undefined;
});
function client() {
  return api.createTypeClient({ subscriptions: [] });
}
test("requests preserve URI and cancellation token", async () => {
  handler = async (command, method, args, config, cancellation) => {
    assert.equal(args.file, document.uri);
    assert.equal(config.executionTarget, 0);
    assert.equal(cancellation, token);
    return { body: { __prettifyPlusPlusResponse: info } };
  };
  assert.equal(await client().request(document, { line: 0, character: 1 }, {}, token), info);
});
test("cancelled and outdated requests do not produce results", async () => {
  const c = client();
  token.isCancellationRequested = true;
  assert.equal(await c.request(document, { line: 0, character: 1 }, {}, token), undefined);
  token.isCancellationRequested = false;
  handler = async () => {
    document.version++;
    return { body: { __prettifyPlusPlusResponse: info } };
  };
  assert.equal(await c.request(document, { line: 0, character: 1 }, {}, token), undefined);
});
test("missing or failed quickinfo preserves valid hover and logs failures", async () => {
  api.registerHoverProvider({ subscriptions: [] }, client());
  assert.deepEqual([...providers.keys()], api.supportedLanguages);
  let hover = await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
  assert.match(hover.contents.value, /value: string/);
  handler = async (command, method) => {
    if (method === "quickinfo") throw new Error("No quickinfo");
    return { body: { __prettifyPlusPlusResponse: info } };
  };
  hover = await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
  assert.match(hover.contents.value, /value: string/);
  assert.match(logs[0], /No quickinfo/);
});
test("toggle writes the highest effective workspace or language override", async () => {
  values.enabled = false;
  inspected.workspaceValue = false;
  await api.toggleEnabled(true);
  assert.deepEqual(updates[0], { key: "enabled", value: true, target: 2, language: false });
  inspected.workspaceLanguageValue = false;
  updates = [];
  await api.toggleEnabled(false);
  assert.equal(updates[0].target, 2);
  assert.equal(updates[0].language, true);
});
test("copies ignore Max Characters as before; full copy expands everything and preserves private choices", async () => {
  values.maxCharacters = 5;
  values.hidePrivateProperties = false;
  const seen = [];
  handler = async (command, method, args) => {
    seen.push(args.triggerCharacter.options);
    return { body: { __prettifyPlusPlusResponse: info } };
  };
  api.registerCommands({ subscriptions: [] }, client());
  await commands.get("prettify-ts-plus-plus.copyPrettifiedType")();
  assert.equal(clipboard, "type Test = {\n    value: string;\n}\n");
  await commands.get("prettify-ts-plus-plus.fullCopyPrettifiedType")();
  assert.match(clipboard, /value: string/);
  assert.equal(seen[0].copy, true);
  assert.equal(seen[0].fullExpansion, false);
  assert.equal(seen[1].fullExpansion, true);
  assert.equal(seen[1].copy, true);
  assert.equal(seen[1].hidePrivateProperties, false);
});
test("hover shows earlier markers and hides duplicates of TypeScript's own hover", async () => {
  api.registerHoverProvider({ subscriptions: [] }, client());
  const collapsed = {
    ...info,
    typeTree: {
      ...info.typeTree,
      properties: [
        {
          name: "nested",
          optional: false,
          readonly: false,
          type: { kind: "object", typeName: "", properties: [], excessProperties: 2 },
        },
      ],
    },
  };
  handler = async (command, method) =>
    method === "completionInfo"
      ? { body: { __prettifyPlusPlusResponse: collapsed } }
      : { body: { displayString: "type Test = Other" } };
  let hover = await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
  assert.equal(hover.contents.value, "type Test = {\n    nested: { ... 2 more };\n}\n");
  handler = async (command, method) =>
    method === "completionInfo"
      ? { body: { __prettifyPlusPlusResponse: info } }
      : { body: { displayString: "type Test = {\n  value: string;\n}" } };
  hover = await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
  assert.equal(hover, undefined);
});
const source = {
  text: "export type Test = ExactlyOneOf<[{ value: string }, { other: number }]>;",
  fileName: "/work/types.ts",
  line: 4,
  character: 2,
};
async function hoverWith(response, quickInfo) {
  api.registerHoverProvider({ subscriptions: [] }, client());
  handler = async (command, method) =>
    method === "completionInfo"
      ? { body: { __prettifyPlusPlusResponse: response } }
      : quickInfo && { body: { displayString: quickInfo } };
  return providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
}

test("the authored source follows the prettified type as its own linked section", async () => {
  const quickInfo = "type Test = Native";
  const hover = await hoverWith({ ...info, source }, quickInfo);
  assert.equal(hover.contents.length, 2);
  assert.equal(hover.contents[0].value, "type Test = {\n    value: string;\n}\n");
  assert.equal(
    hover.contents[1].value,
    "Source: [types\\.ts:5](file:///work/types.ts#L5,3)\n\n```typescript\n" + source.text + "\n```\n",
  );
  // Untrusted: no command link can run, and TypeScript's own hover is left to VS Code, not repeated.
  assert.equal(hover.contents[1].isTrusted, undefined);
  assert.ok(!hover.contents.some((part) => part.value.includes(quickInfo)));
});

test("unusual file names cannot break out of the link", async () => {
  const fileName = "/work/a b)(c]`[x](command:evil)<y>\n#.ts";
  const hover = await hoverWith({ ...info, source: { ...source, fileName } });
  const [heading] = hover.contents[1].value.split("\n\n");
  const target = heading.slice(heading.lastIndexOf("](") + 2, -1);
  assert.doesNotMatch(target, /[\s()<>[\]`]/);
  assert.match(target, /^file:\/\/\/work\/a%20b%29%28c%5D%60%5Bx%5D%28command:evil%29%3Cy%3E%0A#\.ts#L5,3$/);
  assert.equal(heading.indexOf("]("), heading.lastIndexOf("]("));
  assert.match(heading, /^Source: \[a b\\\)\\\(c\\\]\\`\\\[x\\\]\\\(command:evil\\\)\\<y\\> \\#\\\.ts:5\]\(/);
});

test("useful authored source survives a matching native expansion", async () => {
  const native = "type Test = { value: string; }";
  const hover = await hoverWith({ ...info, source }, native);
  assert.equal(hover.contents.length, 2);
  assert.match(hover.contents[1].value, /ExactlyOneOf/);
  assert.equal(await hoverWith(info, native), undefined);
  assert.equal(await hoverWith({ ...info, source: { ...source, text: native } }, native), undefined);
});

test("the source is left out when it matches the expansion, is missing or is not a real file location", async () => {
  for (const candidate of [
    { ...source, text: "export type Test = { value: string };" },
    { ...source, fileName: "types.ts" },
    { ...source, line: -1 },
    { ...source, character: 1.5 },
    { ...source, text: 42 },
    { ...source, text: "  " },
    undefined,
  ]) {
    const hover = await hoverWith({ ...info, source: candidate });
    assert.equal(hover.contents.value, "type Test = {\n    value: string;\n}\n", JSON.stringify(candidate));
  }
  // An annotation that reads the same as the expanded value.
  const value = { ...info, declaration: "const Test: " };
  const hover = await hoverWith({ ...value, source: { ...source, text: "Test: { value: string }" } });
  assert.equal(hover.contents.value, "const Test: {\n    value: string;\n}\n");
});

test("a shortened source says so, including when Max Characters cuts it", async () => {
  let hover = await hoverWith({ ...info, source: { ...source, cut: true } });
  assert.match(hover.contents[1].value, /^Source \(shortened\): \[/);
  values.maxCharacters = 20;
  hover = await hoverWith({ ...info, source });
  assert.match(hover.contents[1].value, /^Source \(shortened\): \[/);
  assert.match(hover.contents[1].value, /\)\n\n```typescript\nexport type Test = E\.\.\.\n```\n$/);
});

test("source comments with indented backticks remain one literal code block", async () => {
  for (const indentation of ["", " ", "  ", "   "]) {
    const text = `type Test = {\n/*\n${indentation}\`\`\`\n[keep as code](command:mustNotRun)\n${indentation}\`\`\`\n*/\nvalue: string;\n};`;
    const hover = await hoverWith({ ...info, source: { ...source, text } });
    const markdown = hover.contents[1].value;
    const block = markdown.slice(markdown.indexOf("\n\n") + 2);
    assert.equal(block, "````typescript\n" + text + "\n````\n");
    assert.equal(hover.contents[1].isTrusted, undefined);
  }
});

test("stale or cancelled hovers show no source either", async () => {
  api.registerHoverProvider({ subscriptions: [] }, client());
  handler = async (command, method) => {
    if (method === "quickinfo") document.version++;
    return method === "completionInfo" ? { body: { __prettifyPlusPlusResponse: { ...info, source } } } : undefined;
  };
  assert.equal(await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token), undefined);
  handler = async (command, method) => {
    if (method === "quickinfo") token.isCancellationRequested = true;
    return method === "completionInfo" ? { body: { __prettifyPlusPlusResponse: { ...info, source } } } : undefined;
  };
  assert.equal(await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token), undefined);
});

test("copies contain only the type, and only hovers ask for the source", async () => {
  const seen = [];
  handler = async (command, method, args) => {
    seen.push(args.triggerCharacter.options);
    return { body: { __prettifyPlusPlusResponse: { ...info, source } } };
  };
  api.registerCommands({ subscriptions: [] }, client());
  for (const name of ["prettify-ts-plus-plus.copyPrettifiedType", "prettify-ts-plus-plus.fullCopyPrettifiedType"]) {
    await commands.get(name)();
    assert.equal(clipboard, "type Test = {\n    value: string;\n}\n");
  }
  assert.deepEqual(
    seen.map((options) => options.showSource),
    [false, false],
  );
  assert.equal(api.readSettings(document).options.showSource, true);
});

test("inline presentation limits do not add hover footers; invisible safety limits do", async () => {
  api.registerHoverProvider({ subscriptions: [] }, client());
  for (const [reasons, footer] of [
    [["object depth limit", "property limit"], false],
    [["object depth limit", "analysis budget"], true],
  ]) {
    handler = async (command, method) =>
      method === "completionInfo"
        ? { body: { __prettifyPlusPlusResponse: { ...info, truncationReasons: reasons } } }
        : undefined;
    const hover = await providers.get("typescript").provideHover(document, { line: 0, character: 1 }, token);
    assert.equal(/Expansion limited/.test(hover.contents.value), footer, reasons.join());
    if (footer) assert.doesNotMatch(hover.contents.value, /object depth limit/);
  }
});
