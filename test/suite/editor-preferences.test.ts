import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { applySettings, ensureTypeScriptServerReady, getHoverContents, getOpenDocument, openDocument } from "./utils";

suite("Saved Promise preference and displayed hovers", () => {
  suiteSetup(async () => {
    await ensureTypeScriptServerReady("canary.ts", "ServerReadinessProbe");
    await openDocument("settings.ts");
  });
  setup(async () => applySettings({ maxDepth: 3 }));
  teardown(async () => applySettings());

  test("unspecified versus explicitly configured generic lists in hover and both Copy commands", async () => {
    const document = getOpenDocument();
    const editor = await vscode.window.showTextDocument(document);
    const config = vscode.workspace.getConfiguration("prettify-ts-plus-plus", document);
    const target = vscode.ConfigurationTarget.Workspace;
    const list = "unwrapGenericArgumentsTypeNames";
    const previousLanguageValue = config.inspect<string[]>(list)?.workspaceLanguageValue;
    const needle = "pendingEditorResult:";
    const start = document.getText().indexOf(needle);
    assert.notEqual(start, -1);
    // A normal, forward selection leaves the active cursor immediately after the identifier.
    editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(start + needle.length - 1));
    const original = await vscode.env.clipboard.readText();
    async function copy(full = false) {
      await vscode.commands.executeCommand(
        full ? "prettify-ts-plus-plus.fullCopyPrettifiedType" : "prettify-ts-plus-plus.copyPrettifiedType",
      );
      return vscode.env.clipboard.readText();
    }
    try {
      await config.update(list, undefined, target);
      await config.update("unwrapPromises", false, target);
      assert.match(await copy(), /: Promise<PromiseItem>/);
      assert.match(await copy(true), /: Promise<\{\s*text: string;/);
      const aliased = document.positionAt(document.getText().indexOf("aliasedEditorResult:") + 1);
      editor.selection = new vscode.Selection(aliased, aliased);
      assert.match(await copy(), /: EditorPromise<PromiseItem>/);
      editor.selection = new vscode.Selection(
        document.positionAt(start),
        document.positionAt(start + needle.length - 1),
      );
      let hovers = await getHoverContents(needle);
      assert.ok(
        hovers.some((hover) => hover.includes("Promise<PromiseItem>")),
        hovers.join("\n"),
      );
      assert.ok(!hovers.some((hover) => hover.includes("text: string")), hovers.join("\n"));

      // An explicitly chosen language override wins even when it includes the same Promise name as the default.
      await config.update(list, ["Promise"], target, true);
      assert.match(await copy(), /: Promise<\{\s*text: string;/);
      hovers = await getHoverContents(needle);
      assert.ok(
        hovers.some((hover) => hover.includes("text: string")),
        hovers.join("\n"),
      );

      // The existing skip-list choice retains higher priority in both editor paths.
      await config.update("skippedTypeNames", ["Promise"], target);
      assert.match(await copy(), /: Promise<PromiseItem>/);
      assert.match(await copy(true), /: Promise<PromiseItem>/);
      assert.ok((await getHoverContents(needle)).some((hover) => hover.includes("Promise<...>")));
    } finally {
      await config.update(list, previousLanguageValue, target, true);
      await vscode.env.clipboard.writeText(original);
      await vscode.commands.executeCommand("notifications.clearAll");
    }
  });

  test("a value named Date still expands its unrelated object type", async () => {
    const hovers = await getHoverContents("Date: PromiseItem");
    assert.ok(
      hovers.some((hover) => hover.includes("text: string")),
      hovers.join("\n"),
    );
    assert.ok(
      hovers.some((hover) => hover.includes("const Date: PromiseItem")),
      hovers.join("\n"),
    );
  });

  test("quote style alone does not duplicate an ordinary object hover or add a Source section", async () => {
    const document = getOpenDocument();
    const index = document.getText().indexOf("QuotedEditorFields");
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      document.positionAt(index + 1),
    );
    const parts = hovers
      .flatMap((hover) => hover.contents)
      .map((part) => (typeof part === "string" ? part : part.value));
    assert.equal(parts.filter((part) => part.includes("QuotedEditorFields")).length, 1, parts.join("\n"));
    assert.ok(!parts.some((part) => part.startsWith("Source:")), parts.join("\n"));
  });
});
