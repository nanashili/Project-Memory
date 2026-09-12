import { Llama } from "../../bindings/Llama.js";
import { GgmlType } from "../../gguf/types/GgufTensorInfoTypes.js";
export declare function resolveCommandGgufPath(ggufPath: string | undefined, llama: Llama, fetchHeaders?: Record<string, string>, { targetDirectory, flashAttention, swaFullCache, useMmap, consoleTitle, kvCacheKeyType, kvCacheValueType }?: {
    targetDirectory?: string;
    flashAttention?: boolean;
    swaFullCache?: boolean;
    useMmap?: boolean;
    consoleTitle?: string;
    kvCacheKeyType?: "currentQuant" | keyof typeof GgmlType;
    kvCacheValueType?: "currentQuant" | keyof typeof GgmlType;
}): Promise<string>;
export declare function tryCoercingModelUri(ggufPath: string): {
    uri: string;
    modifiedRegion: {
        start: number;
        end: number;
    };
} | undefined;
export declare function printDidYouMeanUri(ggufPath: string): void;
