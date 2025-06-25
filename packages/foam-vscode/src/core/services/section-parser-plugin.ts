import { Node, Parent, Point, Position as AstPosition } from 'unist';
import GithubSlugger from 'github-slugger';
import { Resource, Section } from '../model/note';
import { ParserPlugin } from './markdown-parser';
import { Position } from '../model/position';
import { Range } from '../model/range';
import { getNodeText } from '../utils/md';
import visit from 'unist-util-visit';

// #region Helper Functions (migrated from markdown-parser.ts for encapsulation)

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

const getListItemText = (listItemNode: Parent): string => {
  let text = '';
  if (!listItemNode.children) {
    return '';
  }

  for (const child of listItemNode.children) {
    // We only look for text in paragraphs, and ignore nested lists.
    if (child.type === 'paragraph') {
      // getTextFromChildren is fine here, as paragraphs don't have nested lists.
      text += getTextFromChildren(child);
    }
  }
  return text;
};

// #endregion

export const createSectionParserPlugin = (): ParserPlugin => {
  const slugger = new GithubSlugger();
  const processedNodes = new Set<Node>();

  // The sectionStack is now encapsulated within the plugin's closure.
  type SectionStackItem = {
    label: string;
    level: number;
    start: Position;
    blockId?: string;
  };
  let sectionStack: SectionStackItem[] = [];

  return {
    name: 'unified-section-parser',

    onWillVisitTree: (tree, note) => {
      slugger.reset();
      processedNodes.clear();
      sectionStack = []; // Reset stack for each new document.
      note.sections = [];
    },

    visit: (node, note, markdown, index, parent, ancestors) => {
      if (node.type === 'heading') {
        const level = (node as any).depth;
        let label = getTextFromChildren(node);
        if (!label || !level) {
          return;
        }

        // Extract block ID if present at the end of the heading.
        const inlineBlockIdRegex = /(?:^|\s)(\^[:\w.-]+)\s*$/;
        const match = label.match(inlineBlockIdRegex);
        let blockId: string | undefined = undefined;
        if (match) {
          blockId = match[1];
          label = label.replace(inlineBlockIdRegex, '').trim();
        }

        const start = astPositionToFoamRange(node.position!).start;

        // Pop sections from the stack that are of a greater or equal level.
        // This correctly handles the hierarchy of headings.
        while (
          sectionStack.length > 0 &&
          sectionStack[sectionStack.length - 1].level >= level
        ) {
          const poppedSection = sectionStack.pop()!;
          const slug = slugger.slug(poppedSection.label);
          const linkableIds = [slug];
          if (poppedSection.blockId) {
            linkableIds.push(poppedSection.blockId);
            linkableIds.push(poppedSection.blockId.substring(1));
          }

          note.sections.push({
            label: poppedSection.label,
            range: Range.create(
              poppedSection.start.line,
              poppedSection.start.character,
              start.line,
              start.character
            ),
            canonicalId: slug,
            linkableIds: linkableIds,
          });
        }

        // Push the current heading onto the stack. Its end position will be
        // determined by the next heading or the end of the file.
        sectionStack.push({
          label,
          level,
          start,
          ...(blockId ? { blockId } : {}),
        });
      } else if (
        (node.type === 'paragraph' || node.type === 'listItem') &&
        !processedNodes.has(node)
      ) {
        const text =
          node.type === 'listItem'
            ? getListItemText(node as Parent)
            : getTextFromChildren(node);

        const blockIdRegex = /(?:^|\s)(\^[:\w.-]+)\s*$/;
        const match = text.match(blockIdRegex);

        if (match) {
          const blockIdWithCaret = match[1];
          const blockId = blockIdWithCaret.substring(1);
          const label = text.replace(blockIdRegex, '').trim();

          note.sections.push({
            label: label,
            range: astPositionToFoamRange(node.position!),
            canonicalId: blockId,
            linkableIds: [blockId],
          });
          // Mark as processed to avoid children being processed again
          visit(node as any, (n: Node) => {
            processedNodes.add(n);
          });
        } else if (node.type === 'listItem') {
          note.sections.push({
            label: text.trim(),
            range: astPositionToFoamRange(node.position!),
            canonicalId: undefined,
            linkableIds: [],
          });
          // Mark this node and its paragraph children as processed to avoid duplicates,
          // but allow visiting nested lists.
          processedNodes.add(node);
          (node as Parent).children?.forEach(child => {
            if (child.type === 'paragraph') {
              visit(child as any, n => {
                processedNodes.add(n);
              });
            }
          });
        }
      }
    },

    onDidVisitTree: (tree, note, noteSource) => {
      const fileEndPosition = astPointToFoamPosition(tree.position.end);

      // Close all remaining sections on the stack. These are the sections
      // that were not closed by a subsequent heading and extend to the end.
      while (sectionStack.length > 0) {
        const poppedSection = sectionStack.pop()!;
        const slug = slugger.slug(poppedSection.label);
        const linkableIds = [slug];
        if (poppedSection.blockId) {
          linkableIds.push(poppedSection.blockId);
          linkableIds.push(poppedSection.blockId.substring(1));
        }

        note.sections.push({
          label: poppedSection.label,
          range: Range.create(
            poppedSection.start.line,
            poppedSection.start.character,
            fileEndPosition.line,
            fileEndPosition.character
          ),
          canonicalId: slug,
          linkableIds: linkableIds,
        });
      }

      // Finally, sort all sections by their position in the document.
      note.sections.sort((a, b) => a.range.start.line - b.range.start.line);
    },
  };
};
