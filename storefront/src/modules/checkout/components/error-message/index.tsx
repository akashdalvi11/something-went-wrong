"use client"

import { useEffect } from "react"

// Backend 5xx error messages carry an [incident:inc_…] marker (the js-sdk
// only surfaces the message string). The inline error stays traditional and
// generic — the marker is stripped, never shown — while the incident id is
// handed to the persistent IncidentAssistant chatbot via a window event.
const INCIDENT_MARKER = /\[incident:(inc_[0-9a-f-]+)\]/

const GENERIC_ERROR = "Something went wrong. Please try again."

const ErrorMessage = ({ error, 'data-testid': dataTestid }: { error?: string | null, 'data-testid'?: string }) => {
  const incidentId = error?.match(INCIDENT_MARKER)?.[1]

  useEffect(() => {
    if (incidentId) {
      window.dispatchEvent(
        new CustomEvent("sww:incident", { detail: { incidentId } })
      )
    }
  }, [incidentId])

  if (!error) {
    return null
  }

  return (
    <div className="pt-2 text-rose-500 text-small-regular" data-testid={dataTestid}>
      <span>{incidentId ? GENERIC_ERROR : error}</span>
    </div>
  )
}

export default ErrorMessage
