// Minimal shapes of the WP REST payloads we care about.
// See https://developer.wordpress.org/rest-api/reference/

export interface WpRendered {
  rendered: string;
  protected?: boolean;
}

export interface WpPost {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  type: string;
  link: string;
  title: WpRendered;
  content: WpRendered;
  excerpt: WpRendered;
  author: number;
  featured_media: number;
  categories?: number[];
  tags?: number[];
  _embedded?: Record<string, unknown>;
}

export interface WpPage extends WpPost {
  parent: number;
  menu_order: number;
}

/** A term from a WP taxonomy endpoint (/categories, /tags, or a custom taxonomy). */
export interface WpTerm {
  id: number;
  name: string;
  slug: string;
  description?: string;
  count?: number;
  parent?: number;
  taxonomy?: string;
}

/** A WordPress author. */
export interface WpUser {
  id: number;
  name: string;
  slug: string;
  description?: string;
  url?: string;
  link?: string;
  avatar_urls?: Record<string, string>;
}

/** A comment, as returned by /wp/v2/comments. */
export interface WpComment {
  id: number;
  post: number;
  parent: number;
  author: number;
  author_name: string;
  author_url?: string;
  date_gmt: string;
  content: WpRendered;
  status: string;
  link?: string;
}

/** A navigation menu (WP 5.9+, authenticated). */
export interface WpMenu {
  id: number;
  name: string;
  slug: string;
  description?: string;
  locations?: string[];
}

export interface WpMenuItem {
  id: number;
  title: WpRendered | string;
  url: string;
  status: string;
  parent: number;
  menu_order: number;
  object?: string;
  object_id?: number;
  type?: string;
  target?: string;
  menus?: number;
}

export interface WpMedia {
  id: number;
  date: string;
  slug: string;
  type: "attachment";
  mime_type: string;
  media_type: "image" | "file";
  source_url: string;
  title: WpRendered;
  alt_text: string;
  caption: WpRendered;
  media_details: {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
    /** WP's generated variants (thumbnail, medium, large…), keyed by size name. */
    sizes?: Record<string, { file?: string; width?: number; height?: number; source_url?: string }>;
  };
}

export interface StrapiUploadFile {
  id: number;
  documentId?: string;
  name: string;
  url: string;
  mime: string;
  width?: number;
  height?: number;
  /** Responsive variants Strapi generated for images (thumbnail, small, medium, large). */
  formats?: Record<string, { url?: string; width?: number } | undefined> | null;
}

export interface StrapiEntry {
  id: number;
  documentId: string;
}
