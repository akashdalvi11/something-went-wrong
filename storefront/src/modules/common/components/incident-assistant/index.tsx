"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// The persistent explanation chatbot (DESIGN.md §3.5, reworked): the app
// itself shows only a traditional "something went wrong" inline. This widget
// — mounted once in the root layout so it survives navigation — pops up when
// an incident occurs (via the `sww:incident` window event), calms the user,
// then streams in the agent's preliminary and confirmed explanations as chat
// bubbles. Conversation state lives in sessionStorage so a reload or screen
// change doesn't lose it.

type Fault = "USER" | "SYSTEM" | "BOTH" | "UNKNOWN"

type Explanation = {
  status: "pending" | "preliminary" | "confirmed"
  fault: Fault | null
  user_message: string | null
}

type ChatMessage = {
  key: string
  text: string
  fault?: Fault
  tag?: "first look" | "confirmed"
}

type AssistantState = {
  incidentId: string
  startedAt: number
  messages: ChatMessage[]
  done: boolean
}

const STORAGE_KEY = "sww-assistant"
const POLL_INTERVAL_MS = 2_000
const POLL_BUDGET_MS = 3 * 60_000

const INTRO_MESSAGE =
  "Hi — I noticed something just went wrong. I'm sorry about that. " +
  "I'm already looking into what happened and I'll explain it here in a " +
  "moment. You can keep browsing — I'll stay in this corner."

const TIMEOUT_MESSAGE =
  "This one is taking longer than usual to pin down. It's safe to retry or " +
  "keep shopping — if I find the cause, support will have the full story."

const FAULT_LABELS: Record<Fault, { label: string; className: string }> = {
  SYSTEM: { label: "This was on us", className: "bg-rose-100 text-rose-700" },
  BOTH: { label: "Partly on us", className: "bg-amber-100 text-amber-700" },
  USER: { label: "Action needed on your side", className: "bg-blue-100 text-blue-700" },
  UNKNOWN: { label: "Still investigating", className: "bg-grey-10 text-grey-60" },
}

const loadState = (): AssistantState | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as AssistantState) : null
  } catch {
    return null
  }
}

const ChatBubble = ({ message }: { message: ChatMessage }) => {
  const fault = message.fault ? FAULT_LABELS[message.fault] : null
  return (
    <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-grey-5 px-3 py-2">
      {(fault || message.tag) && (
        <div className="flex items-center gap-x-2 pb-1">
          {fault && (
            <span
              className={`px-2 py-0.5 rounded-full text-xsmall-regular ${fault.className}`}
            >
              {fault.label}
            </span>
          )}
          {message.tag && (
            <span className="text-xsmall-regular text-ui-fg-muted">
              {message.tag === "confirmed" ? "✓ confirmed" : "first look"}
            </span>
          )}
        </div>
      )}
      <p className="text-small-regular text-ui-fg-base">{message.text}</p>
    </div>
  )
}

const TypingIndicator = () => (
  <div className="flex w-fit items-center gap-x-1 rounded-2xl rounded-bl-sm bg-grey-5 px-3 py-2.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-ui-fg-muted"
        style={{ animationDelay: `${i * 150}ms` }}
      />
    ))}
  </div>
)

const IncidentAssistant = () => {
  const [state, setState] = useState<AssistantState | null>(null)
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const bodyRef = useRef<HTMLDivElement>(null)

  // restore a conversation from this tab's session (reloads, screen changes)
  useEffect(() => {
    const saved = loadState()
    if (saved) {
      setState(saved)
    }
  }, [])

  useEffect(() => {
    if (state) {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // best-effort persistence
      }
    }
  }, [state])

  useEffect(() => {
    const onIncident = (e: Event) => {
      const incidentId = (e as CustomEvent).detail?.incidentId as
        | string
        | undefined
      if (!incidentId) {
        return
      }
      setState((prev) => {
        if (prev?.incidentId === incidentId) {
          return prev
        }
        return {
          incidentId,
          startedAt: Date.now(),
          messages: [{ key: `${incidentId}-intro`, text: INTRO_MESSAGE }],
          done: false,
        }
      })
      setOpen(true)
      setUnread(false)
    }
    window.addEventListener("sww:incident", onIncident)
    return () => window.removeEventListener("sww:incident", onIncident)
  }, [])

  const appendMessage = useCallback(
    (message: ChatMessage, done?: boolean) => {
      setState((prev) =>
        prev
          ? {
              ...prev,
              messages: [...prev.messages, message],
              done: done ?? prev.done,
            }
          : prev
      )
      if (!openRef.current) {
        setUnread(true)
      }
    },
    []
  )

  const incidentId = state?.incidentId
  const startedAt = state?.startedAt
  const done = state?.done

  useEffect(() => {
    if (!incidentId || !startedAt || done) {
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // after a reload the preliminary bubble may already be in the history
    let seenPreliminary =
      loadState()?.messages.some((m) => m.tag === "first look") ?? false

    const poll = async () => {
      try {
        const res = await fetch(`/api/explanations/${incidentId}`)
        if (res.ok) {
          const data: Explanation = await res.json()
          if (cancelled) {
            return
          }
          if (
            data.status === "preliminary" &&
            !seenPreliminary &&
            data.user_message
          ) {
            seenPreliminary = true
            appendMessage({
              key: `${incidentId}-preliminary`,
              text: data.user_message,
              fault: data.fault ?? "UNKNOWN",
              tag: "first look",
            })
          }
          if (data.status === "confirmed" && data.user_message) {
            appendMessage(
              {
                key: `${incidentId}-confirmed`,
                text: data.user_message,
                fault: data.fault ?? "UNKNOWN",
                tag: "confirmed",
              },
              true
            )
            return
          }
        }
      } catch {
        // polling is best-effort; the intro message stands
      }
      if (cancelled) {
        return
      }
      if (Date.now() - startedAt >= POLL_BUDGET_MS) {
        appendMessage(
          { key: `${incidentId}-timeout`, text: TIMEOUT_MESSAGE },
          true
        )
        return
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [incidentId, startedAt, done, appendMessage])

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [open, state?.messages.length])

  if (!state) {
    return null
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setOpen(true)
          setUnread(false)
        }}
        aria-label="Open store assistant"
        data-testid="incident-assistant-launcher"
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-ui-fg-base text-ui-bg-base shadow-lg transition-transform hover:scale-105"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        {unread && (
          <span className="absolute right-0 top-0 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-white" />
        )}
      </button>
    )
  }

  return (
    <div
      data-testid="incident-assistant"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-ui-border-base bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-ui-border-base px-4 py-3">
        <div className="flex items-center gap-x-2">
          <span
            className={`h-2 w-2 rounded-full ${
              state.done ? "bg-green-500" : "animate-pulse bg-amber-400"
            }`}
          />
          <div>
            <p className="text-small-semi text-ui-fg-base">Store assistant</p>
            <p className="text-xsmall-regular text-ui-fg-muted">
              {state.done ? "Explanation ready" : "Looking into what happened…"}
            </p>
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Minimize store assistant"
          className="rounded p-1 text-ui-fg-muted hover:bg-grey-5 hover:text-ui-fg-base"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <div
        ref={bodyRef}
        className="flex max-h-[55vh] min-h-[120px] flex-col gap-y-3 overflow-y-auto p-4"
      >
        {state.messages.map((message) => (
          <ChatBubble key={message.key} message={message} />
        ))}
        {!state.done && <TypingIndicator />}
      </div>
      <p className="border-t border-ui-border-base px-4 py-2 text-xsmall-regular text-ui-fg-muted">
        Automated explanation, based on what our systems recorded.
      </p>
    </div>
  )
}

export default IncidentAssistant
