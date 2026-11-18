import { z } from "zod";

export const SoloPolicySchema = z.enum(["off", "cap", "exclude"]);

export const SegmentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "Segment ids are lower_snake_case"),
  label: z.string().min(1),
  buyer: z.string().min(1),
  enabled: z.boolean(),
  categories: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)),
  soloPolicy: SoloPolicySchema,
  fitFloor: z.number().int().min(0).max(100),
});

export type Segment = z.infer<typeof SegmentSchema>;
