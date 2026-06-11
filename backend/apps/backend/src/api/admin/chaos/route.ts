import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { chaosFlags, ChaosScenario } from "../../../lib/chaos"

// Demo control panel: read/flip the failure-injection toggles without
// restarting. Unauthenticated on purpose — local prototype only.
export const AUTHENTICATE = false

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  res.json({ chaos: chaosFlags })
}

export const POST = async (
  req: MedusaRequest<{ scenario?: string; enabled?: boolean }>,
  res: MedusaResponse
) => {
  const { scenario, enabled } = req.body ?? {}
  if (!scenario || !(scenario in chaosFlags) || typeof enabled !== "boolean") {
    res.status(400).json({
      message: `body must be { scenario: ${Object.keys(chaosFlags).join(" | ")}, enabled: boolean }`,
    })
    return
  }
  chaosFlags[scenario as ChaosScenario] = enabled
  res.json({ chaos: chaosFlags })
}
