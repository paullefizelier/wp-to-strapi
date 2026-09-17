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
