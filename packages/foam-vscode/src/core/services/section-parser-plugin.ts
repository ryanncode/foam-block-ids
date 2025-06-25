import { Node, Parent, Point, Position as AstPosition } from 'unist';
import GithubSlugger from 'github-slugger';
import { Resource, Section } from '../model/note';
import { ParserPlugin } from './markdown-parser';
import { Position } from '../model/position';
import { Range } from '../model/range';
import { getNodeText } from '../utils/md';
import visit from 'unist-util-visit';

// Helper functions
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
    if (child.type === 'paragraph') {
      text += getTextFromChildren(child);
    }
  }
  return text;
};

// Section stack for heading range calculation
type SectionStackItem = {
  label: string;
  level: number;
  start: Position;
  blockId?: string;
};
let sectionStack: SectionStackItem[] = [];
const slugger = new GithubSlugger();
const processedNodes = new Set<Node>();

// Legacy-compatible section and block ID logic, adapted for new Section model
export const createSectionParserPlugin = (): ParserPlugin => {
  const processedNodes = new Set<Node>();
  const slugger = new GithubSlugger();
  let sectionStack: Array<{
    label: string;
    level: number;
    start: Position;
    blockId?: string;
  }> = [];
  return {
    name: 'unified-section-parser',
    onWillVisitTree: (tree, note) => {
      slugger.reset();
      processedNodes.clear();
      sectionStack = [];
      note.sections = [];
    },
    visit: (node, note, noteSource, index, parent, ancestors) => {
      // Headings
      if (node.type === 'heading') {
        const level = (node as any).depth;
        let label = getTextFromChildren(node);
        if (!label || !level) return;
        // Skip the first depth-1 heading (title) at the top of the file
        if (
          level === 1 &&
          (!note.sections || note.sections.length === 0) &&
          (!sectionStack || sectionStack.length === 0) &&
          node.position &&
          node.position.start.line === 1
        ) {
          // Do not push to sectionStack, do not add as section
          return;
        }
        // Extract block ID if present at end of heading
        const inlineBlockIdRegex = /(?:^|\s)(\^[\w.-]+)\s*$/;
        const match = label.match(inlineBlockIdRegex);
        let blockId: string | undefined = undefined;
        if (match) {
          blockId = match[1];
          label = label.replace(inlineBlockIdRegex, '').trim();
        }
        const start = astPositionToFoamRange(node.position!).start;
        while (
          sectionStack.length > 0 &&
          sectionStack[sectionStack.length - 1].level >= level
        ) {
          const popped = sectionStack.pop()!;
          const slug = slugger.slug(popped.label);
          const linkableIds = [slug, popped.label];
          if (popped.blockId) {
            // Always include both ^block-id and block-id (no duplicates)
            if (!linkableIds.includes(popped.blockId)) linkableIds.push(popped.blockId);
            const noCaret = popped.blockId.startsWith('^') ? popped.blockId.substring(1) : popped.blockId;
            if (!linkableIds.includes(noCaret)) linkableIds.push(noCaret);
          }
          // Section range: from heading to line before next heading
          const lines = noteSource.split('\n');
          let endLine = start.line > 0 ? start.line - 1 : 0;
          while (endLine > popped.start.line && lines[endLine].trim() === '') {
            endLine--;
          }
          note.sections.push({
            label: popped.label,
            range: Range.create(
              popped.start.line,
              popped.start.character,
              endLine,
              0
            ),
            canonicalId: slug,
            linkableIds,
          });
        }
        sectionStack.push({
          label,
          level,
          start,
          ...(blockId ? { blockId } : {}),
        });
      }

      // Block IDs in paragraphs and list items (legacy logic)
      // Full-line block ID: applies to previous sibling (not heading)
      if (
        node.type === 'paragraph' &&
        index > 0 &&
        parent &&
        !processedNodes.has(node)
      ) {
        const text = getTextFromChildren(node).trim();
        const fullLineBlockIdRegex = /^\^[\w.-]+$/;
        if (fullLineBlockIdRegex.test(text)) {
          const prev = parent.children[index - 1];
          // Special case: if previous sibling is a list, apply block ID to the entire list (including the block ID line)
          if (prev && prev.type === 'list' && !processedNodes.has(prev)) {
            const blockIdWithCaret = text;
            const blockId = blockIdWithCaret.substring(1);
            const label = getNodeText(prev, noteSource).trim();
            // Extend the range to include the block ID line itself (legacy: end at block ID line, col 0)
            const listStart = astPositionToFoamRange(prev.position!).start.line;
            const blockIdLine = astPositionToFoamRange(node.position!).start
              .line;
            note.sections.push({
              label,
              range: Range.create(listStart, 0, blockIdLine, 0),
              canonicalId: blockId,
              linkableIds: [blockIdWithCaret, blockId],
            });
            // Mark all nodes in the list and the block ID node as processed
            visit(prev as any, (n: Node) => {
              processedNodes.add(n);
            });
            processedNodes.add(node);
            return;
          }
          // Default: previous sibling is not a heading, apply as before
          if (prev && prev.type !== 'heading' && !processedNodes.has(prev)) {
            const blockIdWithCaret = text;
            const blockId = blockIdWithCaret.substring(1);
            const label = getNodeText(prev, noteSource).trim();
            note.sections.push({
              label,
              range: astPositionToFoamRange(prev.position!),
              canonicalId: blockId,
              linkableIds: [blockIdWithCaret, blockId],
            });
            visit(prev as any, (n: Node) => {
              processedNodes.add(n);
            });
            processedNodes.add(node);
            return;
          }
        }
      }

      // Inline block ID at end of list item (legacy logic: only if not already processed)
      if (node.type === 'listItem' && !processedNodes.has(node)) {
        // Get the text of the list item, including all children
        const text = getListItemText(node as Parent);
        const blockIdRegex = /(?:^|\s)(\^[\w.-]+)\s*$/;
        const match = text.match(blockIdRegex);
        if (match) {
          const blockIdWithCaret = match[1];
          const blockId = blockIdWithCaret.substring(1);
          const label = text.replace(blockIdRegex, '').trim();
          note.sections.push({
            label,
            range: astPositionToFoamRange(node.position!),
            canonicalId: blockId,
            linkableIds: [blockIdWithCaret, blockId],
          });
          processedNodes.add(node);
          // Mark all child paragraphs as processed (legacy behavior)
          (node as Parent).children?.forEach(child => {
            if (child.type === 'paragraph') {
              visit(child as any, n => {
                processedNodes.add(n);
              });
            }
          });
        }
      }

      // Inline block ID at end of paragraph (legacy logic, only if not already processed)
      if (node.type === 'paragraph' && !processedNodes.has(node)) {
        const text = getTextFromChildren(node);
        const blockIdRegex = /(?:^|\s)(\^[\w.-]+)\s*$/;
        const match = text.match(blockIdRegex);
        if (match) {
          const blockIdWithCaret = match[1];
          const blockId = blockIdWithCaret.substring(1);
          const label = text.replace(blockIdRegex, '').trim();
          note.sections.push({
            label,
            range: astPositionToFoamRange(node.position!),
            canonicalId: blockId,
            linkableIds: [blockId, blockIdWithCaret],
          });
          processedNodes.add(node);
        }
      }

      // (No catch-all for both paragraph and listItem; legacy logic only)
    },
    onDidVisitTree: (tree, note, noteSource) => {
      const fileEndPosition = astPointToFoamPosition(tree.position.end);
      const lines = noteSource.split('\n');
      while (sectionStack.length > 0) {
        const popped = sectionStack.pop()!;
        const slug = slugger.slug(popped.label);
        const linkableIds = [slug, popped.label];
        if (popped.blockId) {
          if (!linkableIds.includes(popped.blockId)) linkableIds.push(popped.blockId);
          const noCaret = popped.blockId.startsWith('^') ? popped.blockId.substring(1) : popped.blockId;
          if (!linkableIds.includes(noCaret)) linkableIds.push(noCaret);
        }
        let endLine = fileEndPosition.line;
        while (endLine > popped.start.line && lines[endLine].trim() === '') {
          endLine--;
        }
        note.sections.push({
          label: popped.label,
          range: Range.create(
            popped.start.line,
            popped.start.character,
            endLine,
            0
          ),
          canonicalId: slug,
          linkableIds,
        });
      }
      note.sections.sort((a, b) => a.range.start.line - b.range.start.line);
    },
  };
};
