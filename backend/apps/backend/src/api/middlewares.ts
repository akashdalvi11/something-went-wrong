import { defineMiddlewares } from "@medusajs/framework/http"
import {
  inventoryRaceMiddleware,
  paymentTimeoutMiddleware,
  promoCrashMiddleware,
} from "../lib/chaos"
import { incidentErrorHandler } from "../lib/incident-error-handler"

export default defineMiddlewares({
  errorHandler: incidentErrorHandler,
  routes: [
    {
      // the storefront applies promo codes via cart update ({ promo_codes })
      matcher: "/store/carts/:id",
      method: ["POST"],
      middlewares: [promoCrashMiddleware],
    },
    {
      matcher: "/store/payment-collections/:id/payment-sessions",
      method: ["POST"],
      middlewares: [paymentTimeoutMiddleware],
    },
    {
      matcher: "/store/carts/:id/complete",
      method: ["POST"],
      middlewares: [inventoryRaceMiddleware],
    },
  ],
})
