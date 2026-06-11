import SomethingWentWrong from "@modules/common/components/something-went-wrong"

// Backend 5xx error messages carry an [incident:inc_…] marker (the js-sdk
// only surfaces the message string). When present, render the live
// explanation component instead of the raw error.
const INCIDENT_MARKER = /\[incident:(inc_[0-9a-f-]+)\]/

const ErrorMessage = ({ error, 'data-testid': dataTestid }: { error?: string | null, 'data-testid'?: string }) => {
  if (!error) {
    return null
  }

  const incidentId = error.match(INCIDENT_MARKER)?.[1]
  if (incidentId) {
    return <SomethingWentWrong incidentId={incidentId} />
  }

  return (
    <div className="pt-2 text-rose-500 text-small-regular" data-testid={dataTestid}>
      <span>{error}</span>
    </div>
  )
}

export default ErrorMessage
