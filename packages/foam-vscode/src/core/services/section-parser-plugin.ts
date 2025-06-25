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
  const slugger = new GithubSlugger();
  return {
    name: 'block-id',
    onWillVisitTree: () => {
      processedNodes.clear();
    },
    visit: (node, note, markdown, index, parent, ancestors) => {
      if (
        node.type === 'heading' ||
        ancestors.some(a => a.type === 'heading')
      ) {
        return;
      }
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
      let block: Node | undefined;
      let blockId: string | undefined;
      let idNode: Node | undefined;
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
            range: astPositionToFoamRange(block.position!),
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
