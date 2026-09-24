import { describe, expect, it } from "vitest";
import {
  buildMediaIndex,
  decodeEntities,
  detectFlavour,
  findShortcodes,
  findUnresolvedMediaUrls,
  rewriteMediaUrls,
} from "./html-transform.js";
import type { MigrationState } from "./state.js";

const STRAPI = "https://cms.example.com";

function state(
  media: Array<{
    id: number;
    sourceUrl: string;
    url: string;
    formats?: Array<{ url: string; width: number }>;
  }>,
): MigrationState {
  return {
    media: Object.fromEntries(
      media.map((m) => [
        m.id,
        { strapiId: m.id, url: m.url, sourceUrl: m.sourceUrl, formats: m.formats },
      ]),
    ),
    posts: {},
    pages: {},
  };
}

const photo = state([
  {
    id: 1,
    sourceUrl: "https://blog.example.com/wp-content/uploads/2024/05/photo.jpg",
    url: "/uploads/photo_abc123.jpg",
    formats: [
      { url: "/uploads/small_photo_abc123.jpg", width: 500 },
      { url: "/uploads/large_photo_abc123.jpg", width: 1000 },
    ],
  },
]);

describe("rewriteMediaUrls", () => {
  it("rewrites the exact source URL and makes it absolute", () => {
    const html = `<img src="https://blog.example.com/wp-content/uploads/2024/05/photo.jpg">`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toBe(
      `<img src="${STRAPI}/uploads/photo_abc123.jpg">`,
    );
  });

  it("rewrites WP-generated size variants", () => {
    const html = `<img src="https://blog.example.com/wp-content/uploads/2024/05/photo-1024x768.jpg">`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toContain(`${STRAPI}/uploads/photo_abc123.jpg`);
  });

  it("rewrites -scaled originals and relative URLs", () => {
    const html = `<a href="/wp-content/uploads/2024/05/photo-scaled.jpg">file</a>`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toBe(
      `<a href="${STRAPI}/uploads/photo_abc123.jpg">file</a>`,
    );
  });

  it("rewrites image-CDN (Photon) URLs with a query string", () => {
    const html = `<img src="https://i0.wp.com/blog.example.com/wp-content/uploads/2024/05/photo.jpg?resize=1024%2C576&#038;ssl=1">`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toBe(
      `<img src="${STRAPI}/uploads/photo_abc123.jpg">`,
    );
  });

  it("rebuilds srcset from Strapi's own formats", () => {
    const html =
      `<img src="https://blog.example.com/wp-content/uploads/2024/05/photo.jpg" ` +
      `srcset="https://blog.example.com/wp-content/uploads/2024/05/photo-300x225.jpg 300w, ` +
      `https://blog.example.com/wp-content/uploads/2024/05/photo.jpg 1200w">`;
    const out = rewriteMediaUrls(html, photo, STRAPI);
    expect(out).toContain(`srcset="${STRAPI}/uploads/small_photo_abc123.jpg 500w, ${STRAPI}/uploads/large_photo_abc123.jpg 1000w"`);
    expect(out).not.toContain("blog.example.com");
  });

  it("drops srcset when Strapi generated no formats", () => {
    const noFormats = state([
      {
        id: 2,
        sourceUrl: "https://blog.example.com/wp-content/uploads/2024/05/flat.png",
        url: "/uploads/flat.png",
      },
    ]);
    const html = `<img srcset="https://blog.example.com/wp-content/uploads/2024/05/flat-300x225.png 300w" src="https://blog.example.com/wp-content/uploads/2024/05/flat.png">`;
    const out = rewriteMediaUrls(html, noFormats, STRAPI);
    expect(out).not.toContain("srcset");
    expect(out).toContain(`src="${STRAPI}/uploads/flat.png"`);
  });

  it("rewrites CSS url() in style attributes", () => {
    const html = `<div style="background-image:url('https://blog.example.com/wp-content/uploads/2024/05/photo.jpg')"></div>`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toContain(
      `url('${STRAPI}/uploads/photo_abc123.jpg')`,
    );
  });

  it("leaves unknown media alone", () => {
    const html = `<img src="https://blog.example.com/wp-content/uploads/2024/05/other.jpg">`;
    expect(rewriteMediaUrls(html, photo, STRAPI)).toBe(html);
  });

  it("does not guess when two attachments share a file name", () => {
    const ambiguous = state([
      { id: 1, sourceUrl: "https://blog.example.com/wp-content/uploads/2023/01/logo.png", url: "/uploads/a.png" },
      { id: 2, sourceUrl: "https://blog.example.com/wp-content/uploads/2024/01/logo.png", url: "/uploads/b.png" },
    ]);
    // Same directory as attachment 2 → resolved; a foreign directory → left untouched.
    expect(rewriteMediaUrls(`<img src="/wp-content/uploads/2024/01/logo.png">`, ambiguous, STRAPI)).toContain("/uploads/b.png");
    expect(rewriteMediaUrls(`<img src="https://cdn.other.com/x/logo.png">`, ambiguous, STRAPI)).toBe(
      `<img src="https://cdn.other.com/x/logo.png">`,
    );
  });

  it("is a no-op with an empty media map", () => {
    const html = `<img src="https://blog.example.com/wp-content/uploads/2024/05/photo.jpg">`;
    expect(rewriteMediaUrls(html, state([]), STRAPI)).toBe(html);
  });
});

describe("buildMediaIndex", () => {
  it("keeps Strapi-absolute URLs untouched (external upload providers)", () => {
    const s3 = state([
      {
        id: 3,
        sourceUrl: "https://blog.example.com/wp-content/uploads/2024/05/photo.jpg",
        url: "https://bucket.s3.amazonaws.com/photo.jpg",
      },
    ]);
    expect(buildMediaIndex(s3, STRAPI).lookup("/wp-content/uploads/2024/05/photo.jpg")?.url).toBe(
      "https://bucket.s3.amazonaws.com/photo.jpg",
    );
  });
});

describe("findUnresolvedMediaUrls", () => {
  it("reports WP media left behind after a rewrite", () => {
    const html = `<img src="${STRAPI}/uploads/ok.jpg"><img src="https://blog.example.com/wp-content/uploads/2024/05/missing.jpg">`;
    expect(findUnresolvedMediaUrls(html, "https://blog.example.com")).toEqual([
      "https://blog.example.com/wp-content/uploads/2024/05/missing.jpg",
    ]);
  });

  it("ignores non-media links on the WP host", () => {
    const html = `<a href="https://blog.example.com/about">about</a>`;
    expect(findUnresolvedMediaUrls(html, "https://blog.example.com")).toEqual([]);
  });
});

describe("detectFlavour", () => {
  it.each([
    ["", "empty"],
    ["<p>   </p>", "empty"],
    [`<div class="elementor-element elementor-widget">x</div>`, "elementor"],
    [`<div class="et_pb_section">x</div>`, "divi"],
    [`[vc_row][vc_column]x[/vc_column][/vc_row]`, "wpbakery"],
    [`<p class="wp-block-paragraph">x</p>`, "gutenberg"],
    [`<p>plain</p>`, "classic"],
  ])("classifies %s", (html, expected) => {
    expect(detectFlavour(html)).toBe(expected);
  });

  it("names the builder even when the body renders blank", () => {
    expect(detectFlavour(`<div class="elementor-element elementor-widget"></div>`)).toBe("elementor");
  });

  it("does not call an image-only page empty", () => {
    expect(detectFlavour(`<figure><img src="/a.jpg"></figure>`)).not.toBe("empty");
  });
});

describe("findShortcodes", () => {
  it("collects unexpanded shortcode tags", () => {
    expect(findShortcodes(`<p>[contact-form id="1"] and [gallery]</p>`).sort()).toEqual([
      "contact-form",
      "gallery",
    ]);
  });

  it("ignores plain bracketed text", () => {
    expect(findShortcodes("<p>see [1] and [ok]</p>")).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("decodes numeric, hex and named entities, accents included", () => {
    expect(decodeEntities("Caf&#233;s &amp; cr&egrave;me")).toBe("Cafés & crème");
    expect(decodeEntities("&#x153;uvre &#8217;24")).toBe("œuvre ’24");
    expect(decodeEntities("&lt;script&gt;")).toBe("<script>");
  });

  it("leaves plain text untouched", () => {
    expect(decodeEntities("déjà vu — 100% ok")).toBe("déjà vu — 100% ok");
  });
});

describe("findMediaReferences / buildSourceMatcher", () => {
  it("collects ids and URLs from rendered and raw block markup", async () => {
    const { findMediaReferences } = await import("./html-transform.js");
    const refs = findMediaReferences(
      `<!-- wp:gallery {"ids":[4,5]} --><figure data-id="6"><img class="wp-image-7" src="/u/a.jpg" srcset="/u/a-300x200.jpg 300w, /u/a-1024x768.jpg 1024w"></figure>` +
        `<div style="background-image:url('/u/bg.png')"></div>`,
    );
    expect(refs.ids.sort()).toEqual([4, 5, 6, 7]);
    expect(refs.urls).toEqual(expect.arrayContaining(["/u/a.jpg", "/u/a-300x200.jpg", "/u/bg.png"]));
  });

  it("matches size variants, -scaled originals and CDN prefixes to their attachment", async () => {
    const { buildSourceMatcher } = await import("./html-transform.js");
    const match = buildSourceMatcher([
      { id: 1, source_url: "https://site.test/app/uploads/sites/4/2024/05/photo-scaled.jpg" },
      { id: 2, source_url: "https://site.test/app/uploads/2024/05/logo.png" },
    ]);
    expect(match("https://site.test/app/uploads/sites/4/2024/05/photo-1024x683.jpg")).toBe(1);
    expect(match("https://i0.wp.com/site.test/app/uploads/2024/05/logo.png?w=300")).toBe(2);
    expect(match("https://site.test/other.jpg")).toBeNull();
  });
});
