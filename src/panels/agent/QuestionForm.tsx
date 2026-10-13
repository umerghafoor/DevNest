import { useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import type {
  ElicitationField,
  ElicitationRequest,
  ElicitationResponse,
  EnumOption,
} from "../../lib/acp";

/**
 * Renders an agent's form elicitation — e.g. Claude Code's AskUserQuestion —
 * as compact clickable options in place of the composer. Handles the flat
 * JSON Schema subset ACP allows: single choice (`oneOf` / `enum`), multi
 * choice (array of `anyOf` / `enum`), free text, numbers and booleans.
 *
 * Keyboard: 1–9 picks an option of the first choice field, Enter submits,
 * Esc skips.
 */
export function QuestionForm({
  req,
  onAnswer,
  onStop,
}: {
  req: ElicitationRequest;
  onAnswer: (r: ElicitationResponse) => void;
  onStop: () => void;
}) {
  const props = req.requestedSchema?.properties ?? {};
  const entries = Object.entries(props);
  const required = new Set(req.requestedSchema?.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [k, f] of entries) {
      if (f.default !== undefined) init[k] = f.default;
    }
    return init;
  });
  const formRef = useRef<React.ComponentRef<"form">>(null);

  const set = (k: string, v: unknown) => setValues((p) => ({ ...p, [k]: v }));
  const missing = [...required].some((k) => isEmpty(values[k]));

  // With a single question, its title chip goes in the header row.
  const choiceFields = entries.filter(([, f]) => choicesOf(f));
  const singleQuestion = choiceFields.length === 1;

  const submit = () => {
    if (missing) return;
    const content: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (!isEmpty(v)) content[k] = v;
    }
    onAnswer({ action: "accept", content });
  };

  // Focus the card so number keys work straight away.
  useEffect(() => {
    formRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      e.preventDefault();
      onAnswer({ action: "decline" });
    } else if (!typing && /^[1-9]$/.test(e.key) && choiceFields[0]) {
      const [key, field] = choiceFields[0];
      const opt = choicesOf(field)![Number(e.key) - 1];
      if (!opt) return;
      e.preventDefault();
      set(
        key,
        field.type === "array" ? toggle(values[key], opt.const) : opt.const,
      );
    }
  };

  return (
    <form
      ref={formRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="no-focus-ring rounded-xl border border-(--color-accent)/60 bg-(--color-surface) p-2 outline-none"
    >
      <div className="mb-1.5 flex items-baseline gap-2 px-1">
        {singleQuestion && choiceFields[0][1].title && (
          <span className="shrink-0 rounded bg-(--color-accent)/15 px-1.5 text-[10px] font-semibold tracking-wide text-(--color-accent) uppercase">
            {choiceFields[0][1].title}
          </span>
        )}
        <span className="text-[13px] font-medium">{req.message}</span>
      </div>

      <div className="max-h-[40vh] space-y-2 overflow-y-auto">
        {entries.map(([key, field]) => (
          <Field
            key={key}
            field={field}
            showTitle={!singleQuestion}
            required={required.has(key)}
            value={values[key]}
            onChange={(v) => set(key, v)}
          />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1.5 px-1">
        <span className="flex-1 truncate text-[11px] text-(--color-fg-muted)">
          {choiceFields.length > 0 && "1–9 to pick · "}Enter to submit · Esc to
          skip
        </span>
        <button
          type="button"
          className="h-6 rounded-md px-2.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          onClick={() => onAnswer({ action: "decline" })}
          title="Don't answer; let the agent continue"
        >
          Skip
        </button>
        <button
          type="submit"
          disabled={missing}
          className="h-6 rounded-md bg-(--color-accent) px-3 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Stop this turn"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          <Square size={10} fill="currentColor" />
        </button>
      </div>
    </form>
  );
}

function Field({
  field,
  showTitle,
  required,
  value,
  onChange,
}: {
  field: ElicitationField;
  showTitle: boolean;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const options = choicesOf(field);

  if (options) {
    const multi = field.type === "array";
    return (
      <div>
        {(showTitle || field.description) && (
          <div className="mb-1 px-1 text-[12px]">
            {showTitle && field.title && (
              <span className="mr-1.5 font-semibold">
                {field.title}
                {required && " *"}
              </span>
            )}
            {field.description && (
              <span className="text-(--color-fg-muted)">
                {field.description}
              </span>
            )}
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-(--color-border)">
          {options.map((o, i) => {
            const on = multi
              ? Array.isArray(value) && value.includes(o.const)
              : value === o.const;
            return (
              <button
                key={o.const}
                type="button"
                onClick={() =>
                  onChange(
                    multi ? toggle(value, o.const) : on ? undefined : o.const,
                  )
                }
                title={o.description}
                className={`flex w-full items-center gap-2 border-t border-(--color-border) px-2 py-1 text-left first:border-t-0 ${
                  on ? "bg-(--color-accent)/12" : "hover:bg-(--color-surface-2)"
                }`}
              >
                <Mark on={on} round={!multi} />
                <span className="w-3 shrink-0 text-right text-[11px] text-(--color-fg-muted) tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{o.title ?? o.const}</span>
                  {o.description && (
                    <span className="text-(--color-fg-muted)">
                      {"  "}
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center gap-2 px-1">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.title ?? field.description}
      </label>
    );
  }

  const numeric = field.type === "number" || field.type === "integer";
  return (
    <input
      type={numeric ? "number" : "text"}
      step={field.type === "integer" ? 1 : undefined}
      value={value === undefined ? "" : String(value)}
      onChange={(e) =>
        onChange(
          numeric
            ? e.target.value === ""
              ? undefined
              : Number(e.target.value)
            : e.target.value,
        )
      }
      // Claude's per-question "Other" box arrives as a text field titled
      // "Other" with a long description — keep the placeholder short.
      placeholder={field.title ? `${field.title}…` : "Answer…"}
      title={field.description}
      className="no-focus-ring h-6 w-full rounded-md border border-(--color-border) bg-(--color-bg) px-2 text-xs outline-none placeholder:text-(--color-fg-muted) focus:border-(--color-accent)"
    />
  );
}

function Mark({ on, round }: { on: boolean; round: boolean }) {
  return (
    <span
      className={`inline-flex h-3 w-3 shrink-0 items-center justify-center border ${
        round ? "rounded-full" : "rounded-sm"
      } ${on ? "border-(--color-accent) bg-(--color-accent)" : "border-(--color-fg-muted)"}`}
    >
      {on && (
        <span
          className={`h-1 w-1 bg-(--color-accent-fg) ${round ? "rounded-full" : ""}`}
        />
      )}
    </span>
  );
}

function choicesOf(f: ElicitationField): EnumOption[] | null {
  const labeled = f.type === "array" ? f.items?.anyOf : f.oneOf;
  const bare = f.type === "array" ? f.items?.enum : f.enum;
  if (labeled?.length) return labeled;
  if (bare?.length) return bare.map((v) => ({ const: v }));
  return null;
}

function toggle(value: unknown, c: string): string[] {
  const picked = Array.isArray(value) ? (value as string[]) : [];
  return picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c];
}

function isEmpty(v: unknown) {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}
