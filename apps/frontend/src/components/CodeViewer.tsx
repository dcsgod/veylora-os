import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/features/find/register";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-codicon.css";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/shell/register";
import { useApp } from "../store";
import { Spinner } from "./ui";

// Bundled locally: no CDN loader, and only syntax highlighting (no language-service workers).
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

const KNOWN = new Set(["javascript", "typescript", "css", "html", "markdown", "python", "yaml", "shell"]);

function language(lang: string) {
  if (lang === "json") return "javascript";
  return KNOWN.has(lang) ? lang : "plaintext";
}

function useMonacoTheme() {
  useApp((s) => s.theme);
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

const OPTIONS = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: "JetBrains Mono, Cascadia Code, SF Mono, Menlo, Consolas, monospace",
  scrollBeyondLastLine: false,
  renderLineHighlight: "none" as const,
  wordWrap: "on" as const,
  automaticLayout: true,
  contextmenu: false,
  links: false,
};

export function CodeViewer({ value, lang, path }: { value: string; lang: string; path?: string }) {
  const theme = useMonacoTheme();
  return (
    <Editor value={value} language={language(lang)} path={path} theme={theme} options={OPTIONS}
      loading={<Spinner label="Loading editor" />} />
  );
}

export function DiffViewer({ original, modified, lang }: { original: string; modified: string; lang: string }) {
  const theme = useMonacoTheme();
  return (
    <DiffEditor original={original} modified={modified} language={language(lang)} theme={theme}
      options={{ ...OPTIONS, renderSideBySide: false }} loading={<Spinner label="Loading editor" />} />
  );
}
