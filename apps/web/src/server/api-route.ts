import { forwardToApi } from './api-bridge';

/** One handler for every method of every API route file. */
export const handler = (request: Request): Promise<Response> => forwardToApi(request);
