import * as path from "node:path";
import * as vscode from "vscode";
import type { TypeSource } from "@prettify-ts-plus-plus/typescript-plugin/src/type-tree/types";
import { hoverMarkers, renderTypeParts, sanitizeString } from "./stringify-type-tree";
import { readSettings } from "./configuration";
import { limitPreview, reportedLimits, supportedLanguages } from "./type-client";
import type { TypeClient } from "./type-client";

export function registerHoverProvider(context: vscode.ExtensionContext, client: TypeClient): void {
  async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const settings = readSettings(document);
    if (!settings.enabled || token.isCancellationRequested) return;
    const version = document.version;
    const info = await client.request(document, position, settings.options, token);
    if (!info || token.isCancellationRequested) return;
    if (settings.options.skippedTypeNames.includes(info.name)) return;
    try {
      const parts = renderTypeParts(info, settings.indentation);
      const declaration = parts.declaration;
      const type = hoverMarkers(parts.type);
      const text = declaration + type;
      const limits = reportedLimits(info);
      const quickInfo = await client.quickInfo(document, position, token);
      if (token.isCancellationRequested || document.version !== version) return;
      // A separate section, so VS Code draws a divider between it and the prettified type. Claude Opus 5.5
      const source = sourceSection(info.source, [text, type], settings.maxCharacters);
      // Only skip a duplicate expansion when there is no useful authored source to keep.
      if (
        quickInfo &&
        !source &&
        !limits.length &&
        /^(?:type|const|let|var|function)\b/.test(declaration) &&
        sanitizeString(quickInfo).includes(sanitizeString(type))
      )
        return;
      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(limitPreview(text, settings.maxCharacters), "typescript");
      if (limits.length) markdown.appendText("\nExpansion limited: " + limits.join(", ") + ".");
      return new vscode.Hover(source ? [markdown, source] : markdown);
    } catch (error) {
      client.log(error);
      return undefined;
    }
  }
  for (const language of supportedLanguages) {
    context.subscriptions.push(vscode.languages.registerHoverProvider({ language }, { provideHover }));
  }
}

/**
 * The authored definition beneath the prettified type, linked to where it is written. Omitted when it reads the
 * same as the expansion. The data comes from the TypeScript server, so it is checked and escaped here: the link is
 * always a file URI, and the markdown stays untrusted, so no command link can run. Claude Opus 5.5
 */
function sourceSection(
  source: TypeSource | undefined,
  shown: string[],
  maxCharacters: number,
): vscode.MarkdownString | undefined {
  if (
    !source ||
    typeof source.text !== "string" ||
    !source.text.trim() ||
    typeof source.fileName !== "string" ||
    !path.isAbsolute(source.fileName) ||
    !Number.isSafeInteger(source.line) ||
    source.line < 0 ||
    !Number.isSafeInteger(source.character) ||
    source.character < 0
  )
    return undefined;
  const authored = sanitizeString(source.text.replace(/^(?:(?:export|declare|default)\s+)+/, ""));
  if (shown.some((text) => sanitizeString(text) === authored)) return undefined;
  const uri = vscode.Uri.file(source.fileName).with({ fragment: `L${source.line + 1},${source.character + 1}` });
  const target = uri.toString().replace(/[\s()<>[\]\\`"']/g, percent);
  const label = escapeMarkdown(path.basename(source.fileName) + ":" + (source.line + 1));
  const text = limitPreview(source.text, maxCharacters);
  const markdown = new vscode.MarkdownString();
  const heading = source.cut === true || text !== source.text ? "Source (shortened)" : "Source";
  markdown.appendMarkdown(`${heading}: [${label}](${target})`);
  // VS Code's helper misses indented closing fences. Count every backtick run so source comments stay literal.
  // Codex (model version unavailable)
  const fence = "`".repeat((text.match(/`+/g) ?? []).reduce((width, run) => Math.max(width, run.length + 1), 3));
  markdown.appendMarkdown(`\n\n${fence}typescript\n${text}\n${fence}\n`);
  return markdown;
}

/** Characters that could end or reshape a Markdown link target, written as percent escapes. Claude Opus 5.5 */
function percent(character: string): string {
  const encoded = encodeURIComponent(character);
  // encodeURIComponent leaves `(`, `)` and `'` as they are.
  return encoded === character ? "%" + character.charCodeAt(0).toString(16).toUpperCase() : encoded;
}

/** File names are untrusted: every Markdown punctuation mark is escaped and line breaks are removed. Claude Opus 5.5 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
}
