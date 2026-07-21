import { pgTable, serial, text, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const visitsTable = pgTable("visits", {
  id: serial("id").primaryKey(),
  ip: text("ip"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  accuracy: doublePrecision("accuracy"),
  altitude: doublePrecision("altitude"),
  country: text("country"),
  city: text("city"),
  userAgent: text("user_agent"),
  browser: text("browser"),
  os: text("os"),
  deviceType: text("device_type"),
  referrer: text("referrer"),
  source: text("source"),       // detected platform: facebook / telegram / discord / etc.
  sourceName: text("source_name"), // username/handle extracted from referrer
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertVisitSchema = createInsertSchema(visitsTable).omit({ id: true, createdAt: true });
export type InsertVisit = z.infer<typeof insertVisitSchema>;
export type Visit = typeof visitsTable.$inferSelect;
