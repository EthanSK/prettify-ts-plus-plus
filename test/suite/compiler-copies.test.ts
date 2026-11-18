import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { applySettings, ensureTypeScriptServerReady, getHoverContents, getOpenDocument } from "./utils";

suite("Hover and copy resolved compiler types", () => {
  test("both Copy commands keep the types behind a compact editor hover", async () => {
    const marker = "LibraryPreview =";
    await ensureTypeScriptServerReady("copied-types.ts", marker);
    await applySettings();
    const document = getOpenDocument();
    const editor = await vscode.window.showTextDocument(document);
    const hovers = await getHoverContents(marker);
    const preview = hovers.find((text) => text.includes("entries: Map<...>"));
    assert.ok(preview, hovers.join("\n"));
    assert.match(preview, /Media\.Role\.Audio/);
    assert.match(preview, /Media\.Role\.Video/);
    assert.match(preview, /key: Uppercase<string>/);
    const position = document.positionAt(document.getText().indexOf(marker) + 1);
    editor.selection = new vscode.Selection(position, position);
    const previous = await vscode.env.clipboard.readText();
    try {
      for (const command of ["copyPrettifiedType", "fullCopyPrettifiedType"]) {
        await vscode.env.clipboard.writeText("");
        await vscode.commands.executeCommand("prettify-ts-plus-plus." + command);
        const copy = await vscode.env.clipboard.readText();
        assert.match(copy, /entries: Map<string, number>/);
        assert.match(copy, /key: Uppercase<string>/);
        assert.match(copy, /Media\.Role\.Audio/);
        assert.match(copy, /Media\.Role\.Video/);
        assert.doesNotMatch(copy, /\.\.\.|Expansion limited|\bT\b/);
      }
    } finally {
      await vscode.env.clipboard.writeText(previous);
      await vscode.commands.executeCommand("notifications.clearAll");
    }
  });
});
