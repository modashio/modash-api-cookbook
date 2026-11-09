import * as z from 'zod';

// Deliberately permissive: only the fields this project reads are declared, and every one may be
// missing. A row without a `userId` is skipped by the caller rather than failing the whole response.

const id = z.union([z.string(), z.number()]).transform(String);

export const userRowSchema = z.looseObject({
  userId: id.nullish(),
  username: z.string().nullish(),
  handle: z.string().nullish(),
  fullname: z.string().nullish(),
  followers: z.number().nullish(),
});
export type UserRow = z.infer<typeof userRowSchema>;

export const usersResponseSchema = z.looseObject({
  users: z.array(userRowSchema).nullish(),
});

const contactSchema = z.looseObject({
  type: z.string().nullish(),
  value: z.string().nullish(),
});

export const reportProfileSchema = z.looseObject({
  userId: id.nullish(),
  profile: userRowSchema.nullish(),
  contacts: z.array(contactSchema).nullish(),
});
export type ReportProfile = z.infer<typeof reportProfileSchema>;

export const reportResponseSchema = z.looseObject({
  profile: reportProfileSchema,
});

const searchRowSchema = userRowSchema.extend({ profile: userRowSchema.nullish() });

export const searchResponseSchema = z
  .looseObject({
    directs: z.array(searchRowSchema).nullish(),
    lookalikes: z.array(searchRowSchema).nullish(),
  })
  .refine((d) => Array.isArray(d.directs) || Array.isArray(d.lookalikes), 'no directs or lookalikes in the response');

export const emailSearchResponseSchema = z.looseObject({
  matchedEmails: z
    .array(
      z.looseObject({
        email: z.string().nullish(),
        users: z.array(userRowSchema.extend({ platform: z.string().nullish() })).nullish(),
      }),
    )
    .nullish(),
});
