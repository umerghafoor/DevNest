import { useState } from "react";
import type {
  ElicitationField,
  ElicitationRequest,
  ElicitationResponse,
  EnumOption,
} from "../../lib/acp";

/**
 * Renders an agent's form elicitation — e.g. Claude Code's AskUserQuestion —
 * as clickable options. Handles the flat JSON Schema subset ACP allows:
 * single choice (`oneOf` / `enum`), multi choice (array of `anyOf` / `enum`),
 * free text, numbers and booleans.
 */
export function QuestionForm({
  req,
  onAnswer,
}: {
  req: ElicitationRequest;
  onAnswer: (r: ElicitationResponse) => void;
}) {
  const props = req.requestedSchema?.properties ?? {};
  const required = new Set(req.requestedSchema?.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(props)) {
      if (f.default !== undefined) init[k] = f.default;
    }
    return init;
  });

  const set = (k: string, v: unknown) => setValues((p) => ({ ...p, [k]: v }));
  const missing = [...required].some((k) => isEmpty(values[k]));

  const submit = () => {
    if (missing) return;
    const content: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (!isEmpty(v)) content[k] = v;
    }
    onAnswer({ action: "accept", content });
  };

  return (
    <div className="shrink-0 border-t border-(--color-border) px-4 pt-3">
      <form
        className="mx-auto max-w-3xl rounded-xl border border-(--color-accent)/50 bg-(--color-surface) p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mb-2.5 text-[13px] font-medium">{req.message}</div>
        <div className="max-h-[45vh] space-y-3 overflow-y-auto">
          {Object.entries(props).map(([key, field]) => (
            <Field
              key={key}
              field={field}
              required={required.has(key)}
              value={values[key]}
              onChange={(v) => set(key, v)}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            onClick={() => onAnswer({ action: "decline" })}
            title="Answer nothing and let the agent continue"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={missing}
            className="rounded-md bg-(--color-accent) px-3 py-1 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  field,
  required,
  value,
  onChange,
}: {
  field: ElicitationField;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = field.title ?? "";
  const single = choices(field.oneOf, field.enum);
  const multi =
    field.type === "array"
      ? choices(field.items?.anyOf, field.items?.enum)
      : null;

  const heading = (label || field.description) && (
    <div className="mb-1">
      {label && (
        <span className="mr-2 rounded bg-(--color-surface-2) px-1.5 py-0.5 text-[11px] font-medium text-(--color-fg-muted)">
          {label}
          {required && " *"}
        </span>
      )}
      {field.description && (
        <span className="text-[12px]">{field.description}</span>
      )}
    </div>
  );

  if (single) {
    return (
      <div>
        {heading}
        <OptionList
          options={single}
          isOn={(c) => value === c}
          onToggle={(c) => onChange(value === c ? undefined : c)}
          kind="radio"
        />
      </div>
    );
  }

  if (multi) {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div>
        {heading}
        <OptionList
          options={multi}
          isOn={(c) => picked.includes(c)}
          onToggle={(c) =>
            onChange(
              picked.includes(c)
                ? picked.filter((x) => x !== c)
                : [...picked, c],
            )
          }
          kind="checkbox"
        />
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label || field.description}
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
      // Claude's per-question "Other" box arrives as a titled text field.
      placeholder={
        [label, field.description].filter(Boolean).join(" — ") || "Answer"
      }
      title={field.description}
      className="h-7 w-full rounded-md border border-(--color-border) bg-(--color-bg) px-2 text-xs outline-none placeholder:text-(--color-fg-muted) focus:border-(--color-accent)"
    />
  );
}

function OptionList({
  options,
  isOn,
  onToggle,
  kind,
}: {
  options: EnumOption[];
  isOn: (c: string) => boolean;
  onToggle: (c: string) => void;
  kind: "radio" | "checkbox";
}) {
  return (
    <div className="space-y-1">
      {options.map((o, i) => {
        const on = isOn(o.const);
        return (
          <button
            key={o.const}
            type="button"
            onClick={() => onToggle(o.const)}
            className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              on
                ? "border-(--color-accent) bg-(--color-accent)/10"
                : "border-(--color-border) hover:bg-(--color-surface-2)"
            }`}
          >
            <span
              className={`mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                kind === "radio" ? "rounded-full" : "rounded-sm"
              } ${
                on
                  ? "border-(--color-accent) bg-(--color-accent)"
                  : "border-(--color-fg-muted)"
              }`}
            >
              {on && (
                <span
                  className={`h-1.5 w-1.5 bg-(--color-accent-fg) ${
                    kind === "radio" ? "rounded-full" : "rounded-[1px]"
                  }`}
                />
              )}
            </span>
            <span className="min-w-0">
              <span className="font-medium">
                <span className="mr-1.5 text-(--color-fg-muted)">{i + 1}.</span>
                {o.title ?? o.const}
              </span>
              {o.description && (
                <span className="block text-(--color-fg-muted)">
                  {o.description}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function choices(
  labeled: EnumOption[] | undefined,
  bare: string[] | undefined,
): EnumOption[] | null {
  if (labeled?.length) return labeled;
  if (bare?.length) return bare.map((v) => ({ const: v }));
  return null;
}

function isEmpty(v: unknown) {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}
