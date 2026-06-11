import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260611111835 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "incident" ("id" text not null, "trace_id" text null, "span_id" text null, "status" text check ("status" in ('pending', 'preliminary', 'confirmed')) not null default 'pending', "error_type" text null, "error_message" text null, "error_stack" text null, "route" text null, "method" text null, "scenario" text null, "request_context" jsonb null, "explanation" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "incident_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_incident_deleted_at" ON "incident" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "incident" cascade;`);
  }

}
