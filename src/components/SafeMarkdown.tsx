import { memo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Markdown for untrusted text (agent output). Parses with `marked` but builds
 * React elements from the tokens instead of injecting HTML, so nothing the
 * text contains can become live markup — important because this webview can
 * invoke backend commands. Raw HTML in the source is shown as text.
 */
export const SafeMarkdown = memo(function SafeMarkdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const tokens = marked.lexer(text, { gfm: true });
  return (
    <div className={`markdown-preview ${className}`}>{blocks(tokens)}</div>
  );
});

function blocks(tokens: Token[]): ReactNode[] {
  return tokens.map((t, i) => block(t, i));
}

function block(t: Token, key: number): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens)}</p>;
    case "heading": {
      const h = t as Tokens.Heading;
      const Tag = `h${Math.min(h.depth, 6)}` as "h1";
      return <Tag key={key}>{inline(h.tokens)}</Tag>;
    }
    case "code": {
      const c = t as Tokens.Code;
      return (
        <pre key={key}>
          <code>{c.text}</code>
        </pre>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key}>
          {blocks((t as Tokens.Blockquote).tokens)}
        </blockquote>
      );
    case "list": {
      const l = t as Tokens.List;
      const items = l.items.map((it, j) => (
        <li key={j}>
          {it.task && (
            <input
              type="checkbox"
              checked={!!it.checked}
              readOnly
              className="mr-1.5 align-middle"
            />
          )}
          {/* Tight lists wrap item text in a bare `text` token. */}
          {it.tokens.map((c, k) =>
            c.type === "text" ? (
              <span key={k}>{inline((c as Tokens.Text).tokens ?? [c])}</span>
            ) : (
              block(c, k)
            ),
          )}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === "number" ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      const tb = t as Tokens.Table;
      return (
        <table key={key}>
          <thead>
            <tr>
              {tb.header.map((c, j) => (
                <th key={j}>{inline(c.tokens)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, k) => (
                  <td key={k}>{inline(c.tokens)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "text": {
      const tx = t as Tokens.Text;
      return <p key={key}>{tx.tokens ? inline(tx.tokens) : tx.text}</p>;
    }
    default:
      // html and anything unknown: show the source, never render it.
      return <p key={key}>{"raw" in t ? String(t.raw) : ""}</p>;
  }
}

function inline(tokens: Token[] | undefined): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    switch (t.type) {
      case "text": {
        const tx = t as Tokens.Text;
        return tx.tokens ? (
          <span key={i}>{inline(tx.tokens)}</span>
        ) : (
          decode(tx.text)
        );
      }
      case "escape":
        return (t as Tokens.Escape).text;
      case "strong":
        return <strong key={i}>{inline((t as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={i}>{inline((t as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={i}>{inline((t as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <code key={i}>{decode((t as Tokens.Codespan).text)}</code>;
      case "br":
        return <br key={i} />;
      case "link": {
        const l = t as Tokens.Link;
        const safe = /^https?:\/\//i.test(l.href);
        return safe ? (
          <a
            key={i}
            href={l.href}
            title={l.href}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(l.href);
            }}
          >
            {inline(l.tokens)}
          </a>
        ) : (
          <span key={i}>{inline(l.tokens)}</span>
        );
      }
      case "image": {
        // Don't fetch remote images from agent output; show alt text.
        const im = t as Tokens.Image;
        return <span key={i}>[{im.text || "image"}]</span>;
      }
      default:
        return "raw" in t ? String(t.raw) : "";
    }
  });
}

/** marked escapes entities in text tokens; undo that since React escapes. */
function decode(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
