import { getBaseURL } from "@lib/util/env"
import IncidentAssistant from "@modules/common/components/incident-assistant"
import { Metadata } from "next"
import "styles/globals.css"

export const metadata: Metadata = {
  metadataBase: new URL(getBaseURL()),
}

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en" data-mode="light">
      <body>
        <main className="relative">{props.children}</main>
        <IncidentAssistant />
      </body>
    </html>
  )
}
