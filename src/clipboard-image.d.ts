/**
 * Types for `clipboard-image.js`. The module itself is plain JS — it is
 * shared with the editor half of the app, which isn't typechecked — but
 * the notebook is, and `tsconfig.json` only compiles `src/notebook`, so
 * an untyped import from there is an error. Declaring the surface here
 * keeps one copy of the reader instead of one per bundle.
 */
export declare function readClipboardImageDataUrl(): Promise<string | null>;
export declare function imageFilesFromDataTransfer(dt: DataTransfer | null): File[];
export declare function dataUrlToFile(dataUrl: string, name?: string): File;
