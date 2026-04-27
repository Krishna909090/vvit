import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from '../utils/AppError';


export const validateRequest =
  (schema: ZodSchema<any>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Express 5 defaults req.body to undefined when no body is sent or
      // Content-Type doesn't match (Express 4 used {}). Normalize so Zod
      // sees an object and produces a useful "field required" error
      // instead of an opaque "expected object, received undefined".
      const parsed = await schema.parseAsync({
        body: req.body ?? {},
        query: req.query,
        params: req.params,
      });
      if (parsed.body) req.body = parsed.body;
      if (parsed.query) Object.assign(req.query, parsed.query);
      if (parsed.params) Object.assign(req.params, parsed.params);

      return next();
    } catch (error:any) {
      if (error instanceof ZodError) {
        const errorMessage = error.issues
          .map(e => `${e.path.join('.')}: ${e.message}`)
          .join(', ');

        return next(new AppError(`Validation failed: ${errorMessage}`, 400));
      }

      return next(error);
    }
  };

