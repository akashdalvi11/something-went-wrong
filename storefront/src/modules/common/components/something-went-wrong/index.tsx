"use client"

import { useEffect, useRef, useState } from "react"

// The reusable error explanation (DESIGN.md §3.5): shows a calm holding
// message immediately, polls the explanation, renders the preliminary
// message within seconds and quietly upgrades it when the confirmed verdict
// lands. Fault classification is visually distinct: "this was on us" vs
// "check your input".

type Explanation = {
  status: "pending" | "preliminary" | "confirmed"
  fault: "USER" | "SYSTEM" | "BOTH" | "UNKNOWN" | null
  user_message: string | null
}

const HOLDING_MESSAGE =
  "Something went wrong. We're looking into what happened — this usually takes a few seconds."

const POLL_INTERVAL_MS = 3_000
const POLL_BUDGET_MS = 3 * 60_000

const FAULT_LABELS: Record<string, { label: string; className: string }> = {
  SYSTEM: { label: "This was on us", className: "bg-rose-100 text-rose-700" },
  BOTH: { label: "Partly on us — see below", className: "bg-amber-100 text-amber-700" },
  USER: { label: "Action needed on your side", className: "bg-blue-100 text-blue-700" },
  UNKNOWN: { label: "Still investigating", className: "bg-grey-10 text-grey-60" },
}

const SomethingWentWrong = ({ incidentId }: { incidentId: string }) => {
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const startedAt = useRef(Date.now())

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const res = await fetch(`/api/explanations/${incidentId}`)
        if (res.ok) {
          const data: Explanation = await res.json()
          if (!cancelled) {
            setExplanation(data)
          }
          if (data.status === "confirmed") {
            return
          }
        }
      } catch {
        // polling is best-effort; the holding message stands
      }
      if (!cancelled && Date.now() - startedAt.current < POLL_BUDGET_MS) {
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [incidentId])

  const message = explanation?.user_message || HOLDING_MESSAGE
  const fault = explanation?.fault ? FAULT_LABELS[explanation.fault] : null
  const confirmed = explanation?.status === "confirmed"

  return (
    <div
      className="pt-2 text-small-regular"
      data-testid="something-went-wrong"
      aria-live="polite"
    >
      <div className="flex items-center gap-x-2 pb-1">
        {fault && (
          <span className={`px-2 py-0.5 rounded-full text-xsmall-regular ${fault.className}`}>
            {fault.label}
          </span>
        )}
        <span className="text-xsmall-regular text-ui-fg-muted">
          {confirmed ? "✓ confirmed" : "checking…"}
        </span>
      </div>
      <p className="text-ui-fg-base">{message}</p>
    </div>
  )
}

export default SomethingWentWrong
