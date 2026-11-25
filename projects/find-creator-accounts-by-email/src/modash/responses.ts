import * as z from 'zod';

// Deliberately permissive: only the fields this project reads are declared, every one may be missing, and a field
// of an unexpected type reads as missing. The call is paid for by the time its answer is read, so one odd value
// must not throw the whole answer away.

const optional = <T extends z.ZodType>(schema: T) => schema.nullish().catch(null);

const matchedUserSchema = z.looseObject({
  platform: optional(z.string()),
  userId: optional(z.union([z.string(), z.number()]).transform(String)),
  username: optional(z.string()),
  url: optional(z.string()),
  followers: optional(z.number()),
  isVerified: optional(z.boolean()),
});

const matchedEmailSchema = z.looseObject({
  email: optional(z.string()),
  users: optional(z.array(matchedUserSchema)),
});

export const emailSearchResponseSchema = z.looseObject({
  totalMatches: optional(z.number()),
  matchedEmails: optional(z.array(matchedEmailSchema)).transform((matches) => matches ?? []),
});
