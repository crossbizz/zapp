import { z } from "zod";

import {
  createClient,
  createEventClient,
  defineContract,
  defineEvent,
} from "@/ipc/contracts/core";

import { PlatformAuthStateSchema } from "./session";

const EmptyInputSchema = z.object({}).strict();

export const platformAuthContracts = {
  snapshot: defineContract({
    channel: "zapp-auth:snapshot",
    input: EmptyInputSchema,
    output: PlatformAuthStateSchema,
  }),
  signIn: defineContract({
    channel: "zapp-auth:sign-in",
    input: EmptyInputSchema,
    output: PlatformAuthStateSchema,
  }),
  signOut: defineContract({
    channel: "zapp-auth:sign-out",
    input: EmptyInputSchema,
    output: PlatformAuthStateSchema,
  }),
  selectOrganization: defineContract({
    channel: "zapp-auth:select-organization",
    input: z.object({ organizationId: z.string().min(1) }).strict(),
    output: PlatformAuthStateSchema,
  }),
} as const;

export const platformAuthClient = createClient(platformAuthContracts);

export const platformAuthEvents = {
  stateChanged: defineEvent({
    channel: "zapp-auth:state-changed",
    payload: PlatformAuthStateSchema,
  }),
} as const;

export const platformAuthEventClient = createEventClient(platformAuthEvents);
