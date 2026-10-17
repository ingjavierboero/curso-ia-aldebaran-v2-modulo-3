import type { Request, Response } from 'express';
import type { z } from 'zod';

/**
 * Valida el body con el schema. Si no es válido responde 400 con el primer
 * mensaje de error y devuelve null.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | null {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  res.status(400).json({ error: issue?.message ?? 'Datos inválidos.' });
  return null;
}
