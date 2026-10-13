import type * as Monaco from "monaco-editor";
import type { TableColumn } from "./sql-utils";

/**
 * Schema the completion provider suggests from. Monaco providers are global
 * per language, so the most recently focused SQL editor publishes its schema
 * here; one provider serves every SQL pane.
 */
export interface CompletionSchema {
  tables: string[];
  columns: Record<string, TableColumn[]>;
}

let current: CompletionSchema = { tables: [], columns: {} };
let registered = false;

export function setCompletionSchema(schema: CompletionSchema) {
  current = schema;
}

const KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS NULL",
  "IS NOT NULL",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "DISTINCT",
  "AS",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "COUNT(*)",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "ASC",
  "DESC",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
];

export function registerSqlCompletion(monaco: typeof Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const K = monaco.languages.CompletionItemKind;
      const suggestions: Monaco.languages.CompletionItem[] = [];

      // After "something." only suggest that table's columns (or tables in that schema).
      const before = model
        .getLineContent(position.lineNumber)
        .slice(0, word.startColumn - 1);
      const qualifier = /([\w"`]+)\.$/.exec(before)?.[1]?.replace(/["`]/g, "");
      if (qualifier) {
        for (const t of current.tables) {
          if (t.startsWith(qualifier + ".")) {
            suggestions.push({
              label: t.slice(qualifier.length + 1),
              kind: K.Struct,
              detail: "table",
              insertText: t.slice(qualifier.length + 1),
              range,
            });
          }
        }
        for (const [t, cols] of Object.entries(current.columns)) {
          const short = t.includes(".") ? t.slice(t.indexOf(".") + 1) : t;
          if (t !== qualifier && short !== qualifier) continue;
          for (const c of cols) {
            suggestions.push({
              label: c.name,
              kind: K.Field,
              detail: c.dataType,
              insertText: c.name,
              range,
            });
          }
        }
        // Unknown qualifier is probably an alias — fall through to all columns.
        if (suggestions.length > 0) return { suggestions };
      }

      for (const kw of KEYWORDS) {
        suggestions.push({
          label: kw,
          kind: K.Keyword,
          insertText: kw,
          range,
          sortText: "2" + kw,
        });
      }
      for (const t of current.tables) {
        suggestions.push({
          label: t,
          kind: K.Struct,
          detail: "table",
          insertText: t,
          range,
          sortText: "1" + t,
        });
      }
      const seen = new Set<string>();
      for (const [t, cols] of Object.entries(current.columns)) {
        for (const c of cols) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          suggestions.push({
            label: c.name,
            kind: K.Field,
            detail: `${c.dataType} · ${t}`,
            insertText: c.name,
            range,
            sortText: "0" + c.name,
          });
        }
      }
      return { suggestions };
    },
  });
}
