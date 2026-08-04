import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type PromptCall = { sid: string; body: string; agent?: string }

function createMockContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages?: Record<string, Array<any>>
    statusMap?: Record<string, { type: string }>
    throwOnMessages?: boolean
    throwOnStatus?: boolean
    throwOnAbort?: boolean
    throwOnList?: boolean
    throwOnPrompt?: boolean
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []

    const defaultStatusMap: Record<string, { type: string }> = {}
    for (const s of opts.sessions) {
        defaultStatusMap[s.id] = { type: s.status }
    }
    const statusMap = opts.statusMap ?? defaultStatusMap
    const messages = opts.messages ?? {}

    const unexpectedErr = () => {
        throw new Error("Unexpected server error. Check server logs for details.")
    }

    const ctx = {
        client: {
            app: { log: mock(async (_o: any) => {}) },
            session: {
                list: mock(async () => {
                    if (opts.throwOnList) unexpectedErr()
                    return {
                        data: opts.sessions.map((s) => ({
                            id: s.id,
                            projectID: "proj-1",
                            directory: "/test",
                            title: s.id,
                            version: "1.0.0",
                            time: { created: Date.now(), updated: Date.now() },
                        })),
                    }
                }),
                status: mock(async () => {
                    if (opts.throwOnStatus) unexpectedErr()
                    return { data: statusMap }
                }),
                messages: mock(async (config: { path: { id: string } }) => {
                    if (opts.throwOnMessages) unexpectedErr()
                    return messages[config.path.id] ?? []
                }),
                prompt: mock(async (config: any) => {
                    if (opts.throwOnPrompt) unexpectedErr()
                    promptCalls.push({
                        sid: config.path.id,
                        body: config.body.parts.map((p: any) => p.text).join(""),
                        agent: config.agent,
                    })
                    return {}
                }),
                abort: mock(async (config: { path: { id: string } }) => {
                    if (opts.throwOnAbort) unexpectedErr()
                    abortCalls.push({ sid: config.path.id })
                    return {}
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any

    return { ctx, promptCalls, abortCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const OPTS = { enabled: true, baseBackoffMs: 1, checkIntervalMs: 50 }

describe("unhandled-rejection guards (regression for plugin host crash)", () => {
    test("REGRESSION: event() promise must NOT reject when session.messages throws inside handleEvent's idle path", async () => {
        const { ctx, promptCalls } = createMockContext({
            sessions: [{ id: "ses_RECURR1", status: "idle" }],
            messages: {
                ses_RECURR1: [
                    { role: "user", parts: [{ type: "text", text: "do work" }] },
                    {
                        role: "assistant",
                        parts: [{ type: "text", text: "I will do it" }],
                        // no error: streaming-failure block is skipped, idle falls
                        // through to the unprotected lastAssistantEndsWithCelebration path
                    },
                ],
            },
            statusMap: { ses_RECURR1: { type: "idle" } },
        })

        const hooks = await AutoResumePlugin(ctx, {
            ...OPTS,
            resumeOnActionIntent: true,
            toolTextCheckDelayMs: 1,
            warmupMs: 0,
        } as any)

        let rejected = false
        let rejectionMsg: string | undefined
        const onUnhandled = (reason: unknown) => {
            rejected = true
            rejectionMsg = reason instanceof Error ? reason.message : String(reason)
        }
        process.on("unhandledRejection", onUnhandled)

        try {
            await hooks.event({
                event: {
                    type: "session.status",
                    sessionID: "ses_RECURR1",
                    properties: { status: "idle" },
                },
            })

            const msgThrow = createMockContext({
                sessions: [{ id: "ses_RECURR1", status: "idle" }],
                throwOnMessages: true,
            })
            ;(ctx.client.session.messages as any).mockImplementation(
                (msgThrow.ctx as any).client.session.messages.mock.calls
                    ? async () => { throw new Error("Unexpected server error") }
                    : async () => [],
            )
            ;(ctx.client.session.messages as any).mockImplementation(
                async () => { throw new Error("Unexpected server error") },
            )

            await wait(800)

            expect(rejected).toBe(false)
            if (rejected) {
                throw new Error(`REGRESSION broken: leaked rejection: ${rejectionMsg}`)
            }
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
        void promptCalls
    })

    test("REGRESSION: safe() helper catches SDK errors and returns undefined", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_safe1", status: "busy" }],
            throwOnStatus: true,
        })

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            await AutoResumePlugin(ctx, {
                ...OPTS,
                checkIntervalMs: 30,
                subagentWaitMs: 1,
                gracePeriodMs: 1,
            } as any)
            await wait(500)
            expect(leaked).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })

    test("REGRESSION: log() never rethrows when logging backend is down", async () => {
        const ctx = {
            client: {
                app: {
                    log: mock(async () => {
                        throw new Error("logging backend down")
                    }),
                },
                session: {
                    list: mock(async () => ({ data: [] })),
                    status: mock(async () => ({ data: {} })),
                    messages: mock(async () => []),
                    prompt: mock(async () => ({})),
                    abort: mock(async () => ({})),
                },
            },
            ui: { toast: mock(async () => {}) },
        } as any

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            const hooks = await AutoResumePlugin(ctx, OPTS as any)
            await hooks.event({
                event: {
                    type: "session.status",
                    sessionID: "ses_logfail",
                    properties: { status: "idle" },
                },
            })
            await wait(250)
            expect(leaked).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })

    test("REGRESSION: event() fire-and-forget handleEvent call must be wrapped (leaked rejection impossible from SDK throws)", async () => {
        const { ctx } = createMockContext({
            sessions: [{ id: "ses_wrap1", status: "busy" }],
            throwOnAbort: true,
            throwOnMessages: true,
        })

        let leaked = false
        const onUnhandled = () => { leaked = true }
        process.on("unhandledRejection", onUnhandled)

        try {
            const hooks = await AutoResumePlugin(ctx, {
                ...OPTS,
                checkIntervalMs: 30,
                subagentWaitMs: 1,
                gracePeriodMs: 1,
                chunkTimeoutMs: 1,
            } as any)

            await hooks.event({
                event: {
                    type: "session.status",
                    sessionID: "ses_wrap1",
                    properties: { status: "busy" },
                },
            })
            await hooks["tool.execute.before"]!({ sessionID: "ses_wrap1" } as any)
            await wait(500)

            expect(leaked).toBe(false)
        } finally {
            process.removeListener("unhandledRejection", onUnhandled)
        }
    })
})
