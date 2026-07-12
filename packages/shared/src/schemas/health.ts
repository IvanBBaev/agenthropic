/**
 * TypeBox schema for the health DTO - the first API contract the server
 * exposes and the web app consumes.
 */
import { Type, type Static } from '@sinclair/typebox';

export const HealthSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    version: Type.String(),
    uptimeSeconds: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type HealthDto = Static<typeof HealthSchema>;
