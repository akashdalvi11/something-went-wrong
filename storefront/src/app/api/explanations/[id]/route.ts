import { NextRequest, NextResponse } from "next/server"

// Server-side proxy for the incident explanation poll: the client component
// can't talk to Medusa directly (publishable key + backend URL live on the
// server). Safe fields only pass through.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!/^inc_[0-9a-f-]+$/.test(id)) {
    return NextResponse.json({ message: "invalid incident id" }, { status: 400 })
  }

  const backendUrl = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
  const res = await fetch(`${backendUrl}/store/explanations/${id}`, {
    headers: {
      "x-publishable-api-key": process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY!,
    },
    cache: "no-store",
  })
  if (!res.ok) {
    return NextResponse.json({ message: "not found" }, { status: res.status })
  }
  const data = await res.json()
  return NextResponse.json({
    incident_id: data.incident_id,
    status: data.status,
    fault: data.fault,
    user_message: data.user_message,
  })
}
