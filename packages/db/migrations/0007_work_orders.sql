CREATE TABLE "synced_action" (
	"client_action_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"type" text DEFAULT 'service' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"scheduled_date" date,
	"scheduled_window" text,
	"estimated_minutes" integer,
	"sequence" integer,
	"assigned_user_id" uuid,
	"summary" text,
	"instructions" text,
	"en_route_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"work_performed" text,
	"incomplete_reason" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_ping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"lat" numeric(10, 7),
	"lng" numeric(10, 7),
	"accuracy_meters" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "work_order_id" uuid;
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "client_action_id" uuid;
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "uploaded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "synced_action" ADD CONSTRAINT "synced_action_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_assigned_user_id_app_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order_ping" ADD CONSTRAINT "work_order_ping_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_order"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order_ping" ADD CONSTRAINT "work_order_ping_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "work_order_task" ADD CONSTRAINT "work_order_task_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_order"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "synced_action_user_idx" ON "synced_action" USING btree ("user_id","applied_at");
--> statement-breakpoint
CREATE INDEX "work_order_assignee_date_idx" ON "work_order" USING btree ("assigned_user_id","scheduled_date","sequence");
--> statement-breakpoint
CREATE INDEX "work_order_date_status_idx" ON "work_order" USING btree ("scheduled_date","status");
--> statement-breakpoint
CREATE INDEX "work_order_customer_idx" ON "work_order" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "work_order_property_idx" ON "work_order" USING btree ("property_id");
--> statement-breakpoint
CREATE INDEX "work_order_ping_job_idx" ON "work_order_ping" USING btree ("work_order_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "work_order_task_job_idx" ON "work_order_task" USING btree ("work_order_id","sequence");
--> statement-breakpoint
-- attachment.work_order_id is declared without a reference in the schema to
-- avoid a circular import between the timeline and work modules. The constraint
-- itself still belongs in the database.
ALTER TABLE attachment
  ADD CONSTRAINT attachment_work_order_fk
  FOREIGN KEY (work_order_id) REFERENCES work_order(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX attachment_work_order_idx ON attachment (work_order_id);
--> statement-breakpoint
-- A photo taken offline carries a client-generated id. Networks fail halfway
-- and the device retries, so this is what makes the second attempt land once.
CREATE UNIQUE INDEX attachment_client_action_idx ON attachment (client_action_id)
  WHERE client_action_id IS NOT NULL;
