export declare function parseQueryStringPolicy(mode?: string | null, allowlist?: string | null): {
    mode: string;
    allowed: string[];
};
export type QueryStringPolicy = ReturnType<typeof parseQueryStringPolicy>;
export declare function filterQueryString(url: URL, policy: QueryStringPolicy, referrer?: boolean): URL;
