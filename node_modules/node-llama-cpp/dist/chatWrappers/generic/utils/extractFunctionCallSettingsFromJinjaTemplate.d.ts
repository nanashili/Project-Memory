import { ChatHistoryItem, ChatModelFunctions, ChatWrapperSettings } from "../../../types.js";
import { UniqueIdGenerator } from "./UniqueIdGenerator.js";
export type ExtractFunctionCallSettingsRenderTemplate = (options: {
    chatHistory: ChatHistoryItem[];
    functions: ChatModelFunctions;
    additionalParams: Record<string, unknown>;
    stringifyFunctionParams: boolean;
    stringifyFunctionResults: boolean;
    combineModelMessageAndToolCalls: boolean;
    squashModelTextResponses?: boolean;
}) => string;
export declare function extractFunctionCallSettingsFromJinjaTemplate({ idsGenerator, renderTemplate, examineNonFirstFunctionCall }: {
    idsGenerator: UniqueIdGenerator;
    renderTemplate: ExtractFunctionCallSettingsRenderTemplate;
    examineNonFirstFunctionCall?: boolean;
}): {
    settings: ChatWrapperSettings["functions"] | null;
    stringifyParams: boolean;
    stringifyResult: boolean;
    combineModelMessageAndToolCalls: boolean;
};
export declare function detectNeedToWrapFunctionArgumentsWithMap({ idsGenerator, renderTemplate }: {
    idsGenerator: UniqueIdGenerator;
    renderTemplate: ExtractFunctionCallSettingsRenderTemplate;
}): string | undefined;
