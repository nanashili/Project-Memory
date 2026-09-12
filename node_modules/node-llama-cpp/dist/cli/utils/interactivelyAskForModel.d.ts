import { Llama } from "../../bindings/Llama.js";
import { GgmlType } from "../../gguf/types/GgufTensorInfoTypes.js";
export declare function interactivelyAskForModel({ llama, modelsDirectory, allowLocalModels, downloadIntent, flashAttention, swaFullCache, useMmap, kvCacheKeyType, kvCacheValueType }: {
    llama: Llama;
    modelsDirectory?: string;
    allowLocalModels?: boolean;
    downloadIntent?: boolean;
    flashAttention?: boolean;
    swaFullCache?: boolean;
    useMmap?: boolean;
    kvCacheKeyType?: "currentQuant" | GgmlType;
    kvCacheValueType?: "currentQuant" | GgmlType;
}): Promise<string>;
