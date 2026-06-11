import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // Explicit ssl:false — Medusa assumes SSL for any non-localhost DB host
    // (e.g. Docker service names), and the ssl_mode=disable URL param gets
    // stripped before module migrations can see it.
    databaseDriverOptions: { connection: { ssl: false } },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    }
  },
  modules: [
    { resolve: "./src/modules/incident" },
  ],
})
