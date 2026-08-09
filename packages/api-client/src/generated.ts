export interface paths {
    "/v1/auth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    code?: string;
                    state: string;
                    stytch_token_type?: string;
                    token?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                302: {
                    headers: {
                        /** @description Absolute redirect destination. */
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/device": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deviceCode: string;
                            expiresIn: number;
                            interval: number;
                            userCode: string;
                            verificationUri: string;
                            verificationUriComplete: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/device/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        userCode: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/device/deny": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        userCode: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/device/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        deviceCode: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accessToken?: string;
                            expiresIn: number;
                            refreshToken?: string;
                            /** @enum {string} */
                            tokenType: "Bearer";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    userCode?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                302: {
                    headers: {
                        /** @description Absolute redirect destination. */
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        refreshToken?: string;
                    } | null;
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        refreshToken?: string;
                    } | null;
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accessToken?: string;
                            expiresIn: number;
                            refreshToken?: string;
                            /** @enum {string} */
                            tokenType: "Bearer";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/integrations/github/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        code: string;
                        installationId: string;
                        state: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: {
                                configuration: {
                                    installationId: string;
                                } | {
                                    projectRef: string;
                                } | {
                                    projectId: string;
                                } | {
                                    accountId: string;
                                    /** @enum {string} */
                                    mode: "test" | "live";
                                };
                                credentialRef: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string | null;
                                /** @enum {string} */
                                provider: "github" | "supabase" | "neon" | "stripe";
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/integrations/neon/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        apiKey: string;
                        configuration: {
                            projectId: string;
                        };
                        projectId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: {
                                configuration: {
                                    installationId: string;
                                } | {
                                    projectRef: string;
                                } | {
                                    projectId: string;
                                } | {
                                    accountId: string;
                                    /** @enum {string} */
                                    mode: "test" | "live";
                                };
                                credentialRef: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string | null;
                                /** @enum {string} */
                                provider: "github" | "supabase" | "neon" | "stripe";
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/integrations/stripe/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        apiKey: string;
                        configuration: {
                            accountId: string;
                            /** @enum {string} */
                            mode: "test" | "live";
                        };
                        projectId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: {
                                configuration: {
                                    installationId: string;
                                } | {
                                    projectRef: string;
                                } | {
                                    projectId: string;
                                } | {
                                    accountId: string;
                                    /** @enum {string} */
                                    mode: "test" | "live";
                                };
                                credentialRef: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string | null;
                                /** @enum {string} */
                                provider: "github" | "supabase" | "neon" | "stripe";
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/integrations/supabase/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        accessToken: string;
                        configuration: {
                            projectRef: string;
                        };
                        projectId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: {
                                configuration: {
                                    installationId: string;
                                } | {
                                    projectRef: string;
                                } | {
                                    projectId: string;
                                } | {
                                    accountId: string;
                                    /** @enum {string} */
                                    mode: "test" | "live";
                                };
                                credentialRef: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string | null;
                                /** @enum {string} */
                                provider: "github" | "supabase" | "neon" | "stripe";
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invites/{token}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    token: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            organization: {
                                id: string;
                                name: string;
                                plan: string;
                                slug: string;
                            };
                            /** @enum {string} */
                            role: "owner" | "builder" | "viewer";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            memberships: {
                                allowedModels: string[];
                                organization: {
                                    id: string;
                                    name: string;
                                    slug: string;
                                };
                                /** @enum {string} */
                                role: "owner" | "builder" | "viewer";
                                /** @enum {string} */
                                status: "invited" | "active" | "removed";
                            }[];
                            user: {
                                avatarUrl: string | null;
                                displayName: string;
                                email: string;
                                id: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/organizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                organization: {
                                    id: string;
                                    name: string;
                                    plan: string;
                                    slug: string;
                                };
                                /** @enum {string} */
                                role: "owner" | "builder" | "viewer";
                                /** @enum {string} */
                                status: "invited" | "active" | "removed";
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        slug?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            organization: {
                                id: string;
                                name: string;
                                plan: string;
                                slug: string;
                            };
                            /** @enum {string} */
                            role: "owner" | "builder" | "viewer";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/organizations/{organizationId}/preview-shares/{shareId}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    organizationId: string;
                    shareId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        bearer: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt: string;
                            grant: string;
                            /** Format: uri */
                            previewOrigin: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/organizations/{orgId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    orgId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        slug?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            organization: {
                                id: string;
                                name: string;
                                plan: string;
                                slug: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/organizations/{orgId}/audit-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    action?: "organization.created" | "organization.updated" | "organization.settings_updated" | "member.invited" | "member.joined" | "member.role_changed" | "member.removed" | "project.created" | "project.updated" | "project.scan_requested" | "specification.created" | "specification.updated" | "specification.approved" | "run.created" | "run.events_ingested" | "run.pause_requested" | "run.paused" | "run.pause_rejected" | "run.resume_requested" | "run.resumed" | "run.resume_rejected" | "run.cancel_requested" | "run.cancelled" | "run.cancel_rejected" | "run.redirect_requested" | "run.redirected" | "run.redirect_rejected" | "workspace.create_requested" | "workspace.created" | "workspace.start_requested" | "workspace.started" | "workspace.start_rejected" | "workspace.checkpoint_requested" | "workspace.checkpointed" | "workspace.checkpoint_rejected" | "workspace.terminate_requested" | "workspace.terminated" | "workspace.terminate_rejected" | "workspace.preview_requested" | "workspace.previewed" | "workspace.preview_rejected" | "secret.created" | "secret.rotated" | "secret.deleted" | "release.created" | "release.approved" | "release.deploy_requested" | "release.rollback_requested" | "integration.connected" | "secret.decrypted" | "git_token.minted" | "git_token.revoked";
                    actorId?: string;
                    cursor?: string;
                    from?: string;
                    limit?: number;
                    targetId?: string;
                    targetType?: "organization" | "membership" | "invite" | "project" | "specification" | "run" | "workspace" | "secret" | "release" | "integration_connection";
                    to?: string;
                };
                header?: never;
                path: {
                    orgId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** @enum {string} */
                                action: "organization.created" | "organization.updated" | "organization.settings_updated" | "member.invited" | "member.joined" | "member.role_changed" | "member.removed" | "project.created" | "project.updated" | "project.scan_requested" | "specification.created" | "specification.updated" | "specification.approved" | "run.created" | "run.events_ingested" | "run.pause_requested" | "run.paused" | "run.pause_rejected" | "run.resume_requested" | "run.resumed" | "run.resume_rejected" | "run.cancel_requested" | "run.cancelled" | "run.cancel_rejected" | "run.redirect_requested" | "run.redirected" | "run.redirect_rejected" | "workspace.create_requested" | "workspace.created" | "workspace.start_requested" | "workspace.started" | "workspace.start_rejected" | "workspace.checkpoint_requested" | "workspace.checkpointed" | "workspace.checkpoint_rejected" | "workspace.terminate_requested" | "workspace.terminated" | "workspace.terminate_rejected" | "workspace.preview_requested" | "workspace.previewed" | "workspace.preview_rejected" | "secret.created" | "secret.rotated" | "secret.deleted" | "release.created" | "release.approved" | "release.deploy_requested" | "release.rollback_requested" | "integration.connected" | "secret.decrypted" | "git_token.minted" | "git_token.revoked";
                                actorId: string;
                                /** @enum {string} */
                                actorType: "user" | "service" | "agent" | "support";
                                id: string;
                                metadata: {
                                    [key: string]: (string | number | boolean | ("null" | null)) | (string | number | boolean | ("null" | null))[];
                                };
                                /** Format: date-time */
                                occurredAt: string;
                                organizationId: string;
                                targetId: string | null;
                                /** @enum {string} */
                                targetType: "organization" | "membership" | "invite" | "project" | "specification" | "run" | "workspace" | "secret" | "release" | "integration_connection";
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/organizations/{orgId}/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    orgId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        /** @enum {string} */
                        role: "owner" | "builder" | "viewer";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            invite: {
                                email: string;
                                /** Format: date-time */
                                expiresAt: string;
                                /** @enum {string} */
                                role: "owner" | "builder" | "viewer";
                            };
                            token: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/organizations/{orgId}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    orgId: string;
                    userId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    orgId: string;
                    userId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        role: "owner" | "builder" | "viewer";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            membership: {
                                organizationId: string;
                                /** @enum {string} */
                                role: "owner" | "builder" | "viewer";
                                /** @enum {string} */
                                status: "invited" | "active" | "removed";
                                userId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/organizations/{orgId}/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    orgId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            settings: {
                                /** @default false */
                                builderCanDeploy: boolean;
                                defaultModelPolicy?: string | number | boolean | ("null" | null) | unknown[] | {
                                    [key: string]: unknown;
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    orgId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        builderCanDeploy: boolean;
                        defaultModelPolicy?: string | number | boolean | ("null" | null) | unknown[] | {
                            [key: string]: unknown;
                        };
                    } | {
                        builderCanDeploy?: boolean;
                        defaultModelPolicy: string | number | boolean | ("null" | null) | unknown[] | {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            settings: {
                                /** @default false */
                                builderCanDeploy: boolean;
                                defaultModelPolicy?: string | number | boolean | ("null" | null) | unknown[] | {
                                    [key: string]: unknown;
                                };
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/preview/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        grant: string;
                        organizationId: string;
                        shareId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    includeArchived?: "true" | "false";
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                archivedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                description: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                slug: string;
                                sourceType: string;
                                /** @enum {string} */
                                supportLevel: "compatible" | "verified" | "managed";
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        description?: string;
                        name: string;
                        slug?: string;
                        /**
                         * @default prompt
                         * @enum {string}
                         */
                        sourceType?: "prompt" | "blank" | "template" | "github_import";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            branches: {
                                baseBranchId: string | null;
                                headCommitSha: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                projectId: string;
                                status: string;
                            }[];
                            environments: {
                                /** Format: date-time */
                                createdAt: string;
                                databaseConnectionId: string | null;
                                deploymentProvider: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                projectId: string;
                                type: string;
                            }[];
                            project: {
                                /** Format: date-time */
                                archivedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                description: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                slug: string;
                                sourceType: string;
                                /** @enum {string} */
                                supportLevel: "compatible" | "verified" | "managed";
                            };
                            repository: {
                                defaultBranch: string;
                                externalRepoRef: string | null;
                                id: string;
                                internalRepoRef: string;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                syncPolicy: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            branches: {
                                baseBranchId: string | null;
                                headCommitSha: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                projectId: string;
                                status: string;
                            }[];
                            environments: {
                                /** Format: date-time */
                                createdAt: string;
                                databaseConnectionId: string | null;
                                deploymentProvider: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                projectId: string;
                                type: string;
                            }[];
                            project: {
                                /** Format: date-time */
                                archivedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                description: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                slug: string;
                                sourceType: string;
                                /** @enum {string} */
                                supportLevel: "compatible" | "verified" | "managed";
                            };
                            repository: {
                                defaultBranch: string;
                                externalRepoRef: string | null;
                                id: string;
                                internalRepoRef: string;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                syncPolicy: string;
                            } | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        archived?: boolean;
                        description?: string | null;
                        name?: string;
                        slug?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            project: {
                                /** Format: date-time */
                                archivedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                description: string | null;
                                id: string;
                                name: string;
                                organizationId: string;
                                slug: string;
                                sourceType: string;
                                /** @enum {string} */
                                supportLevel: "compatible" | "verified" | "managed";
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/projects/{projectId}/contract": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            contract: {
                                contract?: unknown;
                                /** Format: date-time */
                                createdAt: string;
                                detectedFramework: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                version: number;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/preview/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            shares: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                expiresAt: string;
                                id: string;
                                /** @enum {string} */
                                policy: "org" | "anyone_with_link";
                                projectId: string;
                                /** Format: date-time */
                                revokedAt: string | null;
                                /** Format: uri */
                                url: string;
                                workspaceId: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/releases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        commitSha: string;
                        environmentId: string;
                        specificationId: string | null;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            release: {
                                commitSha: string;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string;
                                evidenceManifestArtifactId: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                specificationId: string | null;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /**
                         * @default web
                         * @enum {string}
                         */
                        appType?: "web" | "mobile";
                        branchId?: string;
                        budget?: {
                            maxCredits: number;
                        };
                        /** @enum {string} */
                        mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                        model?: string;
                        prompt: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scan: {
                                id: string;
                                projectId: string;
                                /** Format: date-time */
                                requestedAt: string;
                                /** @enum {string} */
                                status: "accepted";
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string | null;
                                id: string;
                                keyVersion: number;
                                name: string;
                                organizationId: string;
                                projectId: string | null;
                                /** Format: date-time */
                                rotatedAt: string | null;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        environmentId?: string;
                        name: string;
                        value: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            secret: {
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string | null;
                                id: string;
                                keyVersion: number;
                                name: string;
                                organizationId: string;
                                projectId: string | null;
                                /** Format: date-time */
                                rotatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/secrets/{secretId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                    secretId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/secrets/{secretId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                    secretId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        value: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            secret: {
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string | null;
                                id: string;
                                keyVersion: number;
                                name: string;
                                organizationId: string;
                                projectId: string | null;
                                /** Format: date-time */
                                rotatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/specifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        acceptanceCriteria: {
                            criticalFlow: boolean;
                            id: string;
                            /** @enum {string} */
                            priority: "critical" | "high" | "medium" | "low";
                            text: string;
                        }[];
                        assumptions: string[];
                        dataModel: string[];
                        definitionOfDone: string[];
                        functionalRequirements: string[];
                        goals: string[];
                        integrations: string[];
                        journeys: string[];
                        nonfunctionalRequirements: string[];
                        nonGoals: string[];
                        pagesRoutes: string[];
                        problem: string;
                        risks: string[];
                        rolesPermissions: string[];
                        targetUsers: string[];
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            specification: {
                                /** Format: date-time */
                                approvedAt: string | null;
                                approvedBy: string | null;
                                content: {
                                    acceptanceCriteria: {
                                        criticalFlow: boolean;
                                        id: string;
                                        /** @enum {string} */
                                        priority: "critical" | "high" | "medium" | "low";
                                        text: string;
                                    }[];
                                    assumptions: string[];
                                    dataModel: string[];
                                    definitionOfDone: string[];
                                    functionalRequirements: string[];
                                    goals: string[];
                                    integrations: string[];
                                    journeys: string[];
                                    nonfunctionalRequirements: string[];
                                    nonGoals: string[];
                                    pagesRoutes: string[];
                                    problem: string;
                                    risks: string[];
                                    rolesPermissions: string[];
                                    targetUsers: string[];
                                };
                                createdBy: string;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                /** @enum {string} */
                                status: "draft" | "approved";
                                version: number;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/specifications/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            specification: {
                                /** Format: date-time */
                                approvedAt: string | null;
                                approvedBy: string | null;
                                content: {
                                    acceptanceCriteria: {
                                        criticalFlow: boolean;
                                        id: string;
                                        /** @enum {string} */
                                        priority: "critical" | "high" | "medium" | "low";
                                        text: string;
                                    }[];
                                    assumptions: string[];
                                    dataModel: string[];
                                    definitionOfDone: string[];
                                    functionalRequirements: string[];
                                    goals: string[];
                                    integrations: string[];
                                    journeys: string[];
                                    nonfunctionalRequirements: string[];
                                    nonGoals: string[];
                                    pagesRoutes: string[];
                                    problem: string;
                                    risks: string[];
                                    rolesPermissions: string[];
                                    targetUsers: string[];
                                };
                                createdBy: string;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                /** @enum {string} */
                                status: "draft" | "approved";
                                version: number;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        acceptanceCriteria: {
                            criticalFlow: boolean;
                            id: string;
                            /** @enum {string} */
                            priority: "critical" | "high" | "medium" | "low";
                            text: string;
                        }[];
                        assumptions: string[];
                        dataModel: string[];
                        definitionOfDone: string[];
                        functionalRequirements: string[];
                        goals: string[];
                        integrations: string[];
                        journeys: string[];
                        nonfunctionalRequirements: string[];
                        nonGoals: string[];
                        pagesRoutes: string[];
                        problem: string;
                        risks: string[];
                        rolesPermissions: string[];
                        targetUsers: string[];
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            specification: {
                                /** Format: date-time */
                                approvedAt: string | null;
                                approvedBy: string | null;
                                content: {
                                    acceptanceCriteria: {
                                        criticalFlow: boolean;
                                        id: string;
                                        /** @enum {string} */
                                        priority: "critical" | "high" | "medium" | "low";
                                        text: string;
                                    }[];
                                    assumptions: string[];
                                    dataModel: string[];
                                    definitionOfDone: string[];
                                    functionalRequirements: string[];
                                    goals: string[];
                                    integrations: string[];
                                    journeys: string[];
                                    nonfunctionalRequirements: string[];
                                    nonGoals: string[];
                                    pagesRoutes: string[];
                                    problem: string;
                                    risks: string[];
                                    rolesPermissions: string[];
                                    targetUsers: string[];
                                };
                                createdBy: string;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                /** @enum {string} */
                                status: "draft" | "approved";
                                version: number;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/projects/{projectId}/specifications/{version}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            specification: {
                                /** Format: date-time */
                                approvedAt: string | null;
                                approvedBy: string | null;
                                content: {
                                    acceptanceCriteria: {
                                        criticalFlow: boolean;
                                        id: string;
                                        /** @enum {string} */
                                        priority: "critical" | "high" | "medium" | "low";
                                        text: string;
                                    }[];
                                    assumptions: string[];
                                    dataModel: string[];
                                    definitionOfDone: string[];
                                    functionalRequirements: string[];
                                    goals: string[];
                                    integrations: string[];
                                    journeys: string[];
                                    nonfunctionalRequirements: string[];
                                    nonGoals: string[];
                                    pagesRoutes: string[];
                                    problem: string;
                                    risks: string[];
                                    rolesPermissions: string[];
                                    targetUsers: string[];
                                };
                                createdBy: string;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                /** @enum {string} */
                                status: "draft" | "approved";
                                version: number;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{projectId}/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        branchId?: string;
                        /**
                         * @default standard
                         * @enum {string}
                         */
                        resourceProfile?: "small" | "standard" | "large";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspace: {
                                branchId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                providerWorkspaceId: string | null;
                                /** @enum {string} */
                                resourceProfile: "small" | "standard" | "large";
                                snapshotRef: string | null;
                                /** @enum {string} */
                                status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                /** Format: date-time */
                                terminatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/releases/{releaseId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    releaseId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            readiness: {
                                findings: {
                                    /** @enum {string} */
                                    action: "fix_and_recheck" | "review" | "waive";
                                    detail: string;
                                    id: string;
                                    /** @enum {string} */
                                    severity: "blocker" | "warning";
                                    title: string;
                                }[];
                                /** @enum {string} */
                                state: "ready" | "warnings" | "blocked";
                            };
                            release: {
                                commitSha: string;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string;
                                evidenceManifestArtifactId: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                specificationId: string | null;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/releases/{releaseId}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    releaseId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            release: {
                                commitSha: string;
                                /** Format: date-time */
                                createdAt: string;
                                createdBy: string;
                                environmentId: string;
                                evidenceManifestArtifactId: string | null;
                                id: string;
                                organizationId: string;
                                projectId: string;
                                specificationId: string | null;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/releases/{releaseId}/deploy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    releaseId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        dataDisposition?: "preserve" | "transfer" | "reset";
                        /** @enum {string} */
                        deploymentType: "first_deploy" | "redeploy" | "replace_deployment";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deploymentId: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/releases/{releaseId}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    releaseId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            evidence: {
                                browser_tests: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                                build: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                                commit_sha: string;
                                criteria: {
                                    id: string;
                                    /** @enum {string} */
                                    status: "passed" | "failed";
                                }[];
                                known_risks: {
                                    detail: string;
                                    id: string;
                                }[];
                                migration: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                                preview: {
                                    /** Format: uri */
                                    url: string;
                                };
                                release_id: string;
                                rollback: {
                                    supported: boolean;
                                };
                                security: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                                specification_version: number;
                                tests: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                                typecheck: {
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "skipped" | "not_required";
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/releases/{releaseId}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    releaseId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        reason: string;
                        toDeploymentId?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deploymentId: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    after?: string;
                };
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": {
                            agentId?: string;
                            id: string;
                            /** Format: date-time */
                            occurredAt: string;
                            organizationId: string;
                            payload: {
                                [key: string]: unknown;
                            };
                            phaseId?: string;
                            projectId: string;
                            runId: string;
                            sequence: number;
                            taskId?: string;
                            /** @enum {string} */
                            type: "run.created" | "run.started" | "run.paused" | "run.resumed" | "run.cancelled" | "run.completed" | "phase.created" | "phase.started" | "phase.completed" | "task.created" | "task.started" | "task.blocked" | "task.updated" | "task.completed" | "task.failed" | "agent.started" | "agent.completed" | "tool.started" | "tool.output" | "tool.completed" | "tool.failed" | "approval.requested" | "approval.resolved" | "artifact.created" | "commit.created" | "test.started" | "test.completed" | "verification.completed" | "preview.starting" | "preview.ready" | "preview.failed" | "release.created" | "deployment.updated" | "usage.recorded";
                            /** @enum {string} */
                            visibility: "user" | "internal" | "support";
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/mission-control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            activeAgents: {
                                agentId: string;
                                role: string;
                                /** Format: date-time */
                                startedAt: string;
                                taskId: string | null;
                            }[];
                            approvals: {
                                approvalId: string;
                                request?: unknown;
                                /** Format: date-time */
                                requestedAt: string;
                                /** Format: date-time */
                                resolvedAt: string | null;
                                response?: unknown;
                                status: string;
                                taskId: string | null;
                                type: string;
                            }[];
                            commits: {
                                diffstat: {
                                    additions: number;
                                    deletions: number;
                                    path: string;
                                }[];
                                message: string | null;
                                /** Format: date-time */
                                occurredAt: string;
                                sequence: number;
                                sha: string;
                                taskId: string | null;
                            }[];
                            cost: {
                                budget: number | null;
                                creditsUsed: number;
                            };
                            currentPhase: {
                                id: string;
                                sequence: number;
                                status: string;
                                title: string;
                            } | null;
                            filesChanged: {
                                additions: number;
                                deletions: number;
                                path: string;
                            }[];
                            previewStatus: {
                                /** Format: date-time */
                                occurredAt: string;
                                /** @enum {string} */
                                status: "starting" | "ready" | "failed";
                            } | null;
                            progress: {
                                done: number;
                                total: number;
                            };
                            recentToolCalls: {
                                agentId: string | null;
                                durationMs: number | null;
                                /** Format: date-time */
                                occurredAt: string;
                                sequence: number;
                                status: string;
                                taskId: string | null;
                                toolCallId: string;
                                toolName: string;
                                userSummary: string | null;
                            }[];
                            risks: {
                                id: string;
                                severity: string;
                                summary: string;
                            }[];
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                            screenshots: {
                                artifactId: string;
                                contentHash: string;
                                /** Format: date-time */
                                createdAt: string;
                            }[];
                            taskGraph: {
                                edges: {
                                    from: string;
                                    to: string;
                                }[];
                                nodes: {
                                    assignedAgentRole: string | null;
                                    id: string;
                                    phaseId: string;
                                    riskLevel: string;
                                    status: string;
                                    title: string;
                                }[];
                            };
                            testRuns: {
                                commitSha: string;
                                /** Format: date-time */
                                occurredAt: string;
                                status: string;
                                summary?: unknown;
                                taskId: string | null;
                                testRunId: string;
                                type: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/mission-control/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                diffstat: {
                                    additions: number;
                                    deletions: number;
                                    path: string;
                                }[];
                                message: string | null;
                                /** Format: date-time */
                                occurredAt: string;
                                sequence: number;
                                sha: string;
                                taskId: string | null;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/mission-control/tool-calls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                agentId: string | null;
                                durationMs: number | null;
                                /** Format: date-time */
                                occurredAt: string;
                                sequence: number;
                                status: string;
                                taskId: string | null;
                                toolCallId: string;
                                toolName: string;
                                userSummary: string | null;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/redirect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        prompt: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** @enum {string} */
                                appType: "web" | "mobile";
                                branchId: string | null;
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                /** @enum {string} */
                                mode: "ask" | "prototype" | "build" | "fix" | "autonomous";
                                model: string | null;
                                organizationId: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                startedBy: string;
                                status: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspace: {
                                branchId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                providerWorkspaceId: string | null;
                                /** @enum {string} */
                                resourceProfile: "small" | "standard" | "large";
                                snapshotRef: string | null;
                                /** @enum {string} */
                                status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                /** Format: date-time */
                                terminatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/checkpoint": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        kind: "active" | "diagnostic" | "release_evidence";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspace: {
                                branchId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                providerWorkspaceId: string | null;
                                /** @enum {string} */
                                resourceProfile: "small" | "standard" | "large";
                                snapshotRef: string | null;
                                /** @enum {string} */
                                status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                /** Format: date-time */
                                terminatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/preview/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expiresInSeconds: number;
                        /** @enum {string} */
                        policy: "org" | "anyone_with_link";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            share: {
                                /** Format: date-time */
                                expiresAt: string;
                                id: string;
                                /** @enum {string} */
                                policy: "org" | "anyone_with_link";
                                /** Format: uri */
                                url: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/preview/shares/{shareId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    shareId: string;
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            revoked: true;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspace: {
                                branchId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                providerWorkspaceId: string | null;
                                /** @enum {string} */
                                resourceProfile: "small" | "standard" | "large";
                                snapshotRef: string | null;
                                /** @enum {string} */
                                status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                /** Format: date-time */
                                terminatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workspaces/{workspaceId}/terminate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workspaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                "4XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                "5XX": {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                details?: {
                                    [key: string]: unknown;
                                };
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            workspace: {
                                branchId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                organizationId: string;
                                projectId: string;
                                provider: string;
                                providerWorkspaceId: string | null;
                                /** @enum {string} */
                                resourceProfile: "small" | "standard" | "large";
                                snapshotRef: string | null;
                                /** @enum {string} */
                                status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                /** Format: date-time */
                                terminatedAt: string | null;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
