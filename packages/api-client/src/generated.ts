export interface paths {
    "/v1/admin/organizations/{organizationId}/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    from: string;
                    to: string;
                };
                header: {
                    "x-zapp-support-session": string;
                };
                path: {
                    organizationId: string;
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
                            projects: {
                                /** Format: date-time */
                                archivedAt: string | null;
                                deploymentStatus: string | null;
                                id: string;
                                /** Format: date-time */
                                lastActivityAt: string | null;
                                name: string;
                                releaseStatus: string | null;
                                runs: {
                                    /** Format: date-time */
                                    completedAt: string | null;
                                    id: string;
                                    mode: string;
                                    projectId: string;
                                    /** Format: date-time */
                                    startedAt: string;
                                    status: string;
                                }[];
                                slug: string;
                                supportLevel: string;
                                workspaces: {
                                    /** Format: date-time */
                                    createdAt: string;
                                    id: string;
                                    /** Format: date-time */
                                    lastActiveAt: string | null;
                                    projectId: string;
                                    provider: string;
                                    resourceProfile: string;
                                    runId: string | null;
                                    /** @enum {string} */
                                    status: "requested" | "provisioning" | "started" | "ready" | "active" | "checkpointing" | "idle" | "terminated";
                                    /** Format: date-time */
                                    terminatedAt: string | null;
                                }[];
                            }[];
                            usage: {
                                byCategory: {
                                    category: string;
                                    quantity: string;
                                }[];
                                byProject: {
                                    projectId: string | null;
                                    quantity: string;
                                }[];
                                byRun: {
                                    quantity: string;
                                    runId: string | null;
                                }[];
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
    "/v1/admin/organizations/{organizationId}/runs/{runId}/diagnostics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header: {
                    "x-zapp-support-session": string;
                };
                path: {
                    organizationId: string;
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
                            artifacts: {
                                contentHash: string;
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                type: string;
                            }[];
                            events: {
                                agentId: string | null;
                                id: string;
                                /** Format: date-time */
                                occurredAt: string;
                                payload: {
                                    [key: string]: unknown;
                                };
                                phaseId: string | null;
                                sequence: number;
                                taskId: string | null;
                                type: string;
                            }[];
                            run: {
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                mode: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
                                status: string;
                            };
                            sourceInspection: {
                                /** @enum {boolean} */
                                allowed: false;
                                /** @enum {boolean} */
                                requiresCustomerGrant: true;
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
    "/v1/admin/organizations/{organizationId}/runs/{runId}/terminate": {
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
                header: {
                    "idempotency-key": string;
                    "x-zapp-support-session": string;
                };
                path: {
                    organizationId: string;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: {
                                /** Format: date-time */
                                completedAt: string | null;
                                id: string;
                                mode: string;
                                projectId: string;
                                /** Format: date-time */
                                startedAt: string;
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
    "/v1/admin/organizations/{organizationId}/terminate-all": {
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
                header: {
                    "idempotency-key": string;
                    "x-zapp-support-session": string;
                };
                path: {
                    organizationId: string;
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
                            terminated: number;
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
    "/v1/admin/organizations/{organizationId}/workspaces/{workspaceId}/terminate": {
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
                header: {
                    "idempotency-key": string;
                    "x-zapp-support-session": string;
                };
                path: {
                    organizationId: string;
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
                                /** Format: date-time */
                                createdAt: string;
                                id: string;
                                /** Format: date-time */
                                lastActiveAt: string | null;
                                projectId: string;
                                provider: string;
                                resourceProfile: string;
                                runId: string | null;
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
    "/v1/admin/support-sessions": {
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
                header: {
                    "idempotency-key": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        reason?: string;
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
                            /** Format: date-time */
                            expiresAt: string;
                            id: string;
                            organizationId: string;
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
    "/v1/attachments/{attachmentId}": {
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
                    attachmentId: string;
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
                            /** Format: date-time */
                            expiresAt: string;
                            /** Format: uri */
                            url: string;
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
    "/v1/billing/checkout": {
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
                        /** @enum {string} */
                        planId: "builder" | "studio";
                        seats: number;
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
                            /** Format: uri */
                            url: string;
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
    "/v1/billing/estimate": {
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
                        items: {
                            /** @enum {string} */
                            category: "model_input_tokens" | "model_output_tokens" | "model_cached_tokens" | "sandbox_cpu_seconds" | "sandbox_mem_gib_seconds" | "storage_gib_hours" | "deploy_provider" | "artifact_storage";
                            model?: string;
                            provider?: string;
                            quantity: string;
                        }[];
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
                            items: {
                                costUsd: string;
                                credits: string;
                            }[];
                            pricingVersion: string;
                            total: {
                                costUsd: string;
                                credits: string;
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
    "/v1/billing/portal": {
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
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uri */
                            url: string;
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
    "/v1/billing/status": {
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
                            billing: {
                                customerId: string | null;
                                dunning: {
                                    /** @enum {string} */
                                    state: "current";
                                } | {
                                    failedInvoiceId: string;
                                    /** Format: date-time */
                                    graceEndsAt: string;
                                    /** @enum {string} */
                                    state: "grace";
                                } | {
                                    failedInvoiceId: string;
                                    /** Format: date-time */
                                    graceEndsAt: string;
                                    /** @enum {string} */
                                    state: "downgraded";
                                };
                                planId: string;
                                seats: number | null;
                                subscriptionId: string | null;
                                subscriptionStatus: string | null;
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
    "/v1/billing/subscription": {
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
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        seats: number;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            accepted: true;
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/v1/billing/topups": {
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
                            packs: {
                                amountUsd: string;
                                credits: string;
                                id: string;
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
    "/v1/billing/topups/checkout": {
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
                        packId: string;
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
                            /** Format: uri */
                            url: string;
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
    "/v1/feature-flags": {
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
                            flags: {
                                "mobile-app-tab": boolean;
                                "visual-editing": boolean;
                                "voice-input": boolean;
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
    "/v1/forks": {
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
                        /** @default false */
                        copyDeploymentConfig?: boolean;
                        name: string;
                        sourceOrganizationId: string;
                        sourceProjectId: string;
                        /** @enum {string} */
                        target: "project";
                    } | {
                        fromSha: string;
                        name: string;
                        projectId: string;
                        sourceOrganizationId: string;
                        /** @enum {string} */
                        target: "branch";
                    } | {
                        /** @default null */
                        destinationBranchId?: string | null;
                        destinationProjectId: string;
                        sourceOrganizationId: string;
                        sourceRunId: string;
                        /** @enum {string} */
                        target: "conversation";
                    } | {
                        checkpointRef: string;
                        /** @default null */
                        destinationBranchId?: string | null;
                        destinationProjectId: string;
                        sourceOrganizationId: string;
                        sourceRunId: string;
                        /** @enum {string} */
                        target: "run_checkpoint";
                    } | {
                        releaseId: string;
                        sourceOrganizationId: string;
                        /** @default false */
                        startFixRun?: boolean;
                        /** @enum {string} */
                        target: "release_repair";
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
                            fork: {
                                branchId: string;
                                deploymentConfigCopied: boolean;
                                projectId: string;
                                secretSetupChecklist: string[];
                                sourceProjectId: string;
                                /** @enum {string} */
                                target: "project";
                            } | {
                                branchId: string;
                                headCommitSha: string;
                                projectId: string;
                                /** @enum {string} */
                                target: "branch";
                            } | {
                                contextArtifactId: string;
                                runId: string;
                                sourceRunId: string;
                                /** @enum {string} */
                                target: "conversation";
                            } | {
                                checkpointRef: string;
                                contextArtifactId: string;
                                runId: string;
                                sourceRunId: string;
                                /** @enum {string} */
                                target: "run_checkpoint";
                                workspaceId: string;
                            } | {
                                branchId: string;
                                fixRunId: string | null;
                                releaseId: string;
                                /** @enum {string} */
                                target: "release_repair";
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
                                    databaseName: string;
                                    previewBranchId?: string;
                                    productionBranchId?: string;
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
    "/v1/integrations/github/install/authorize": {
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
                header: {
                    "idempotency-key": string;
                };
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
                            /** Format: uri */
                            url: string;
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
    "/v1/integrations/github/repositories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    cursor?: string;
                    installationId: string;
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
                                defaultBranch: string;
                                fullName: string;
                                id: string;
                                private: boolean;
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
    "/v1/integrations/github/repositories/{repositoryId}/branches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    cursor?: string;
                    installationId: string;
                };
                header?: never;
                path: {
                    repositoryId: string;
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
                                headCommitSha: string;
                                name: string;
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
                            databaseName: string;
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
                                    databaseName: string;
                                    previewBranchId?: string;
                                    productionBranchId?: string;
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
                                    databaseName: string;
                                    previewBranchId?: string;
                                    productionBranchId?: string;
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
                                    databaseName: string;
                                    previewBranchId?: string;
                                    productionBranchId?: string;
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
    "/v1/local-agent/sessions": {
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
                        localProjectName: string;
                        /** Format: uuid */
                        sessionId: string;
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
                            session: {
                                organizationId: string;
                                projectId: string;
                                runId: string;
                                /** Format: uuid */
                                sessionId: string;
                                taskId: string;
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
    "/v1/local-agent/sessions/{sessionId}/completions": {
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
                    sessionId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        agentRole: "planner" | "builder" | "verifier" | "summarizer";
                        budget?: {
                            remainingCredits: number;
                        };
                        /** @default [] */
                        cacheBreakpointMessageIndexes?: number[];
                        completionId: string;
                        maxInputTokens: number;
                        maxOutputTokens: number;
                        messages: ({
                            content: string;
                            /** @enum {string} */
                            role: "system";
                        } | {
                            content: string | {
                                text: string;
                                /** @enum {string} */
                                type: "text";
                            }[];
                            /** @enum {string} */
                            role: "user";
                        } | {
                            content: string | ({
                                text: string;
                                /** @enum {string} */
                                type: "text";
                            } | {
                                input: {
                                    [key: string]: (string | number | boolean | ("null" | null)) | unknown[] | {
                                        [key: string]: unknown;
                                    };
                                };
                                toolCallId: string;
                                toolName: string;
                                /** @enum {string} */
                                type: "tool-call";
                            })[];
                            /** @enum {string} */
                            role: "assistant";
                        } | {
                            content: {
                                output: {
                                    /** @enum {string} */
                                    type: "text";
                                    value: string;
                                } | {
                                    /** @enum {string} */
                                    type: "json";
                                    value: (string | number | boolean | ("null" | null)) | unknown[] | {
                                        [key: string]: unknown;
                                    };
                                } | {
                                    /** @enum {string} */
                                    type: "error-text";
                                    value: string;
                                } | {
                                    /** @enum {string} */
                                    type: "error-json";
                                    value: (string | number | boolean | ("null" | null)) | unknown[] | {
                                        [key: string]: unknown;
                                    };
                                } | {
                                    reason?: string;
                                    /** @enum {string} */
                                    type: "execution-denied";
                                };
                                toolCallId: string;
                                toolName: string;
                                /** @enum {string} */
                                type: "tool-result";
                            }[];
                            /** @enum {string} */
                            role: "tool";
                        })[];
                        tools?: {
                            description: string;
                            inputJsonSchema: {
                                additionalProperties?: boolean | ({
                                    const?: string;
                                    default?: string;
                                    description?: string;
                                    enum?: string[];
                                    format?: string;
                                    maxLength?: number;
                                    minLength?: number;
                                    pattern?: string;
                                    /** @enum {string} */
                                    type: "string";
                                } | {
                                    const?: number;
                                    default?: number;
                                    description?: string;
                                    enum?: number[];
                                    exclusiveMaximum?: number;
                                    exclusiveMinimum?: number;
                                    maximum?: number;
                                    minimum?: number;
                                    multipleOf?: number;
                                    /** @enum {string} */
                                    type: "number" | "integer";
                                } | {
                                    const?: boolean;
                                    default?: boolean;
                                    description?: string;
                                    enum?: boolean[];
                                    /** @enum {string} */
                                    type: "boolean";
                                } | {
                                    description?: string;
                                    /** @enum {string} */
                                    type: "null";
                                } | {
                                    description?: string;
                                    items: unknown;
                                    maxItems?: number;
                                    minItems?: number;
                                    /** @enum {string} */
                                    type: "array";
                                    uniqueItems?: boolean;
                                } | {
                                    additionalProperties?: boolean | unknown;
                                    description?: string;
                                    maxProperties?: number;
                                    minProperties?: number;
                                    properties: {
                                        [key: string]: unknown;
                                    };
                                    required?: string[];
                                    /** @enum {string} */
                                    type: "object";
                                });
                                description?: string;
                                maxProperties?: number;
                                minProperties?: number;
                                properties: {
                                    [key: string]: {
                                        const?: string;
                                        default?: string;
                                        description?: string;
                                        enum?: string[];
                                        format?: string;
                                        maxLength?: number;
                                        minLength?: number;
                                        pattern?: string;
                                        /** @enum {string} */
                                        type: "string";
                                    } | {
                                        const?: number;
                                        default?: number;
                                        description?: string;
                                        enum?: number[];
                                        exclusiveMaximum?: number;
                                        exclusiveMinimum?: number;
                                        maximum?: number;
                                        minimum?: number;
                                        multipleOf?: number;
                                        /** @enum {string} */
                                        type: "number" | "integer";
                                    } | {
                                        const?: boolean;
                                        default?: boolean;
                                        description?: string;
                                        enum?: boolean[];
                                        /** @enum {string} */
                                        type: "boolean";
                                    } | {
                                        description?: string;
                                        /** @enum {string} */
                                        type: "null";
                                    } | {
                                        description?: string;
                                        items: unknown;
                                        maxItems?: number;
                                        minItems?: number;
                                        /** @enum {string} */
                                        type: "array";
                                        uniqueItems?: boolean;
                                    } | {
                                        additionalProperties?: boolean | unknown;
                                        description?: string;
                                        maxProperties?: number;
                                        minProperties?: number;
                                        properties: {
                                            [key: string]: unknown;
                                        };
                                        required?: string[];
                                        /** @enum {string} */
                                        type: "object";
                                    };
                                };
                                required?: string[];
                                /** @enum {string} */
                                type: "object";
                            };
                            name: string;
                        }[];
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
                        "text/event-stream": ({
                            text: string;
                            /** @enum {string} */
                            type: "text-delta";
                        } | {
                            input: {
                                [key: string]: string | number | boolean | ("null" | null) | unknown[] | {
                                    [key: string]: unknown;
                                };
                            };
                            toolCallId: string;
                            toolName: string;
                            /** @enum {string} */
                            type: "tool-call";
                        } | {
                            cachedInputTokens?: number;
                            cacheWriteInputTokens?: number;
                            finishReason: string;
                            inputTokens?: number;
                            model: string;
                            outputTokens?: number;
                            provider: string;
                            totalTokens?: number;
                            /** @enum {string} */
                            type: "usage";
                        }) | {
                            completionId: string;
                            credits: {
                                ceiling: string;
                                reserved: string;
                                used: string;
                                version: number;
                            };
                            /** @enum {string} */
                            type: "usage.recorded";
                            usage: {
                                cacheReadInputTokens: number;
                                cacheWriteInputTokens: number;
                                inputTokens: number;
                                model: string;
                                /** Format: date-time */
                                occurredAt: string;
                                outputTokens: number;
                                provider: string;
                            }[];
                        } | ({
                            /** @enum {string} */
                            type: "done";
                        } | {
                            /** @enum {string} */
                            code: "provider_error" | "content_filter" | "output_limit_exceeded" | "unknown_finish_reason" | "completion_leased" | "completion_retryable" | "budget_exceeded";
                            message: string;
                            /** @enum {string} */
                            type: "error";
                        });
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
    "/v1/notification-preferences": {
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
                            preferences: {
                                desktopPush: boolean;
                                email: boolean;
                                inApp: boolean;
                                organizationId: string;
                                /** @enum {string} */
                                type: "approval_requested" | "run_completed" | "run_failed" | "budget_50" | "budget_80" | "budget_100" | "synthetic_check_failed" | "production_incident" | "deploy_succeeded" | "deploy_failed" | "payment_failed" | "member_invited";
                                userId: string;
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
    "/v1/notification-preferences/{type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    type: "approval_requested" | "run_completed" | "run_failed" | "budget_50" | "budget_80" | "budget_100" | "synthetic_check_failed" | "production_incident" | "deploy_succeeded" | "deploy_failed" | "payment_failed" | "member_invited";
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        desktopPush: boolean;
                        email: boolean;
                        inApp: boolean;
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
                            preference: {
                                desktopPush: boolean;
                                email: boolean;
                                inApp: boolean;
                                organizationId: string;
                                /** @enum {string} */
                                type: "approval_requested" | "run_completed" | "run_failed" | "budget_50" | "budget_80" | "budget_100" | "synthetic_check_failed" | "production_incident" | "deploy_succeeded" | "deploy_failed" | "payment_failed" | "member_invited";
                                userId: string;
                            };
                        };
                    };
                };
            };
        };
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
        delete: {
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
                            deletions: {
                                /** Format: date-time */
                                completedAt: string | null;
                                projectId: string;
                                /** Format: date-time */
                                requestedAt: string;
                                /** @enum {string} */
                                status: "queued" | "running" | "failed" | "completed";
                                targets: {
                                    /** @enum {string} */
                                    git: "pending" | "verified";
                                    /** @enum {string} */
                                    objects: "pending" | "verified";
                                    /** @enum {string} */
                                    postgres: "pending" | "verified";
                                    /** @enum {string} */
                                    snapshots: "pending" | "verified";
                                };
                            }[];
                        };
                    };
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
                    action?: "organization.created" | "organization.updated" | "organization.settings_updated" | "member.invited" | "member.joined" | "member.role_changed" | "member.removed" | "project.created" | "project.updated" | "project.scan_requested" | "project.deletion_requested" | "project.exported" | "specification.created" | "specification.updated" | "specification.approved" | "run.created" | "run.dispatch_failed" | "run.dispatch_retried" | "run.message_created" | "run.conversation_response_requested" | "run.conversation_response_signalled" | "run.events_ingested" | "run.pause_requested" | "run.paused" | "run.pause_rejected" | "run.resume_requested" | "run.resumed" | "run.resume_rejected" | "run.cancel_requested" | "run.cancelled" | "run.cancel_rejected" | "run.redirect_requested" | "run.redirected" | "run.redirect_rejected" | "run.task_retry_requested" | "run.task_retry_signalled" | "run.task_retry_rejected" | "run.phase_skip_requested" | "run.phase_skip_signalled" | "run.phase_skip_rejected" | "run.approval_resolved" | "workspace.create_requested" | "workspace.created" | "workspace.start_requested" | "workspace.started" | "workspace.start_rejected" | "workspace.checkpoint_requested" | "workspace.checkpointed" | "workspace.checkpoint_rejected" | "workspace.terminate_requested" | "workspace.terminated" | "workspace.terminate_rejected" | "workspace.preview_requested" | "workspace.previewed" | "workspace.preview_rejected" | "secret.created" | "secret.rotated" | "secret.deleted" | "attachment.created" | "release.created" | "release.approved" | "release.deploy_requested" | "release.rollback_requested" | "incident.created" | "incident.fix_run_created" | "incident.resolved" | "support.impersonation" | "integration.connected" | "secret.decrypted" | "git_token.minted" | "git_token.revoked";
                    actorId?: string;
                    cursor?: string;
                    from?: string;
                    limit?: number;
                    targetId?: string;
                    targetType?: "organization" | "membership" | "invite" | "project" | "specification" | "run" | "workspace" | "artifact" | "secret" | "release" | "integration_connection";
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
                                action: "organization.created" | "organization.updated" | "organization.settings_updated" | "member.invited" | "member.joined" | "member.role_changed" | "member.removed" | "project.created" | "project.updated" | "project.scan_requested" | "project.deletion_requested" | "project.exported" | "specification.created" | "specification.updated" | "specification.approved" | "run.created" | "run.dispatch_failed" | "run.dispatch_retried" | "run.message_created" | "run.conversation_response_requested" | "run.conversation_response_signalled" | "run.events_ingested" | "run.pause_requested" | "run.paused" | "run.pause_rejected" | "run.resume_requested" | "run.resumed" | "run.resume_rejected" | "run.cancel_requested" | "run.cancelled" | "run.cancel_rejected" | "run.redirect_requested" | "run.redirected" | "run.redirect_rejected" | "run.task_retry_requested" | "run.task_retry_signalled" | "run.task_retry_rejected" | "run.phase_skip_requested" | "run.phase_skip_signalled" | "run.phase_skip_rejected" | "run.approval_resolved" | "workspace.create_requested" | "workspace.created" | "workspace.start_requested" | "workspace.started" | "workspace.start_rejected" | "workspace.checkpoint_requested" | "workspace.checkpointed" | "workspace.checkpoint_rejected" | "workspace.terminate_requested" | "workspace.terminated" | "workspace.terminate_rejected" | "workspace.preview_requested" | "workspace.previewed" | "workspace.preview_rejected" | "secret.created" | "secret.rotated" | "secret.deleted" | "attachment.created" | "release.created" | "release.approved" | "release.deploy_requested" | "release.rollback_requested" | "incident.created" | "incident.fix_run_created" | "incident.resolved" | "support.impersonation" | "integration.connected" | "secret.decrypted" | "git_token.minted" | "git_token.revoked";
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
                                targetType: "organization" | "membership" | "invite" | "project" | "specification" | "run" | "workspace" | "artifact" | "secret" | "release" | "integration_connection";
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
                                billing?: {
                                    dunning: {
                                        /** @enum {string} */
                                        state: "current";
                                    } | {
                                        failedInvoiceId: string;
                                        /** Format: date-time */
                                        graceEndsAt: string;
                                        /** @enum {string} */
                                        state: "grace";
                                    } | {
                                        failedInvoiceId: string;
                                        /** Format: date-time */
                                        graceEndsAt: string;
                                        /** @enum {string} */
                                        state: "downgraded";
                                    };
                                };
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
                                billing?: {
                                    dunning: {
                                        /** @enum {string} */
                                        state: "current";
                                    } | {
                                        failedInvoiceId: string;
                                        /** Format: date-time */
                                        graceEndsAt: string;
                                        /** @enum {string} */
                                        state: "grace";
                                    } | {
                                        failedInvoiceId: string;
                                        /** Format: date-time */
                                        graceEndsAt: string;
                                        /** @enum {string} */
                                        state: "downgraded";
                                    };
                                };
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
        delete: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
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
                            deletion: {
                                /** Format: date-time */
                                completedAt: string | null;
                                projectId: string;
                                /** Format: date-time */
                                requestedAt: string;
                                /** @enum {string} */
                                status: "queued" | "running" | "failed" | "completed";
                                targets: {
                                    /** @enum {string} */
                                    git: "pending" | "verified";
                                    /** @enum {string} */
                                    objects: "pending" | "verified";
                                    /** @enum {string} */
                                    postgres: "pending" | "verified";
                                    /** @enum {string} */
                                    snapshots: "pending" | "verified";
                                };
                            };
                        };
                    };
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
    "/v1/projects/{projectId}/attachments": {
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
                    "multipart/form-data": unknown | unknown;
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
                            attachmentId: string;
                            byteSize: number;
                            /** @enum {string} */
                            contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                            /** @enum {string} */
                            kind: "image";
                            name: string;
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
    "/v1/projects/{projectId}/deletion": {
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
                            deletion: {
                                /** Format: date-time */
                                completedAt: string | null;
                                projectId: string;
                                /** Format: date-time */
                                requestedAt: string;
                                /** @enum {string} */
                                status: "queued" | "running" | "failed" | "completed";
                                targets: {
                                    /** @enum {string} */
                                    git: "pending" | "verified";
                                    /** @enum {string} */
                                    objects: "pending" | "verified";
                                    /** @enum {string} */
                                    postgres: "pending" | "verified";
                                    /** @enum {string} */
                                    snapshots: "pending" | "verified";
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
    "/v1/projects/{projectId}/export": {
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
                header: {
                    "idempotency-key": string;
                };
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
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            export: {
                                byteSize: number;
                                contentHash: string;
                                /** @enum {string} */
                                contentType: "application/x-tar";
                                /** Format: date-time */
                                expiresAt: string;
                                exportId: string;
                                projectId: string;
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
    "/v1/projects/{projectId}/import/github": {
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
                            branch: string;
                            /** @enum {string|null} */
                            errorCode: "github_unavailable" | "repository_not_found" | "branch_not_found" | "mirror_failed" | "scan_unavailable" | null;
                            externalRepoRef: string | null;
                            headCommitSha: string | null;
                            projectId: string;
                            scanId: string | null;
                            /** @enum {string} */
                            status: "queued" | "mirroring" | "scan_pending" | "scan_accepted" | "failed";
                            /** Format: date-time */
                            updatedAt: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    projectId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        branch: string;
                        installationId: string;
                        repo: string;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            import: {
                                projectId: string;
                                /** @enum {string} */
                                status: "queued";
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
    "/v1/projects/{projectId}/incidents": {
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
                                commitSha: string;
                                /** Format: date-time */
                                createdAt: string;
                                errorPayload: string;
                                evidenceArtifactId: string | null;
                                fixRequest: {
                                    errorPayload?: string;
                                    evidence: ({
                                        artifactId: string;
                                        /** @enum {string} */
                                        kind: "preview_console" | "preview_network" | "failed_check" | "user_report";
                                        summary: string;
                                    } | {
                                        /** @enum {string} */
                                        kind: "grafana_faro" | "grafana_loki";
                                        summary: string;
                                        /** Format: uri */
                                        url: string;
                                    } | {
                                        incidentId: string;
                                        /** @enum {string} */
                                        kind: "incident_record";
                                        summary: string;
                                    })[];
                                    incidentId?: string;
                                    releaseId?: string;
                                    relevantCommitSha: string;
                                    reproductionRef: string;
                                    /** @enum {string} */
                                    source: "error_report" | "failed_check" | "user_bug";
                                    summary: string;
                                };
                                fixRunId: string | null;
                                id: string;
                                /** Format: uri */
                                logsUrl: string | null;
                                organizationId: string;
                                projectId: string;
                                releaseId: string;
                                reproductionRoute: string;
                                resolutionReleaseId: string | null;
                                /** @enum {string} */
                                source: "grafana_faro" | "grafana_loki" | "synthetic_failure" | "user_report";
                                /** @enum {string} */
                                status: "open" | "fix_running" | "resolved";
                                title: string;
                                /** Format: uri */
                                traceUrl: string | null;
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
                        errorPayload: string;
                        /** Format: uri */
                        logsUrl?: string;
                        releaseId: string;
                        reproductionRoute: string;
                        title: string;
                        /** Format: uri */
                        traceUrl?: string;
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
                            incident: {
                                commitSha: string;
                                /** Format: date-time */
                                createdAt: string;
                                errorPayload: string;
                                evidenceArtifactId: string | null;
                                fixRequest: {
                                    errorPayload?: string;
                                    evidence: ({
                                        artifactId: string;
                                        /** @enum {string} */
                                        kind: "preview_console" | "preview_network" | "failed_check" | "user_report";
                                        summary: string;
                                    } | {
                                        /** @enum {string} */
                                        kind: "grafana_faro" | "grafana_loki";
                                        summary: string;
                                        /** Format: uri */
                                        url: string;
                                    } | {
                                        incidentId: string;
                                        /** @enum {string} */
                                        kind: "incident_record";
                                        summary: string;
                                    })[];
                                    incidentId?: string;
                                    releaseId?: string;
                                    relevantCommitSha: string;
                                    reproductionRef: string;
                                    /** @enum {string} */
                                    source: "error_report" | "failed_check" | "user_bug";
                                    summary: string;
                                };
                                fixRunId: string | null;
                                id: string;
                                /** Format: uri */
                                logsUrl: string | null;
                                organizationId: string;
                                projectId: string;
                                releaseId: string;
                                reproductionRoute: string;
                                resolutionReleaseId: string | null;
                                /** @enum {string} */
                                source: "grafana_faro" | "grafana_loki" | "synthetic_failure" | "user_report";
                                /** @enum {string} */
                                status: "open" | "fix_running" | "resolved";
                                title: string;
                                /** Format: uri */
                                traceUrl: string | null;
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
                                planMaxCredits: string;
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
                        fixRequest: {
                            errorPayload?: string;
                            evidence: ({
                                artifactId: string;
                                /** @enum {string} */
                                kind: "preview_console" | "preview_network" | "failed_check" | "user_report";
                                summary: string;
                            } | {
                                /** @enum {string} */
                                kind: "grafana_faro" | "grafana_loki";
                                summary: string;
                                /** Format: uri */
                                url: string;
                            } | {
                                incidentId: string;
                                /** @enum {string} */
                                kind: "incident_record";
                                summary: string;
                            })[];
                            incidentId?: string;
                            releaseId?: string;
                            relevantCommitSha: string;
                            reproductionRef: string;
                            /** @enum {string} */
                            source: "error_report" | "failed_check" | "user_bug";
                            summary: string;
                        };
                        /** @enum {string} */
                        mode: "fix";
                        model?: string;
                        prompt: string;
                    } | {
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
                        mode: "ask" | "prototype" | "build" | "autonomous";
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
                                planMaxCredits: string;
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
                header?: {
                    "if-match"?: string;
                };
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
    "/v1/projects/summaries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    projectId: string[];
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
                            summaries: {
                                deployReadiness: {
                                    findings: {
                                        /** @enum {string} */
                                        action: "fix_and_recheck" | "review" | "waive";
                                        detail: string;
                                        id: string;
                                        /** @enum {string} */
                                        severity: "blocker" | "warning";
                                        title: string;
                                    }[];
                                    releaseId: string;
                                    /** @enum {string} */
                                    state: "ready" | "warnings" | "blocked";
                                } | null;
                                /** Format: date-time */
                                lastActivityAt: string | null;
                                preview: {
                                    /** Format: date-time */
                                    occurredAt: string | null;
                                    /** @enum {string} */
                                    status: "not_started" | "starting" | "ready" | "failed";
                                };
                                production: {
                                    /** Format: date-time */
                                    occurredAt: string | null;
                                    releaseId: string | null;
                                    /** @enum {string} */
                                    status: "not_deployed" | "deploying" | "healthy" | "failed";
                                };
                                projectId: string;
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
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                build: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                commit_sha: string;
                                criteria: {
                                    criterionId: string;
                                    evidenceArtifactIds: string[];
                                    /** @enum {string} */
                                    result: "passed" | "failed" | "unverified" | "waived";
                                    specificationVersion: number;
                                    taskIds: string[];
                                    testCaseIds: string[];
                                    verifierComments: string[];
                                }[];
                                known_risks: {
                                    detail: string;
                                    id: string;
                                }[];
                                migration: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                preview: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                release_id: string;
                                rollback: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                security: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                specification_version: number;
                                tests: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
                                };
                                typecheck: {
                                    gates: ({
                                        /** @enum {string} */
                                        class: "required" | "best_effort" | "if_available" | "required_or_explicit_waiver" | "project_policy" | "existing_only" | "required_for_critical_logic" | "as_applicable" | "required_for_managed_integrations" | "optional" | "if_applicable" | "required_for_managed_auth" | "no" | "advisory" | "required_policy" | "required_for_code" | "required_for_supported_release_state" | "recommended";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                        waiver?: {
                                            actorId: string;
                                            /** Format: date-time */
                                            createdAt: string;
                                            /** @enum {string} */
                                            gateId: "dev_server_start" | "production_build" | "typecheck" | "lint" | "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" | "authorization_tests" | "migration_validation" | "secret_scan" | "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check";
                                            reason: string;
                                        };
                                    } | {
                                        /** @enum {string} */
                                        class: "support_level_policy";
                                        evidenceArtifactIds: string[];
                                        /** @enum {string} */
                                        gateId: "accessibility";
                                        /** @enum {string} */
                                        status: "passed" | "failed" | "waived" | "not_applicable";
                                    })[];
                                    /** @enum {string} */
                                    status: "passed" | "failed" | "waived" | "not_applicable";
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
    "/v1/releases/{releaseId}/fork": {
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
                        /** @default false */
                        startFixRun?: boolean;
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
                            fork: {
                                branchId: string;
                                branchName: string;
                                fixRunId: string | null;
                                releaseId: string;
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
                                planMaxCredits: string;
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
    "/v1/runs/{runId}/approvals/{approvalId}": {
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
                    approvalId: string;
                    runId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        decision: "approved" | "rejected";
                        /**
                         * @default budget_increase
                         * @enum {string}
                         */
                        kind?: "budget_increase";
                        reason?: string;
                    } | {
                        /** @enum {string} */
                        decision: "approved" | "rejected";
                        /** @enum {string} */
                        kind: "specification" | "plan" | "plan_diff" | "migration" | "deploy";
                        reason?: string;
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
                            approval: {
                                absoluteCeiling: string;
                                approvalId: string;
                                /** @enum {string} */
                                kind: "budget_increase";
                                /** @enum {string} */
                                status: "approved" | "rejected";
                            };
                        } | {
                            approval: {
                                approvalId: string;
                                /** @enum {string} */
                                kind: "specification" | "plan" | "plan_diff" | "migration" | "deploy";
                                /** @enum {string} */
                                status: "approved" | "rejected";
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
    "/v1/runs/{runId}/artifacts/{artifactId}": {
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
                    artifactId: string;
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
                            artifact: {
                                byteSize: number;
                                content: string;
                                contentHash: string;
                                contentType: string;
                                /** @enum {string} */
                                encoding: "utf8" | "base64";
                                id: string;
                                type: string;
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
                                planMaxCredits: string;
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
    "/v1/runs/{runId}/conversation-responses": {
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
                        answers: {
                            answer: string;
                            questionId: string;
                        }[];
                        cardId: string;
                        /** @enum {string} */
                        kind: "question_answers";
                        /** @enum {number} */
                        version: 1;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            operationKey: string;
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
                            type: "run.created" | "run.started" | "run.paused" | "run.resumed" | "run.cancelled" | "run.completed" | "phase.created" | "phase.started" | "phase.completed" | "task.created" | "task.started" | "task.blocked" | "task.updated" | "task.completed" | "task.failed" | "agent.started" | "agent.completed" | "message.user" | "message.assistant" | "conversation.card" | "conversation.response" | "tool.started" | "tool.output" | "tool.completed" | "tool.failed" | "approval.requested" | "approval.resolved" | "artifact.created" | "commit.created" | "test.started" | "test.completed" | "verification.completed" | "preview.starting" | "preview.ready" | "preview.failed" | "release.created" | "deployment.updated" | "usage.recorded";
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
    "/v1/runs/{runId}/messages": {
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
                        /** @default [] */
                        attachments?: {
                            attachmentId: string;
                            byteSize: number;
                            /** @enum {string} */
                            contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
                            /** @enum {string} */
                            kind: "image";
                            name: string;
                        }[];
                        content: string;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            messageId: string;
                            sequence: number;
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
                            actions: {
                                retryFailedTasks: {
                                    eligible: boolean;
                                    /** @enum {string} */
                                    reason: "eligible" | "run_not_active" | "mode_unsupported" | "task_not_found" | "task_not_failed" | "dependencies_unsatisfied";
                                    taskId: string;
                                }[];
                                skipOptionalPhases: {
                                    eligible: boolean;
                                    phaseId: string;
                                    /** @enum {string} */
                                    reason: "eligible" | "run_not_active" | "mode_unsupported" | "phase_not_found" | "phase_required" | "phase_task_started" | "phase_already_skipped";
                                }[];
                            };
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
                                planMaxCredits: string;
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
                                planMaxCredits: string;
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
    "/v1/runs/{runId}/phases/{phaseId}/skip": {
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
                    phaseId: string;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            operationKey: string;
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
    "/v1/runs/{runId}/plans/{artifactId}": {
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
                    artifactId: string;
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
                            plan: {
                                approvalId: string;
                                /** @enum {string} */
                                approvalKind: "plan" | "plan_diff";
                                artifactId: string;
                                phaseCount: number;
                                phases: {
                                    acceptanceCriteria: string[];
                                    id: string;
                                    optional: boolean;
                                    sequence: number;
                                    status: string;
                                    title: string;
                                }[];
                                taskCount: number;
                                tasks: {
                                    acceptanceCriteria: string[];
                                    assignedAgentRole: string | null;
                                    dependencies: string[];
                                    id: string;
                                    phaseId: string;
                                    /** @enum {string} */
                                    riskLevel: "low" | "medium" | "high";
                                    status: string;
                                    title: string;
                                }[];
                                truncated: boolean;
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
                                planMaxCredits: string;
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
                                planMaxCredits: string;
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
    "/v1/runs/{runId}/specifications/{specificationId}": {
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
                    specificationId: string;
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
        patch?: never;
        trace?: never;
    };
    "/v1/runs/{runId}/tasks/{taskId}/retry": {
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
                    taskId: string;
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
                            operationKey: string;
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
    "/v1/usage/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    from: string;
                    to: string;
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
                            credits: {
                                available: string;
                                reserved: string;
                                /** @enum {string} */
                                source: "wallet" | "cache" | "grace";
                                wallet: string;
                            };
                            usage: {
                                byCategory: {
                                    /** @enum {string} */
                                    category: "model_input_tokens" | "model_output_tokens" | "model_cached_tokens" | "sandbox_cpu_seconds" | "sandbox_mem_gib_seconds" | "storage_gib_hours" | "deploy_provider" | "artifact_storage" | "credit_grant";
                                    credits: string;
                                }[];
                                byProject: {
                                    credits: string;
                                    projectId: string | null;
                                }[];
                                byRun: {
                                    credits: string;
                                    runId: string | null;
                                }[];
                            };
                            window: {
                                /** Format: date-time */
                                from: string;
                                /** Format: date-time */
                                to: string;
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
    "/v1/webhooks/github": {
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
                header: {
                    "x-github-delivery": string;
                    "x-github-event": string;
                    "x-hub-signature-256"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": unknown;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            accepted: true;
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
    "/v1/webhooks/grafana": {
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
                        alerts: ({
                            annotations: {
                                error_payload: string;
                                /** Format: uri */
                                logs_url?: string;
                                repro_route: string;
                                summary: string;
                                /** Format: uri */
                                trace_url?: string;
                            } & {
                                [key: string]: unknown;
                            };
                            fingerprint: string;
                            labels: {
                                organization_id: string;
                                project_id: string;
                                release_id: string;
                                /** @enum {string} */
                                source: "grafana_faro" | "grafana_loki";
                            } & {
                                [key: string]: unknown;
                            };
                            /** @enum {string} */
                            status: "firing" | "resolved";
                        } & {
                            [key: string]: unknown;
                        })[];
                        /** @enum {string} */
                        status: "firing" | "resolved";
                    } & {
                        [key: string]: unknown;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accepted: number;
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
    "/v1/webhooks/stripe": {
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
                header?: {
                    "stripe-signature"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": unknown;
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
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            accepted: true;
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
    "/v1/workspaces/{workspaceId}/dev-server/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    after?: number;
                    limit?: number;
                };
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
                            entries: {
                                /** Format: date-time */
                                at: string;
                                cursor: number;
                                message: string;
                                /** @enum {string} */
                                stream: "stdout" | "stderr";
                            }[];
                            failureId: string | null;
                            nextCursor: number;
                            /** @enum {string} */
                            state: "idle" | "starting" | "ready" | "restarting" | "failed";
                            truncated: boolean;
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
    "/v1/workspaces/{workspaceId}/dev-server/restart": {
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
                header: {
                    "idempotency-key": string;
                };
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
                            /** @enum {string} */
                            ownership: "process" | "process_group";
                            pid: number;
                            port: number;
                            supervisorId: string;
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
    "/v1/workspaces/{workspaceId}/preview/events": {
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
                        "text/event-stream": {
                            payload: {
                                /** @enum {string} */
                                level: "log" | "warn" | "error";
                                message: string;
                                stack: string;
                            };
                            /** @enum {string} */
                            type: "console";
                        } | {
                            payload: {
                                durationMs: number;
                                method: string;
                                status: number;
                                /** @enum {string} */
                                transport: "fetch" | "xhr";
                                /** Format: uri */
                                url: string;
                            };
                            /** @enum {string} */
                            type: "network";
                        } | {
                            payload: {
                                /** Format: uri */
                                url: string;
                            };
                            /** @enum {string} */
                            type: "route_change";
                        } | {
                            payload: {
                                message: string;
                                stack: string;
                            };
                            /** @enum {string} */
                            type: "runtime_error";
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
    "/v1/workspaces/{workspaceId}/preview/screenshot": {
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
                header: {
                    "idempotency-key": string;
                };
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
                        "image/png": string;
                    };
                };
                /** @description Default Response */
                501: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                503: {
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
