import { CommandModule } from "yargs";
import { BuildGpu } from "../../../../bindings/types.js";
import { GgmlType } from "../../../../gguf/types/GgufTensorInfoTypes.js";
type InspectEstimateCommand = {
    modelPath: string;
    header?: string[];
    gpu?: BuildGpu | "auto";
    gpuLayers?: number | "max";
    contextSize?: number | "train";
    embedding?: boolean;
    noMmap?: boolean;
    kvCacheKeyType?: "currentQuant" | keyof typeof GgmlType;
    kvCacheValueType?: "currentQuant" | keyof typeof GgmlType;
    swaFullCache?: boolean;
};
export declare const InspectEstimateCommand: CommandModule<object, InspectEstimateCommand>;
export {};
