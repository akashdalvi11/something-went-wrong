import {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Failure-injection scenarios (DESIGN.md §5), each behind a toggle.
// Defaults come from env (CHAOS_*); flippable at runtime via /admin/chaos.
// In-memory on purpose: a restart resets to env defaults, which is what a
// demo wants.

export type ChaosScenario = "promo_crash" | "payment_timeout" | "inventory_race"

const fromEnv = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v === "true" || v === "1"

export const chaosFlags: Record<ChaosScenario, boolean> = {
  // harmless unless the magic code is applied, so on by default
  promo_crash: fromEnv(process.env.CHAOS_PROMO_CRASH, true),
  payment_timeout: fromEnv(process.env.CHAOS_PAYMENT_TIMEOUT, false),
  inventory_race: fromEnv(process.env.CHAOS_INVENTORY_RACE, false),
}

// Set by a scenario middleware when it fires, read by the error handler to
// tag the incident row. Keyed nowhere — a request that crashes is answered
// before the next scenario can fire, and this is a single-demo prototype.
export function markScenario(req: MedusaRequest, scenario: ChaosScenario) {
  ;(req as any).chaos_scenario = scenario
}

export function activeScenario(req: MedusaRequest): ChaosScenario | undefined {
  return (req as any).chaos_scenario
}

const PROMO_CRASH_CODE = "SAVE-NULL"

// Scenario 1 — promo code crash (fault: BOTH).
// A "custom promo handler" that looks up extra promo config which doesn't
// exist for SAVE-NULL and dereferences it: a genuine, unhandled TypeError
// with a real stack, thrown synchronously so Express routes it to the
// error handler. Matched on POST /store/carts/:id — the storefront applies
// promo codes via cart update ({ promo_codes }).
const customPromoConfig = new Map<string, { rules: string[] }>([
  ["WELCOME10", { rules: ["min_subtotal:0"] }],
])

export function promoCrashMiddleware(
  req: MedusaRequest<{ promo_codes?: string[] }>,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const codes = req.body?.promo_codes
  if (!chaosFlags.promo_crash || !codes?.includes(PROMO_CRASH_CODE)) {
    return next()
  }
  markScenario(req, "promo_crash")
  const config = customPromoConfig.get(PROMO_CRASH_CODE)
  // config is undefined — the bug scenario 1 exists to demonstrate
  req.scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(`applying custom promo ${PROMO_CRASH_CODE} with ${config!.rules.length} rules`)
  next()
}

// Scenario 2 — payment provider timeout (fault: SYSTEM).
// Simulates the PSP client: the provider hangs past our 3s client timeout,
// the client gives up and surfaces a timeout error. next(err) because
// Express 4 does not route rejected async middlewares to the error handler.
const PAYMENT_CLIENT_TIMEOUT_MS = 3_000

export function paymentTimeoutMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (!chaosFlags.payment_timeout) {
    return next()
  }
  markScenario(req, "payment_timeout")
  setTimeout(() => {
    const err = new Error(
      `Payment provider did not respond within ${PAYMENT_CLIENT_TIMEOUT_MS}ms ` +
        `(provider: fakepay, operation: createPaymentSession). No charge was made.`
    )
    err.name = "PaymentProviderTimeoutError"
    next(err)
  }, PAYMENT_CLIENT_TIMEOUT_MS)
}

// Scenario 3 — inventory race (fault: SYSTEM/state).
// Simulates a concurrent buyer taking the last unit between cart and
// checkout: zero the stock of everything in this cart right before the
// completion workflow runs, then let Medusa's own inventory confirmation
// fail naturally (real workflow, real trace). The error handler escalates
// that failure to an incident while the flag is on.
export async function inventoryRaceMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (!chaosFlags.inventory_race) {
    return next()
  }
  markScenario(req, "inventory_race")
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
    const inventoryService = req.scope.resolve(Modules.INVENTORY)
    const {
      data: [cart],
    } = await query.graph({
      entity: "cart",
      fields: ["items.variant.inventory_items.inventory.id"],
      filters: { id: req.params.id },
    })
    const inventoryItemIds = [
      ...new Set(
        (cart?.items ?? [])
          .flatMap((item: any) => item?.variant?.inventory_items ?? [])
          .map((link: any) => link?.inventory?.id)
          .filter(Boolean)
      ),
    ] as string[]
    if (inventoryItemIds.length) {
      const levels = await inventoryService.listInventoryLevels({
        inventory_item_id: inventoryItemIds,
      })
      await inventoryService.updateInventoryLevels(
        levels.map((level) => ({
          inventory_item_id: level.inventory_item_id,
          location_id: level.location_id,
          stocked_quantity: 0,
        }))
      )
    }
  } catch (e) {
    // chaos must never break checkout by accident — only deliberately
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`inventory_race injection failed, passing through: ${e}`)
  }
  next()
}
