/**
 * Minimal syntax highlighter for systemd unit files (and INI-like configs).
 *
 * Produces an array of React fragments — one per line — with span coloring
 * for [Section], Key, =, Value, # comments, and ; comments.
 */
import React from "react";

export interface HighlightedLine {
  key: string;
  node: React.ReactNode;
}

export function highlightUnit(text: string): HighlightedLine[] {
  return text.split("\n").map((line, i) => ({
    key: `${i}`,
    node: highlightLine(line, i),
  }));
}

function highlightLine(line: string, idx: number): React.ReactNode {
  // Comment line
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return (
      <span className="text-(--color-fg-muted) italic" key={idx}>
        {line || " "}
      </span>
    );
  }

  // Section header [Unit]
  const sectionMatch = line.match(/^(\s*)(\[[^\]]+\])(\s*)$/);
  if (sectionMatch) {
    return (
      <>
        <span>{sectionMatch[1]}</span>
        <span className="font-semibold text-(--color-accent)">{sectionMatch[2]}</span>
        <span>{sectionMatch[3]}</span>
      </>
    );
  }

  // Key=Value
  const kvMatch = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*)(\s*)(=)(.*)$/);
  if (kvMatch) {
    const [, lead, key, sp, eq, rest] = kvMatch;
    return (
      <>
        <span>{lead}</span>
        <span className="text-(--color-online)">{key}</span>
        <span>{sp}</span>
        <span className="text-(--color-fg-muted)">{eq}</span>
        <span className="text-(--color-fg)">{rest}</span>
      </>
    );
  }

  // Plain / continuation line
  return <span>{line || " "}</span>;
}
