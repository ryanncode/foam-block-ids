// Legacy-faithful sectionsPlugin and createBlockIdPlugin, updated to emit new Section object

// Legacy sectionsPlugin and createBlockIdPlugin, updated to emit new Section object
import { Node, Parent, Point, Position as AstPosition } from 'unist';
import GithubSlugger from 'github-slugger';
import { Resource, Section } from '../model/note';
import { ParserPlugin } from './markdown-parser';
import { Position } from '../model/position';
import { Range } from '../model/range';
import { getNodeText } from '../utils/md';
import visit from 'unist-util-visit';

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

export const createSectionPlugin = (): ParserPlugin => {
  const slugger = new GithubSlugger();
  // Legacy-faithful section stack item
  let sectionStack = [];
  return {
    name: 'section',
    onWillVisitTree: () => {
      sectionStack = [];
      slugger.reset();
    },
    visit: (node, note) => {
      if (node.type === 'heading') {
        const level = (node as any).depth;
        let label = getTextFromChildren(node);
        if (!label || !level) {
          return;
        }
        // Extract block ID if present at the end of the heading
        const inlineBlockIdRegex = /(?:^|\s)(\^[\w.-]+)\s*$/;
        const match = label.match(inlineBlockIdRegex);
        let blockId = undefined;
        if (match) {
          blockId = match[1];
          label = label.replace(inlineBlockIdRegex, '').trim();
        }
        const start = astPositionToFoamRange(node.position).start;
        while (
          sectionStack.length > 0 &&
          sectionStack[sectionStack.length - 1].level >= level
        ) {
          const section = sectionStack.pop();
          const slug = slugger.slug(section.label);
          const linkableIds = [slug, section.label];
          if (section.blockId) {
            if (!linkableIds.includes(section.blockId))
              linkableIds.push(section.blockId);
            const noCaret = section.blockId.startsWith('^')
              ? section.blockId.substring(1)
              : section.blockId;
            if (!linkableIds.includes(noCaret)) linkableIds.push(noCaret);
          }
          note.sections.push({
            label: section.label,
            range: Range.create(
              section.start.line,
              section.start.character,
              start.line - 1,
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
    },
    onDidVisitTree: (tree, note) => {
      const fileEndPosition = astPointToFoamPosition(tree.position.end);
      while (sectionStack.length > 0) {
        const section = sectionStack.pop();
        const slug = slugger.slug(section.label);
        const linkableIds = [slug, section.label];
        if (section.blockId) {
          if (!linkableIds.includes(section.blockId))
            linkableIds.push(section.blockId);
          const noCaret = section.blockId.startsWith('^')
            ? section.blockId.substring(1)
            : section.blockId;
          if (!linkableIds.includes(noCaret)) linkableIds.push(noCaret);
        }
        note.sections.push({
          label: section.label,
          range: Range.create(
            section.start.line,
            section.start.character,
            fileEndPosition.line - 1,
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

export const createBlockIdPlugin = (): ParserPlugin => {
  const processedNodes = new Set<Node>();
  return {
    name: 'block-id',
    onWillVisitTree: () => {
      processedNodes.clear();
    },
    visit: (node, note, markdown, index, parent, ancestors) => {
      // Legacy: skip headings and their descendants
      if (
        node.type === 'heading' ||
        ancestors.some(a => a.type === 'heading')
      ) {
        return;
      }
      // Legacy: skip already processed nodes
      let isAlreadyProcessed = false;
      if (node.type === 'listItem') {
        isAlreadyProcessed = processedNodes.has(node);
      } else {
        isAlreadyProcessed =
          processedNodes.has(node) ||
          ancestors.some(a => processedNodes.has(a));
      }
      if (isAlreadyProcessed || !parent || index === undefined) {
        return;
      }

      // --- Legacy: handle full-line block IDs for lists and blockquotes ---
      if (node.type === 'list' || node.type === 'blockquote') {
        const blockText = getNodeText(node, markdown);
        const lines = blockText.split('\n');
        const lastLine = lines[lines.length - 1];
        const fullLineBlockIdMatch = lastLine.match(/^\s*(\^[\w.-]+)\s*$/);
        if (fullLineBlockIdMatch) {
          const blockId = fullLineBlockIdMatch[1];
          // Exclude the ID line from the label and range
          const label = lines.slice(0, -1).join('\n');
          const start = astPointToFoamPosition(node.position.start);
          const endLine = start.line + lines.length - 2; // -1 for 0-indexed, -1 to exclude ID line
          const endChar = lines.length > 1 ? lines[lines.length - 2].length : 0;
          const range = Range.create(
            start.line,
            start.character,
            endLine,
            endChar
          );
          const blockIdNoCaret = blockId.startsWith('^')
            ? blockId.substring(1)
            : blockId;
          note.sections.push({
            label,
            range,
            canonicalId: blockIdNoCaret,
            linkableIds: [blockIdNoCaret, blockId],
          });
          processedNodes.add(node);
          return;
        }
      }

      // --- Legacy: handle full-line block IDs for paragraphs ---
      let block;
      let blockId;
      let idNode;
      const nodeText = getNodeText(node, markdown);
      if (node.type === 'paragraph' && index > 0) {
        const pText = nodeText.trim();
        const isFullLineIdParagraph = /^\s*(\^[:\w.-]+\s*)+$/.test(pText);
        if (isFullLineIdParagraph) {
          const prev = parent.children[index - 1];
          if (prev && prev.type !== 'heading' && !processedNodes.has(prev)) {
            block = prev;
            blockId = pText.split(/\s+/).pop();
            idNode = node;
          }
        }
      }

      // --- Legacy: handle inline block IDs ---
      if (!block) {
        let textForInlineId = nodeText;
        if (node.type === 'listItem') {
          textForInlineId = getTextFromChildren(node);
        }
        const inlineBlockIdMatch = textForInlineId.match(
          /(?:^|\s)(\^[\w.-]+)\s*$/
        );
        if (inlineBlockIdMatch) {
          block = node;
          blockId = inlineBlockIdMatch[1];
        }
      }

      // --- Legacy: create section for block ID ---
      if (block && blockId) {
        if (!processedNodes.has(block)) {
          const blockIdNoCaret = blockId.startsWith('^')
            ? blockId.substring(1)
            : blockId;
          let label = getTextFromChildren(block);
          if (block.type === 'listItem' || block.type === 'paragraph') {
            label = label.replace(/(?:^|\s)\^[\w.-]+\s*$/, '').trim();
          }
          note.sections.push({
            label,
            range: astPositionToFoamRange(block.position),
            canonicalId: blockIdNoCaret,
            linkableIds: [blockIdNoCaret, blockId],
          });
          processedNodes.add(block);
          if (idNode) processedNodes.add(idNode);
        }
      }
    },
  };
};
