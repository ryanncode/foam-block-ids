import { URI } from './uri';
import { Range } from './range';

export interface ResourceLink {
  type: 'wikilink' | 'link';
  rawText: string;
  range: Range;
  isEmbed: boolean;
}

export interface NoteLinkDefinition {
  label: string;
  url: string;
  title?: string;
  range?: Range;
}

export abstract class NoteLinkDefinition {
  static format(definition: NoteLinkDefinition) {
    const url =
      definition.url.indexOf(' ') > 0 ? `<${definition.url}>` : definition.url;
    let text = `[${definition.label}]: ${url}`;
    if (definition.title) {
      text = `${text} "${definition.title}"`;
    }

    return text;
  }
}

export interface Tag {
  label: string;
  range: Range;
}

export interface Alias {
  title: string;
  range: Range;
}

/**
 * Represents a linkable part of a document, which can be either a heading
 * or a block of content with a block identifier.
 *
 * This interface is designed to be uniform, abstracting the differences
 * between headings and blocks so that they can be treated identically
 * by the rest of the application (e.g. for link resolution, completion).
 */
export interface Section {
  /**
   * The human-readable text content of the section.
   * e.g. "My Awesome Heading" or "This is a paragraph of text."
   */
  label: string;
  range: Range;

  /**
   * The primary, or "canonical", identifier for this section.
   * This is the ID that Foam should use when creating new links.
   * For a heading, this is the slug (e.g. "my-awesome-heading").
   * For a block, this is the block ID (e.g. "^my-block-id").
   * Can be undefined for sections that are not directly linkable by a primary ID,
   * like list items without a block ID.
   */
  canonicalId: string | undefined;

  /**
   * A list of all valid identifiers that can resolve to this section.
   * This includes the canonicalId, plus any alternatives.
   * e.g. for a block: ["^my-block-id", "my-block-id"]
   * e.g. for a heading with a blockId: ["my-awesome-heading", "^h-block-id", "h-block-id"]
   */
  linkableIds: string[];
}

export interface Resource {
  uri: URI;
  type: string;
  title: string;
  properties: any;
  sections: Section[];
  tags: Tag[];
  aliases: Alias[];
  links: ResourceLink[];

  // TODO to remove
  definitions: NoteLinkDefinition[];
}

export interface ResourceParser {
  parse: (uri: URI, text: string) => Resource;
}

export abstract class Resource {
  public static sortByTitle(a: Resource, b: Resource) {
    return a.title.localeCompare(b.title);
  }

  public static sortByPath(a: Resource, b: Resource) {
    return a.uri.path.localeCompare(b.uri.path);
  }

  public static isResource(thing: any): thing is Resource {
    if (!thing) {
      return false;
    }
    return (
      (thing as Resource).uri instanceof URI &&
      typeof (thing as Resource).title === 'string' &&
      typeof (thing as Resource).type === 'string' &&
      typeof (thing as Resource).properties === 'object' &&
      typeof (thing as Resource).tags === 'object' &&
      typeof (thing as Resource).aliases === 'object' &&
      typeof (thing as Resource).links === 'object'
    );
  }

  public static findSection(
    resource: Resource,
    fragment: string
  ): Section | null {
    if (!fragment) return null;
    // Normalize for robust matching (legacy logic)
    const normalize = (str: string | undefined) =>
      str
        ? str
            .toLocaleLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9_-]/g, '')
        : '';
    const normFragment = normalize(fragment);
    return (
      resource.sections.find(s => {
        // For headings with blockId, match slug, caret-prefixed blockId, or blockId without caret
        if (s.canonicalId && s.linkableIds) {
          if (s.linkableIds.includes(fragment)) return true;
          if (s.linkableIds.includes(normFragment)) return true;
        }
        return false;
      }) ?? null
    );
  }
}
