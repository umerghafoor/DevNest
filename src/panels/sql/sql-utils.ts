import type { SqlEngine } from "../../lib/api";

export interface TableColumn {
  name: string;
  dataType: string;
}

const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/;

/** Quote one identifier part only when it needs it, so generated SQL stays readable. */
export function quoteIdent(engine: SqlEngine, name: string): string {
  if (PLAIN_IDENT.test(name)) return name;
  if (engine === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** `schema.table` → quoted parts. Table names come from `sql_list_tables`. */
export function quoteTable(engine: SqlEngine, table: string): string {
  if (engine !== "postgres") return quoteIdent(engine, table);
  const dot = table.indexOf(".");
  if (dot < 0) return quoteIdent(engine, table);
  return (
    quoteIdent(engine, table.slice(0, dot)) +
    "." +
    quoteIdent(engine, table.slice(dot + 1))
  );
}

export function quoteString(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'";
}

export function selectAllSql(engine: SqlEngine, table: string, limit = 100) {
  return `SELECT *\nFROM ${quoteTable(engine, table)}\nLIMIT ${limit};`;
}

/** Introspection query returning `(name, type)` rows for one table. */
export function columnsSql(engine: SqlEngine, table: string): string {
  if (engine === "postgres") {
    const dot = table.indexOf(".");
    const schema = dot < 0 ? "public" : table.slice(0, dot);
    const name = dot < 0 ? table : table.slice(dot + 1);
    return (
      "SELECT column_name, data_type FROM information_schema.columns " +
      `WHERE table_schema = ${quoteString(schema)} AND table_name = ${quoteString(name)} ` +
      "ORDER BY ordinal_position"
    );
  }
  if (engine === "mysql") {
    return (
      "SELECT column_name, data_type FROM information_schema.columns " +
      `WHERE table_schema = DATABASE() AND table_name = ${quoteString(table)} ` +
      "ORDER BY ordinal_position"
    );
  }
  return `SELECT name, type FROM pragma_table_info(${quoteString(table)})`;
}

// ── Visual query builder ───────────────────────────────────────────────────

export type FilterOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "starts"
  | "ends"
  | "in"
  | "null"
  | "notnull";

export const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "=", label: "equals" },
  { value: "!=", label: "not equal" },
  { value: ">", label: "greater than" },
  { value: ">=", label: "greater or equal" },
  { value: "<", label: "less than" },
  { value: "<=", label: "less or equal" },
  { value: "contains", label: "contains" },
  { value: "starts", label: "starts with" },
  { value: "ends", label: "ends with" },
  { value: "in", label: "is one of (a, b, …)" },
  { value: "null", label: "is empty (NULL)" },
  { value: "notnull", label: "is not empty" },
];

export function opTakesValue(op: FilterOp): boolean {
  return op !== "null" && op !== "notnull";
}

export interface BuilderFilter {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
}

export interface BuilderState {
  table: string;
  /** Empty = all columns. */
  columns: string[];
  filters: BuilderFilter[];
  /** "all" = every filter must match, "any" = at least one. */
  match: "all" | "any";
  orderBy: string;
  orderDir: "ASC" | "DESC";
  limit: number | null;
  countOnly: boolean;
}

export const EMPTY_BUILDER: BuilderState = {
  table: "",
  columns: [],
  filters: [],
  match: "all",
  orderBy: "",
  orderDir: "ASC",
  limit: 100,
  countOnly: false,
};

const NUMERIC_TYPE =
  /int|numeric|decimal|real|double|float|serial|money|number|bit/i;
const BOOL_TYPE = /bool/i;

function literal(value: string, dataType: string | undefined): string {
  const v = value.trim();
  if (/^null$/i.test(v)) return "NULL";
  if (dataType && NUMERIC_TYPE.test(dataType) && /^-?\d+(\.\d+)?$/.test(v)) {
    return v;
  }
  if (dataType && BOOL_TYPE.test(dataType) && /^(true|false)$/i.test(v)) {
    return v.toUpperCase();
  }
  return quoteString(v);
}

function likeEscape(v: string): string {
  return v.replace(/[%_]/g, (m) => "\\" + m);
}

function filterSql(
  engine: SqlEngine,
  f: BuilderFilter,
  types: Map<string, string>,
): string | null {
  if (!f.column) return null;
  const col = quoteIdent(engine, f.column);
  const type = types.get(f.column);
  // Case-insensitive matching is what non-SQL users expect from "contains".
  const like = engine === "postgres" ? "ILIKE" : "LIKE";
  // SQLite has no default LIKE escape character; Postgres/MySQL use `\`.
  const esc = engine === "sqlite" ? " ESCAPE '\\'" : "";
  switch (f.op) {
    case "null":
      return `${col} IS NULL`;
    case "notnull":
      return `${col} IS NOT NULL`;
    case "contains":
      return `${col} ${like} ${quoteString(`%${likeEscape(f.value)}%`)}${esc}`;
    case "starts":
      return `${col} ${like} ${quoteString(`${likeEscape(f.value)}%`)}${esc}`;
    case "ends":
      return `${col} ${like} ${quoteString(`%${likeEscape(f.value)}`)}${esc}`;
    case "in": {
      const items = f.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => literal(s, type));
      if (items.length === 0) return null;
      return `${col} IN (${items.join(", ")})`;
    }
    default:
      if (f.value.trim() === "") return null;
      return `${col} ${f.op} ${literal(f.value, type)}`;
  }
}

export function buildSelectSql(
  engine: SqlEngine,
  b: BuilderState,
  tableColumns: TableColumn[],
): string {
  if (!b.table) return "";
  const types = new Map(tableColumns.map((c) => [c.name, c.dataType]));
  const select = b.countOnly
    ? "COUNT(*) AS total"
    : b.columns.length === 0
      ? "*"
      : b.columns.map((c) => quoteIdent(engine, c)).join(", ");
  const lines = [`SELECT ${select}`, `FROM ${quoteTable(engine, b.table)}`];
  const where = b.filters
    .map((f) => filterSql(engine, f, types))
    .filter((s): s is string => !!s);
  if (where.length > 0) {
    const joiner = b.match === "all" ? "\n  AND " : "\n   OR ";
    lines.push(`WHERE ${where.join(joiner)}`);
  }
  if (!b.countOnly && b.orderBy) {
    lines.push(`ORDER BY ${quoteIdent(engine, b.orderBy)} ${b.orderDir}`);
  }
  if (!b.countOnly && b.limit && b.limit > 0) {
    lines.push(`LIMIT ${Math.floor(b.limit)}`);
  }
  return lines.join("\n") + ";";
}

// ── Starter templates for the SQL editor ───────────────────────────────────

export function templates(
  engine: SqlEngine,
  table: string | null,
  cols: TableColumn[],
): { label: string; hint: string; sql: string }[] {
  const t = table ? quoteTable(engine, table) : "table_name";
  const c1 = cols[0] ? quoteIdent(engine, cols[0].name) : "column_a";
  const c2 = cols[1] ? quoteIdent(engine, cols[1].name) : "column_b";
  return [
    {
      label: "Show rows",
      hint: "First 100 rows of a table",
      sql: `SELECT *\nFROM ${t}\nLIMIT 100;`,
    },
    {
      label: "Count rows",
      hint: "How many rows are in a table",
      sql: `SELECT COUNT(*) AS total\nFROM ${t};`,
    },
    {
      label: "Filter rows",
      hint: "Rows where a column matches a value",
      sql: `SELECT *\nFROM ${t}\nWHERE ${c1} = 'value'\nLIMIT 100;`,
    },
    {
      label: "Search text",
      hint: "Rows where a column contains some text",
      sql: `SELECT *\nFROM ${t}\nWHERE ${c1} ${engine === "postgres" ? "ILIKE" : "LIKE"} '%text%'\nLIMIT 100;`,
    },
    {
      label: "Sort rows",
      hint: "Newest / largest first",
      sql: `SELECT *\nFROM ${t}\nORDER BY ${c1} DESC\nLIMIT 100;`,
    },
    {
      label: "Group & count",
      hint: "How many rows per distinct value",
      sql: `SELECT ${c1}, COUNT(*) AS total\nFROM ${t}\nGROUP BY ${c1}\nORDER BY total DESC;`,
    },
    {
      label: "Distinct values",
      hint: "Unique values in a column",
      sql: `SELECT DISTINCT ${c1}\nFROM ${t}\nORDER BY ${c1};`,
    },
    {
      label: "Join tables",
      hint: "Combine rows from two tables",
      sql: `SELECT a.*, b.*\nFROM ${t} AS a\nJOIN other_table AS b ON b.${c1} = a.${c1}\nLIMIT 100;`,
    },
    {
      label: "Update rows",
      hint: "Change values (always use WHERE!)",
      sql: `UPDATE ${t}\nSET ${c2} = 'new value'\nWHERE ${c1} = 'value';`,
    },
    {
      label: "Delete rows",
      hint: "Remove rows (always use WHERE!)",
      sql: `DELETE FROM ${t}\nWHERE ${c1} = 'value';`,
    },
  ];
}
