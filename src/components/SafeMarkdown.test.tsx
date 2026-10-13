import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown";

const render = (text: string) =>
  renderToStaticMarkup(<SafeMarkdown text={text} />);

describe("SafeMarkdown", () => {
  it("renders lists, emphasis and inline code", () => {
    const html = render("1. **Add** a `x<y>`\n2. two");
    expect(html).toContain("<ol");
    expect(html).toContain("<strong>Add</strong>");
    expect(html).toContain("<code>x&lt;y&gt;</code>");
  });

  it("shows raw HTML as text instead of rendering it", () => {
    const html = render("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("only links http(s) URLs", () => {
    const html = render("[bad](javascript:alert(1)) [ok](https://a.b)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://a.b"');
  });
});
