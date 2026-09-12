export declare function resolveGithubRelease(githubOwner: string, githubRepo: string, release: string): Promise<string>;
export declare function isGithubReleaseNeedsResolving(release: string): release is "latest";
