export interface EmbeddedAsset {
  filePath: string;
  mimeType: string;
}

export declare const embeddedAssets: Map<string, EmbeddedAsset>;

export declare const embeddedBuiltinSkills: Map<string, string>;
