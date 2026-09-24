import { describe, expect, it } from "vitest";
import { extractReadableContent } from "./content-extract.js";

const PAGE_URL = "https://blog.example.com/services/";

function page(body: string): string {
  return `<!doctype html><html><head><title>t</title><style>.a{color:red}</style></head>
<body><header class="site-header"><nav><a href="/">Menu</a></nav></header>
${body}
<footer class="site-footer">© 2024</footer>
<script>tracker()</script></body></html>`;
}

describe("extractReadableContent", () => {
  it("keeps text and images from an Elementor page and drops the layout", () => {
    const html = page(`
      <div data-elementor-type="wp-post" class="elementor elementor-1">
        <section class="elementor-section elementor-top-section">
          <div class="elementor-column elementor-col-50">
            <div class="elementor-widget elementor-widget-heading">
              <div class="elementor-widget-container"><h2 class="elementor-heading-title">Our services</h2></div>
            </div>
            <div class="elementor-widget elementor-widget-text-editor">
              <div class="elementor-widget-container"><p>We build ${"things ".repeat(40)}</p></div>
            </div>
            <div class="elementor-widget elementor-widget-image">
              <div class="elementor-widget-container"><img src="/wp-content/uploads/2024/05/team.jpg" alt="The team" class="attachment-large"></div>
            </div>
          </div>
        </section>
      </div>`);
    const out = extractReadableContent(html, PAGE_URL);

    expect(out.html).toContain("<h2>Our services</h2>");
    expect(out.html).toContain('<img src="https://blog.example.com/wp-content/uploads/2024/05/team.jpg" alt="The team">');
    expect(out.html).not.toMatch(/elementor|class=|style=/);
    expect(out.html).not.toContain("Menu");
    expect(out.html).not.toContain("tracker()");
    expect(out.html).not.toContain("© 2024");
    expect(out.textLength).toBeGreaterThan(200);
  });

  it("resolves relative URLs against the page and rewrites srcset candidates", () => {
    const html = page(
      `<article class="entry-content"><p>${"word ".repeat(60)}</p>` +
        `<img src="../uploads/a.jpg" srcset="../uploads/a-300x200.jpg 300w, /uploads/a.jpg 900w" alt="a">` +
        `<a href="/contact">Contact</a></article>`,
    );
    const out = extractReadableContent(html, PAGE_URL);
    expect(out.html).toContain('src="https://blog.example.com/uploads/a.jpg"');
    expect(out.html).toContain("https://blog.example.com/uploads/a-300x200.jpg 300w");
    expect(out.html).toContain('href="https://blog.example.com/contact"');
  });

  it("reports dropped embeds instead of silently losing them", () => {
    const html = page(
      `<div class="entry-content"><p>${"text ".repeat(60)}</p>` +
        `<iframe src="https://youtube.com/embed/x"></iframe><video src="/v.mp4"></video></div>`,
    );
    const out = extractReadableContent(html, PAGE_URL);
    expect(out.droppedEmbeds).toBe(2);
    expect(out.html).not.toContain("iframe");
  });

  it("prefers the post container over the whole body", () => {
    const html = page(
      `<div class="entry-content"><p>${"real content ".repeat(20)}</p></div>` +
        `<div class="related-posts"><p>${"noise ".repeat(80)}</p></div>`,
    );
    const out = extractReadableContent(html, PAGE_URL);
    expect(out.html).toContain("real content");
    expect(out.html).not.toContain("noise");
  });

  it("strips comment threads and screen-reader-only text", () => {
    const html = page(
      `<div class="entry-content"><span class="screen-reader-text">skip</span><p>${"body ".repeat(60)}</p></div>` +
        `<div id="comments"><p>a comment</p></div>`,
    );
    const out = extractReadableContent(html, PAGE_URL);
    expect(out.html).not.toContain("skip");
    expect(out.html).not.toContain("a comment");
  });

  it("drops images with no usable src and prunes the empty wrappers", () => {
    const html = page(
      `<div class="entry-content"><p>${"x ".repeat(60)}</p><figure><img data-lazy-src="/a.jpg"></figure><p></p></div>`,
    );
    const out = extractReadableContent(html, PAGE_URL);
    expect(out.html).not.toContain("<img");
    expect(out.html).not.toContain("<figure>");
    expect(out.html).not.toContain("<p></p>");
  });

  it("returns nothing for an empty document", () => {
    expect(extractReadableContent("", PAGE_URL)).toEqual({ html: "", textLength: 0, droppedEmbeds: 0 });
  });
});
