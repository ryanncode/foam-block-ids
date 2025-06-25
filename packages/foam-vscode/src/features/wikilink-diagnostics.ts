/**
 * @file Provides diagnostics for wikilinks in markdown files.
 * This includes:
 * - Detecting ambiguous links (when an identifier can resolve to multiple notes).
 * - Detecting broken section links (when the note exists but the #section does not).
 * - Providing Quick Fixes (Code Actions) to resolve these issues.
 */
import { debounce } from 'lodash';
import * as vscode from 'vscode';
import { Foam } from '../core/model/foam';
import { Resource, ResourceParser, ResourceLink } from '../core/model/note';
import { Range } from '../core/model/range';
import { FoamWorkspace } from '../core/model/workspace';
import { MarkdownLink } from '../core/services/markdown-link';
import {
  fromVsCodeUri,
  toVsCodePosition,
  toVsCodeRange,
  toVsCodeUri,
} from '../utils/vsc-utils';
import { isNone } from '../core/utils';
import { toSlug } from '../utils/slug';

/**
 * Diagnostic code for an ambiguous link identifier.
 * Used when a wikilink could refer to more than one note.
 */
const AMBIGUOUS_IDENTIFIER_CODE = 'ambiguous-identifier';

/**
 * Diagnostic code for an unknown section in a wikilink.
 * Used when the note exists, but the section identifier (e.g., #my-section) does not.
 */
const UNKNOWN_SECTION_CODE = 'unknown-section';

interface FoamCommand<T> {
  name: string;
  execute: (params: T) => Promise<void>;
}

interface FindIdentifierCommandArgs {
  range: vscode.Range;
  target: vscode.Uri;
  defaultExtension: string;
  amongst: vscode.Uri[];
}

/**
 * A command that computes the shortest unambiguous identifier for a target URI
 * among a set of potential targets and replaces the text in the editor.
 * Used by the Quick Fix for ambiguous links.
 */
const FIND_IDENTIFIER_COMMAND: FoamCommand<FindIdentifierCommandArgs> = {
  name: 'foam:compute-identifier',
  execute: async ({ target, amongst, range, defaultExtension }) => {
    if (vscode.window.activeTextEditor) {
      let identifier = FoamWorkspace.getShortestIdentifier(
        target.path,
        amongst.map(uri => uri.path)
      );

      identifier = identifier.endsWith(defaultExtension)
        ? identifier.slice(0, defaultExtension.length * -1)
        : identifier;

      await vscode.window.activeTextEditor.edit(builder => {
        builder.replace(range, identifier);
      });
    }
  },
};

interface ReplaceTextCommandArgs {
  range: vscode.Range;
  value: string;
}

/**
 * A generic command that replaces a range of text in the active editor with a new value.
 * Used by the Quick Fix for unknown sections.
 */
const REPLACE_TEXT_COMMAND: FoamCommand<ReplaceTextCommandArgs> = {
  name: 'foam:replace-text',
  execute: async ({ range, value }) => {
    await vscode.window.activeTextEditor.edit(builder => {
      builder.replace(range, value);
    });
  },
};

export default async function activate(
  context: vscode.ExtensionContext,
  foamPromise: Promise<Foam>
) {
  const collection = vscode.languages.createDiagnosticCollection('foam');
  const debouncedUpdateDiagnostics = debounce(updateDiagnostics, 500);
  const foam = await foamPromise;
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(
      foam.workspace,
      foam.services.parser,
      vscode.window.activeTextEditor.document,
      collection
    );
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        updateDiagnostics(
          foam.workspace,
          foam.services.parser,
          editor.document,
          collection
        );
      }
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      debouncedUpdateDiagnostics(
        foam.workspace,
        foam.services.parser,
        event.document,
        collection
      );
    }),
    vscode.languages.registerCodeActionsProvider(
      'markdown',
      new IdentifierResolver(foam.workspace, foam.workspace.defaultExtension),
      {
        providedCodeActionKinds: IdentifierResolver.providedCodeActionKinds,
      }
    ),
    vscode.commands.registerCommand(
      FIND_IDENTIFIER_COMMAND.name,
      FIND_IDENTIFIER_COMMAND.execute
    ),
    vscode.commands.registerCommand(
      REPLACE_TEXT_COMMAND.name,
      REPLACE_TEXT_COMMAND.execute
    )
  );
}

/**
 * Analyzes the current document for ambiguous or broken wikilinks and generates
 * corresponding diagnostics in the editor.
 * @param workspace The Foam workspace, used to resolve link targets.
 * @param parser The resource parser, used to get links from the document text.
 * @param document The document to analyze.
 * @param collection The diagnostic collection to update.
 */
export function updateDiagnostics(
  workspace: FoamWorkspace,
  parser: ResourceParser,
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  collection.clear();
  if (!document || document.languageId !== 'markdown') {
    return;
  }

  const resource = parser.parse(
    fromVsCodeUri(document.uri),
    document.getText()
  );

  const diagnostics = resource.links.flatMap(link => {
    if (link.type !== 'wikilink') {
      return [];
    }
    // Legacy-compatible: only suggest heading labels and block IDs (not paragraph text)
    // for unknown section diagnostics
    const diagnostics: vscode.Diagnostic[] = [];
    const { target, section } = MarkdownLink.analyzeLink(link);
    const targets = workspace.listByIdentifier(target);

    if (targets.length > 1) {
      return [createAmbiguousIdentifierDiagnostic(link, targets)];
    }
    if (section && targets.length === 1) {
      const targetResource = targets[0];
      if (isNone(Resource.findSection(targetResource, section))) {
        return [
          createUnknownSectionDiagnostic(link, target, section, targetResource),
        ];
      }
    }
    return [];
  });

  if (diagnostics.length > 0) {
    collection.set(document.uri, diagnostics);
  }
}

/**
 * Creates a VS Code Diagnostic for an ambiguous wikilink identifier.
 * @param link The wikilink that is ambiguous.
 * @param targets The list of potential resources the link could target.
 * @returns A `vscode.Diagnostic` object.
 */
function createAmbiguousIdentifierDiagnostic(
  link: ResourceLink,
  targets: Resource[]
): vscode.Diagnostic {
  return {
    code: AMBIGUOUS_IDENTIFIER_CODE,
    message: 'Resource identifier is ambiguous',
    range: toVsCodeRange(link.range),
    severity: vscode.DiagnosticSeverity.Warning,
    source: 'Foam',
    relatedInformation: targets.map(
      t =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(toVsCodeUri(t.uri), new vscode.Position(0, 0)),
          `Possible target: ${vscode.workspace.asRelativePath(
            toVsCodeUri(t.uri)
          )}`
        )
    ),
  };
}

/**
 * Creates a VS Code Diagnostic for a wikilink pointing to a non-existent section.
 * @param link The wikilink containing the broken section reference.
 * @param target The string identifier of the target note.
 * @param sectionId The string identifier of the (non-existent) section.
 * @param targetResource The target resource where the section was not found.
 * @returns A `vscode.Diagnostic` object.
 */
function createUnknownSectionDiagnostic(
  link: ResourceLink,
  target: string,
  sectionId: string,
  targetResource: Resource
): vscode.Diagnostic {
  const linkRange = Range.create(
    link.range.start.line,
    link.range.start.character + target.length + 3, // [[ + target + #
    link.range.end.line,
    link.range.end.character - 2
  );
  const diagnostic = new vscode.Diagnostic(
    toVsCodeRange(linkRange),
    `Unknown section #${sectionId}`,
    vscode.DiagnosticSeverity.Warning
  );
  diagnostic.source = 'foam';
  diagnostic.code = UNKNOWN_SECTION_CODE;
  // Legacy-compatible: only suggest heading labels and block IDs (with caret), not paragraph text
  const suggestions: string[] = [];
  for (const section of targetResource.sections) {
    // Only suggest heading labels (not paragraph text)
    if (
      section.label &&
      section.label.trim() !== '' &&
      toSlug(section.label) === section.canonicalId
    ) {
      suggestions.push(section.label);
    }
    // Only suggest block IDs (with caret)
    const blockId = section.linkableIds.find(id => id.startsWith('^'));
    if (blockId) {
      suggestions.push(blockId);
    }
  }
  // Remove duplicates and keep order
  const uniqueSuggestions = Array.from(new Set(suggestions));
  diagnostic.relatedInformation = uniqueSuggestions.map(
    s =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          toVsCodeUri(targetResource.uri),
          new vscode.Position(0, 0)
        ),
        s
      )
  );
  return diagnostic;
}

/**
 * Provides Code Actions (Quick Fixes) for the diagnostics created by this file.
 */
export class IdentifierResolver implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  constructor(
    private workspace: FoamWorkspace,
    private defaultExtension: string
  ) {}

  /**
   * This method is called by VS Code when the user's cursor is on a diagnostic.
   * It returns a list of applicable Quick Fixes.
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    return context.diagnostics.flatMap(diagnostic => {
      switch (diagnostic.code) {
        case AMBIGUOUS_IDENTIFIER_CODE:
          return this.createAmbiguousIdentifierActions(diagnostic);
        case UNKNOWN_SECTION_CODE:
          return this.createUnknownSectionActions(diagnostic);
        default:
          return [];
      }
    });
  }

  /**
   * Creates the set of Quick Fixes for an `AMBIGUOUS_IDENTIFIER_CODE` diagnostic.
   * This generates one Code Action for each potential target file.
   */
  private createAmbiguousIdentifierActions(
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction[] {
    const uris = diagnostic.relatedInformation.map(info => info.location.uri);
    return diagnostic.relatedInformation.map(item =>
      createFindIdentifierCommand(
        diagnostic,
        item.location.uri,
        this.defaultExtension,
        uris
      )
    );
  }

  /**
   * Creates the set of Quick Fixes for an `UNKNOWN_SECTION_CODE` diagnostic.
   * This generates one Code Action for each valid section in the target file.
   */
  private createUnknownSectionActions(
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction[] {
    return diagnostic.relatedInformation
      .map(info =>
        createReplaceSectionCommand(diagnostic, info, this.workspace)
      )
      .filter((action): action is vscode.CodeAction => action !== null);
  }

  private createSectionActions(
    diagnostic: vscode.Diagnostic
  ): vscode.CodeAction[] {
    return diagnostic.relatedInformation.map(info => {
      const isBlock = info.message.startsWith('^');
      const newSectionId = isBlock ? info.message : toSlug(info.message);
      const title = `Change to '#${newSectionId}'`;
      const action = new vscode.CodeAction(
        title,
        vscode.CodeActionKind.QuickFix
      );
      const linkText = vscode.window.activeTextEditor.document.getText(
        diagnostic.range
      );
      const newLink = MarkdownLink.replaceSection(linkText, newSectionId);
      action.command = {
        command: REPLACE_TEXT_COMMAND.name,
        title: 'Replace text',
        arguments: [
          {
            range: diagnostic.range,
            value: newLink,
          },
        ],
      };
      action.diagnostics = [diagnostic];
      return action;
    });
  }
}

/**
 * Creates a Code Action to fix a broken section link by replacing it with a valid one.
 * @param diagnostic The `UNKNOWN_SECTION_CODE` diagnostic.
 * @param suggestion The diagnostic info for a valid section to suggest as a replacement.
 * @param workspace The Foam workspace.
 * @returns A `vscode.CodeAction` or `null` if the target resource can't be found.
 */
const createReplaceSectionCommand = (
  diagnostic: vscode.Diagnostic,
  suggestion: vscode.DiagnosticRelatedInformation,
  workspace: FoamWorkspace
): vscode.CodeAction | null => {
  const targetUri = fromVsCodeUri(suggestion.location.uri);
  const targetResource = workspace.get(targetUri);
  if (!targetResource) {
    return null;
  }

  // Find the exact section using the location from the suggestion.
  const section = targetResource.sections.find(
    s =>
      s.range.start.line === suggestion.location.range.start.line &&
      s.range.start.character === suggestion.location.range.start.character
  );

  if (!section) {
    return null;
  }

  // The suggestion message is either the heading label or the block ID (e.g., `^my-id`).
  const suggestedMessage = suggestion.message;
  const isBlockId = suggestedMessage.startsWith('^');

  let replacementValue: string;
  if (isBlockId) {
    // The message is the block ID itself (e.g. `^my-id`), which is a valid linkableId.
    // We just need to remove the `^` for the final link fragment.
    replacementValue = suggestedMessage.substring(1);
  } else {
    // The message is the heading label. We need to find the corresponding slug.
    // The slug is the linkableId that is NOT a block ID.
    replacementValue = section.linkableIds.find(id => !id.startsWith('^'));
    if (isNone(replacementValue)) {
      // This should not happen if the section was generated correctly.
      // It means we have a heading without a slug.
      return null;
    }
  }

  const actionTitle = `Use ${isBlockId ? 'block' : 'heading'} "${
    section.label
  }"`;

  const action = new vscode.CodeAction(
    actionTitle,
    vscode.CodeActionKind.QuickFix
  );
  action.command = {
    command: REPLACE_TEXT_COMMAND.name,
    title: actionTitle,
    arguments: [
      {
        value: replacementValue,
        range: diagnostic.range,
      },
    ],
  };
  action.diagnostics = [diagnostic];
  return action;
};

/**
 * Creates a Code Action to fix an ambiguous identifier by replacing it with a
 * non-ambiguous identifier.
 * @param diagnostic The `AMBIGUOUS_IDENTIFIER_CODE` diagnostic.
 * @param target The URI of the specific file the user wants to link to.
 * @param defaultExtension The workspace's default file extension.
 * @param possibleTargets The list of all possible target URIs.
 * @returns A `vscode.CodeAction`.
 */
const createFindIdentifierCommand = (
  diagnostic: vscode.Diagnostic,
  target: vscode.Uri,
  defaultExtension: string,
  possibleTargets: vscode.Uri[]
): vscode.CodeAction => {
  const action = new vscode.CodeAction(
    `${vscode.workspace.asRelativePath(target)}`,
    vscode.CodeActionKind.QuickFix
  );
  action.command = {
    command: FIND_IDENTIFIER_COMMAND.name,
    title: 'Link to this resource',
    arguments: [
      {
        target: target,
        amongst: possibleTargets,
        defaultExtension: defaultExtension,
        range: new vscode.Range(
          diagnostic.range.start.line,
          diagnostic.range.start.character + 2,
          diagnostic.range.end.line,
          diagnostic.range.end.character - 2
        ),
      },
    ],
  };
  action.diagnostics = [diagnostic];
  return action;
};
