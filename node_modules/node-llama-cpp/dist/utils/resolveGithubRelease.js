import { getConsoleLogPrefix } from "./getConsoleLogPrefix.js";
export async function resolveGithubRelease(githubOwner, githubRepo, release) {
    const githubClient = new GitHubClient();
    const repo = githubOwner + "/" + githubRepo;
    let githubRelease = null;
    try {
        if (release === "latest")
            githubRelease = await githubClient.getLatestRelease({
                owner: githubOwner,
                repo: githubRepo
            });
        else
            githubRelease = await githubClient.getReleaseByTag({
                owner: githubOwner,
                repo: githubRepo,
                tag: release
            });
    }
    catch (err) {
        console.error(getConsoleLogPrefix() + "Failed to fetch llama.cpp release info", err);
    }
    if (githubRelease == null)
        throw new Error(`Failed to find release "${release}" of "${repo}"`);
    if (githubRelease.tag_name == null)
        throw new Error(`Failed to find tag of release "${release}" of "${repo}"`);
    return githubRelease.tag_name;
}
export function isGithubReleaseNeedsResolving(release) {
    return release === "latest";
}
const defaultGitHubApiBase = "https://api.github.com";
const defaultGitHubApiVersion = "2022-11-28";
class GitHubClient {
    _clientOptions;
    constructor(clientOptions = {}) {
        this._clientOptions = clientOptions;
    }
    async getLatestRelease({ owner, repo }) {
        return this._fetchJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`);
    }
    async getReleaseByTag({ owner, repo, tag }) {
        return this._fetchJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`);
    }
    async _fetchJson(path) {
        const url = this._getApiBase() + path;
        const headers = {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": this._clientOptions.apiVersion ?? defaultGitHubApiVersion
        };
        if (this._clientOptions.token != null && this._clientOptions.token !== "")
            headers.Authorization = "Bearer " + this._clientOptions.token;
        if (this._clientOptions.userAgent != null && this._clientOptions.userAgent !== "")
            headers["User-Agent"] = this._clientOptions.userAgent;
        const res = await fetch(url, {
            method: "GET",
            headers
        });
        if (!res.ok) {
            const err = new Error(`GitHub API error ${res.status} ${res.statusText}`);
            err.status = res.status;
            err.url = url;
            err.headers = Object.fromEntries(res.headers.entries());
            try {
                err.bodyText = await res.text();
            }
            catch {
                err.bodyText = undefined;
            }
            throw err;
        }
        return (await res.json());
    }
    _getApiBase() {
        return this._clientOptions?.apiBase ?? defaultGitHubApiBase;
    }
}
//# sourceMappingURL=resolveGithubRelease.js.map