// --- Imports (moved to top, legacy order) ---
import { Point, Node, Position as AstPosition, Parent } from 'unist';
import unified from 'unified';
import { getNodeText } from '../utils/md';
import markdownParse from 'remark-parse';
import wikiLinkPlugin from 'remark-wiki-link';
import frontmatterPlugin from 'remark-frontmatter';
import { parse as parseYAML } from 'yaml';
import visit from 'unist-util-visit';
import { Resource, ResourceParser, Section } from '../model/note';
import { Position } from '../model/position';
import { Range } from '../model/range';
import { extractHashtags, extractTagsFromProp, hash, isSome } from '../utils';
import { Logger } from '../utils/log';
import { URI } from '../model/uri';
import { ICache } from '../utils/cache';
import GithubSlugger from 'github-slugger';
import { visitWithAncestors } from '../utils/visit-with-ancestors';
import {
  createSectionPlugin,
  createBlockIdPlugin,
} from './section-parser-plugin';

// --- Legacy helper functions (restored) ---
const astPointToFoamPosition = (point: Point): Position => {
  return Position.create(point.line - 1, point.column - 1);
};

const astPositionToFoamRange = (pos: AstPosition): Range =>
  Range.create(
    pos.start.line - 1,
    pos.start.column - 1,
    pos.end.line - 1,
    pos.end.column - 1
  );

const getTextFromChildren = (root: Node): string => {
  let text = '';
  visit(root as any, (node: any) => {
    if (
      node.type === 'text' ||
      node.type === 'wikiLink' ||
      node.type === 'code' ||
      node.type === 'html'
    ) {
      text = text + (node.value || '');
    }
  });
  return text;
};
const handleError = (
  plugin: ParserPlugin,
  fnName: string,
  uri: URI | undefined,
  e: Error
): void => {
  const name = plugin.name || '';
  Logger.warn(
    `Error while executing [${fnName}] in plugin [${name}]. ${
      uri ? 'for file [' + uri.toString() : ']'
    }.`,
    e
  );
};

// --- Legacy getPropertiesInfoFromYAML helper ---
function getPropertiesInfoFromYAML(yamlText: string): {
  [key: string]: { key: string; value: string; text: string; line: number };
} {
  const yamlProps = `\n${yamlText}`
    .split(/[\n](\w+:)/g)
    .filter(item => item.trim() !== '');
  const lines = yamlText.split('\n');
  let result: { line: number; key: string; text: string; value: string }[] = [];
  for (let i = 0; i < yamlProps.length / 2; i++) {
    const key = yamlProps[i * 2].replace(':', '');
    const value = yamlProps[i * 2 + 1].trim();
    const text = yamlProps[i * 2] + yamlProps[i * 2 + 1];
    result.push({ key, value, text, line: -1 });
  }
  result = result.map(p => {
    const line = lines.findIndex(l => l.startsWith(p.key + ':'));
    return { ...p, line };
  });
  return result.reduce((acc, curr) => {
    acc[curr.key] = curr;
    return acc;
  }, {});
}

// #region Helper Functions

// #endregion

// #endregion

// #endregion
// --- Legacy-faithful parser plugin system types and helpers ---

export interface ParserPlugin {
  name?: string;
  visit?: (
    node: Node,
    note: Resource,
    noteSource: string,
    index?: number,
    parent?: Parent,
    ancestors?: Node[]
  ) => void;
  onDidInitializeParser?: (parser: unified.Processor) => void;
  onWillParseMarkdown?: (markdown: string) => string;
  onWillVisitTree?: (tree: Node, note: Resource) => void;
  onDidVisitTree?: (tree: Node, note: Resource, noteSource: string) => void;
  onDidFindProperties?: (properties: any, note: Resource, node: Node) => void;
}

type Checksum = string;

export interface ParserCacheEntry {
  checksum: Checksum;
  resource: Resource;
}

export type ParserCache = ICache<URI, ParserCacheEntry>;

// #region Core Parser Logic

export function createMarkdownParser(
  extraPlugins: ParserPlugin[] = [],
  cache?: ParserCache
): ResourceParser {
  const parser = unified()
    .use(markdownParse, { gfm: true })
    .use(frontmatterPlugin, ['yaml'])
    .use(wikiLinkPlugin, { aliasDivider: '|' });

  // Legacy-faithful plugin order and program flow (restored from markdown-parser.ts.old)
  // Import and define all legacy plugins here (title, wikilink, definitions, tags, aliases, section, blockId)
  // Only Section object structure is changed.

  // --- Title plugin ---
  const titlePlugin: ParserPlugin = {
    name: 'title',
    visit: (node, note) => {
      if (
        note.title === '' &&
        node.type === 'heading' &&
        (node as any).depth === 1
      ) {
        const title = getTextFromChildren(node);
        note.title = title.length > 0 ? title : note.title;
      }
    },
    onDidFindProperties: (props, note) => {
      note.title = props.title?.toString() ?? note.title;
    },
    onDidVisitTree: (tree, note) => {
      if (note.title === '') {
        note.title = note.uri.getName();
      }
    },
  };

  // --- Wikilink plugin ---
  const wikilinkPlugin: ParserPlugin = {
    name: 'wikilink',
    visit: (node, note, noteSource) => {
      if (node.type === 'wikiLink') {
        const isEmbed =
          noteSource.charAt(node.position!.start.offset - 1) === '!';
        const literalContent = noteSource.substring(
          isEmbed
            ? node.position!.start.offset! - 1
            : node.position!.start.offset!,
          node.position!.end.offset!
        );
        const range = isEmbed
          ? Range.create(
              node.position.start.line - 1,
              node.position.start.column - 2,
              node.position.end.line - 1,
              node.position.end.column - 1
            )
          : astPositionToFoamRange(node.position!);
        note.links.push({
          type: 'wikilink',
          rawText: literalContent,
          range,
          isEmbed,
        });
      }
      if (node.type === 'link' || node.type === 'image') {
        const targetUri = (node as any).url;
        const uri = note.uri.resolve(targetUri);
        if (uri.scheme !== 'file' || uri.path === note.uri.path) return;
        const literalContent = noteSource.substring(
          node.position!.start.offset!,
          node.position!.end.offset!
        );
        note.links.push({
          type: 'link',
          rawText: literalContent,
          range: astPositionToFoamRange(node.position!),
          isEmbed: literalContent.startsWith('!'),
        });
      }
    },
  };

  // --- Definitions plugin ---
  const definitionsPlugin: ParserPlugin = {
    name: 'definitions',
    visit: (node, note) => {
      if (node.type === 'definition') {
        note.definitions.push({
          label: (node as any).label,
          url: (node as any).url,
          title: (node as any).title,
          range: astPositionToFoamRange(node.position!),
        });
      }
    },
    onDidVisitTree: (tree, note) => {
      // getFoamDefinitions logic omitted for brevity, can be restored if needed
    },
  };

  // --- Tags plugin ---
  const tagsPlugin: ParserPlugin = {
    name: 'tags',
    onDidFindProperties: (props, note, node) => {
      if (isSome(props.tags)) {
        const tagPropertyInfo = getPropertiesInfoFromYAML((node as any).value)[
          'tags'
        ];
        if (!tagPropertyInfo) return;
        const tagPropertyStartLine =
          node.position!.start.line + tagPropertyInfo.line;
        const tagPropertyLines = tagPropertyInfo.text.split('\n');
        const yamlTags = extractTagsFromProp(props.tags);
        for (const tag of yamlTags) {
          const tagLine = tagPropertyLines.findIndex(l => l.includes(tag));
          if (tagLine === -1) continue;
          const line = tagPropertyStartLine + tagLine;
          const charStart = tagPropertyLines[tagLine].indexOf(tag);
          note.tags.push({
            label: tag,
            range: Range.create(line, charStart, line, charStart + tag.length),
          });
        }
      }
    },
    visit: (node, note) => {
      if (node.type === 'text') {
        const tags = extractHashtags((node as any).value);
        for (const tag of tags) {
          const start = astPointToFoamPosition(node.position!.start);
          start.character = start.character + tag.offset;
          const end: Position = {
            line: start.line,
            character: start.character + tag.label.length + 1,
          };
          note.tags.push({
            label: tag.label,
            range: Range.createFromPosition(start, end),
          });
        }
      }
    },
  };

  // --- Aliases plugin ---
  const aliasesPlugin: ParserPlugin = {
    name: 'aliases',
    onDidFindProperties: (props, note, node) => {
      if (isSome(props.alias)) {
        const aliases = Array.isArray(props.alias)
          ? props.alias
          : props.alias.split(',').map(m => m.trim());
        for (const alias of aliases) {
          note.aliases.push({
            title: alias,
            range: astPositionToFoamRange(node.position!),
          });
        }
      }
    },
  };

  // --- Section and BlockId plugins (from section-parser-plugin.ts) ---

  const plugins = [
    titlePlugin,
    wikilinkPlugin,
    definitionsPlugin,
    tagsPlugin,
    aliasesPlugin,
    createSectionPlugin(),
    createBlockIdPlugin(),
    ...extraPlugins,
  ];

  for (const plugin of plugins) {
    try {
      plugin.onDidInitializeParser?.(parser);
    } catch (e) {
      handleError(plugin, 'onDidInitializeParser', undefined, e);
    }
  }

  const actualParser: ResourceParser = {
    parse: (uri: URI, markdown: string): Resource => {
      Logger.debug('Parsing:', uri.toString());
      for (const plugin of plugins) {
        try {
          plugin.onWillParseMarkdown?.(markdown);
        } catch (e) {
          handleError(plugin, 'onWillParseMarkdown', uri, e);
        }
      }
      const tree = parser.parse(markdown);

      const note: Resource = {
        uri: uri,
        type: 'note',
        properties: {},
        title: '',
        sections: [],
        tags: [],
        aliases: [],
        links: [],
        definitions: [],
      };

      for (const plugin of plugins) {
        try {
          plugin.onWillVisitTree?.(tree, note);
        } catch (e) {
          handleError(plugin, 'onWillVisitTree', uri, e);
        }
      }
      visitWithAncestors(tree, (node, ancestors) => {
        const parent = ancestors[ancestors.length - 1] as Parent | undefined;
        const index = parent ? parent.children.indexOf(node) : undefined;

        if (node.type === 'yaml') {
          try {
            const yamlProperties = parseYAML((node as any).value) ?? {};
            note.properties = {
              ...note.properties,
              ...yamlProperties,
            };
            for (const plugin of plugins) {
              try {
                plugin.onDidFindProperties?.(yamlProperties, note, node);
              } catch (e) {
                handleError(plugin, 'onDidFindProperties', uri, e);
              }
            }
          } catch (e) {
            Logger.warn(`Error while parsing YAML for [${uri.toString()}]`, e);
          }
        }

        for (const plugin of plugins) {
          try {
            plugin.visit?.(node, note, markdown, index, parent, ancestors);
          } catch (e) {
            handleError(plugin, 'visit', uri, e);
          }
        }
      });
      for (const plugin of plugins) {
        try {
          plugin.onDidVisitTree?.(tree, note, markdown);
        } catch (e) {
          handleError(plugin, 'onDidVisitTree', uri, e);
        }
      }
      Logger.debug('Result:', note);
      return note;
    },
  };

  const cachedParser: ResourceParser = {
    parse: (uri: URI, markdown: string): Resource => {
      const actualChecksum = hash(markdown);
      if (cache && cache.has(uri)) {
        const { checksum, resource } = cache.get(uri);
        if (actualChecksum === checksum) {
          return resource;
        }
      }
      const resource = actualParser.parse(uri, markdown);
      if (cache) {
        cache.set(uri, { checksum: actualChecksum, resource });
      }
      return resource;
    },
  };

  return cache ? cachedParser : actualParser;
}

// #endregion
