CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"mode" text NOT NULL,
	"entity" text,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"watermark" text,
	"notes" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "import_issue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"legacy_id" text,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_row" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"source" text NOT NULL,
	"entity" text NOT NULL,
	"legacy_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line1" text,
	"line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"lat" numeric(10, 7),
	"lng" numeric(10, 7),
	"raw_input" text,
	"validated_at" timestamp with time zone,
	"validation_source" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"role" text,
	"phone" text,
	"mobile" text,
	"email" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"notes" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_number" text,
	"kind" text DEFAULT 'residential' NOT NULL,
	"company_name" text,
	"first_name" text,
	"last_name" text,
	"display_name" text DEFAULT '' NOT NULL,
	"primary_phone" text,
	"primary_email" text,
	"billing_address_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_customer_id" uuid,
	"customer_since" date,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_exempt_id" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"reason" text,
	"merged_snapshot" jsonb,
	"merged_by" text,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid,
	"label" text,
	"property_type" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"access_notes" text,
	"gate_code" text,
	"pet_notes" text,
	"water_shutoff_notes" text,
	"electrical_notes" text,
	"parking_notes" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"category" text,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"installed_on" date,
	"warranty_expires_on" date,
	"sold_by_us" boolean,
	"notes" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"property_id" uuid,
	"timeline_event_id" uuid,
	"kind" text DEFAULT 'photo' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"content_hash" text,
	"captured_at" timestamp with time zone,
	"captured_lat" text,
	"captured_lng" text,
	"captured_by_user_id" uuid,
	"caption" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"direction" text,
	"actor_user_id" uuid,
	"actor_label" text,
	"title" text,
	"body" text,
	"ref_type" text,
	"ref_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"redacted_at" timestamp with time zone,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "water_test" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tested_by_user_id" uuid,
	"source" text DEFAULT 'in_store' NOT NULL,
	"free_chlorine" numeric(8, 2),
	"total_chlorine" numeric(8, 2),
	"ph" numeric(8, 2),
	"total_alkalinity" numeric(8, 2),
	"calcium_hardness" numeric(8, 2),
	"cyanuric_acid" numeric(8, 2),
	"salt" numeric(8, 2),
	"phosphates" numeric(8, 2),
	"temperature_f" numeric(8, 2),
	"recommendation" text,
	"notes" text,
	"legacy_source" text,
	"legacy_id" text,
	"import_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_issue" ADD CONSTRAINT "import_issue_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_row" ADD CONSTRAINT "legacy_row_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_billing_address_id_address_id_fk" FOREIGN KEY ("billing_address_id") REFERENCES "public"."address"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_survivor_id_customer_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge" ADD CONSTRAINT "customer_merge_merged_id_customer_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_address_id_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."address"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_equipment" ADD CONSTRAINT "property_equipment_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_timeline_event_id_timeline_event_id_fk" FOREIGN KEY ("timeline_event_id") REFERENCES "public"."timeline_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_captured_by_user_id_app_user_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_test" ADD CONSTRAINT "water_test_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_test" ADD CONSTRAINT "water_test_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_test" ADD CONSTRAINT "water_test_tested_by_user_id_app_user_id_fk" FOREIGN KEY ("tested_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_source_started_idx" ON "import_batch" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "import_issue_batch_idx" ON "import_issue" USING btree ("batch_id","severity");--> statement-breakpoint
CREATE INDEX "import_issue_code_idx" ON "import_issue" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_row_batch_key_idx" ON "legacy_row" USING btree ("batch_id","source","entity","legacy_id");--> statement-breakpoint
CREATE INDEX "legacy_row_lookup_idx" ON "legacy_row" USING btree ("source","entity","legacy_id");--> statement-breakpoint
CREATE INDEX "legacy_row_hash_idx" ON "legacy_row" USING btree ("source","entity","row_hash");--> statement-breakpoint
CREATE INDEX "address_postal_idx" ON "address" USING btree ("postal_code");--> statement-breakpoint
CREATE INDEX "address_city_state_idx" ON "address" USING btree ("city","state");--> statement-breakpoint
CREATE INDEX "contact_customer_idx" ON "contact" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contact_phone_idx" ON "contact" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "contact_email_idx" ON "contact" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_legacy_key_idx" ON "customer" USING btree ("legacy_source","legacy_id");--> statement-breakpoint
CREATE INDEX "customer_account_number_idx" ON "customer" USING btree ("account_number");--> statement-breakpoint
CREATE INDEX "customer_status_idx" ON "customer" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customer_merge_survivor_idx" ON "customer_merge" USING btree ("survivor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_merge_merged_idx" ON "customer_merge" USING btree ("merged_id");--> statement-breakpoint
CREATE INDEX "property_customer_idx" ON "property" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "property_address_idx" ON "property" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "property_equipment_property_idx" ON "property_equipment" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "property_equipment_serial_idx" ON "property_equipment" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "app_user_email_idx" ON "app_user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "attachment_property_idx" ON "attachment" USING btree ("property_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attachment_customer_idx" ON "attachment" USING btree ("customer_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attachment_event_idx" ON "attachment" USING btree ("timeline_event_id");--> statement-breakpoint
CREATE INDEX "attachment_hash_idx" ON "attachment" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "timeline_customer_occurred_idx" ON "timeline_event" USING btree ("customer_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_property_occurred_idx" ON "timeline_event" USING btree ("property_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_kind_idx" ON "timeline_event" USING btree ("kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_ref_idx" ON "timeline_event" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "water_test_customer_idx" ON "water_test" USING btree ("customer_id","tested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "water_test_property_idx" ON "water_test" USING btree ("property_id","tested_at" DESC NULLS LAST);