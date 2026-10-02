import { NextResponse } from "next/server";
import { z } from "zod";
import { GroupError } from "./competitor-groups";
export const idSchema = z.string().min(1).max(100);
export const metadataSchema = z
  .object({
    name: z
      .string()
      .trim()
      .refine(
        (v) => [...v].length >= 1 && [...v].length <= 80,
        "Name must contain 1–80 characters",
      ),
    description: z
      .string()
      .trim()
      .refine((v) => [...v].length <= 2000)
      .nullable()
      .optional(),
  })
  .strict();
export const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(200000).default(0),
    q: z.string().max(200).default(""),
  })
  .strict();
export const windowSchema = z.object({
  window: z.enum(["24h", "7d"]).default("24h"),
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export async function groupResponse(
  action: () => Promise<unknown>,
  status = 200,
) {
  try {
    return NextResponse.json(await action(), { status });
  } catch (e) {
    if (e instanceof GroupError)
      return NextResponse.json({ error: e.code }, { status: e.status });
    console.error("GROUP_REQUEST_FAILED");
    return NextResponse.json(
      { error: "GROUP_REQUEST_FAILED" },
      { status: 500 },
    );
  }
}
export function parseQuery<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const parsed = schema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) throw new GroupError("INVALID_QUERY", 400);
  return parsed.data;
}
