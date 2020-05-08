import {
    CommandFailed,
    CommandFailedType,
    CommandHandledType,
    CompletionRequestCompleted,
    CompletionRequestCompletedType,
    DisposableSubscription,
    HoverTextProduced,
    HoverTextProducedType,
    KernelCommand,
    KernelCommandType,
    KernelEvent,
    KernelEventEnvelope,
    KernelEventEnvelopeObserver,
    KernelEventType,
    KernelTransport,
    RequestCompletion,
    RequestCompletionType,
    RequestHoverText,
    RequestHoverTextType,
    ReturnValueProduced,
    ReturnValueProducedType,
    StandardOutputValueProduced,
    StandardOutputValueProducedType,
    SubmissionType,
    SubmitCode,
    SubmitCodeType,
    DisplayEventBase,
} from './contracts';
import { CellOutput, CellErrorOutput, CellOutputKind, CellStreamOutput, CellDisplayOutput } from './interfaces/vscode';

export class InteractiveClient {
    private nextToken: number = 1;
    private tokenEventObservers: Map<string, Array<KernelEventEnvelopeObserver>> = new Map<string, Array<KernelEventEnvelopeObserver>>();

    constructor(readonly kernelTransport: KernelTransport) {
        kernelTransport.subscribeToKernelEvents(eventEnvelope => this.eventListener(eventEnvelope));
    }

    async execute(source: string, language: string, observer: {(outputs: Array<CellOutput>): void}, token?: string | undefined): Promise<void> {
        let outputs: Array<CellOutput> = [];
        let disposable = await this.submitCode(source, language, eventEnvelope => {
            switch (eventEnvelope.eventType) {
                case CommandFailedType:
                    {
                        let err = <CommandFailed>eventEnvelope.event;
                        let output: CellErrorOutput = {
                            outputKind: CellOutputKind.Error,
                            ename: 'Error',
                            evalue: err.message,
                            traceback: [],
                        };
                        outputs.push(output);
                        observer(outputs);
                        disposable.dispose(); // is this correct?
                    }
                    break;
                case StandardOutputValueProducedType:
                    {
                        let st = <StandardOutputValueProduced>eventEnvelope.event;
                        let output: CellStreamOutput = {
                            outputKind: CellOutputKind.Text,
                            text: st.value.toString(),
                        };
                        outputs.push(output);
                        observer(outputs);
                    }
                    break;
                case ReturnValueProducedType:
                    {
                        let disp = <DisplayEventBase>eventEnvelope.event;
                        let data: { [key: string]: any } = {};
                        for (let formatted of disp.formattedValues) {
                            data[formatted.mimeType] = formatted.value;
                        }
                        let output: CellDisplayOutput = {
                            outputKind: CellOutputKind.Rich,
                            data: data,
                        };
                        outputs.push(output);
                        observer(outputs);
                    }
                    break;
            }
        }, token);
    }

    completion(language: string, code: string, line: number, character: number, token?: string | undefined): Promise<CompletionRequestCompleted> {
        let command: RequestCompletion = {
            code: code,
            position: {
                line,
                character
            },
            targetKernelName: language
        };
        return this.submitCommandAndGetResult<CompletionRequestCompleted>(command, RequestCompletionType, CompletionRequestCompletedType, token);
    }

    hover(language: string, code: string, line: number, character: number, token?: string | undefined): Promise<HoverTextProduced> {
        let command: RequestHoverText = {
            code: code,
            position: {
                line: line,
                character: character,
            },
            targetKernelName: language
        };
        return this.submitCommandAndGetResult<HoverTextProduced>(command, RequestHoverTextType, HoverTextProducedType, token);
    }

    async submitCode(code: string, language: string, observer: KernelEventEnvelopeObserver, token?: string | undefined): Promise<DisposableSubscription> {
        let command: SubmitCode = {
            code: code,
            submissionType: SubmissionType.Run,
            targetKernelName: language
        };
        token = token || this.getNextToken();
        let disposable = this.subscribeToKernelTokenEvents(token, observer);
        await this.kernelTransport.submitCommand(command, SubmitCodeType, token);
        return disposable;
    }

    private submitCommandAndGetResult<TEvent extends KernelEvent>(command: KernelCommand, commandType: KernelCommandType, expectedEventType: KernelEventType, token: string | undefined): Promise<TEvent> {
        return new Promise<TEvent>(async (resolve, reject) => {
            let handled = false;
            token = token || this.getNextToken();
            let disposable = this.subscribeToKernelTokenEvents(token, eventEnvelope => {
                switch (eventEnvelope.eventType) {
                    case CommandFailedType:
                    case CommandHandledType:
                        if (!handled) {
                            handled = true;
                            disposable.dispose();
                            reject();
                        }
                        break;
                    default:
                        if (eventEnvelope.eventType === expectedEventType) {
                            handled = true;
                            disposable.dispose();
                            let event = <TEvent>eventEnvelope.event;
                            resolve(event);
                        }
                        break;
                }
            });
            await this.kernelTransport.submitCommand(command, commandType, token);
        });
    }

    private subscribeToKernelTokenEvents(token: string, observer: KernelEventEnvelopeObserver): DisposableSubscription {
        if (!this.tokenEventObservers.get(token)) {
            this.tokenEventObservers.set(token, []);
        }

        this.tokenEventObservers.get(token)?.push(observer);
        return {
            dispose: () => {
                let listeners = this.tokenEventObservers.get(token);
                if (listeners) {
                    let i = listeners.indexOf(observer);
                    if (i >= 0) {
                        listeners.splice(i, 1);
                    }

                    if (listeners.length === 0) {
                        this.tokenEventObservers.delete(token);
                    }
                }
            }
        };
    }

    private eventListener(eventEnvelope: KernelEventEnvelope) {
        let token = eventEnvelope.command?.token;
        if (token) {
            let listeners = this.tokenEventObservers.get(token);
            if (listeners) {
                for (let listener of listeners) {
                    listener(eventEnvelope);
                }
            }
        }
    }

    private getNextToken(): string {
        return (this.nextToken++).toString();
    }
}
