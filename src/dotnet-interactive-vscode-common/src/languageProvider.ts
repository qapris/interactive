// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import * as vscode from 'vscode';
import { ClientMapper } from './clientMapper';
import { provideCompletion } from './languageServices/completion';
import { provideHover } from '././languageServices/hover';
import { notebookCellLanguages, getSimpleLanguage, notebookCellChanged } from './interactiveNotebook';
import { convertToRange, toVsCodeDiagnostic } from './vscodeUtilities';
import { getDiagnosticCollection } from './diagnostics';
import { provideSignatureHelp } from './languageServices/signatureHelp';
import * as versionSpecificFunctions from '../versionSpecificFunctions';

function getNotebookUriFromCellDocument(cellDocument: vscode.TextDocument): vscode.Uri | undefined {
    const notebookDocument = vscode.workspace.notebookDocuments.find(notebook => notebook.getCells().some(cell => cell.document === cellDocument));
    if (notebookDocument) {
        return notebookDocument.uri;
    }

    return undefined;
}

export class CompletionItemProvider implements vscode.CompletionItemProvider {
    static readonly triggerCharacters = ['.'];

    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const documentUri = getNotebookUriFromCellDocument(document);
        if (documentUri) {
            const documentText = document.getText();
            const completionPromise = provideCompletion(this.clientMapper, getSimpleLanguage(document.languageId), documentUri, documentText, position, this.languageServiceDelay);
            return ensureErrorsAreRejected(completionPromise, result => {
                let range: vscode.Range | undefined = undefined;
                if (result.linePositionSpan) {
                    range = new vscode.Range(
                        new vscode.Position(result.linePositionSpan.start.line, result.linePositionSpan.start.character),
                        new vscode.Position(result.linePositionSpan.end.line, result.linePositionSpan.end.character));
                }
                const completionItems: Array<vscode.CompletionItem> = [];
                for (const item of result.completions) {
                    const insertText: string | vscode.SnippetString = item.insertTextFormat === 'snippet' ? new vscode.SnippetString(item.insertText) : item.insertText;
                    const vscodeItem: vscode.CompletionItem = {
                        label: item.displayText,
                        documentation: item.documentation,
                        filterText: item.filterText,
                        insertText: insertText,
                        sortText: item.sortText,
                        range: range,
                        kind: this.mapCompletionItem(item.kind)
                    };
                    completionItems.push(vscodeItem);
                }

                const completionList = new vscode.CompletionList(completionItems, false);
                return completionList;
            });
        }
    }

    private mapCompletionItem(completionItemText: string): vscode.CompletionItemKind {
        // incomplete mapping from http://sourceroslyn.io/#Microsoft.CodeAnalysis.Workspaces/Tags/WellKnownTags.cs
        switch (completionItemText) {
            case "Class": return vscode.CompletionItemKind.Class;
            case "Constant": return vscode.CompletionItemKind.Constant;
            case "Delegate": return vscode.CompletionItemKind.Function;
            case "Enum": return vscode.CompletionItemKind.Enum;
            case "EnumMember": return vscode.CompletionItemKind.EnumMember;
            case "Event": return vscode.CompletionItemKind.Event;
            case "ExtensionMethod": return vscode.CompletionItemKind.Method;
            case "Field": return vscode.CompletionItemKind.Field;
            case "Interface": return vscode.CompletionItemKind.Interface;
            case "Local": return vscode.CompletionItemKind.Variable;
            case "Method": return vscode.CompletionItemKind.Method;
            case "Module": return vscode.CompletionItemKind.Module;
            case "Namespace": return vscode.CompletionItemKind.Module;
            case "Property": return vscode.CompletionItemKind.Property;
            case "Structure": return vscode.CompletionItemKind.Struct;
            case "Value": return vscode.CompletionItemKind.Value;
            default: return vscode.CompletionItemKind.Text; // what's an appropriate default?
        }
    }
}

export class HoverProvider implements vscode.HoverProvider {
    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {

        const documentUri = getNotebookUriFromCellDocument(document);
        if (documentUri) {
            const documentText = document.getText();
            const hoverPromise = provideHover(this.clientMapper, getSimpleLanguage(document.languageId), documentUri, documentText, position, this.languageServiceDelay);
            return ensureErrorsAreRejected(hoverPromise, result => {
                const contents = result.isMarkdown
                    ? new vscode.MarkdownString(result.contents)
                    : result.contents;
                const hover = new vscode.Hover(contents, convertToRange(result.range));
                return hover;
            });
        }
    }
}

export class SignatureHelpProvider implements vscode.SignatureHelpProvider {
    static readonly triggerCharacters = ['(', ','];

    constructor(readonly clientMapper: ClientMapper, private languageServiceDelay: number) {
    }

    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): vscode.ProviderResult<vscode.SignatureHelp> {
        const documentUri = getNotebookUriFromCellDocument(document);
        if (documentUri) {
            const documentText = document.getText();
            const sigHelpPromise = provideSignatureHelp(this.clientMapper, getSimpleLanguage(document.languageId), documentUri, documentText, position, this.languageServiceDelay);
            return ensureErrorsAreRejected(sigHelpPromise, result => {
                const signatures: Array<vscode.SignatureInformation> = result.signatures.map(sig => {
                    const parameters: Array<vscode.ParameterInformation> = sig.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation.value));
                    let si = new vscode.SignatureInformation(
                        sig.label,
                        sig.documentation.value
                    );
                    si.parameters = parameters;
                    return si;
                });
                let sh = new vscode.SignatureHelp();
                sh.signatures = signatures;
                sh.activeSignature = result.activeSignatureIndex;
                sh.activeParameter = result.activeParameterIndex;
                return sh;
            });
        }
    }
}

function ensureErrorsAreRejected<TInterimResult, TFinalResult>(promise: Promise<TInterimResult>, successHandler: { (result: TInterimResult): TFinalResult }): Promise<TFinalResult> {
    return new Promise<TFinalResult>((resolve, reject) => {
        promise.then(interimResult => {
            const finalResult = successHandler(interimResult);
            resolve(finalResult);
        }).catch(err => {
            reject(err);
        });
    });
}

export function registerLanguageProviders(clientMapper: ClientMapper, languageServiceDelay: number): vscode.Disposable {
    const disposables: Array<vscode.Disposable> = [];

    let languages = [...notebookCellLanguages, "dotnet-interactive.magic-commands"];
    disposables.push(vscode.languages.registerCompletionItemProvider(languages, new CompletionItemProvider(clientMapper, languageServiceDelay), ...CompletionItemProvider.triggerCharacters));
    disposables.push(vscode.languages.registerHoverProvider(languages, new HoverProvider(clientMapper, languageServiceDelay)));
    disposables.push(vscode.languages.registerSignatureHelpProvider(languages, new SignatureHelpProvider(clientMapper, languageServiceDelay), ...SignatureHelpProvider.triggerCharacters));
    disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (vscode.languages.match(notebookCellLanguages, e.document) &&
            vscode.window.activeNotebookEditor) {
            const cells = versionSpecificFunctions.getNotebookDocumentFromEditor(vscode.window.activeNotebookEditor).getCells();
            const cell = cells?.find(cell => cell.document === e.document);
            if (cell) {
                const documentUri = getNotebookUriFromCellDocument(e.document);
                if (documentUri) {
                    notebookCellChanged(clientMapper, documentUri, e.document.getText(), getSimpleLanguage(cell.document.languageId), languageServiceDelay, diagnostics => {
                        const collection = getDiagnosticCollection(e.document.uri);
                        collection.set(e.document.uri, diagnostics.map(toVsCodeDiagnostic));
                    });
                }
            }
        }
    }));

    return vscode.Disposable.from(...disposables);
}
